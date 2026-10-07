/**
 * yan-qa 独立复验 —— 高价值断言 4（裁剪仍矢量）。
 *
 * 独立性：素材自造（3 页不同尺寸/内容），裁剪写入按生产同一条代码路径
 * （PdfTools.tsx:1111 的 page.setCropBox(l, b, w-l-r, h-t-b)）复刻执行；
 * 「未栅格化」用我自己的判定法：
 *   1) MediaBox 逐页不变（数值精确比对）
 *   2) 页面内容流逐字节不变（pdf-lib PDFRawStream.contents 原始（压缩态）字节比对）
 *   3) CropBox 数值落在预期位置（裁剪确实生效，不是没裁）
 *
 * 运行：
 *   NODE_OPTIONS="" node --experimental-loader=./tests/loader.mjs --experimental-strip-types \
 *     tests/pdf-audit/qa/yan-check-crop-vector.mjs
 */
import { PDFDocument, StandardFonts, rgb, PDFArray, PDFRawStream } from 'pdf-lib'
import { selectionToMargins, unitToPt } from '../../../src/renderer/src/utils/pdfCropSelect.ts'

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  → ' + detail : ''}`) }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  → ' + detail : ''}`) }
}
const section = (t) => console.log('\n■ ' + t)

/** 取页面内容流的原始（压缩态）字节；Contents 可能是单个流或流数组 */
function rawContentBytes(page, context) {
  const c = page.node.Contents()
  if (!c) return []
  if (c instanceof PDFArray) {
    return c.asArray().map((ref) => {
      const s = context.lookup(ref)
      return s instanceof PDFRawStream ? Buffer.from(s.contents) : Buffer.from(String(s))
    })
  }
  const s = c
  return [s instanceof PDFRawStream ? Buffer.from(s.contents) : Buffer.from(String(s))]
}

/* ============ A. 自造素材 ============ */
section('A. 自造素材：3 页不同尺寸（A4 横/竖 + Letter），文字 + 矢量图形')

const doc = await PDFDocument.create()
const font = await doc.embedFont(StandardFonts.Helvetica)
const sizes = [[841.89, 595.28], [595.28, 841.89], [612, 792]]
const texts = ['Crop Vector A 4321', 'Crop Vector B 8765', 'Crop Vector C 9111']
for (let i = 0; i < 3; i++) {
  const [w, h] = sizes[i]
  const p = doc.addPage([w, h])
  p.drawText(texts[i], { x: 40, y: h - 80, size: 20, font, color: rgb(0, 0, 0) })
  p.drawRectangle({ x: 40, y: 100, width: w - 80, height: h * 0.3, borderWidth: 2, borderColor: rgb(0.2, 0.4, 0.7) })
  if (i === 1) p.drawCircle({ x: w / 2, y: h / 2, size: 90, borderWidth: 3, borderColor: rgb(0.7, 0.2, 0.1) })
}
const original = new Uint8Array(await doc.save({ useObjectStreams: false }))

/* 裁剪前快照 */
const pre = await PDFDocument.load(original)
const prePages = pre.getPages()
const preMedia = prePages.map((p) => p.node.MediaBox().asArray().map(Number))
const preContent = prePages.map((p) => rawContentBytes(p, pre.context).map((b) => b.toString('binary')))

/* ============ B. 生产同路径写入裁剪 ============ */
section('B. 框选(10%,12%)→(88%,86%) → 生产代码路径写入 CropBox（PdfTools.tsx:1111 同式）')

const sel = { x0p: 10, y0p: 12, x1p: 88, y1p: 86 }
const trimmed = await PDFDocument.load(original)
const pages = trimmed.getPages()
pages.forEach((page, i) => {
  const { width, height } = page.getSize()
  const m = selectionToMargins({ ...sel, pageW: width, pageH: height, unit: 'mm' })
  const l = unitToPt(m.left, 'mm')
  const r = unitToPt(m.right, 'mm')
  const t = unitToPt(m.top, 'mm')
  const b = unitToPt(m.bottom, 'mm')
  // PdfTools.tsx:1111: page.setCropBox(l, b, width - l - r, height - t - b)
  page.setCropBox(l, b, width - l - r, height - t - b)
})
const cropped = new Uint8Array(await trimmed.save({ useObjectStreams: false }))
console.log(`      原始 ${original.byteLength} B → 裁剪后 ${cropped.byteLength} B`)

/* ============ C. 断言：MediaBox 不变 + 内容流逐字节不变 + CropBox 生效 ============ */
section('C. 矢量性断言')

const post = await PDFDocument.load(cropped)
const postPages = post.getPages()
for (let i = 0; i < 3; i++) {
  const postMedia = postPages[i].node.MediaBox().asArray().map(Number)
  check(`第 ${i + 1} 页 MediaBox 逐值不变`, JSON.stringify(postMedia) === JSON.stringify(preMedia[i]),
    `[${preMedia[i].map((v) => +v.toFixed(2))}] → [${postMedia.map((v) => +v.toFixed(2))}]`)
}
const postContent = postPages.map((p) => rawContentBytes(p, post.context).map((b) => b.toString('binary')))
let sameAll = true
for (let i = 0; i < 3; i++) {
  const a = preContent[i].join('|')
  const b = postContent[i].join('|')
  if (a !== b) { sameAll = false; console.log(`      第 ${i + 1} 页内容流不同（len ${a.length} vs ${b.length}）`) }
}
check('3 页内容流（压缩态原始字节）逐字节不变 → 未栅格化、未重采样', sameAll)
check('对照：文件整体字节已变（说明确实重写了文件）', original.byteLength !== cropped.byteLength ||
  !Buffer.compare(Buffer.from(original), Buffer.from(cropped)) === 0, `${original.byteLength} vs ${cropped.byteLength} B`)

for (let i = 0; i < 3; i++) {
  const [w, h] = sizes[i]
  const cb = postPages[i].node.CropBox().asArray().map(Number)
  const inBox = cb[0] >= 0 && cb[1] >= 0 && cb[2] <= w + 0.5 && cb[3] <= h + 0.5
  const shrunk = cb[2] - cb[0] < w - 1 && cb[3] - cb[1] < h - 1
  check(`第 ${i + 1} 页 CropBox 生效（在 MediaBox 内且小于整页）`, inBox && shrunk,
    `[${cb.map((v) => +v.toFixed(2))}] 页尺寸 ${w}x${h}`)
}

console.log('\n' + '='.repeat(70))
console.log(`yan-check-crop-vector 结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
