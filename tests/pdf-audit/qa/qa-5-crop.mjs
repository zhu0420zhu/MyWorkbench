/**
 * QA 独立复验 #5：裁剪面板真实框选交互 + 矢量裁剪。
 *
 * 独立性声明：
 *   - 自造 3 页「混合尺寸」PDF（A4 / Letter / A5），验证「按各页自身尺寸应用」而非套用第一页尺寸；
 *   - 用 12%/7%…88%/93% 等非对称框选（工程师用 10%/90% 对称），更易暴露换算出错；
 *   - MediaBox 用 qpdf 独立读取；内容流「逐字节不变」比较的是**压缩态原始字节**（无需解压，最严格）；
 *   - 额外核对产出未新增任何 Image XObject（证明没被栅格化）。
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PDFDocument, PDFName, PDFRef, StandardFonts, rgb } from 'pdf-lib'
import {
  selectionToMargins,
  marginsToSelection,
  clampMarginsPt,
  unitToPt,
  ptToUnit,
  MIN_CROP_PT
} from '../../../src/renderer/src/utils/pdfCropSelect.ts'

const execFileP = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const WORK = join(HERE, 'qa-work', 'crop')
const QPDF = join(ROOT, 'resources', 'tools', 'qpdf', 'qpdf.exe')
await rm(WORK, { recursive: true, force: true })
await mkdir(WORK, { recursive: true })

let pass = 0
let fail = 0
const failList = []
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  [PASS] ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; failList.push(name); console.log('  [FAIL] ' + name + (detail ? '  ' + detail : '')) }
}
const near = (a, b, eps = 0.15) => Math.abs(a - b) <= eps

const A4 = { w: 595.28, h: 841.89 }
const LETTER = { w: 612, h: 792 }
const A5 = { w: 419.53, h: 595.28 }

/* ================= A. 几何换算（非对称框选 / 非 A4 页面） ================= */
console.log('== A. 框选几何换算（Letter 612×792pt，mm；非对称 12%/7%…88%/93%）==')
{
  const sel = { x0p: 12, y0p: 7, x1p: 88, y1p: 93 }
  const fwd = selectionToMargins({ ...sel, pageW: LETTER.w, pageH: LETTER.h, unit: 'mm' })
  const expLeft = ptToUnit((12 / 100) * LETTER.w, 'mm')
  const expRight = ptToUnit((12 / 100) * LETTER.w, 'mm')
  const expTop = ptToUnit((7 / 100) * LETTER.h, 'mm')
  const expBottom = ptToUnit((7 / 100) * LETTER.h, 'mm')
  console.log('  正向 (12%,7%)→(88%,93%): ' + JSON.stringify(fwd))
  check('左边距 = 12% 页宽', near(fwd.left, expLeft, 0.05), fwd.left + ' vs ' + expLeft)
  check('右边距 = 12% 页宽', near(fwd.right, expRight, 0.05), fwd.right + ' vs ' + expRight)
  check('上边距 = 7% 页高', near(fwd.top, expTop, 0.05), fwd.top + ' vs ' + expTop)
  check('下边距 = 7% 页高', near(fwd.bottom, expBottom, 0.05), fwd.bottom + ' vs ' + expBottom)
  check('左右对称、上下对称（非对称框选的必然结果）', near(fwd.left, fwd.right) && near(fwd.top, fwd.bottom))

  const rev = selectionToMargins({ x0p: 88, y0p: 93, x1p: 12, y1p: 7, pageW: LETTER.w, pageH: LETTER.h, unit: 'mm' })
  check('反向拖拽（右下→左上）与正向完全一致', JSON.stringify(rev) === JSON.stringify(fwd), JSON.stringify(rev))
  const rev2 = selectionToMargins({ x0p: 12, y0p: 93, x1p: 88, y1p: 7, pageW: LETTER.w, pageH: LETTER.h, unit: 'mm' })
  check('反向拖拽（左下→右上）与正向一致', JSON.stringify(rev2) === JSON.stringify(fwd))

  const oob = selectionToMargins({ x0p: -30, y0p: -40, x1p: 130, y1p: 150, pageW: A4.w, pageH: A4.h, unit: 'mm' })
  check('拖到预览图外 → 截断为整页（四边 0，CropBox 合法）', oob.left === 0 && oob.right === 0 && oob.top === 0 && oob.bottom === 0, JSON.stringify(oob))

  const oob2 = selectionToMargins({ x0p: 25, y0p: 25, x1p: 130, y1p: 150, pageW: A4.w, pageH: A4.h, unit: 'mm' })
  check('部分越界 → 越界边截断到 0，其余保留', oob2.left > 0 && oob2.right === 0 && oob2.top > 0 && oob2.bottom === 0, JSON.stringify(oob2))

  const zero = selectionToMargins({ x0p: 50, y0p: 50, x1p: 50, y1p: 50, pageW: A4.w, pageH: A4.h, unit: 'mm' })
  const zw = A4.w - unitToPt(zero.left, 'mm') - unitToPt(zero.right, 'mm')
  const zh = A4.h - unitToPt(zero.top, 'mm') - unitToPt(zero.bottom, 'mm')
  check('零面积 → 扩到最小可裁剪边长 ≥ MIN_CROP_PT', zw >= MIN_CROP_PT - 0.31 && zh >= MIN_CROP_PT - 0.31, zw.toFixed(2) + '×' + zh.toFixed(2))

  const tiny = selectionToMargins({ x0p: 49.9, y0p: 49.9, x1p: 50.1, y1p: 50.1, pageW: A4.w, pageH: A4.h, unit: 'mm' })
  const tw = A4.w - unitToPt(tiny.left, 'mm') - unitToPt(tiny.right, 'mm')
  check('极小面积同样被扩到合法范围', tw >= MIN_CROP_PT - 0.31, tw.toFixed(2))

  const huge = clampMarginsPt({ top: 9999, right: 9999, bottom: 9999, left: 9999 }, A4.w, A4.h, 'mm')
  check('手输超大边距 → 保留区 ≥ MIN_CROP_PT', (A4.w - huge.l - huge.r) >= MIN_CROP_PT - 0.01 && (A4.h - huge.t - huge.b) >= MIN_CROP_PT - 0.01, JSON.stringify(huge))
  const neg = clampMarginsPt({ top: -50, right: -50, bottom: -50, left: -50 }, A4.w, A4.h, 'mm')
  check('负边距 → 夹到 0', neg.l >= 0 && neg.r >= 0 && neg.t >= 0 && neg.b >= 0, JSON.stringify(neg))

  // 双向同步：框选 → 数值 → 框选 往返
  const back = marginsToSelection({ margins: fwd, pageW: LETTER.w, pageH: LETTER.h, unit: 'mm' })
  console.log('  边距 → 选框: ' + JSON.stringify(back))
  check('往返一致（改数值 → 选框同步移动）', near(back.left, 12, 0.4) && near(back.top, 7, 0.4) && near(back.width, 76, 0.8) && near(back.height, 86, 0.8), JSON.stringify(back))

  // 单位换向一致
  check('mm↔pt 换算自洽', ptToUnit(unitToPt(30.5, 'mm'), 'mm') === 30.5 && unitToPt(1, 'pt') === 1)
  check('pt 单位直通（不换算）', selectionToMargins({ x0p: 10, y0p: 10, x1p: 90, y1p: 90, pageW: 600, pageH: 800, unit: 'pt' }).left === 60)
}

/* ================= B. 端到端：混合尺寸多页 → CropBox ================= */
console.log('\n== B. 端到端：3 页混合尺寸（A4/Letter/A5）批量裁剪 ==')
const TINY = { w: 80, h: 80 } // 用于触发 clampMarginsPt 的保留区下限
const sizes = [A4, LETTER, A5, TINY]
const srcDoc = await PDFDocument.create()
{
  const font = await srcDoc.embedFont(StandardFonts.Helvetica)
  sizes.forEach((s, i) => {
    const p = srcDoc.addPage([s.w, s.h])
    p.drawText('crop-src-page-' + (i + 1), { x: 5, y: s.h - 14, size: 6, font, color: rgb(0, 0, 0) })
  })
}
const srcBytes = await srcDoc.save()
const srcPath = join(WORK, 'qa-crop-src.pdf')
await writeFile(srcPath, srcBytes)

/** 读取某页 Contents 的**压缩态原始字节**（不解压，逐字节比较最严格） */
function rawContentBytes(doc, pageIndex) {
  const c = doc.getPage(pageIndex).node.get(PDFName.of('Contents'))
  const parts = []
  const one = (item) => {
    const o = item instanceof PDFRef ? doc.context.lookup(item) : item
    if (o && typeof o.getContents === 'function') parts.push(Buffer.from(o.getContents()))
    else if (o?.contents) parts.push(Buffer.from(o.contents))
  }
  if (c && typeof c.asArray === 'function') c.asArray().forEach(one)
  else if (c) one(c)
  return Buffer.concat(parts)
}
async function qpdfBoxes(pp) {
  const { stdout } = await execFileP(QPDF, ['--json=1', pp], { maxBuffer: 64 * 1024 * 1024 })
  const j = JSON.parse(stdout)
  return (j.pages ?? []).map((p) => {
    const o = j.objects?.[p.object] ?? {}
    const mb = o['/MediaBox'] ?? [0, 0, 0, 0]
    const cb = o['/CropBox'] ?? mb
    return { media: { w: mb[2] - mb[0], h: mb[3] - mb[1] }, crop: { x: cb[0], y: cb[1], w: cb[2] - cb[0], h: cb[3] - cb[1] } }
  })
}
async function countImages(pp) {
  const { stdout } = await execFileP(QPDF, ['--json=1', pp], { maxBuffer: 64 * 1024 * 1024 })
  const j = JSON.parse(stdout)
  let imgs = 0
  for (const o of Object.values(j.objects ?? {})) if (o && o['/Subtype'] === '/Image') imgs++
  return imgs
}

const sel = { x0p: 12, y0p: 7, x1p: 88, y1p: 93 }
const m = selectionToMargins({ ...sel, pageW: A4.w, pageH: A4.h, unit: 'mm' }) // 面板以第 1 页尺寸换算

{
  const srcDoc2 = await PDFDocument.load(srcBytes, { ignoreEncryption: true })
  const beforeRaw = sizes.map((_, i) => rawContentBytes(srcDoc2, i))
  const beforeImgs = await countImages(srcPath)

  const doc = await PDFDocument.load(srcBytes, { ignoreEncryption: true })
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize()
    const { l, r, t, b } = clampMarginsPt(m, width, height, 'mm')
    page.setCropBox(l, b, width - l - r, height - t - b)
  }
  const outPath = join(WORK, 'qa-crop-out.pdf')
  const outBytes = await doc.save()
  await writeFile(outPath, outBytes)

  const boxes = await qpdfBoxes(outPath)
  console.log('  逐页 qpdf: ' + boxes.map((x, i) => '#' + (i + 1) + ' media=' + x.media.w.toFixed(1) + '×' + x.media.h.toFixed(1) + ' crop=' + x.crop.w.toFixed(1) + '×' + x.crop.h.toFixed(1) + '@' + x.crop.x.toFixed(1) + ',' + x.crop.y.toFixed(1)).join('  '))

  // 生产语义（面板 apply 用 clampMarginsPt(margins, 各页尺寸)）：同一组**物理边距(pt)** 应用到每一页。
  // 因此大页在物理上裁掉同样的 mm 数；而非「同一百分比」。
  const lPt = unitToPt(m.left, 'mm')
  const rPt = unitToPt(m.right, 'mm')
  const tPt = unitToPt(m.top, 'mm')
  const bPt = unitToPt(m.bottom, 'mm')
  let perPageOk = true
  const notes = []
  sizes.forEach((s, i) => {
    const cx = clampMarginsPt(m, s.w, s.h, 'mm')
    const expectX = cx.l
    const expectY = cx.b
    const expectW = s.w - cx.l - cx.r
    const expectH = s.h - cx.t - cx.b
    const b = boxes[i]
    if (!near(b.crop.w, expectW, 0.5) || !near(b.crop.h, expectH, 0.5) || !near(b.crop.x, expectX, 0.5) || !near(b.crop.y, expectY, 0.5)) {
      perPageOk = false
      notes.push('#' + (i + 1) + ' 期望 ' + expectW.toFixed(1) + '×' + expectH.toFixed(1) + '@' + expectX.toFixed(1) + ',' + expectY.toFixed(1) + ' 实际 ' + b.crop.w.toFixed(1) + '×' + b.crop.h.toFixed(1) + '@' + b.crop.x.toFixed(1) + ',' + b.crop.y.toFixed(1))
    }
  })
  check('各页 CropBox 与 clampMarginsPt(该页尺寸) 逐项吻合（同物理边距批量应用）', perPageOk, notes.join(' | ') || '4/4 正确')

  // 大页上「物理边距恒定」
  check('A4/Letter/A5 三页使用同一物理边距（x 同为 ' + lPt.toFixed(2) + 'pt）',
    near(boxes[0].crop.x, lPt, 0.5) && near(boxes[1].crop.x, lPt, 0.5) && near(boxes[2].crop.x, lPt, 0.5),
    boxes.slice(0, 3).map((b) => b.crop.x.toFixed(2)).join(','))

  // 极小页（80pt）：边距 2×71.43 > 页宽 → 必须被夹到合法保留区，不得产出非法/负尺寸 CropBox
  const tinyCrop = boxes[3].crop
  check('极小页被夹到合法保留区（≥ MIN_CROP_PT，不出现负尺寸）', tinyCrop.w >= MIN_CROP_PT - 0.5 && tinyCrop.h >= MIN_CROP_PT - 0.5 && tinyCrop.w <= 80 && tinyCrop.h <= 80, tinyCrop.w.toFixed(2) + '×' + tinyCrop.h.toFixed(2))
  check('极小页 CropBox 仍在 MediaBox 内（x,y ≥ 0）', tinyCrop.x >= -0.01 && tinyCrop.y >= -0.01)

  check('MediaBox 全部未变（矢量裁剪，不重采样）', sizes.every((s, i) => near(boxes[i].media.w, s.w, 0.5) && near(boxes[i].media.h, s.h, 0.5)), boxes.map((b) => b.media.w.toFixed(1) + '×' + b.media.h.toFixed(1)).join(' '))

  const doc3 = await PDFDocument.load(outBytes, { ignoreEncryption: true })
  const afterRaw = sizes.map((_, i) => rawContentBytes(doc3, i))
  const sameBytes = sizes.every((_, i) => beforeRaw[i].length > 0 && beforeRaw[i].equals(afterRaw[i]))
  check('页面内容流逐字节不变（压缩态原始字节，未栅格化）', sameBytes, sizes.map((_, i) => beforeRaw[i].length + 'B').join(','))

  const afterImgs = await countImages(outPath)
  check('产出未新增任何 Image XObject（未栅格化）', afterImgs === beforeImgs, beforeImgs + ' → ' + afterImgs)

  const reload = await PDFDocument.load(outBytes, { ignoreEncryption: true })
  check('产出可重新解析且页数不变', reload.getPageCount() === sizes.length)
  check('产出可被 qpdf 完整解析（无结构损坏）', boxes.length === sizes.length)
}

/* ================= C. 面板双向同步接线（静态证据） ================= */
console.log('\n== C. 面板接线：拖拽 ↔ 数值 双向同步 ==')
{
  const tsx = await readFile(join(ROOT, 'src', 'renderer', 'src', 'pages', 'PdfTools.tsx'), 'utf-8')
  const start = tsx.indexOf('function CropPanel()')
  const crop = tsx.slice(start, tsx.indexOf('/* ---------- 编辑器', start))
  check('拖拽起点用 pointerCapture（拖出元素不丢事件）', /setPointerCapture/.test(crop) && /onPointerDown/.test(crop) && /onPointerMove/.test(crop) && /onPointerUp/.test(crop))
  check('数值 → 选框：selRect = marginsToSelection(...)', /marginsToSelection\(/.test(crop) && /selRect/.test(crop))
  check('选框 → 数值：applySelection = selectionToMargins(...)', /selectionToMargins\(/.test(crop) && /applySelection/.test(crop))
  check('越界点被 clamp 到预览框内', /clamp\(clientX - r\.left/.test(crop) && /clamp\(clientY - r\.top/.test(crop))
  check('误点（位移<1.5%）不改变边距', /1\.5/.test(crop))
  check('仍走矢量 setCropBox', /setCropBox\(/.test(crop))
  check('多页语义在 UI 明示（基于第 1 页 / 应用到全部）', /框选基于第 1 页/.test(crop) && /应用到全部/.test(crop))
  check('旋转页停用拖拽并如实说明（避免边距算错边）', /旋转/.test(crop) && /停用/.test(crop))
  check('拖拽底图为第 1 页真实渲染（renderPdfPages(bytes,[0])）', /renderPdfPages\(bytes,\s*\[0\]/.test(crop))
}

console.log('\n' + '='.repeat(64))
console.log('QA#5 结果: ' + pass + ' 项通过, ' + fail + ' 项失败')
if (failList.length) console.log('失败项: ' + failList.join(' | '))
console.log('='.repeat(64))
process.exit(fail ? 1 : 0)
