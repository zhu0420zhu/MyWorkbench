/**
 * yan-qa 独立复验 —— 高价值断言 1/2/5（压缩 × 加密源 × 闸门文案）。
 *
 * 独立性：素材自造（自绘 2 页含文字+矢量图的 PDF → 生产 encryptPdf 加密），
 * 测量口径自定：文本字符数（pdf.js 全文提取）、非白像素计数、加密判定、
 * 源文件字节级特征搜索（/Encrypt）。
 *
 * 运行：
 *   NODE_OPTIONS="" node --experimental-loader=./tests/loader.mjs --experimental-strip-types \
 *     tests/pdf-audit/qa/yan-check-compress.mjs
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { encryptPdf, isPdfEncrypted } from '../../../src/renderer/src/utils/pdfSecurity.ts'
import { structureCompressPdf } from '../../../src/renderer/src/utils/pdfCompress.ts'
import { rasterCompressPdf } from '../../../src/renderer/src/utils/pdfRasterCompress.ts'
import { guardProtectedSource, describeProtectedOutcome } from '../../../src/renderer/src/utils/pdfCompressGuard.ts'
import { openWithPdfjs, renderInkCount, nodeRender, installCanvasShim } from '../lib/node-render-backend.mjs'

installCanvasShim() // matteWhite 在 raster 管线内依赖 document.createElement('canvas')

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  → ' + detail : ''}`) }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  → ' + detail : ''}`) }
}
const section = (t) => console.log('\n■ ' + t)

/* ============ A. 自造素材（与 lead-check 不同内容、不同页数） ============ */
section('A. 自造素材：2 页，含已知文本 + 矢量矩形，生产 encryptPdf 加密（owner-only 口令）')

const doc = await PDFDocument.create()
const font = await doc.embedFont(StandardFonts.Helvetica)
const p1 = doc.addPage([595, 842])
p1.drawText('Yan QA Independent Check 8642', { x: 50, y: 780, size: 18, font, color: rgb(0, 0, 0) })
p1.drawText('Krypton Voltage 7734 Ocean', { x: 50, y: 740, size: 14, font, color: rgb(0, 0, 0) })
p1.drawRectangle({ x: 50, y: 300, width: 400, height: 200, borderWidth: 3, borderColor: rgb(0.1, 0.2, 0.6) })
const p2 = doc.addPage([595, 842])
p2.drawText('Nebula Ledger 5501 Copper', { x: 50, y: 780, size: 18, font, color: rgb(0, 0, 0) })
p2.drawText('Matrix Sky Audit 20260929', { x: 50, y: 740, size: 14, font, color: rgb(0, 0, 0) })
p2.drawCircle({ x: 300, y: 400, size: 120, borderWidth: 4, borderColor: rgb(0.6, 0.1, 0.2) })
const plain = new Uint8Array(await doc.save())

const baseOpen = await openWithPdfjs(plain, undefined)
const baseInk = await renderInkCount(plain, 0)
const baseRatio = baseInk.ink / baseInk.total
check('明文素材可开、2 页、有文字层', baseOpen.pages === 2 && baseOpen.text.length > 0,
  `pages=${baseOpen.pages} text=${baseOpen.text.length} 字`)
check('明文素材页面有内容', baseInk.ink > 0, `${baseInk.ink}/${baseInk.total} (${(baseRatio * 100).toFixed(2)}%)`)

const enc = new Uint8Array(await encryptPdf(plain, { userPassword: '', ownerPassword: 'YanOwner#2026' }))
check('生产 encryptPdf 产出被判定为已加密', (await isPdfEncrypted(enc)) === true)
check('产出字节含 /Encrypt 字面特征', Buffer.from(enc).includes('/Encrypt'))
const encOpen = await openWithPdfjs(enc, undefined)
check('空用户口令 → 无口令可打开（渲染可解密）', encOpen.pages === 2 && encOpen.text.length > 0,
  `pages=${encOpen.pages} text=${encOpen.text.length} 字`)

/* ============ B. 断言1：结构压缩 + 加密源 = 损坏文件 ============ */
section('B. 断言1：structureCompressPdf(加密源) → 无保护 且 文本 0 字 且 页面全白')

const sOut = await structureCompressPdf(enc, 'medium')
const sBytes = sOut.bytes ?? sOut.out ?? sOut
check('structure 产出无保护（isPdfEncrypted=false）', (await isPdfEncrypted(sBytes)) === false)
check('产出字节不再含 /Encrypt', !Buffer.from(sBytes).includes('/Encrypt'))
let sText = ''
let sErr = null
try { sText = (await openWithPdfjs(sBytes, undefined)).text } catch (e) { sErr = e }
check('产出无需口令即可打开', sErr === null, sErr ? String(sErr).slice(0, 90) : 'ok')
check('文本提取 = 0 字（内容流是密文 → 损坏）', sText.length === 0, `${sText.length} 字`)
const sInk = await renderInkCount(sBytes, 0)
check('第 1 页全白（非白像素 = 0）', sInk.ink === 0, `${sInk.ink}/${sInk.total}`)
const sInk2 = await renderInkCount(sBytes, 1)
check('第 2 页全白（非白像素 = 0）', sInk2.ink === 0, `${sInk2.ink}/${sInk2.total}`)
check('对照：明文同管线文字 >0（损坏只发生在加密源上）', baseOpen.text.length > 0 && sText.length === 0,
  `明文 ${baseOpen.text.length} 字 → 加密源过结构压缩 ${sText.length} 字`)

/* ============ C. 断言2：图像化 + 加密源 = 可见但无保护 ============ */
section('C. 断言2：rasterCompressPdf(加密源) → 无保护 但 内容可见')
/* 素材须使栅格化产物更小于原文件，否则 keepSmallerOutput 兜底回退保留原加密文件。
   自造：4 页各嵌一张高熵 JPEG（确定性伪随机）+ 文本，文件显著变大。 */
const { noiseJpeg } = await import('../lib/node-render-backend.mjs')
const big = await PDFDocument.create()
const bigFont = await big.embedFont(StandardFonts.Helvetica)
for (let i = 0; i < 4; i++) {
  const jpg = noiseJpeg(1200, 1600, 90)
  const img = await big.embedJpg(jpg)
  const page = big.addPage([595, 842])
  page.drawText(`Yan Bulk Page ${i + 1} Sample 9000`, { x: 50, y: 800, size: 16, font: bigFont, color: rgb(0, 0, 0) })
  page.drawImage(img, { x: 0, y: 0, width: 595, height: 780 })
}
const bigPlain = new Uint8Array(await big.save())
const bigEnc = new Uint8Array(await encryptPdf(bigPlain, { userPassword: '', ownerPassword: 'YanOwner#2026' }))
const bigBaseRatio = (await renderInkCount(bigPlain, 0)).ink / (await renderInkCount(bigPlain, 0)).total
check('大素材（4 页含图）加密判定为已加密', (await isPdfEncrypted(bigEnc)) === true,
  `plain ${bigPlain.byteLength} B`)

const rr = await rasterCompressPdf(bigEnc, 'medium', nodeRender)
const rBytes = rr.bytes
console.log(`      raster 产物 ${rBytes.byteLength} B vs 加密源 ${bigEnc.byteLength} B，keptOriginal=${rr.keptOriginal}`)
check('raster 走重建路径（keptOriginal=false，未触发兜底回退）', rr.keptOriginal === false)
check('raster 产出无保护（isPdfEncrypted=false）', (await isPdfEncrypted(rBytes)) === false)
check('产出字节不再含 /Encrypt', !Buffer.from(rBytes).includes('/Encrypt'))
const rOpen = await openWithPdfjs(rBytes, undefined)
check('raster 产出无口令可开、页数一致', rOpen.pages === 4, `pages=${rOpen.pages}`)
const rInk = await renderInkCount(rBytes, 0)
const rRatio = rInk.ink / rInk.total
check('raster 产出内容可见（非白像素占比 ≥ 基线 50%）', rRatio >= bigBaseRatio * 0.5,
  `${(rRatio * 100).toFixed(2)}% vs 基线 ${(bigBaseRatio * 100).toFixed(2)}%`)
check('raster 产出无文字层（栅格化属预期）', rOpen.text.length === 0, `${rOpen.text.length} 字`)

/* C2. 兜底回退场景（小素材产物更大 → 保留原加密文件）：记录行为，不判缺陷 */
section('C2. 补充：兜底回退场景（小素材 raster 产物更大 → 保留原加密文件）')
const rrSmall = await rasterCompressPdf(enc, 'medium', nodeRender)
check('keptOriginal=true（保留原件）', rrSmall.keptOriginal === true)
check('回退产出即原加密文件（仍有 /Encrypt 保护）', (await isPdfEncrypted(rrSmall.bytes)) === true)
check('回退产出文本仍可解密提取（内容未损坏）', (await openWithPdfjs(rrSmall.bytes, undefined)).text.length > 0)

/* ============ D. 断言5：两模式加密后果文案不同，structure 含「0 字」 ============ */
section('D. 断言5：describeProtectedOutcome 两模式文案不同，structure 含「0 字」')

let captured = null
const decision = await guardProtectedSource({
  bytes: enc,
  confirm: async (v) => { captured = v; return true }
})
check('guard 对加密源触发确认并放行', decision === 'proceed' && !!captured && captured.encrypted === true)
const oS = describeProtectedOutcome('structure', captured)
const oR = describeProtectedOutcome('raster', captured)
console.log(`      structure 文案: ${JSON.stringify(oS.consequence)}`)
console.log(`      raster    文案: ${JSON.stringify(oR.consequence)}`)
check('structure 文案含「0 字」', oS.consequence.includes('0 字'))
check('两模式后果文案不同', oS.consequence !== oR.consequence)
check('raster 文案说明口令/保护后果', /口令|保护/.test(oR.consequence))

console.log('\n' + '='.repeat(70))
console.log(`yan-check-compress 结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
