/**
 * 从样本 PDF 抽取文字几何，产出 TextReplacement 候选。
 *
 * 关键问题：pdf.js 的 textContent item.transform 到底是哪套坐标？
 *   本脚本用「页面尺寸 + 首个（最靠上的）文字行的 transform[5]」交叉判定：
 *   若首行 transform[5] 落在页面高度附近（而不是接近 0），说明它是
 *   **未翻转的 PDF 用户坐标**（原点左下、y 向上），可直接当
 *   TextReplacement.baseline 用。
 *   若 pdf.js 已经把 viewport 的翻转矩阵乘进去了，首行的 y 会接近 0。
 *
 * 运行：node tests/pdf-audit/scratch/zh-text-geometry.mjs [pdf]
 * 默认读取 tests/pdf-audit/scratch/out/zh-edit-src.pdf
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const OUT = join(HERE, 'out')
const PDF = process.argv[2] ? process.argv[2] : join(OUT, 'zh-edit-src.pdf')

const PDFJS_ROOT = join(ROOT, 'node_modules', 'pdfjs-dist')
const KW = {
  isEvalSupported: false,
  disableFontFace: true,
  standardFontDataUrl: join(PDFJS_ROOT, 'standard_fonts') + '/',
  cMapUrl: join(PDFJS_ROOT, 'cmaps') + '/',
  cMapPacked: true
}

const bytes = new Uint8Array(await readFile(PDF))
const doc = await pdfjs.getDocument({ data: bytes, ...KW }).promise
console.log('='.repeat(96))
console.log('文件: ' + PDF + '  (' + bytes.length + ' 字节, ' + doc.numPages + ' 页)')
console.log('='.repeat(96))

const pages = []
let imageOps = 0

for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p)
  const view = page.view // [x0, y0, x1, y1]（用户坐标）
  const rot = page.rotate
  const vp = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()

  // 图片 XObject 计数（用操作符表，最直接）
  const ops = await page.getOperatorList()
  let imgs = 0
  for (const fn of ops.fnArray) if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject) imgs++
  imageOps += imgs

  console.log('\n--- 第 ' + p + ' 页 ---')
  console.log(
    'page.view = [' + view.join(', ') + ']  MediaBox 宽高 = ' +
      (view[2] - view[0]) + ' x ' + (view[3] - view[1]) + '  /Rotate = ' + rot +
      '  viewport = ' + Math.round(vp.width) + 'x' + Math.round(vp.height)
  )
  console.log('getViewport({scale:1}).transform = [' + vp.transform.map((v) => Number(v.toFixed(3))).join(', ') + ']')
  console.log('图片绘制操作符 = ' + imgs)
  console.log(
    '  ' + 'str'.padEnd(34) + '| ' + 'x'.padStart(8) + ' | ' + 'baseline'.padStart(9) + ' | ' +
      'width'.padStart(8) + ' | ' + 'height'.padStart(7) + ' | fontSize | font'
  )
  const items = []
  for (const it of content.items) {
    if (!('str' in it)) continue
    const t = it.transform
    const fontSize = Math.abs(t[3]) || Math.abs(t[0])
    const rec = {
      str: it.str,
      transform: t.slice(),
      x: t[4],
      baseline: t[5],
      fontSize,
      width: it.width,
      height: it.height,
      fontName: it.fontName,
      dir: it.dir
    }
    items.push(rec)
    if (!it.str.trim()) continue
    console.log(
      '  ' + JSON.stringify(it.str).slice(0, 32).padEnd(34) + '| ' +
        t[4].toFixed(2).padStart(8) + ' | ' + t[5].toFixed(2).padStart(9) + ' | ' +
        it.width.toFixed(2).padStart(8) + ' | ' + it.height.toFixed(2).padStart(7) + ' | ' +
        fontSize.toFixed(2).padStart(8) + ' | ' + it.fontName
    )
  }
  pages.push({ page: p, view, rotate: rot, viewport: { w: vp.width, h: vp.height }, items })
}

console.log('\n' + '='.repeat(96))
console.log('坐标系判定')
console.log('='.repeat(96))
const p1 = pages[0]
const firstOpaque = p1.items.find((i) => i.str.trim())
const mediaH = p1.view[3] - p1.view[1]
console.log('第1页 MediaBox 高度        : ' + mediaH)
console.log('第1页首个非空文字行        : ' + JSON.stringify(firstOpaque.str))
console.log('其 transform[5]            : ' + firstOpaque.baseline)
console.log('若为「未翻转用户坐标」，首行 y 应接近页高（' + mediaH + ' 附近）；')
console.log('若已被 viewport 翻转，首行 y 应接近 0。实测 = ' + firstOpaque.baseline)
console.log(
  '判定 = ' +
    (firstOpaque.baseline > mediaH * 0.5
      ? '未翻转的 PDF 用户坐标（原点左下，y 向上）→ baseline 可直接用 transform[5]'
      : '疑似已翻转，需要换算')
)

/* ---------- 候选替换 ---------- */
function findLine(pageNo, predicate) {
  const pg = pages.find((x) => x.page === pageNo)
  return pg.items.find(predicate)
}

const asciiItem = findLine(1, (i) => i.str.includes('DRAFT-2026'))
const zhItem = findLine(1, (i) => i.str.includes('本合同自双方签字之日起生效'))

const toRep = (item, pageNo, newText, align = 'left') => ({
  page: pageNo - 1,
  rect: {
    x: Number(item.x.toFixed(3)),
    // 外接框下沿：基线往下退约 22% 字高（近似降部深度）
    y: Number((item.baseline - item.fontSize * 0.22).toFixed(3)),
    width: Number(item.width.toFixed(3)),
    height: Number(item.fontSize.toFixed(3))
  },
  baseline: Number(item.baseline.toFixed(3)),
  fontSize: Number(item.fontSize.toFixed(3)),
  color: { r: 0, g: 0, b: 0 },
  bgColor: { r: 1, g: 1, b: 1 },
  align,
  newText
})

const reps = []
if (asciiItem) reps.push(toRep(asciiItem, 1, 'FINAL-2026-APPROVED'))
if (zhItem) reps.push(toRep(zhItem, 1, '本合同已由双方于 2026 年 9 月 29 日签署并生效。'))

await mkdir(OUT, { recursive: true })
await writeFile(join(OUT, 'zh-text-geometry.json'), JSON.stringify({ file: PDF, pages, reps }, null, 2), 'utf8')
await writeFile(join(OUT, 'candidate-reps.json'), JSON.stringify(reps, null, 2), 'utf8')

console.log('\n' + '='.repeat(96))
console.log('候选替换（candidate-reps.json）')
console.log('='.repeat(96))
console.log(JSON.stringify(reps, null, 2))
console.log('\n全文件图片绘制操作符总数 = ' + imageOps + '（>0 说明样本含位图 XObject）')
console.log('落盘: out/zh-text-geometry.json, out/candidate-reps.json')
console.log('\n注意：color 无从 textContent 取得，按纯黑 {0,0,0} 估计（soffice 正文默认黑）；')
console.log('      bgColor 按白底 {1,1,1} 估计。两者都是估计值，不是从内容流解析出来的。')
