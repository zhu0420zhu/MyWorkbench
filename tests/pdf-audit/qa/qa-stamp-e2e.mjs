/**
 * 任务 #7：水印 / 页眉页脚 / 插入文字 —— 端到端验证（走【真实】applyTextStamp 全流程）。
 *
 * 环境：Node + @napi-rs/canvas（Skia）；pdfText.ts 为真实产品代码，编排从 PdfTools.tsx 原样抽取。
 * 用 pdf.js 把产出渲染成像素图，验证「真的画上去了」，并对占位符/页范围/布局/对齐/透明度/旋转逐项取证。
 *
 * 运行：
 *   NODE_OPTIONS="" "<node>" --experimental-loader=./tests/loader.mjs \
 *     --experimental-strip-types tests/pdf-audit/qa/qa-stamp-e2e.mjs
 */
import './qa-dom-shim.mjs'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { createCanvas, ImageData } from '@napi-rs/canvas'
import { parsePageRanges, expandPlaceholders, pickRenderMode } from '../../../src/renderer/src/utils/pdfText.ts'
import { renderPagePixels, extractTextPages, extractText } from './qa-render.mjs'
import { applyTextStamp } from './_gen-pdftools.ts'

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

/** 3 页纯白 A4 源（水印测量不受原内容干扰） */
async function makeBlank() {
  const doc = await PDFDocument.create()
  for (let p = 0; p < 3; p++) doc.addPage([595, 842])
  return doc.save({ useObjectStreams: false })
}

/** 渲染并统计：非白像素数、包围盒、均值亮度 */
async function stats(data, pageIndex, scale = 1.0) {
  const pix = await renderPagePixels(data, pageIndex, scale)
  const { w, h, data: d } = pix
  let nonWhite = 0, sum = 0
  let minX = w, minY = h, maxX = -1, maxY = -1
  for (let i = 0, px = 0; i < d.length; i += 4, px++) {
    const x = px % w
    const y = (px - x) / w
    const yv = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000
    sum += yv
    if (yv < 240) {
      nonWhite++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  const total = d.length / 4
  return {
    w, h, total, nonWhite, coveragePct: 100 * nonWhite / total, meanLuma: sum / total,
    bbox: { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 },
    data: d
  }
}

const BASE = {
  kind: 'watermark', text: 'CONFIDENTIAL', fontSize: 46,
  color: { r: 0.55, g: 0.55, b: 0.58 }, opacity: 0.18,
  layout: 'center', rotate: 0, align: 'center', margin: 28, range: ''
}

const src = await makeBlank()
writeFileSync(join(OUT, 'stamp-blank.pdf'), Buffer.from(src))
const srcStats = await stats(src, 0)

console.log('='.repeat(84))
console.log('任务 #7：水印 / 页眉页脚 端到端（真实 applyTextStamp；Node + Skia）')
console.log('='.repeat(84))
console.log(`源：3 页纯白 A4；源非白像素 ${srcStats.nonWhite} (${f3(srcStats.coveragePct)}%)`)
console.log('渲染路径：pickRenderMode(CONFIDENTIAL)=' + pickRenderMode('CONFIDENTIAL') +
  '  pickRenderMode(内部资料)=' + pickRenderMode('内部资料'))

/* ============ 1. 英文（矢量） vs 中文（栅格） vs 混排 ============ */
console.log('\n[1] 三项文本 x 两条渲染路径')
const texts = [
  ['纯英文', 'CONFIDENTIAL', 'vector', true],
  ['纯中文', '内部资料 请勿外传', 'raster', false],
  ['中英混排', '机密 Confidential 2026', 'raster', false]
]
for (const [label, text, expectMode, extractable] of texts) {
  const o = { ...BASE, text, fontSize: 40, layout: 'center', opacity: 0.5 }
  const { out } = await applyTextStamp(src, o)
  writeFileSync(join(OUT, `stamp-${expectMode}-${text.slice(0, 4)}.pdf`), Buffer.from(out))
  const st = await stats(out, 0)
  const delta = st.nonWhite - srcStats.nonWhite
  const pagesText = await extractTextPages(out)
  const found = pagesText[0].includes(text)
  console.log(`  ${label.padEnd(6)} text=${JSON.stringify(text)} 路径=${expectMode} 非白增量=+${delta}px (${f3(st.coveragePct)}%) ` +
    `pdf.js 可提取=${found}`)
  check(delta > 500, `${label}：水印区域非白像素显著增加（+${delta}px）`)
  if (extractable) check(found, `${label}：矢量文字可被 pdf.js 提取（可选中/检索）`)
  else check(!found, `${label}：栅格文字【不可】被 pdf.js 提取，但像素上有（如实报告）`)
}

/* ============ 2. 占位符（矢量，E2E 逐页） ============ */
console.log('\n[2] 占位符 {page}/{total}（页脚；大小写不敏感）')
{
  const o = { ...BASE, kind: 'footer', text: 'p{PAGE} of {TOTAL}', fontSize: 12, opacity: 1, align: 'center', margin: 28 }
  const { out } = await applyTextStamp(src, o)
  writeFileSync(join(OUT, 'stamp-footer-page.pdf'), Buffer.from(out))
  const pagesText = await extractTextPages(out)
  pagesText.forEach((t, i) => console.log(`    第 ${i + 1} 页提取: ${JSON.stringify(t.replace(/\s+/g, ' ').trim())}`))
  const ok = pagesText[0].includes('p1 of 3') && pagesText[1].includes('p2 of 3') && pagesText[2].includes('p3 of 3')
  check(ok, '大写 {PAGE}/{TOTAL} 正确展开且逐页递增')
}
{
  const d = new Date(2026, 8, 28, 14, 5)
  const r = [
    ['{page}/{total}', 2, '2/3'],
    ['{date}', 1, '2026-09-28'],
    ['{time}', 1, '14:05'],
    ['未识别 {foo} 原样', 1, '未识别 {foo} 原样']
  ]
  const out = r.map(([tpl, p, exp]) => { const got = expandPlaceholders(tpl, p, 3, d); return [tpl, got, exp] })
  out.forEach(([t, got, exp]) => console.log(`    ${JSON.stringify(t).padEnd(22)} → ${JSON.stringify(got)} ${got === exp ? '✓' : '✗ 期望 ' + exp}`))
  check(out.every(([, got, exp]) => got === exp), 'expandPlaceholders 逐项正确')
}

/* ============ 3. 页范围解析 ============ */
console.log('\n[3] parsePageRanges 语义（total=10）')
{
  const cases = [
    ['1-3,5,8-', [1, 2, 3, 5, 8, 9, 10]],
    ['', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]],
    ['99', []],
    ['abc', []],
    ['3-1', [1, 2, 3]],
    ['5-99', [5, 6, 7, 8, 9, 10]],
    ['2,2,2', [2]],
    ['-3', [1, 2, 3]]
  ]
  let allOk = true
  for (const [input, exp] of cases) {
    const got = parsePageRanges(input, 10)
    const ok = JSON.stringify(got) === JSON.stringify(exp)
    if (!ok) allOk = false
    console.log(`    ${JSON.stringify(input).padEnd(12)} → [${got.join(',')}]  ${ok ? '✓' : '✗ 期望 [' + exp.join(',') + ']'}`)
  }
  check(allOk, '页范围解析（含越界 99 / 非法 abc / 倒序 3-1）语义正确')
}
{
  // E2E：只盖第 1、3 页（矢量文字），验证逐页命中
  const o = { ...BASE, text: 'RANGED', fontSize: 20, opacity: 1, layout: 'center', range: '1,3' }
  const { out, pages } = await applyTextStamp(src, o)
  writeFileSync(join(OUT, 'stamp-range13.pdf'), Buffer.from(out))
  const t = await extractTextPages(out)
  console.log(`    命中页=${JSON.stringify(pages)}  逐页含 RANGED: ${t.map((x) => x.includes('RANGED')).join(',')}`)
  check(JSON.stringify(pages) === '[1,3]' && t[0].includes('RANGED') && !t[1].includes('RANGED') && t[2].includes('RANGED'),
    'range="1,3" 只盖第 1、3 页（逐页取证）')
}

/* ============ 4. 三种水印布局 ============ */
console.log('\n[4] 水印布局 center / diagonal / tile')
{
  const cov = {}
  const bb = {}
  for (const layout of ['center', 'diagonal', 'tile']) {
    const o = { ...BASE, text: 'DRAFT', fontSize: 40, opacity: 0.4, layout, rotate: layout === 'diagonal' ? -30 : 0 }
    const { out } = await applyTextStamp(src, o)
    writeFileSync(join(OUT, `stamp-layout-${layout}.pdf`), Buffer.from(out))
    const st = await stats(out, 0)
    cov[layout] = st.nonWhite
    bb[layout] = st.bbox
    console.log(`    ${layout.padEnd(9)} 非白=${st.nonWhite} (${f3(st.coveragePct)}%)  包围盒=${JSON.stringify(st.bbox)}`)
  }
  check(cov.tile > cov.center * 3, `tile 覆盖显著多于 center（tile=${cov.tile} vs center=${cov.center}）`)
  // diagonal 与 center 同字号，但旋转 -30° 会改变包围盒长宽；据此断言两者几何确实不同
  check(Math.abs(bb.diagonal.width - bb.center.width) > 3 || Math.abs(bb.diagonal.height - bb.center.height) > 3,
    `diagonal 与 center 几何不同（center ${bb.center.width}x${bb.center.height} vs diagonal ${bb.diagonal.width}x${bb.diagonal.height}）`)
}

/* ============ 5. 页眉对齐 + 边距（用包围盒取证） ============ */
console.log('\n[5] 页眉对齐 left / center / right（margin=28，页宽 595）')
{
  const bbox = {}
  for (const align of ['left', 'center', 'right']) {
    const o = { ...BASE, kind: 'header', text: 'HEADER-{page}', fontSize: 14, opacity: 1, align, margin: 28 }
    const { out } = await applyTextStamp(src, o)
    writeFileSync(join(OUT, `stamp-header-${align}.pdf`), Buffer.from(out))
    // 只看页眉带（顶部 60px 内）
    const pix = await renderPagePixels(out, 0, 1.0)
    let minX = 1e9, maxX = -1
    for (let i = 0, px = 0; i < pix.data.length; i += 4, px++) {
      const x = px % pix.w
      const y = (px - x) / pix.w
      if (y > 60) continue
      const yv = (pix.data[i] * 299 + pix.data[i + 1] * 587 + pix.data[i + 2] * 114) / 1000
      if (yv < 240) { if (x < minX) minX = x; if (x > maxX) maxX = x }
    }
    bbox[align] = { minX, maxX, center: (minX + maxX) / 2 }
    console.log(`    ${align.padEnd(6)} 页眉带 x 范围=[${minX},${maxX}] 中心=${f3((minX + maxX) / 2)}`)
  }
  check(bbox.left.minX <= 30 && bbox.left.minX >= 20, `left 对齐左缘≈margin(28)（实测 minX=${bbox.left.minX}）`)
  check(Math.abs(bbox.right.maxX - (595 - 28)) <= 6, `right 对齐右缘≈页宽-margin(567)（实测 maxX=${bbox.right.maxX}）`)
  check(Math.abs(bbox.center.center - 595 / 2) <= 8, `center 居中≈297.5（实测 ${f3(bbox.center.center)}）`)
  check(bbox.left.minX < bbox.center.minX && bbox.center.minX < bbox.right.minX, '三者水平位置单调 left<center<right')
}
{
  // 边距真实生效：margin 10 vs 90（footer）
  const res = []
  for (const margin of [10, 90]) {
    const o = { ...BASE, kind: 'footer', text: 'MARGIN-TEST', fontSize: 14, opacity: 1, align: 'left', margin }
    const { out } = await applyTextStamp(src, o)
    writeFileSync(join(OUT, `stamp-margin-${margin}.pdf`), Buffer.from(out))
    const pix = await renderPagePixels(out, 0, 1.0)
    // footer 在底部：margin=10 → 像素 y≈832；margin=90 → y≈752，取 y>700 覆盖两者
    let minX = 1e9
    for (let i = 0, px = 0; i < pix.data.length; i += 4, px++) {
      const x = px % pix.w
      const y = (px - x) / pix.w
      if (y < 700) continue
      const yv = (pix.data[i] * 299 + pix.data[i + 1] * 587 + pix.data[i + 2] * 114) / 1000
      if (yv < 240 && x < minX) minX = x
    }
    res.push({ margin, minX })
    console.log(`    边距 margin=${margin} → 页脚文字左缘 x=${minX}`)
  }
  check(res[1].minX - res[0].minX >= 70, `margin 10→90 使左缘右移≈80（实测右移 ${res[1].minX - res[0].minX}）`)
}

/* ============ 6. 透明度生效 ============ */
console.log('\n[6] 透明度 opacity 0.1 vs 0.9')
{
  const r = []
  for (const op of [0.1, 0.9]) {
    const o = { ...BASE, text: 'OPACITY', fontSize: 60, opacity: op, layout: 'center' }
    const { out } = await applyTextStamp(src, o)
    writeFileSync(join(OUT, `stamp-opacity-${op}.pdf`), Buffer.from(out))
    const st = await stats(out, 0)
    // 水印区平均亮度：越不透明越暗
    let minLuma = 255
    for (let i = 0; i < st.data.length; i += 4) {
      const yv = (st.data[i] * 299 + st.data[i + 1] * 587 + st.data[i + 2] * 114) / 1000
      if (yv < minLuma) minLuma = yv
    }
    r.push({ op, meanLuma: st.meanLuma, minLuma })
    console.log(`    opacity=${op} → 页面均值亮度=${f3(st.meanLuma)} 最暗像素=${f3(minLuma)}`)
  }
  check(r[0].meanLuma > r[1].meanLuma && r[0].minLuma > r[1].minLuma, '透明度越大越暗（0.9 比 0.1 明显更暗）')
}

/* ============ 7. 旋转生效（包围盒长宽比） ============ */
console.log('\n[7] 旋转 rotate 0° vs 90°（包围盒长宽比）')
{
  const r = []
  for (const rot of [0, 90]) {
    const o = { ...BASE, text: 'ROTATE-TEST', fontSize: 28, opacity: 1, layout: 'center', rotate: rot }
    const { out } = await applyTextStamp(src, o)
    writeFileSync(join(OUT, `stamp-rotate-${rot}.pdf`), Buffer.from(out))
    const st = await stats(out, 0)
    const aspect = st.bbox.width / st.bbox.height
    r.push({ rot, aspect, bbox: st.bbox })
    console.log(`    rotate=${rot}° → 包围盒 ${st.bbox.width}x${st.bbox.height} 长宽比=${f3(aspect)}`)
  }
  check(r[0].aspect > 2 && r[1].aspect < 0.6, `0° 横长(w/h=${f3(r[0].aspect)}) 与 90° 竖长(w/h=${f3(r[1].aspect)}) 方向相反`)
}

/* ============ 7b. 在真实有内容 PDF 上盖章：原内容保留 ============ */
console.log('\n[7b] 真实有内容 PDF（enhance-source.pdf）盖水印：原内容应保留')
{
  const realSrc = readFileSync(join(FIX, 'enhance-source.pdf'))
  const before = await extractTextPages(realSrc)
  const o = { ...BASE, text: 'CONFIDENTIAL', fontSize: 30, opacity: 0.35, layout: 'diagonal', rotate: -25 }
  const { out, pages, modes } = await applyTextStamp(realSrc, o)
  writeFileSync(join(OUT, 'stamp-on-real.pdf'), Buffer.from(out))
  const after = await extractTextPages(out)
  const norm = (s) => s.replace(/\s+/g, '')
  const bodyKept = before.every((t, i) => t.length === 0 || norm(after[i]).includes(norm(t).slice(0, 20)))
  const stampAdded = after.every((t) => t.includes('CONFIDENTIAL'))
  const pageCountOk = after.length === before.length
  console.log(`    页数 ${before.length}→${after.length}  命中页=${JSON.stringify(pages)}  路径=${JSON.stringify(modes)}`)
  console.log(`    第1页原文片段: ${JSON.stringify(before[0].slice(0, 40))}`)
  console.log(`    第1页盖章后  : ${JSON.stringify(after[0].slice(0, 40))}`)
  check(pageCountOk, '页数不变')
  check(stampAdded, '水印文字已在每页可提取（矢量）')
  check(bodyKept, '原有正文内容保留（未被水印覆盖丢失）')
}

/* ============ 8. 落盘对比图 + md5 ============ */
console.log('\n[8] 渲染对比图落盘')
{
  const saved = {}
  for (const name of ['stamp-blank', 'stamp-vector-CONF', 'stamp-raster-内部资料', 'stamp-layout-tile', 'stamp-on-real']) {
    const p = join(OUT, name + '.pdf')
    let bytes
    try { bytes = readFileSync(p) } catch { continue }
    const st = await stats(bytes, 0)
    const c = createCanvas(st.w, st.h)
    c.getContext('2d').putImageData(new ImageData(st.data, st.w, st.h), 0, 0)
    const png = join(OUT, name + '-p1.png')
    writeFileSync(png, c.encodeSync('png'))
    saved[name] = md5(readFileSync(png))
  }
  for (const [k, v] of Object.entries(saved)) console.log(`    md5(${k}-p1.png) = ${v}`)
}

console.log('\n' + '='.repeat(84))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
if (fail) console.log('  - ' + fails.join('\n  - '))
console.log('='.repeat(84))
process.exit(fail ? 1 : 0)
