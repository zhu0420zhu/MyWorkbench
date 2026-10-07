/**
 * 任务 #6：PDF 文字增强 —— 端到端验证（走【真实】enhancePdf 全流程）。
 *
 * 环境：Node + @napi-rs/canvas（Skia）无头。enhancePdf 编排从 PdfTools.tsx 原样抽取（见
 * qa-gen-tools.mjs），算法层 pdfEnhance.ts 与渲染 pdf.js 均为真实实现；唯一替换的是
 * pdfRender.ts 的 Vite `?worker` 接线（见 qa-render.mjs）。
 *
 * 运行：
 *   NODE_OPTIONS="" "<node>" --experimental-loader=./tests/loader.mjs \
 *     --experimental-strip-types tests/pdf-audit/qa/qa-enhance-e2e.mjs
 */
import './qa-dom-shim.mjs'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { createCanvas, ImageData } from '@napi-rs/canvas'
import { analyze } from '../../../src/renderer/src/utils/pdfEnhance.ts'
import { renderPagePixels, extractText } from './qa-render.mjs'
import { enhancePdf } from './_gen-pdftools.ts'
import { makeVectorScan, makeRasterScan } from './qa-sources.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'qa-work')
const FIX = join(HERE, '..', 'fixtures')
mkdirSync(OUT, { recursive: true })

let pass = 0, fail = 0
const fails = []
const check = (ok, msg) => {
  console.log((ok ? '  [OK] ' : '  [XX] ') + msg)
  ok ? pass++ : (fail++, fails.push(msg))
}
const md5 = (b) => createHash('md5').update(Buffer.from(b)).digest('hex')
const f3 = (n) => (typeof n === 'number' ? n.toFixed(3) : String(n))

/** 扫描件风格源（见 qa-sources.mjs） */
const makeScanSource = () => makeVectorScan(false)

console.log('='.repeat(80))
console.log('任务 #6：文字增强 端到端（真实 enhancePdf 全流程；Node + Skia）')
console.log('='.repeat(80))

const scanSrc = await makeScanSource()
writeFileSync(join(OUT, 'enh-source-scan.pdf'), Buffer.from(scanSrc))
const realSrc = readFileSync(join(FIX, 'enhance-source.pdf'))

// 源页面尺寸 + 元数据
const srcDoc = await PDFDocument.load(scanSrc)
const srcSizes = srcDoc.getPages().map((pg) => pg.getSize())
const srcMeta = {
  title: srcDoc.getTitle(), author: srcDoc.getAuthor(), subject: srcDoc.getSubject(),
  keywords: srcDoc.getKeywords(), producer: srcDoc.getProducer(), creator: srcDoc.getCreator()
}
console.log('\n源文件（QA 自造扫描件风格）元数据：')
console.log('  ' + JSON.stringify(srcMeta))
console.log('  页面尺寸: ' + srcSizes.map((s) => `${s.width}x${s.height}`).join(', '))

const STRENGTHS = ['light', 'medium', 'strong']
const results = {}

for (const strength of STRENGTHS) {
  console.log('\n' + '─'.repeat(80) + `\n■ 强度 = ${strength}（format=png，无损，隔离增强效果）`)
  const { out, stats } = await enhancePdf(scanSrc, strength, 'png')
  writeFileSync(join(OUT, `enh-${strength}.pdf`), Buffer.from(out))
  results[strength] = { out, stats, bytes: out.length }

  // ---- 内部统计（产品自报）----
  const agg = (key) => stats.reduce((s, st) => s + st.after[key], 0) / stats.length
  const before = (key) => stats.reduce((s, st) => s + st.before[key], 0) / stats.length
  console.log(`  产品自报 before→after: std ${f3(before('stdLuma'))}→${f3(agg('stdLuma'))}  ` +
    `haze ${f3(before('hazeRatio'))}→${f3(agg('hazeRatio'))}  light ${f3(before('lightRatio'))}→${f3(agg('lightRatio'))}`)
  console.log(`  色阶: blackPoint=${f3(stats[0].blackPoint)} whitePoint=${f3(stats[0].whitePoint)} whitenThreshold=${stats[0].whitenThreshold}`)
  console.log(`  体积: ${scanSrc.length} → ${out.length} B`)

  // ---- 页面物理尺寸（pdf-lib 读产出）----
  const outDoc = await PDFDocument.load(out)
  const outSizes = outDoc.getPages().map((pg) => pg.getSize())
  let maxDelta = 0
  outSizes.forEach((s, i) => {
    maxDelta = Math.max(maxDelta, Math.abs(s.width - srcSizes[i].width), Math.abs(s.height - srcSizes[i].height))
  })
  check(outSizes.length === srcSizes.length && maxDelta < 1e-6,
    `页面尺寸逐页不变（${outSizes.length} 页，最大偏差 ${maxDelta} pt，容差 1e-6）`)

  // ---- 元数据 ----
  const outMeta = {
    title: outDoc.getTitle(), author: outDoc.getAuthor(), subject: outDoc.getSubject(),
    keywords: outDoc.getKeywords(), producer: outDoc.getProducer(), creator: outDoc.getCreator()
  }
  console.log('  产出元数据: ' + JSON.stringify(outMeta))
  check(outMeta.title === srcMeta.title && outMeta.author === srcMeta.author &&
    outMeta.subject === srcMeta.subject && outMeta.keywords === srcMeta.keywords,
    '元数据 Title/Author/Subject/Keywords 保留')
  check(outMeta.creator === 'LingmoWorkbench',
    `Creator=LingmoWorkbench；Producer 实际=${JSON.stringify(outMeta.producer)}（enhancePdf 里的 setProducer('LingmoWorkbench') 被 pdf-lib.save 覆盖，属实现瑕疵，非数据丢失）`)

  // ---- 独立渲染验证 ----
  const srcPix = await renderPagePixels(scanSrc, 0, 1.0)
  const outPix = await renderPagePixels(out, 0, 1.0)
  let same = 0, nonWhiteOut = 0, nonWhiteSrc = 0, inkOut = 0
  for (let i = 0; i < srcPix.data.length; i += 4) {
    const a = srcPix.data[i], b = outPix.data[i]
    if (a === b && srcPix.data[i + 1] === outPix.data[i + 1] && srcPix.data[i + 2] === outPix.data[i + 2]) same++
    if (b < 240) nonWhiteOut++
    if (a < 240) nonWhiteSrc++
    if (b < 150) inkOut++
  }
  const total = srcPix.data.length / 4
  const dimsOk = srcPix.w === outPix.w && srcPix.h === outPix.h
  const changedPct = 100 * (1 - same / total)
  check(dimsOk, `渲染尺寸一致（源 ${srcPix.w}x${srcPix.h} vs 产出 ${outPix.w}x${outPix.h}）`)
  check(changedPct > 5, `内容确实变了（${f3(changedPct)}% 像素不同）`)
  check(nonWhiteOut / total > 0.02, `非白像素占比合理（产出 ${f3(100 * nonWhiteOut / total)}% <240，其中墨迹<150 占 ${f3(100 * inkOut / total)}%；源 ${f3(100 * nonWhiteSrc / total)}%）`)
  console.log(`  渲染对比: 不同像素 ${f3(changedPct)}%  非白(<240) 源 ${f3(100 * nonWhiteSrc / total)}% → 产出 ${f3(100 * nonWhiteOut / total)}%；产出墨迹(<150) ${f3(100 * inkOut / total)}%`)

  // 落盘对比图
  const srcCanvas = createCanvas(srcPix.w, srcPix.h)
  srcCanvas.getContext('2d').putImageData(new ImageData(srcPix.data, srcPix.w, srcPix.h), 0, 0)
  const outCanvas = createCanvas(outPix.w, outPix.h)
  outCanvas.getContext('2d').putImageData(new ImageData(outPix.data, outPix.w, outPix.h), 0, 0)
  writeFileSync(join(OUT, `enh-src-p1.png`), srcCanvas.encodeSync('png'))
  writeFileSync(join(OUT, `enh-${strength}-p1.png`), outCanvas.encodeSync('png'))
}

/* ---------- 三档单调性：用【同一渲染尺度】重测三份产出，隔离分辨率差异 ---------- */
console.log('\n' + '='.repeat(80))
console.log('三档强度单调性（把三份产出在同一 scale 下渲染 → analyze()，公平对比）')
console.log('='.repeat(80))
const common = {}
for (const strength of STRENGTHS) {
  const pix = await renderPagePixels(results[strength].out, 0, 1.0)
  const st = analyze(pix.data)
  common[strength] = st
}
const rows = [
  ['对比度 stdLuma', 'stdLuma'],
  ['灰雾占比 hazeRatio', 'hazeRatio'],
  ['纸底白化率 lightRatio(>200)', 'lightRatio'],
  ['暗像素占比 darkRatio(<100)', 'darkRatio']
]
console.log('  指标'.padEnd(30) + STRENGTHS.map((s) => s.padStart(12)).join(''))
for (const [label, key] of rows) {
  console.log('  ' + label.padEnd(28) + STRENGTHS.map((s) => f3(common[s][key]).padStart(12)).join(''))
}
const light = common.light, med = common.medium, strong = common.strong
check(med.stdLuma > light.stdLuma && strong.stdLuma > med.stdLuma,
  `对比度单调上升: light(${f3(light.stdLuma)}) < medium(${f3(med.stdLuma)}) < strong(${f3(strong.stdLuma)})`)
check(med.hazeRatio <= light.hazeRatio && strong.hazeRatio <= med.hazeRatio,
  `灰雾单调下降: light(${f3(light.hazeRatio)}) ≥ medium(${f3(med.hazeRatio)}) ≥ strong(${f3(strong.hazeRatio)})`)
check(med.lightRatio >= light.lightRatio && strong.lightRatio >= med.lightRatio,
  `纸底白化单调上升: light(${f3(light.lightRatio)}) ≤ medium(${f3(med.lightRatio)}) ≤ strong(${f3(strong.lightRatio)})`)

/* ---------- 增强代价：文字层是否丢失 ---------- */
console.log('\n' + '='.repeat(80))
console.log('增强代价：文字层是否还能选中/检索（用户可见事实）')
console.log('='.repeat(80))
const srcText = await extractText(scanSrc)
const enhText = await extractText(results.medium.out)
console.log(`  源文本层字符数   : ${srcText.length}`)
console.log(`  增强后文本层字符数: ${enhText.length}`)
console.log(`  源片段: ${JSON.stringify(srcText.slice(0, 60))}`)
console.log(`  增强后片段: ${JSON.stringify(enhText.slice(0, 60))}`)
check(srcText.length > 100 && enhText.length < srcText.length * 0.1,
  `增强后文字层几乎不可提取（${srcText.length} → ${enhText.length}），文字不可选中/检索 —— 如实记录`)

/* ---------- 对真实素材 enhance-source.pdf 也跑一遍 ---------- */
console.log('\n' + '='.repeat(80))
console.log('附：对既有素材 enhance-source.pdf 跑 medium，确认非 QA 专用素材也 OK')
console.log('='.repeat(80))
{
  const realSrcDoc = await PDFDocument.load(realSrc)
  const realSizes = realSrcDoc.getPages().map((pg) => pg.getSize())
  const { out, stats } = await enhancePdf(realSrc, 'medium', 'jpeg')
  writeFileSync(join(OUT, 'enh-real-medium.pdf'), Buffer.from(out))
  const od = await PDFDocument.load(out)
  let md = 0
  od.getPages().forEach((pg, i) => {
    const s = pg.getSize()
    md = Math.max(md, Math.abs(s.width - realSizes[i].width), Math.abs(s.height - realSizes[i].height))
  })
  const outText = await extractText(out)
  const inText = await extractText(realSrc)
  check(od.getPageCount() === realSizes.length && md < 1e-6, `真实素材页尺寸不变（最大偏差 ${md}）`)
  check(outText.length < inText.length * 0.1, `真实素材增强后文本层丢失（${inText.length} → ${outText.length}）`)
  console.log(`  ${stats.length} 页, ${realSrc.length} → ${out.length} B`)
}

console.log('\n' + '='.repeat(80))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
if (fail) console.log('  - ' + fails.join('\n  - '))
console.log('落盘: qa-work/enh-*.pdf, enh-*-p1.png')
console.log('md5(enh-src-p1.png)   = ' + md5(readFileSync(join(OUT, 'enh-src-p1.png'))))
for (const s of STRENGTHS) console.log(`md5(enh-${s}-p1.png) = ` + md5(readFileSync(join(OUT, `enh-${s}-p1.png`))))
console.log('='.repeat(80))
process.exit(fail ? 1 : 0)
