/**
 * 素材工具：把一个（有文本层的）PDF 渲染成图再重建为**纯图像 PDF（无文字层）**。
 *
 * 用途（#14 产出）：QA 在 app 里手动点测「提取文字」面板的 OCR 用户路径——
 *   选这个文件 → 面板提示无文本层 → 出现「用 OCR 识别此扫描件」按钮 →
 *   点击 → 逐页进度 → 出 markdown。
 *
 * 用法：
 *   NODE_OPTIONS="" npm run make:image-only-pdf [输入.pdf] [输出.pdf]
 *   默认：输入 tests/pdf-audit/fixtures/enhance-source.pdf（3 页）
 *         输出 tests/pdf-audit/work/image-only-sample.pdf
 *
 * 产出后自带自检：无文字层（pdf.js 全文提取 0 字）、页面有可见内容（非白像素 > 0）、
 * 未加密。渲染走 node 后端（pdf.js + @napi-rs/canvas，scale 2 + 白底合成），
 * 与面板内 OCR 的渲染参数一致。
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import { nodeRender, openWithPdfjs, renderInkCount, installCanvasShim } from './lib/node-render-backend.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
installCanvasShim()

const { matteWhite } = await import('../../src/renderer/src/utils/pdfOcrExtract.ts')
const { isPdfEncrypted } = await import('../../src/renderer/src/utils/pdfSecurity.ts')

const args = process.argv.slice(2)
const INPUT = resolve(args[0] || join(HERE, 'fixtures', 'enhance-source.pdf'))
const OUTPUT = resolve(args[1] || join(HERE, 'work', 'image-only-sample.pdf'))

const { readFile } = await import('node:fs/promises')
const bytes = await readFile(INPUT)
const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
const n = src.getPageCount()
console.log(`输入: ${INPUT}（${n} 页，${bytes.byteLength} B）`)

// 逐页渲染（scale 2、白底合成，与 OCR 链路同参）→ JPEG → 按原始页面点尺寸重建
const out = await PDFDocument.create()
const toJpeg = (canvas, quality) =>
  new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG 编码失败'))), 'image/jpeg', quality)
  )
for (let i = 0; i < n; i++) {
  const [p] = await nodeRender(bytes, [i], { scale: 2, maxSide: 2200 })
  if (!p) throw new Error(`第 ${i + 1} 页渲染失败`)
  const jpeg = new Uint8Array(await (await toJpeg(matteWhite(p.canvas), 0.85)).arrayBuffer())
  const img = await out.embedJpg(jpeg)
  const size = src.getPage(i).getSize()
  const page = out.addPage([size.width, size.height])
  page.drawImage(img, { x: 0, y: 0, width: size.width, height: size.height })
  console.log(`  第 ${i + 1} 页: ${p.canvas.width}x${p.canvas.height}px → JPEG ${jpeg.byteLength} B`)
}
const produced = await out.save({ useObjectStreams: true })
await mkdir(dirname(OUTPUT), { recursive: true })
await writeFile(OUTPUT, produced)
console.log(`输出: ${OUTPUT}（${produced.byteLength} B）`)

/* ── 自检 ── */
let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  console.log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (detail ? '  ' + detail : ''))
  ok ? pass++ : fail++
}
check('无文字层（pdf.js 全文提取 0 字）', (await openWithPdfjs(produced)).text.length === 0)
check('对照：源文件有文字层', (await openWithPdfjs(bytes)).text.length > 0)
const ink = await renderInkCount(produced)
check('页面有可见内容（非白像素 > 0）', ink.ink > 0, `${ink.ink}/${ink.total}`)
check('未加密（QA 可直接打开）', (await isPdfEncrypted(produced)) === false)

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
console.log('QA 点测路径：提取文字面板 → 选择本文件 → 应提示无文本层并出现 OCR 按钮 → 点击 → 出 markdown')
process.exit(fail ? 1 : 0)
