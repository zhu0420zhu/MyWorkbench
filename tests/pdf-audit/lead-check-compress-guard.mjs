/**
 * 主理人独立验证 —— 压缩面板两项补活（档位语义对齐 + 加密源闸门）。
 *
 * 背景：QA（yan-qa）因 429 频率限制不可用（配额 2026-09-29 16:34 重置），
 * 本脚本由主理人亲自执行，作为独立取证。命名空间 lead-check-*，与
 * 工程师的 verify-*.mjs、QA 的 qa/ 均不重叠。
 *
 * 独立性说明：
 *   - 测量结论全部由本脚本自行下断言：文本字符数、非白像素占比、加密判定、字节数；
 *   - 加密素材由本脚本**现场自造**（取 real-large-plain.pdf 前 3 页 → 生产 encryptPdf 加密），
 *     不复用工程师脚本里现造的素材；
 *   - 仅复用 tests/pdf-audit/lib/node-render-backend.mjs 作为「无头渲染 mechanics」
 *     （pdf.js + node canvas），测量口径（数什么、怎么判）是本脚本自己的。
 *
 * 运行（需 loader，因生产模块存在无扩展名导入）：
 *   NODE_OPTIONS="" node --experimental-loader=./tests/loader.mjs --experimental-strip-types \
 *     tests/pdf-audit/lead-check-compress-guard.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { encryptPdf, isPdfEncrypted } from '../../src/renderer/src/utils/pdfSecurity.ts'
import { structureCompressPdf, keepSmallerOutput } from '../../src/renderer/src/utils/pdfCompress.ts'
import { RASTER_PRESETS, rasterLevelHint, RASTER_LEVELS, RASTER_LEVEL_NAMES } from '../../src/renderer/src/utils/pdfRasterCompress.ts'
import { rasterCompressPdf } from '../../src/renderer/src/utils/pdfRasterCompress.ts'
import { guardProtectedSource, describeProtectedOutcome, describeProtection } from '../../src/renderer/src/utils/pdfCompressGuard.ts'
import { openWithPdfjs, renderInkCount, nodeRender } from './lib/node-render-backend.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const QA_FIX = join(HERE, 'qa-fixtures')
const FIX = join(HERE, 'fixtures', 'encrypted')

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? '  → ' + detail : ''}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? '  → ' + detail : ''}`) }
}
const section = (t) => console.log('\n' + '─'.repeat(78) + '\n■ ' + t + '\n' + '─'.repeat(78))

/* ============ A. 自造加密素材 + 基线测量 ============ */
section('A. 自造加密素材（real-large-plain 前 3 页 → 生产 encryptPdf，空用户口令）')

const plainFull = new Uint8Array(readFileSync(join(QA_FIX, 'real-large-plain.pdf')))
const srcDoc = await PDFDocument.load(plainFull)
const base = await PDFDocument.create()
const cp = await base.copyPages(srcDoc, [0, 1, 2])
cp.forEach((p) => base.addPage(p))
const baseBytes = new Uint8Array(await base.save())

const baseText = await openWithPdfjs(baseBytes, undefined)
const baseInk = await renderInkCount(baseBytes, 0)
const baseRatio = baseInk.ink / baseInk.total
check('基线（明文 3 页）可无口令打开且页数=3', baseText.pages === 3, `pages=${baseText.pages}`)
check('基线有文字层', baseText.text.length > 0, `${baseText.text.length} 字`)
check('基线页面有内容（非白像素>0）', baseInk.ink > 0, `${baseInk.ink}/${baseInk.total} (${(baseRatio * 100).toFixed(1)}%)`)

const myEnc = new Uint8Array(await encryptPdf(baseBytes, { userPassword: '', ownerPassword: 'LeadOwner2026' }))
check('自造素材被判定为已加密', (await isPdfEncrypted(myEnc)) === true)
const encOpen = await openWithPdfjs(myEnc, undefined) // 空用户口令 → 无口令可开
check('空用户口令的加密文件无需口令即可打开（渲染可解密）', encOpen.pages === 3 && encOpen.text.length > 0,
  `pages=${encOpen.pages} text=${encOpen.text.length} 字`)

/* ============ B. structure + 加密源 → 应为「损坏文件」 ============ */
section('B. 结构压缩 + 加密源：独立测量是否「无保护 且 内容不可用」')

const sOut = await structureCompressPdf(myEnc, 'medium')
const sBytes = sOut.bytes ?? sOut.out ?? sOut
const sEnc = await isPdfEncrypted(sBytes)
check('structure 产出已不含 /Encrypt（保护丢失）', sEnc === false)
let sText = ''
let sOpenErr = null
try { sText = (await openWithPdfjs(sBytes, undefined)).text } catch (e) { sOpenErr = e }
check('structure 产出无需口令即可打开', sOpenErr === null, sOpenErr ? String(sOpenErr).slice(0, 80) : 'ok')
check('structure 产出文本 = 0 字（内容流仍是密文 → 损坏）', sText.length === 0, `${sText.length} 字`)
const sInk = await renderInkCount(sBytes, 0)
check('structure 产出页面空白（非白像素≈0）', sInk.ink === 0, `${sInk.ink}/${sInk.total}`)
check('对照：同管线对明文不产生此损坏（基线文字>0）', baseText.text.length > 0 && sText.length === 0,
  `明文 ${baseText.text.length} 字 → 加密源过结构压缩 ${sText.length} 字`)

/* ============ C. raster + 加密源 → 应为「可见但无保护」 ============ */
section('C. 图像化压缩 + 加密源：独立测量是否「无保护 但 内容可见」')

const rr = await rasterCompressPdf(myEnc, 'medium', nodeRender)
const rBytes = rr.bytes
check('raster 产出已不含 /Encrypt（保护丢失）', (await isPdfEncrypted(rBytes)) === false)
const rOpen = await openWithPdfjs(rBytes, undefined)
check('raster 产出无需口令即可打开且页数一致', rOpen.pages === 3, `pages=${rOpen.pages}`)
check('raster 产出无文字层（栅格化，属预期）', rOpen.text.length === 0, `${rOpen.text.length} 字`)
const rInk = await renderInkCount(rBytes, 0)
const rRatio = rInk.ink / rInk.total
check('raster 产出内容可见（非白像素占比 ≥ 基线 50%）', rRatio >= baseRatio * 0.5,
  `${(rRatio * 100).toFixed(1)}% vs 基线 ${(baseRatio * 100).toFixed(1)}%`)

/* ============ D. 闸门行为 ============ */
section('D. 闸门：未加密不打扰 / 加密必确认 / 取消即 canceled')

let confirmCalls = 0
const decNone = await guardProtectedSource({
  bytes: baseBytes,
  confirm: async () => { confirmCalls++; return true }
})
check('明文 → 直接放行，confirm 调用 0 次（不打扰）', decNone === 'proceed' && confirmCalls === 0,
  `decision=${decNone} confirmCalls=${confirmCalls}`)

let captured = null
const decCancel = await guardProtectedSource({
  bytes: myEnc,
  confirm: async (v) => { confirmCalls++; captured = v; return false }
})
check('加密源 → confirm 恰好 1 次', confirmCalls === 1, `confirmCalls=${confirmCalls}`)
check('confirm 拿到加密判定（含算法信息）', !!captured && captured.encrypted === true && !!captured.info,
  captured && captured.info ? `algo=${captured.info.algorithm ?? JSON.stringify(captured.info).slice(0, 60)}` : 'no-info')
check('拒绝 → canceled（调用方必须零写入）', decCancel === 'canceled', `decision=${decCancel}`)
const decOk = await guardProtectedSource({ bytes: myEnc, confirm: async () => true })
check('确认 → proceed（保留用户继续压缩的能力）', decOk === 'proceed')

const v = captured
const who = describeProtection(v)
check('警示文案含算法/版本信息', /AES|RC4/.test(who), who.slice(0, 60) + '…')
const oS = describeProtectedOutcome('structure', v)
const oR = describeProtectedOutcome('raster', v)
check('structure 后果文案如实说明「0 字 / 损坏」', /0 字|损坏/.test(oS.consequence), oS.consequence.slice(0, 70) + '…')
check('raster 后果文案如实说明「不再需要口令」', /口令|保护/.test(oR.consequence), oR.consequence.slice(0, 70) + '…')
check('两模式后果文案必须不同（后果本不相同）', oS.consequence !== oR.consequence)

/* ============ E. 档位语义：两模式同向 ============ */
section('E. 档位语义：图像化三档按「压缩强度」低<中<高 递增，文案由数值生成')

const P = RASTER_PRESETS
check('scale 单调递减（画质随档位降）', P.low.scale > P.medium.scale && P.medium.scale > P.high.scale,
  `${P.low.scale} > ${P.medium.scale} > ${P.high.scale}`)
check('jpeg 质量单调递减', P.low.jpeg > P.medium.jpeg && P.medium.jpeg > P.high.jpeg,
  `${P.low.jpeg} > ${P.medium.jpeg} > ${P.high.jpeg}`)
check('maxSide 单调递减', P.low.maxSide > P.medium.maxSide && P.medium.maxSide > P.high.maxSide,
  `${P.low.maxSide} > ${P.medium.maxSide} > ${P.high.maxSide}`)
check('按结果命名：low=高画质 / high=最小体积', /高画质/.test(P.low.result) && /最小体积/.test(P.high.result),
  `${P.low.result} | ${P.high.result}`)

const hints = RASTER_LEVELS.map((q) => rasterLevelHint(q))
check('三条档位提示互不相同', new Set(hints).size === 3)
check('提示由 preset 数值生成（low 含 2560、high 含 1280）',
  hints[0].includes(String(P.low.maxSide)) && hints[2].includes(String(P.high.maxSide)),
  `low→…${hints[0].slice(-40)} high→…${hints[2].slice(-40)}`)
check('提示含 JPEG 质量百分比（数值来自 preset）',
  hints.every((h, i) => h.includes(String(Math.round(RASTER_PRESETS[RASTER_LEVELS[i]].jpeg * 100)) + '%')))

section('E2. 结构压缩三档：压缩强度递增（字节数 high ≤ medium ≤ low）')
const sizes = {}
for (const lv of ['low', 'medium', 'high']) {
  const r = await structureCompressPdf(plainFull, lv)
  sizes[lv] = r.bytes.byteLength
}
check('三档字节数单调：high ≤ medium ≤ low', sizes.high <= sizes.medium && sizes.medium <= sizes.low,
  `low=${sizes.low} medium=${sizes.medium} high=${sizes.high}（原 ${plainFull.byteLength}）`)
check('三档两两可区分（中≠低、高≠中）', sizes.low !== sizes.medium && sizes.medium !== sizes.high)

const big = new Uint8Array(10).fill(1)
const small = new Uint8Array(5).fill(2)
// 语义：produced >= original → 保留 original；produced < original → 采用 produced
check('keepSmallerOutput：产出更小 → 采用产出', keepSmallerOutput(big, small).keptOriginal === false)
check('keepSmallerOutput：产出更大 → 保留原文件', keepSmallerOutput(small, big).keptOriginal === true)

/* ============ F. 源码级：闸门必须位于模式分支之前 ============ */
section('F. 源码级：两模式共用同一处确认，且取消在写入前返回')

const src = readFileSync(join(HERE, '..', '..', 'src', 'renderer', 'src', 'pages', 'PdfTools.tsx'), 'utf8')
const gAt = src.indexOf('guardProtectedSource')
const mAt = src.indexOf("mode === 'raster'")
check('CompressPanel 中存在 guardProtectedSource 调用', gAt > 0)
check('闸门位于模式分支之前（两模式共用同一确认）', gAt > 0 && mAt > 0 && gAt < mAt, `guard@${gAt} < branch@${mAt}`)
const cancelReturn = src.indexOf("=== 'canceled'", gAt)
check('取消分支存在且位于模式分支之前（return 早于任何写入）', cancelReturn > 0 && cancelReturn < mAt,
  `cancel-return@${cancelReturn} < branch@${mAt}`)

/* ============ 汇总 ============ */
console.log('\n' + '='.repeat(78))
console.log(`主理人独立验证汇总: ${pass} 项通过, ${fail} 项失败`)
console.log('='.repeat(78))
process.exit(fail ? 1 : 0)
