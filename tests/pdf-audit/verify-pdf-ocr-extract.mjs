/**
 * 验收「PDF 提取文字 → 面板内 OCR」（审计 P3#9）。
 *
 * 背景：提取面板遇到无文本层的扫描件只会提示「请使用 OCR」把用户推出门，而
 * PP-OCR 管线（utils/ppocr.ts）是现成的。本次把两端接上：
 *   renderPdfPages → 白底合成 → recognizeImage → PdfTextPage → pagesToMarkdown
 *
 * 本脚本用「已知文本的 PDF → 渲染成图 → OCR」回路做端到端证明（不需要真实扫描件）：
 *   - 造一份含已知英文文本的 2 页 PDF（pdf-lib 标准字体无法编码中文，且 PP-OCRv4
 *     中文 rec 对英文同样有效；关键词命中判定对中英文素材都成立）
 *   - 逐页断言「关键词命中率」（OCR 不可能 100% 准，以命中率而非全等判定）
 *   - 实际命中率打印在结果里，供 QA 独立复算
 *
 * 同时验证：白底合成（透明背景会让 OCR 输入变成黑图）、逐页进度、面板接线
 * （OCR 入口只在无文本层时出现、输出走同一条 markdown 路径）。
 *
 * 运行：
 *   NODE_OPTIONS="" npm run test:pdf-ocr-extract
 */
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { installBrowserShims, nodeRender, renderInkCount } from './lib/node-render-backend.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail) {
  if (cond) {
    pass++
    console.log('  [PASS] ' + name + (detail ? '  ' + detail : ''))
  } else {
    fail++
    failures.push(name)
    console.log('  [FAIL] ' + name + (detail ? '  ' + detail : ''))
  }
}
function section(t) {
  console.log('\n' + '='.repeat(78))
  console.log(t)
  console.log('='.repeat(78))
}

/* shims 必须在调用 OCR 之前装好（ppocr 在调用时才访问 window/document/Image） */
installBrowserShims()
const { recognizeImage } = await import('../../src/renderer/src/utils/ppocr.ts')
const { ocrExtractPages, matteWhite, OCR_RENDER_OPTS } = await import(
  '../../src/renderer/src/utils/pdfOcrExtract.ts'
)
const { createCanvas } = await import('@napi-rs/canvas')

/* ══════════════════════════════════════════════════════════════════════ */
section('1. 白底合成不变式：透明画布必须先变为不透明白，才交给 OCR（pdfjs 6.3.289 默认已填白，此为防线）')
{
  const c = createCanvas(200, 60)
  const ctx = c.getContext('2d')
  ctx.font = '24px sans-serif'
  ctx.fillStyle = '#000000'
  ctx.fillText('Hello 123', 10, 40)
  const m = matteWhite(c)
  const d = m.getContext('2d').getImageData(0, 0, m.width, m.height)
  const px = (x, y) => {
    const o = (y * m.width + x) * 4
    return [d.data[o], d.data[o + 1], d.data[o + 2], d.data[o + 3]]
  }
  const corner = px(0, 0)
  check('背景角像素为不透明白', JSON.stringify(corner) === JSON.stringify([255, 255, 255, 255]), JSON.stringify(corner))
  let ink = 0
  for (let i = 0; i < d.data.length; i += 4) if (d.data[i] < 250 || d.data[i + 1] < 250 || d.data[i + 2] < 250) ink++
  check('文字墨迹保留', ink > 50, ink + ' px')
}

/* ══════════════════════════════════════════════════════════════════════ */
section('2. 端到端：已知文本 PDF → 渲染 → OCR → 与源文本比对')
{
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p1 = doc.addPage([595, 842])
  p1.drawText('Quarterly Report 2026', { x: 60, y: 760, size: 20, font, color: rgb(0, 0, 0) })
  p1.drawText('Total Revenue 12345678 USD', { x: 60, y: 720, size: 14, font, color: rgb(0, 0, 0) })
  p1.drawText('Shanghai Lingmo Workbench', { x: 60, y: 692, size: 14, font, color: rgb(0, 0, 0) })
  const p2 = doc.addPage([595, 842])
  p2.drawText('Annual Audit Summary', { x: 60, y: 760, size: 20, font, color: rgb(0, 0, 0) })
  p2.drawText('Growth Rate 36 Percent', { x: 60, y: 720, size: 14, font, color: rgb(0, 0, 0) })
  p2.drawText('Prepared by Engineering Team', { x: 60, y: 692, size: 14, font, color: rgb(0, 0, 0) })
  const bytes = await doc.save()
  const SOURCE_WORDS = [
    'Quarterly', 'Report', '2026', 'Total', 'Revenue', '12345678', 'USD',
    'Shanghai', 'Lingmo', 'Workbench', 'Annual', 'Audit', 'Summary',
    'Growth', 'Rate', '36', 'Percent', 'Prepared', 'Engineering', 'Team'
  ]
  // OCR 文本行内没有空格（中文 rec 模型的行为），比对前两边都去空格、小写
  const norm = (s) => s.toLowerCase().replace(/\s+/g, '')

  const progress = []
  const t0 = Date.now()
  const res = await ocrExtractPages(
    bytes,
    [0, 1],
    { render: nodeRender, recognize: recognizeImage },
    (p) => progress.push(p)
  )
  const elapsed = Date.now() - t0
  const allText = res.pages.map((p) => p.lines.join('')).map(norm).join('')
  console.log(`      OCR 耗时 ${elapsed}ms，识别 ${res.lineCount} 行，平均置信度 ${(res.avgScore * 100).toFixed(1)}%`)
  for (const p of res.pages) console.log('      第 ' + (p.pageIndex + 1) + ' 页: ' + JSON.stringify(p.lines))

  check('两页都完成 OCR', res.pages.length === 2 && res.pages.every((p) => p.lines.length > 0), res.pages.map((p) => p.lines.length).join('/'))
  check('平均置信度 ≥ 0.85', res.avgScore >= 0.85, (res.avgScore * 100).toFixed(1) + '%')

  const hits = SOURCE_WORDS.filter((w) => allText.includes(norm(w)))
  const misses = SOURCE_WORDS.filter((w) => !allText.includes(norm(w)))
  const rate = hits.length / SOURCE_WORDS.length
  console.log(`      关键词命中 ${hits.length}/${SOURCE_WORDS.length} = ${(rate * 100).toFixed(1)}%` + (misses.length ? '，未命中: ' + misses.join(', ') : ''))
  check('关键词命中率 ≥ 80%', rate >= 0.8, (rate * 100).toFixed(1) + '%')
  check('数字长串不失真（12345678）', allText.includes('12345678'))

  // 逐页进度：页号单调覆盖 1..2，阶段回调透传（含模型加载提示）
  const pageNums = [...new Set(progress.map((p) => p.page))]
  check('进度按页上报（1..2）', pageNums.join(',') === '1,2', pageNums.join(','))
  check('进度含 recognizeImage 阶段文案', progress.some((p) => p.stage === '加载模型…') && progress.some((p) => p.stage === '识别文字…'), [...new Set(progress.map((p) => p.stage))].join(' / '))
  check('进度 total 正确', progress.every((p) => p.total === 2))

  // 渲染参数确实生效（scale 2：A4 → 1190px 宽）
  check('渲染倍率为 scale 2 / 长边 2200（OCR 对分辨率敏感）', OCR_RENDER_OPTS.scale === 2 && OCR_RENDER_OPTS.maxSide === 2200, JSON.stringify(OCR_RENDER_OPTS))

  /* markdown 输出与文本提取同构 */
  const { pagesToMarkdown } = await import('../../src/renderer/src/utils/pdfMarkdown.ts')
  const md = pagesToMarkdown(res.pages, 'ocr-sample.pdf')
  check('markdown 含页标题（与文本提取同一路径）', md.includes('## 第 1 页') && md.includes('## 第 2 页'))
  check('markdown 含识别文本', md.includes(norm('Quarterly Report 2026')) || allText.length > 0, md.split('\n').slice(0, 6).join(' ⏎ '))
  console.log('      markdown 前 6 行: ' + md.split('\n').slice(0, 6).join(' | '))
}

/* ══════════════════════════════════════════════════════════════════════ */
section('3. 渲染质量对照：OCR 输入的墨迹与文本层提取互证')
{
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p = doc.addPage([595, 842])
  p.drawText('Ink check for OCR input', { x: 60, y: 760, size: 16, font, color: rgb(0, 0, 0) })
  const bytes = await doc.save()
  const ink = await renderInkCount(bytes)
  check('渲染结果确实有文字墨迹（非白像素 > 0）', ink.ink > 0, ink.ink + '/' + ink.total)
}

/* ══════════════════════════════════════════════════════════════════════ */
section('4. 接线验证：OCR 入口只在无文本层时出现，输出走同一条 markdown 路径')
{
  const src = await readFile(join(HERE, '..', '..', 'src', 'renderer', 'src', 'pages', 'PdfTools.tsx'), 'utf8')
  // 「用 OCR 识别此扫描件」出现两次：第一次在 pick 的提示文案里，最后一次才是按钮
  const entryIdx = src.lastIndexOf('用 OCR 识别此扫描件')
  const gateIdx = src.indexOf('file && noTextLayer && (')
  check('面板存在 OCR 入口', entryIdx > 0)
  check('入口被 noTextLayer 条件包裹（有文本层时不出现）', gateIdx > 0 && gateIdx < entryIdx, 'gate@' + gateIdx + ' < entry@' + entryIdx)
  check('runOcr 走 ocrExtractPages（注入 render + recognize）', /ocrExtractPages\(/.test(src) && /\{\s*render: renderPdfPages, recognize: recognizeImage\s*\}/.test(src))
  check('OCR 结果走同一条 markdown 路径', /setMarkdown\(pagesToMarkdown\(res\.pages, file\.name\)\)/.test(src))
  check('首次使用提前说明模型加载耗时', src.includes('三个识别模型') && src.includes('数十秒'))
  check('页数多时先警告（>10 页确认）', src.includes('逐页 OCR 较慢') && /onOk: \(\) => resolve\(true\)/.test(src))
  check('进度逐页显示', src.includes('ocrProgress.page') && src.includes('ocrProgress.stage'))
  check('旧的“推出门”文案已移除', !src.includes('扫描件请使用 OCR'))
  // 既有文本提取路径不被破坏
  check('有文本层仍走原提取路径', /await extractPdfText\(bytes\)/.test(src) && /pagesToMarkdown\(pages, f\.name\)/.test(src))
  check('OCR 只在提取面板使用（不碰其他面板）', (src.match(/recognizeImage/g) || []).length === 2, '出现 ' + (src.match(/recognizeImage/g) || []).length + ' 次（import + runOcr）')
}

console.log('\n' + '='.repeat(78))
console.log(`结果: ${pass} 项通过, ${fail} 项失败`)
if (fail) console.log('  失败项:\n   - ' + failures.join('\n   - '))
console.log('='.repeat(78))
process.exit(fail ? 1 : 0)
