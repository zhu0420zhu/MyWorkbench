/**
 * yan-qa 独立复验 —— 高价值断言 3（OCR 回路）。
 *
 * 独立性：自造素材（与工程师脚本完全不同的关键词集），独立计算命中率：
 *   已知文本 PDF（2 页）→ ocrExtractPages 渲染成图 → OCR → 规范化后子串包含判定。
 * 关键词 20 个、互不重复、数字与字母混合，命中判定与回归套件同口径
 * （去空格 + 小写后子串包含）。
 *
 * 运行（较慢，属正常）：
 *   NODE_OPTIONS="" node --experimental-loader=./tests/loader.mjs --experimental-strip-types \
 *     tests/pdf-audit/qa/yan-check-ocr.mjs
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { installBrowserShims, nodeRender } from '../lib/node-render-backend.mjs'

installBrowserShims()
const { recognizeImage } = await import('../../../src/renderer/src/utils/ppocr.ts')
const { ocrExtractPages } = await import('../../../src/renderer/src/utils/pdfOcrExtract.ts')
const { pagesToMarkdown } = await import('../../../src/renderer/src/utils/pdfMarkdown.ts')

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  → ' + detail : ''}`) }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  → ' + detail : ''}`) }
}

/* ============ 自造素材：2 页 20 个关键词（与工程师脚本词集不同） ============ */
const doc = await PDFDocument.create()
const font = await doc.embedFont(StandardFonts.Helvetica)
const p1 = doc.addPage([595, 842])
p1.drawText('Echo Harbor 91042', { x: 60, y: 760, size: 20, font, color: rgb(0, 0, 0) })
p1.drawText('Granite Falcon 66881', { x: 60, y: 720, size: 14, font, color: rgb(0, 0, 0) })
p1.drawText('Summit Ledger 20456', { x: 60, y: 692, size: 14, font, color: rgb(0, 0, 0) })
p1.drawText('Copper Beacon 7319', { x: 60, y: 664, size: 14, font, color: rgb(0, 0, 0) })
const p2 = doc.addPage([595, 842])
p2.drawText('Willow Cipher 55730', { x: 60, y: 760, size: 20, font, color: rgb(0, 0, 0) })
p2.drawText('Marble Vector 88214', { x: 60, y: 720, size: 14, font, color: rgb(0, 0, 0) })
p2.drawText('Quant Drift 33107', { x: 60, y: 692, size: 14, font, color: rgb(0, 0, 0) })
p2.drawText('Aurora Signal 44098', { x: 60, y: 664, size: 14, font, color: rgb(0, 0, 0) })
const bytes = new Uint8Array(await doc.save())

const WORDS = [
  'Echo', 'Harbor', '91042', 'Granite', 'Falcon', '66881', 'Summit', 'Ledger',
  '20456', 'Copper', 'Beacon', '7319', 'Willow', 'Cipher', '55730', 'Marble',
  'Vector', '88214', 'Quant', 'Drift'
]
const norm = (s) => s.toLowerCase().replace(/\s+/g, '')

const progress = []
const t0 = Date.now()
const res = await ocrExtractPages(bytes, [0, 1], { render: nodeRender, recognize: recognizeImage }, (p) => progress.push(p))
const elapsed = Date.now() - t0
const allText = res.pages.map((p) => p.lines.join('')).map(norm).join('')
console.log(`      OCR 耗时 ${elapsed}ms，识别 ${res.lineCount} 行，平均置信度 ${(res.avgScore * 100).toFixed(1)}%`)
for (const p of res.pages) console.log('      第 ' + (p.pageIndex + 1) + ' 页: ' + JSON.stringify(p.lines))

const hits = WORDS.filter((w) => allText.includes(norm(w)))
const misses = WORDS.filter((w) => !allText.includes(norm(w)))
const rate = hits.length / WORDS.length
console.log(`      独立复算命中 ${hits.length}/${WORDS.length} = ${(rate * 100).toFixed(1)}%` +
  (misses.length ? '，未命中: ' + misses.join(', ') : ''))

check('两页均完成 OCR 且有行产出', res.pages.length === 2 && res.pages.every((p) => p.lines.length > 0),
  res.pages.map((p) => p.lines.length).join('/'))
check('平均置信度 ≥ 0.85', res.avgScore >= 0.85, (res.avgScore * 100).toFixed(1) + '%')
check('自造素材命中率 ≥ 90%（独立词集）', rate >= 0.9, `${hits.length}/${WORDS.length} = ${(rate * 100).toFixed(1)}%`)
check('进度按页上报 1..2', [...new Set(progress.map((p) => p.page))].join(',') === '1,2')

const md = pagesToMarkdown(res.pages, 'yan-ocr-sample.pdf')
check('markdown 含页标题「## 第 1 页」「## 第 2 页」', md.includes('## 第 1 页') && md.includes('## 第 2 页'))
check('markdown 含识别文本（首个命中词在场）', hits.length > 0 && md.toLowerCase().replace(/\s+/g, '').includes(norm(hits[0])))
console.log('      markdown 前 4 行: ' + md.split('\n').slice(0, 4).join(' | '))

console.log('\n' + '='.repeat(70))
console.log(`yan-check-ocr 结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
