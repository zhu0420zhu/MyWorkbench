/**
 * 验收「裁剪面板真实框选交互」（P2#7）。
 *
 * 文案承诺「框选保留区域并批量裁剪页面」，旧实现只有四个边距数字输入框，没有任何框选 UI。
 *
 * 本脚本验证：
 *   A. 框选几何换算（src/renderer/src/utils/pdfCropSelect.ts，与面板同一条代码路径）
 *      - 正向拖拽 → 四边边距
 *      - 反向拖拽（右下→左上）结果一致
 *      - 拖到预览图外按边界截断
 *      - 零面积/过小 → 扩到最小可裁剪尺寸（不产出非法 CropBox）
 *      - 边距 → 选框 的反向映射（数值改动 → 选框动）可往返
 *   B. 端到端：把框选结果真正写进 PDF 的 CropBox（矢量，不栅格化）
 *      - CropBox 数值正确、MediaBox 不变、内容流逐字节不变
 *      - 多页时边距按各页尺寸应用到全部页（批量语义）
 *   C. 面板确实接上了拖拽交互（静态证据）
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, PDFName, PDFRef } from 'pdf-lib'
import {
  selectionToMargins,
  marginsToSelection,
  clampMarginsPt,
  unitToPt,
  ptToUnit,
  MIN_CROP_PT
} from '../../src/renderer/src/utils/pdfCropSelect.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const A4 = { w: 595.28, h: 841.89 }

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  [PASS] ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? '  ' + detail : '')) }
}
const near = (a, b, eps = 0.11) => Math.abs(a - b) <= eps

/**
 * 从 PdfTools.tsx 切出某个面板的源码，**不依赖精确签名**。
 * 起点匹配 `function X(` / `const X =` / `let X =` / `var X =`；
 * 终点为下一个分节注释 `/* ----------`。
 * 这样面板后续加 `initialFile` 等参数、或由函数声明改写成箭头函数，都不会再让切片落空
 * （此前的 `indexOf('function CropPanel()')` 在签名变成 `CropPanel({ initialFile })` 后返回 -1）。
 */
function slicePanelSource(tsx, name) {
  const start = tsx.search(new RegExp(`\\b(?:function|const|let|var)\\s+${name}\\b`))
  if (start < 0) return ''
  const end = tsx.indexOf('/* ----------', start + 1)
  return tsx.slice(start, end < 0 ? undefined : end)
}

/* ---------- A. 几何换算 ---------- */
console.log('== A. 框选几何换算（A4 595.28×841.89pt，单位 mm）==')
const fwd = selectionToMargins({ x0p: 10, y0p: 10, x1p: 90, y1p: 90, pageW: A4.w, pageH: A4.h, unit: 'mm' })
console.log('  正向拖拽 (10%,10%)→(90%,90%): ' + JSON.stringify(fwd))
check('左右边距 = 10% 页宽 ≈ 21.0mm', near(fwd.left, 21) && near(fwd.right, 21), fwd.left + '/' + fwd.right)
check('上下边距 = 10% 页高 ≈ 29.7mm', near(fwd.top, 29.7) && near(fwd.bottom, 29.7), fwd.top + '/' + fwd.bottom)

const rev = selectionToMargins({ x0p: 90, y0p: 90, x1p: 10, y1p: 10, pageW: A4.w, pageH: A4.h, unit: 'mm' })
check('反向拖拽（右下→左上）结果一致', JSON.stringify(rev) === JSON.stringify(fwd), JSON.stringify(rev))

const oob = selectionToMargins({ x0p: -50, y0p: -50, x1p: 150, y1p: 150, pageW: A4.w, pageH: A4.h, unit: 'mm' })
check('拖出预览图外 → 截断为整页（四边 0）', oob.left === 0 && oob.right === 0 && oob.top === 0 && oob.bottom === 0, JSON.stringify(oob))

const zero = selectionToMargins({ x0p: 50, y0p: 50, x1p: 50, y1p: 50, pageW: A4.w, pageH: A4.h, unit: 'mm' })
const zeroW = A4.w - unitToPt(zero.left, 'mm') - unitToPt(zero.right, 'mm')
const zeroH = A4.h - unitToPt(zero.top, 'mm') - unitToPt(zero.bottom, 'mm')
check('零面积 → 扩到最小可裁剪尺寸（宽 10pt）', near(zeroW, MIN_CROP_PT, 0.31), zeroW.toFixed(2) + 'pt')
check('零面积 → 扩到最小可裁剪尺寸（高 10pt）', near(zeroH, MIN_CROP_PT, 0.31), zeroH.toFixed(2) + 'pt')

const full = selectionToMargins({ x0p: 0, y0p: 0, x1p: 100, y1p: 100, pageW: A4.w, pageH: A4.h, unit: 'pt' })
check('整页框选（pt 单位）→ 四边 0', full.left === 0 && full.right === 0 && full.top === 0 && full.bottom === 0)

const back = marginsToSelection({ margins: fwd, pageW: A4.w, pageH: A4.h, unit: 'mm' })
console.log('  边距 → 选框 反向映射: ' + JSON.stringify(back))
check('往返一致（改数值→选框动）', near(back.left, 10, 0.3) && near(back.top, 10, 0.3) && near(back.width, 80, 0.6) && near(back.height, 80, 0.6), JSON.stringify(back))

const huge = clampMarginsPt({ top: 500, right: 500, bottom: 500, left: 500 }, A4.w, A4.h, 'mm')
check('手输超大边距 → 夹到合法且保留区 ≥ 10pt', A4.w - huge.l - huge.r >= MIN_CROP_PT - 0.01 && A4.h - huge.t - huge.b >= MIN_CROP_PT - 0.01, JSON.stringify(huge))

check('单位换算 mm↔pt 自洽', ptToUnit(unitToPt(21, 'mm'), 'mm') === 21)

/* ---------- B. 端到端写入 CropBox ---------- */
console.log('\n== B. 端到端：框选结果写进真实 PDF 的 CropBox ==')
const src = await PDFDocument.create()
{
  const font = await src.embedFont('Helvetica')
  for (let i = 0; i < 5; i++) {
    const p = src.addPage([A4.w, A4.h])
    p.drawText('crop target page ' + (i + 1), { x: 40, y: 800, size: 12, font })
  }
}
const srcBytes = await src.save()

function firstContentStream(doc) {
  const c = doc.getPage(0).node.get(PDFName.of('Contents'))
  const parts = []
  const one = (item) => {
    const o = item instanceof PDFRef ? doc.context.lookup(item) : item
    if (o?.contents) parts.push(Buffer.from(o.contents))
  }
  if (c && typeof c.asArray === 'function') c.asArray().forEach(one)
  else if (c) one(c)
  return Buffer.concat(parts).toString('latin1')
}

const m0 = selectionToMargins({ x0p: 10, y0p: 10, x1p: 90, y1p: 90, pageW: A4.w, pageH: A4.h, unit: 'mm' })
{
  const srcDoc = await PDFDocument.load(srcBytes, { ignoreEncryption: true })
  const before = firstContentStream(srcDoc)

  const doc = await PDFDocument.load(srcBytes, { ignoreEncryption: true })
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize()
    const { l, r, t, b } = clampMarginsPt(m0, width, height, 'mm')
    page.setCropBox(l, b, width - l - r, height - t - b)
  }
  const cb = doc.getPage(0).getCropBox()
  console.log('  CropBox = ' + JSON.stringify(cb))
  check('CropBox 左下角 = (10% 页宽, 10% 页高)', near(cb.x, A4.w * 0.1, 0.2) && near(cb.y, A4.h * 0.1, 0.2), cb.x.toFixed(2) + ',' + cb.y.toFixed(2))
  check('CropBox 尺寸 = 80% 页宽 × 80% 页高', near(cb.width, A4.w * 0.8, 0.3) && near(cb.height, A4.h * 0.8, 0.3), cb.width.toFixed(2) + '×' + cb.height.toFixed(2))
  const mb = doc.getPage(0).getMediaBox()
  check('MediaBox 未变（矢量裁剪，不重采样）', near(mb.width, A4.w) && near(mb.height, A4.h), mb.width.toFixed(2) + '×' + mb.height.toFixed(2))
  check('全部 5 页应用同一组边距（批量语义）', doc.getPages().every((p) => near(p.getCropBox().width, A4.w * 0.8, 0.3)))
  check('页面内容流逐字节不变（未栅格化）', before.length > 0 && firstContentStream(doc) === before, before.length + 'B')
  check('产出可被重新解析且页数不变', (await PDFDocument.load(await doc.save(), { ignoreEncryption: true })).getPageCount() === 5)
}

/* ---------- C. 面板接线（静态证据） ---------- */
console.log('\n== C. 面板确实接上了拖拽框选 ==')
{
  const tsx = await readFile(join(HERE, '..', '..', 'src', 'renderer', 'src', 'pages', 'PdfTools.tsx'), 'utf-8')
  const crop = slicePanelSource(tsx, 'CropPanel')
  check('定位到 CropPanel 源码（切片非空）', crop.length > 0, crop.length + ' 字符')
  check('存在 onPointerDown / onPointerMove / onPointerUp 拖拽处理', /onPointerDown/.test(crop) && /onPointerMove/.test(crop) && /onPointerUp/.test(crop))
  check('渲染当前页位图预览（renderPdfPages(bytes, [0])）', /renderPdfPages\(bytes,\s*\[0\]/.test(crop))
  check('保留数值输入做精确微调', /InputNumber/.test(crop) && /边距<\/Text>/.test(crop))
  check('仍走矢量 setCropBox', /setCropBox/.test(crop))
  check('多页语义在 UI 中说明', /应用到全部/.test(crop))
  check('无新增重依赖（复用项目内 pdfRender）', /from '\.\.\/utils\/pdfRender'/.test(tsx))
}

console.log('\n' + '='.repeat(64))
console.log(`结果: ${pass} 项通过, ${fail} 项失败`)
console.log('='.repeat(64))
process.exit(fail ? 1 : 0)
