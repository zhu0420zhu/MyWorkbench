/**
 * 验收「加页码面板的真实可视预览」（P2#8）。
 *
 * 旧实现：Alert 写「实时预览」，但面板里只有一个文字清单（命中页码 + 渲染方式说明），没有可视预览。
 * 新实现：渲染当前预览页位图，并按当前 位置/格式/起始页码/字号/边距 **叠加绘制** 页码；
 *         落位坐标与导出共用同一套计算（src/renderer/src/utils/pdfPageNumber.ts）。
 *
 * 断言：
 *   A. 模板 → 标签
 *   B. 9 种位置 × 3 种模板：预览叠加用的落位 == 真实导出到 PDF 内容流里的 Tm 坐标（逐项相等）
 *      且落位落在页面内、方位符合预期
 *   C. 预览叠加的坐标变换 == pdf.js viewport transform（0/90/180/270），旋转页也不得错位
 *   D. 字体边界：Helvetica(WinAnsi) 无法编码中文 —— 必须能提前判定，不能等导出才抛异常
 *   E. 面板接线（静态证据）：只渲染当前页、渲染前先上屏加载态、叠加层是 SVG
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { PDFDocument, PDFName, PDFRef, StandardFonts, rgb } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  buildPageLabel,
  canEncode,
  PAGE_NUMBER_POSITIONS,
  pageNumberPlacement,
  pagePreviewTransform,
  safeTextWidth
} from '../../src/renderer/src/utils/pdfPageNumber.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const W = 595.28
const H = 841.89

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  [PASS] ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? '  ' + detail : '')) }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps

/**
 * 从 PdfTools.tsx 切出某个面板的源码，**不依赖精确签名**。
 * 起点匹配 `function X(` / `const X =` / `let X =` / `var X =`；终点为下一个分节注释 `/* ----------`。
 * 这样面板后续加 `initialFile` 等参数、或由函数声明改写成箭头函数，都不会再让切片落空
 * （此前的 `indexOf('function PageNumberPanel()')` 在签名变成 `PageNumberPanel({ initialFile })` 后返回 -1）。
 */
function slicePanelSource(tsx, name) {
  const start = tsx.search(new RegExp(`\\b(?:function|const|let|var)\\s+${name}\\b`))
  if (start < 0) return ''
  const end = tsx.indexOf('/* ----------', start + 1)
  return tsx.slice(start, end < 0 ? undefined : end)
}

/* ---------- 读取 PDF 内容流里的 Tm 坐标（真实产出） ---------- */
function contentStreams(doc, pageIndex) {
  const c = doc.getPage(pageIndex).node.get(PDFName.of('Contents'))
  const parts = []
  const one = (x) => {
    const o = x instanceof PDFRef ? doc.context.lookup(x) : x
    if (o?.contents) parts.push(Buffer.from(o.contents))
  }
  if (c && typeof c.asArray === 'function') c.asArray().forEach(one)
  else if (c) one(c)
  const buf = Buffer.concat(parts)
  try { return zlib.inflateSync(buf).toString('latin1') } catch { return buf.toString('latin1') }
}
function lastTextMatrix(doc, pageIndex) {
  const s = contentStreams(doc, pageIndex)
  const ms = [...s.matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm/g)]
  if (!ms.length) return null
  const m = ms[ms.length - 1]
  return { x: Number(m[1]), y: Number(m[2]) }
}

/* ---------- A. 模板 → 标签 ---------- */
console.log('== A. 模板 → 标签 ==')
check('number → "3"', buildPageLabel({ template: 'number', custom: '', n: 3, total: 10 }) === '3')
check('pageof → "3 / 10"', buildPageLabel({ template: 'pageof', custom: '', n: 3, total: 10 }) === '3 / 10')
check('dash → "- 3 -"', buildPageLabel({ template: 'dash', custom: '', n: 3, total: 10 }) === '- 3 -')
check('custom 占位符替换', buildPageLabel({ template: 'custom', custom: 'P{n} of {total}', n: 3, total: 10 }) === 'P3 of 10')
check('custom 空串回落为 {n}', buildPageLabel({ template: 'custom', custom: '   ', n: 3, total: 10 }) === '3')
check('起始页码偏移生效（startAt=5, i=2 → 7）', buildPageLabel({ template: 'number', custom: '', n: 5 + 2, total: 10 }) === '7')

/* ---------- B. 9 位置 × 3 模板：预览落位 == 真实产出 ---------- */
console.log('\n== B. 9 种位置 × 3 种模板：预览落位 == 导出到 PDF 的真实坐标 ==')
const TEMPLATES = ['number', 'pageof', 'dash']
const margin = 24
const fontSize = 11
const templates = {}
{
  let anyFail = 0
  let mismatch = []
  for (const template of TEMPLATES) {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    templates[template] = {}
    // 每种位置单独一页，便于逐页解析真实 Tm
    for (const pos of PAGE_NUMBER_POSITIONS) {
      const label = buildPageLabel({ template, custom: '', n: 3, total: 10 })
      const tw = font.widthOfTextAtSize(label, fontSize)
      const { x, y } = pageNumberPlacement({ position: pos.value, textWidth: tw, fontSize, margin, pageW: W, pageH: H })
      templates[template][pos.value] = { label, tw, x, y }
      doc.addPage([W, H]).drawText(label, { x, y, size: fontSize, font, color: rgb(0.2, 0.2, 0.2) })
    }
    const reloaded = await PDFDocument.load(await doc.save(), { ignoreEncryption: true })
    let ok = 0
    for (let i = 0; i < PAGE_NUMBER_POSITIONS.length; i++) {
      const pos = PAGE_NUMBER_POSITIONS[i]
      const real = lastTextMatrix(reloaded, i)
      const expect = templates[template][pos.value]
      if (real && near(real.x, expect.x, 0.02) && near(real.y, expect.y, 0.02)) ok++
      else mismatch.push(template + '/' + pos.value + ' 预览(' + expect.x.toFixed(2) + ',' + expect.y.toFixed(2) + ') 实际(' + (real ? real.x + ',' + real.y : 'null') + ')')
    }
    if (ok !== 9) anyFail++
    console.log('  模板 ' + template + '：' + ok + '/9 落位与真实产出一致')
  }
  check('3 种模板 × 9 种位置的落位全部与真实 PDF 一致', anyFail === 0 && mismatch.length === 0, mismatch.slice(0, 3).join(' | '))
}

/* 方位语义 + 不出界 */
console.log('\n  方位语义校验（模板 number，标签宽度 ' + templates.number['bottom-left'].tw.toFixed(2) + 'pt）')
{
  const tw = templates.number['bottom-left'].tw
  let ok = true
  const notes = []
  for (const pos of PAGE_NUMBER_POSITIONS) {
    const p = templates.number[pos.value]
    const inX = p.x >= 0 && p.x + p.tw <= W + 0.01
    const inY = p.y >= 0 && p.y + fontSize <= H + 0.01
    if (!inX || !inY) { ok = false; notes.push(pos.value + ' 出界') }
    if (pos.value.endsWith('-left') && !near(p.x, margin)) { ok = false; notes.push(pos.value + ' x≠margin') }
    if (pos.value.endsWith('-center') && !near(p.x, (W - p.tw) / 2, 0.01)) { ok = false; notes.push(pos.value + ' 未居中') }
    if (pos.value.endsWith('-right') && !near(p.x, W - p.tw - margin, 0.01)) { ok = false; notes.push(pos.value + ' 未右对齐') }
    if (pos.value.startsWith('bottom') && !near(p.y, margin)) { ok = false; notes.push(pos.value + ' y≠margin') }
    if (pos.value.startsWith('top') && !near(p.y, H - margin - fontSize)) { ok = false; notes.push(pos.value + ' 顶部 y 错') }
    if (pos.value.startsWith('middle') && !near(p.y, (H - fontSize) / 2)) { ok = false; notes.push(pos.value + ' 垂直未居中') }
  }
  check('9 种位置的左/中/右、上/中/下语义正确且不出界', ok, notes.join('; ') || '全部分位正确')
}

/* 预览叠加（SVG）与真实落位一致：把页面上的文字框映射到显示坐标，必须落在显示区内且不变形 */
{
  let ok = true
  const notes = []
  for (const rot of [0, 90, 180, 270]) {
    const t = pagePreviewTransform(W, H, rot)
    const m = t.matrix
    const map = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
    const p = templates.number['bottom-left']
    // 文字框四角（pdf 空间）→ 显示坐标
    const corners = [
      map(p.x, p.y),
      map(p.x + p.tw, p.y),
      map(p.x, p.y + fontSize),
      map(p.x + p.tw, p.y + fontSize)
    ]
    const xs = corners.map((c) => c[0])
    const ys = corners.map((c) => c[1])
    const inside =
      Math.min(...xs) >= -0.01 && Math.max(...xs) <= t.width + 0.01 &&
      Math.min(...ys) >= -0.01 && Math.max(...ys) <= t.height + 0.01
    const boxW = Math.max(...xs) - Math.min(...xs)
    const boxH = Math.max(...ys) - Math.min(...ys)
    // 旋转/翻转为正交变换：文字框尺寸不得被拉伸（0/180 交换宽高后仍应等于 tw×fontSize）
    const sizeOk =
      (near(boxW, p.tw, 0.01) && near(boxH, fontSize, 0.01)) ||
      (near(boxW, fontSize, 0.01) && near(boxH, p.tw, 0.01))
    if (!inside || !sizeOk) {
      ok = false
      notes.push('rot' + rot + ' inside=' + inside + ' size=' + boxW.toFixed(2) + 'x' + boxH.toFixed(2))
    }
  }
  check('文字框在 0/90/180/270 下都落在显示区内且不被拉伸（预览不错位/不变形）', ok, notes.join('; ') || '4/4 正确')
}

/* ---------- C. 预览变换 == pdf.js viewport transform ---------- */
console.log('\n== C. 预览叠加变换 == pdf.js 视口变换 ==')
{
  const doc0 = await PDFDocument.create()
  const page0 = doc0.addPage([400, 600])
  page0.drawText('x', { x: 5, y: 5, size: 8 })
  let ok = true
  const notes = []
  for (const rot of [0, 90, 180, 270]) {
    page0.setRotation({ type: 'degrees', angle: rot })
    const bytes = await doc0.save()
    const jsDoc = await pdfjs.getDocument({ data: bytes.slice(0), disableWorker: true }).promise
    const jsPage = await jsDoc.getPage(1)
    const vp = jsPage.getViewport({ scale: 1 })
    const mine = pagePreviewTransform(400, 600, rot)
    const m = vp.transform
    const same =
      near(mine.matrix[0], m[0]) && near(mine.matrix[1], m[1]) &&
      near(mine.matrix[2], m[2]) && near(mine.matrix[3], m[3]) &&
      near(mine.matrix[4], m[4]) && near(mine.matrix[5], m[5]) &&
      near(mine.width, vp.width) && near(mine.height, vp.height)
    if (!same) { ok = false; notes.push('rot' + rot + ' mine=' + mine.matrix.join(',') + ' ' + mine.width + 'x' + mine.height + ' vs ' + m.map((v) => Math.round(v)).join(',') + ' ' + vp.width + 'x' + vp.height) }
    await (jsDoc.destroy ? jsDoc.destroy() : jsDoc.cleanup())
  }
  check('0/90/180/270 的矩阵与视口尺寸逐项一致', ok, notes.join(' | ') || '4/4 一致')
}

/* ---------- D. 字体边界 ---------- */
console.log('\n== D. 字体边界：Helvetica(WinAnsi) 不能编码中文 ==')
{
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  check('canEncode("第 1 页") === false（可提前判定）', canEncode(font, '第 1 页') === false)
  check('canEncode("3 / 10") === true', canEncode(font, '3 / 10') === true)
  check('safeTextWidth 对中文返回 undefined（预览不崩）', safeTextWidth(font, '第 1 页', 11) === undefined)

  let threw = ''
  try {
    const p = doc.addPage([200, 200])
    p.drawText('第 1 页', { x: 10, y: 10, size: 11, font })
  } catch (e) {
    threw = String(e && e.message ? e.message : e)
  }
  check('真实 drawText 会抛 WinAnsi 错误（证明必须提前拦截）', /WinAnsi|cannot encode/i.test(threw), threw.slice(0, 90))

  const builtins = [
    buildPageLabel({ template: 'number', custom: '', n: 1, total: 9 }),
    buildPageLabel({ template: 'pageof', custom: '', n: 1, total: 9 }),
    buildPageLabel({ template: 'dash', custom: '', n: 1, total: 9 })
  ]
  check('三个内置模板的标签都可编码（导出永不会被字体卡住）', builtins.every((t) => canEncode(font, t)), builtins.join(' | '))
  check('自定义模板含中文 → 判定为不可编码', canEncode(font, buildPageLabel({ template: 'custom', custom: '第 {n} 页', n: 1, total: 9 })) === false)
}

/* ---------- E. 面板接线 ---------- */
console.log('\n== E. 面板接线（静态证据） ==')
{
  const tsx = await readFile(join(HERE, '..', '..', 'src', 'renderer', 'src', 'pages', 'PdfTools.tsx'), 'utf-8')
  const panel = slicePanelSource(tsx, 'PageNumberPanel')
  check('定位到 PageNumberPanel 源码（切片非空）', panel.length > 0, panel.length + ' 字符')
  check('渲染当前预览页位图（renderPdfPages(bytes, [idx])）', /renderPdfPages\(bytes,\s*\[idx\]/.test(panel))
  check('渲染前先让加载态上屏（setLoading + setTimeout 0）', /setLoadingPreview\(true\)[\s\S]{0,400}setTimeout\(resolve,\s*0\)/.test(panel))
  check('叠加层为 SVG，按当前参数实时重算', /<svg/.test(panel) && /pagePreviewTransform/.test(panel) && /pageNumberPlacement/.test(panel))
  check('9 种位置来自共享常量（与导出同源）', /PAGE_NUMBER_POSITIONS/.test(panel))
  check('不可编码时禁用导出并给出提前提示', /disabled=\{!encodable\}/.test(panel) && /无法编码的字符/.test(panel))
  check('UI 明示字体限制并指向支持中文的水印工具', /WinAnsi/.test(panel) && /水印 \/ 页眉页脚/.test(panel))
  check('有预览页选择（只渲染当前页，不整本渲染）', /仅渲染第/.test(panel) && /previewPage/.test(panel))
  check('预览保真偏差已在 UI 明示', /字形宽度与标准 Helvetica 可能存在极细微差异/.test(panel))
}

console.log('\n' + '='.repeat(64))
console.log(`结果: ${pass} 项通过, ${fail} 项失败`)
console.log('='.repeat(64))
process.exit(fail ? 1 : 0)
