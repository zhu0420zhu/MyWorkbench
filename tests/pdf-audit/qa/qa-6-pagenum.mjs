/**
 * QA 独立复验 #6：加页码「真实可视预览」的落位 = 导出 PDF 的真实坐标。
 *
 * 独立性声明：
 *   - 自造多种页面尺寸（A4 / Letter / 自定义）+ 非默认边距(37.5)与字号(18) + 4 种模板(含 ASCII 自定义)；
 *   - 坐标用**两条独立证据链**同时校验：
 *       (A) 自写解析器从内容流取 Tm 文本矩阵；
 *       (B) pdfjs getTextContent() 的 item.transform（与生产代码无任何共享）;
 *     二者都必须等于预览声明的 place。
 *   - 旋转页：预览变换与 pdfjs 视口变换逐项比对，并核验落位在 4 个角度下都不出界。
 *   - 字体边界：实测 drawText('第') 抛 WinAnsi，且确认 UI 在导出前拦截（guard + 禁用按钮）。
 *   - 性能/接线：静态确认只渲染当前页 + 渲染前上屏加载态。
 */
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
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
} from '../../../src/renderer/src/utils/pdfPageNumber.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

let pass = 0
let fail = 0
const failList = []
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  [PASS] ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; failList.push(name); console.log('  [FAIL] ' + name + (detail ? '  ' + detail : '')) }
}
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps

/* ---------- 工具：自写内容流读取 + Tm 解析 ---------- */
function contentText(doc, pageIndex) {
  const c = doc.getPage(pageIndex).node.get(PDFName.of('Contents'))
  const parts = []
  const one = (x) => {
    const o = x instanceof PDFRef ? doc.context.lookup(x) : x
    if (o?.contents) parts.push(Buffer.from(o.contents))
    else if (o && typeof o.getContents === 'function') parts.push(Buffer.from(o.getContents()))
  }
  if (c && typeof c.asArray === 'function') c.asArray().forEach(one)
  else if (c) one(c)
  const buf = Buffer.concat(parts)
  try { return zlib.inflateSync(buf).toString('latin1') } catch { return buf.toString('latin1') }
}
function lastTm(doc, pageIndex) {
  const s = contentText(doc, pageIndex)
  const ms = [...s.matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm/g)]
  if (!ms.length) return null
  const m = ms[ms.length - 1]
  return { x: Number(m[1]), y: Number(m[2]) }
}
async function pdfjsPlacements(bytesStr) {
  const bytes = typeof bytesStr === 'string' ? new Uint8Array(await readFile(bytesStr)) : bytesStr
  const d = await pdfjs.getDocument({ data: bytes, disableWorker: true, isEvalSupported: false, verbosity: 0 }).promise
  const out = []
  for (let i = 1; i <= d.numPages; i++) {
    const page = await d.getPage(i)
    const tc = await page.getTextContent()
    for (const it of tc.items) if (it.str && it.str.trim()) out.push({ str: it.str, x: it.transform[4], y: it.transform[5] })
  }
  await (d.destroy ? d.destroy() : d.cleanup())
  return out
}

/* ---------- A. 模板 → 标签 ---------- */
console.log('== A. 模板 → 标签 ==')
check('number → "7"', buildPageLabel({ template: 'number', custom: '', n: 7, total: 42 }) === '7')
check('pageof → "7 / 42"', buildPageLabel({ template: 'pageof', custom: '', n: 7, total: 42 }) === '7 / 42')
check('dash → "- 7 -"', buildPageLabel({ template: 'dash', custom: '', n: 7, total: 42 }) === '- 7 -')
check('custom {n}/{total} 替换', buildPageLabel({ template: 'custom', custom: 'Pg {n} of {total}', n: 7, total: 42 }) === 'Pg 7 of 42')
check('custom 空串回落 {n}', buildPageLabel({ template: 'custom', custom: '  ', n: 7, total: 42 }) === '7')
check('起始页码偏移（startAt=100,i=5 →105）', buildPageLabel({ template: 'number', custom: '', n: 100 + 5, total: 42 }) === '105')

/* ---------- B. 9 位置 × 4 模板 × 2 页面尺寸：预览落位 == 真实坐标 ---------- */
console.log('\n== B. 9 位置 × 4 模板 × 2 尺寸（A4/Letter, margin=37.5, size=18）：预览落位 == 导出真实坐标 ==')
const TEMPLATES = [
  { t: 'number', custom: '' },
  { t: 'pageof', custom: '' },
  { t: 'dash', custom: '' },
  { t: 'custom', custom: 'P{n}/{total}' }
]
const PAGES = { A4: { w: 595.28, h: 841.89 }, Letter: { w: 612, h: 792 } }
const margin = 37.5
const fontSize = 18
{
  let combos = 0
  let bothOk = 0
  let tmOk = 0
  let pdfjsOk = 0
  const bad = []
  for (const [sizeName, size] of Object.entries(PAGES)) {
    for (const { t, custom } of TEMPLATES) {
      const doc = await PDFDocument.create()
      const font = await doc.embedFont(StandardFonts.Helvetica)
      const expects = []
      for (const pos of PAGE_NUMBER_POSITIONS) {
        const label = buildPageLabel({ template: t, custom, n: 3, total: 9 })
        const tw = font.widthOfTextAtSize(label, fontSize)
        const { x, y } = pageNumberPlacement({ position: pos.value, textWidth: tw, fontSize, margin, pageW: size.w, pageH: size.h })
        expects.push({ pos: pos.value, label, x, y, tw })
        doc.addPage([size.w, size.h]).drawText(label, { x, y, size: fontSize, font, color: rgb(0.2, 0.2, 0.2) })
      }
      const reloaded = await PDFDocument.load(await doc.save(), { ignoreEncryption: true })
      const jsPlaces = await pdfjsPlacements(await reloaded.save())
      for (let i = 0; i < PAGE_NUMBER_POSITIONS.length; i++) {
        combos++
        const e = expects[i]
        const tm = lastTm(reloaded, i)
        const js = jsPlaces[i]
        const tmMatch = !!tm && near(tm.x, e.x) && near(tm.y, e.y)
        const jsMatch = !!js && near(js.x, e.x) && near(js.y, e.y)
        if (tmMatch) tmOk++
        if (jsMatch) pdfjsOk++
        if (tmMatch && jsMatch) bothOk++
        else bad.push(sizeName + '/' + t + '/' + e.pos + ' 预览(' + e.x.toFixed(2) + ',' + e.y.toFixed(2) + ') Tm(' + (tm ? tm.x + ',' + tm.y : 'null') + ') pdfjs(' + (js ? js.x.toFixed(2) + ',' + js.y.toFixed(2) : 'null') + ')')
      }
    }
  }
  console.log('  组合数=' + combos + '  Tm 命中=' + tmOk + '  pdfjs 命中=' + pdfjsOk)
  check('(证据链A) 全部组合的 Tm 坐标 == 预览落位', tmOk === combos, tmOk + '/' + combos)
  check('(证据链B) 全部组合的 pdfjs transform == 预览落位', pdfjsOk === combos, pdfjsOk + '/' + combos)
  check('两条独立证据链同时命中（预览 = 真实导出）', bothOk === combos, bothOk + '/' + combos + (bad.length ? ' | ' + bad.slice(0, 3).join(' ; ') : ''))
}

/* 方位语义 + 不出界（A4，number 模板） */
console.log('\n  方位语义与不出界（A4, number, margin=24, size=11）')
{
  const W = 595.28, H = 841.89, mg = 24, fs = 11
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const tw = font.widthOfTextAtSize('3', fs)
  let ok = true
  const notes = []
  for (const pos of PAGE_NUMBER_POSITIONS) {
    const p = pageNumberPlacement({ position: pos.value, textWidth: tw, fontSize: fs, margin: mg, pageW: W, pageH: H })
    if (p.x < -0.01 || p.x + tw > W + 0.01 || p.y < -0.01 || p.y + fs > H + 0.01) { ok = false; notes.push(pos.value + ' 出界') }
    if (pos.value.endsWith('-left') && !near(p.x, mg)) { ok = false; notes.push(pos.value + ' x≠margin') }
    if (pos.value.endsWith('-center') && !near(p.x, (W - tw) / 2)) { ok = false; notes.push(pos.value + ' 未居中') }
    if (pos.value.endsWith('-right') && !near(p.x, W - tw - mg)) { ok = false; notes.push(pos.value + ' 未右对齐') }
    if (pos.value.startsWith('bottom') && !near(p.y, mg)) { ok = false; notes.push(pos.value + ' 底 y≠margin') }
    if (pos.value.startsWith('top') && !near(p.y, H - mg - fs)) { ok = false; notes.push(pos.value + ' 顶 y 错') }
    if (pos.value.startsWith('middle') && !near(p.y, (H - fs) / 2)) { ok = false; notes.push(pos.value + ' 未垂直居中') }
  }
  check('9 位置的左/中/右、上/中/下语义正确且不出界', ok, notes.join('; ') || '全部分位正确')
}

/* ---------- C. 旋转页：预览变换 == pdfjs 视口；落位仍等于真实坐标 ---------- */
console.log('\n== C. 旋转页（0/90/180/270）==')
{
  const W = 500, H = 700, mg = 20, fs = 12
  let matOk = true, placeOk = true, insideOk = true
  const notes = []
  for (const rot of [0, 90, 180, 270]) {
    // C1 预览变换 vs pdfjs viewport
    const d1 = await PDFDocument.create()
    const p1 = d1.addPage([W, H])
    p1.setRotation({ type: 'degrees', angle: rot })
    p1.drawText('x', { x: 5, y: 5, size: 8 })
    const b1 = await d1.save()
    const jsDoc = await pdfjs.getDocument({ data: b1.slice(0), disableWorker: true, isEvalSupported: false, verbosity: 0 }).promise
    const jsPage = await jsDoc.getPage(1)
    const vp = jsPage.getViewport({ scale: 1 })
    const mine = pagePreviewTransform(W, H, rot)
    const same = near(mine.matrix[0], vp.transform[0]) && near(mine.matrix[1], vp.transform[1]) &&
      near(mine.matrix[2], vp.transform[2]) && near(mine.matrix[3], vp.transform[3]) &&
      near(mine.matrix[4], vp.transform[4]) && near(mine.matrix[5], vp.transform[5]) &&
      near(mine.width, vp.width) && near(mine.height, vp.height)
    if (!same) { matOk = false; notes.push('rot' + rot + ' 矩阵不一致') }
    await (jsDoc.destroy ? jsDoc.destroy() : jsDoc.cleanup())

    // C2 精确落位：旋转页上的真实 Tm 仍应等于 place（同一套用户空间坐标）
    const d2 = await PDFDocument.create()
    const font = await d2.embedFont(StandardFonts.Helvetica)
    const label = buildPageLabel({ template: 'pageof', custom: '', n: 4, total: 8 })
    const tw = font.widthOfTextAtSize(label, fs)
    const place = pageNumberPlacement({ position: 'top-right', textWidth: tw, fontSize: fs, margin: mg, pageW: W, pageH: H })
    const p2 = d2.addPage([W, H])
    p2.setRotation({ type: 'degrees', angle: rot })
    p2.drawText(label, { x: place.x, y: place.y, size: fs, font })
    const d2r = await PDFDocument.load(await d2.save(), { ignoreEncryption: true })
    const tm = lastTm(d2r, 0)
    if (!tm || !near(tm.x, place.x) || !near(tm.y, place.y)) { placeOk = false; notes.push('rot' + rot + ' Tm(' + (tm ? tm.x + ',' + tm.y : 'null') + ')≠place') }

    // C3 预览层里，把文字框四角映射到视口 → 必须仍在视口内、且不被拉伸
    const m = mine.matrix
    const map = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
    const corners = [map(place.x, place.y), map(place.x + tw, place.y), map(place.x, place.y + fs), map(place.x + tw, place.y + fs)]
    const xs = corners.map((c) => c[0]); const ys = corners.map((c) => c[1])
    const inside = Math.min(...xs) >= -0.01 && Math.max(...xs) <= mine.width + 0.01 && Math.min(...ys) >= -0.01 && Math.max(...ys) <= mine.height + 0.01
    const boxW = Math.max(...xs) - Math.min(...xs); const boxH = Math.max(...ys) - Math.min(...ys)
    const sizeOk = (near(boxW, tw, 0.01) && near(boxH, fs, 0.01)) || (near(boxW, fs, 0.01) && near(boxH, tw, 0.01))
    if (!inside || !sizeOk) { insideOk = false; notes.push('rot' + rot + ' inside=' + inside + ' size=' + boxW.toFixed(2) + 'x' + boxH.toFixed(2)) }
  }
  check('预览变换 == pdfjs 视口变换（4 角度逐项）', matOk, notes.filter((n) => n.includes('矩阵')).join(';') || '4/4 一致')
  check('旋转页上真实 Tm 仍 == 预览落位（不错位）', placeOk, notes.filter((n) => n.includes('Tm')).join(';') || '4/4 一致')
  check('文字框映射到视口后不出界、不变形（4 角度）', insideOk, notes.filter((n) => n.includes('inside')).join(';') || '4/4 正确')
}

/* ---------- D. 字体边界 ---------- */
console.log('\n== D. 字体边界：Helvetica(WinAnsi) 不能编码中文 ==')
{
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  check('canEncode 无法编码「第 1 页」', canEncode(font, '第 1 页') === false)
  check('canEncode 可编码 "3 / 9"', canEncode(font, '3 / 9') === true)
  check('safeTextWidth 中文返回 undefined（预览不崩）', safeTextWidth(font, '第 1 页', 11) === undefined)

  let threw = ''
  try {
    const p = doc.addPage([200, 200])
    p.drawText('第', { x: 10, y: 10, size: 11, font })
  } catch (e) { threw = String(e && e.message ? e.message : e) }
  console.log('   真实 drawText("第") 抛出: ' + threw.slice(0, 80))
  check('真实 drawText("第") 抛 WinAnsi 错误', /WinAnsi|cannot encode/i.test(threw), threw.slice(0, 60))

  const builtins = ['number', 'pageof', 'dash'].map((t) => buildPageLabel({ template: t, custom: '', n: 1, total: 9 }))
  check('三个内置模板均可编码（导出不会被字体卡住）', builtins.every((x) => canEncode(font, x)), builtins.join(' | '))
  check('中文自定义模板判定为不可编码', canEncode(font, buildPageLabel({ template: 'custom', custom: '第 {n} 页', n: 1, total: 9 })) === false)

  // 生产 apply() 必须在 drawText 之前拦截
  const tsx = await readFile(join(ROOT, 'src', 'renderer', 'src', 'pages', 'PdfTools.tsx'), 'utf-8')
  const start = tsx.indexOf('function PageNumberPanel()')
  const panel = tsx.slice(start, tsx.indexOf('/* ---------- 裁剪', start))
  const applyIdx = panel.indexOf('const apply = async ()')
  const guardIdx = panel.indexOf('canEncode(font, previewLabel)')
  const drawIdx = panel.indexOf('drawText(label')
  check('导出函数在 drawText 之前先 canEncode 拦截并 return', applyIdx >= 0 && guardIdx > applyIdx && drawIdx > guardIdx, 'apply@' + applyIdx + ' guard@' + guardIdx + ' draw@' + drawIdx)
  check('导出按钮在不可编码时被禁用（而非等点击后才抛错）', /disabled=\{!encodable\}/.test(panel))
  check('预览阶段即给出错误 Alert（encodable 实时计算）', /const encodable = /.test(panel) && /无法编码的字符/.test(panel))
}

/* ---------- E. 性能与接线：只渲染当前页 + 加载态上屏 ---------- */
console.log('\n== E. 面板接线：只渲染当前页 + 加载态上屏 + 叠加层同源 ==')
{
  const tsx = await readFile(join(ROOT, 'src', 'renderer', 'src', 'pages', 'PdfTools.tsx'), 'utf-8')
  const start = tsx.indexOf('function PageNumberPanel()')
  const panel = tsx.slice(start, tsx.indexOf('/* ---------- 裁剪', start))
  check('只渲染当前页（renderPdfPages(bytes,[idx])）', /renderPdfPages\(bytes,\s*\[idx\]/.test(panel))
  check('渲染前先上屏加载态（setLoadingPreview(true) → setTimeout 0 → 渲染）', /setLoadingPreview\(true\)[\s\S]{0,400}setTimeout\(resolve,\s*0\)/.test(panel))
  check('切换预览页触发重渲染（仅依赖 previewPage）', /\[previewPage\]/.test(panel))
  check('叠加层为 SVG，且用同一 pageNumberPlacement/pagePreviewTransform', /<svg/.test(panel) && /pageNumberPlacement\(/.test(panel) && /pagePreviewTransform\(/.test(panel))
  check('位置选项来自共享常量 PAGE_NUMBER_POSITIONS', /PAGE_NUMBER_POSITIONS/.test(panel))
  check('旧「命中页码文字清单」已不是本面板的预览（无 preview.pages/modes 文案）', !/已处理 \$\{preview\.pages/.test(panel) && !/渲染方式：/.test(panel))
  check('UI 明示只渲染当前页、不整本渲染', /仅渲染第/.test(panel))
}

console.log('\n' + '='.repeat(64))
console.log('QA#6 结果: ' + pass + ' 项通过, ' + fail + ' 项失败')
if (failList.length) console.log('失败项: ' + failList.join(' | '))
console.log('='.repeat(64))
process.exit(fail ? 1 : 0)
