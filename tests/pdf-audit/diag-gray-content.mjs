/**
 * 浅灰内容保全探针 —— 激进的纸底白化会不会吃掉浅灰元素？
 *
 * 背景：修完 D1/D2 后，色调映射相当激进（墨迹压 0、纸底提 255，近乎二值化）。
 * 这对「发灰扫描件」正是想要的效果，因为那页上的灰全是脏纸底。
 *
 * 但同一套判据用在【数字原生 PDF】上就危险：浅灰表格线、浅色图例、灰色分隔线
 * 在 luma 上属于「纸底类」，会被白化成不可见 —— 这是内容丢失，
 * 而且与「增强文字」的预期完全不符。
 *
 * 本探针造三种页，各自量「浅灰元素在增强后是否还可见」：
 *   A. 纯扫描件（灰 = 脏纸底，灰被抹掉是对的）
 *   B. 数字原生页 + 浅灰表格线（灰 = 内容，灰被抹掉是错的）
 *   C. 扫描件 + 手写浅灰批注（灰 = 内容，但看起来像纸底 —— 最难的一档）
 */
import {
  enhanceImageData,
  classifyTones
} from '../../src/renderer/src/utils/pdfEnhance.ts'

const W = 600
const H = 800
const lum = (d, i) => (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000

function blank(paper) {
  const d = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < d.length; i += 4) {
    d[i] = d[i + 1] = d[i + 2] = paper
    d[i + 3] = 255
  }
  return d
}
function paint(d, x0, y0, x1, y1, v) {
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4
      d[i] = d[i + 1] = d[i + 2] = v
    }
}
/** 统计指定 luma 区间的像素数 */
function countIn(d, lo, hi) {
  let n = 0
  for (let i = 0; i < d.length; i += 4) {
    const y = lum(d, i)
    if (y >= lo && y <= hi) n++
  }
  return n
}

/* A. 纯扫描件：纸底 215 带噪声，墨迹 150 */
function makeScan() {
  const d = blank(215)
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = 0; i < d.length; i += 4) {
    const v = 215 + (rnd() - 0.5) * 16
    d[i] = d[i + 1] = d[i + 2] = v
  }
  for (let r = 60; r < 700; r += 26) paint(d, 70, r, 530, r + 6, 150)
  return d
}

/* B. 数字原生页：纯白 255 底 + 黑字 + 浅灰表格线(200) */
function makeDigitalWithGrayRules() {
  const d = blank(255)
  for (let r = 60; r < 700; r += 26) paint(d, 70, r, 530, r + 6, 20) // 黑字
  for (let r = 40; r < 760; r += 40) paint(d, 60, r, 540, r + 1, 200) // 浅灰表格线
  for (let c = 60; c < 540; c += 80) paint(d, c, 40, c + 1, 760, 200)
  return d
}

/* C. 扫描件 + 浅灰批注（手写，luma 195） */
function makeScanWithGrayNote() {
  const d = makeScan()
  paint(d, 320, 300, 520, 306, 195)
  paint(d, 320, 330, 500, 336, 195)
  return d
}

const CASES = [
  { name: 'A 纯扫描件（灰=脏纸底，抹掉是对的）', make: makeScan, grayBand: [180, 230], grayIsContent: false },
  { name: 'B 数字原生页 + 浅灰表格线（灰=内容）', make: makeDigitalWithGrayRules, grayBand: [180, 220], grayIsContent: true },
  { name: 'C 扫描件 + 浅灰批注（灰=内容，最难的档）', make: makeScanWithGrayNote, grayBand: [185, 215], grayIsContent: true }
]

console.log('='.repeat(90))
console.log('浅灰内容保全探针')
console.log('='.repeat(90))

for (const c of CASES) {
  const src = c.make()
  const cls = classifyTones(src)
  console.log('\n' + '█'.repeat(90))
  console.log('■ ' + c.name)
  console.log('█'.repeat(90))
  console.log(`  Otsu 分割点=${cls ? cls.split : 'n/a'}`)
  const srcGray = countIn(src, c.grayBand[0], c.grayBand[1])
  console.log(
    `  源图中 luma∈[${c.grayBand[0]},${c.grayBand[1]}] 的像素 = ${srcGray}` +
      (c.grayIsContent ? '   ← 这些是【内容】' : '   ← 这些是【脏纸底】')
  )

  const rows = []
  for (const strength of ['light', 'medium', 'strong']) {
    const d = new Uint8ClampedArray(src)
    enhanceImageData(d, W, H, strength)
    const grayLeft = countIn(d, c.grayBand[0], c.grayBand[1])
    // 「灰内容」是否还可见：看它在输出里是变成了纯白（消失）还是留了下来
    const survived = grayLeft / Math.max(1, srcGray)
    rows.push({ strength, grayLeft, survived })
    const verdict = grayLeft === 0 ? '❌ 全部消失' : survived < 0.3 ? '⚠ 大部分消失' : '✅ 基本保留'
    console.log(
      `    ${strength.padEnd(7)} 输出中该区间像素=${String(grayLeft).padStart(6)}  ` +
        `存活率=${(survived * 100).toFixed(1).padStart(6)}%  ${verdict}`
    )
  }

  const s = rows[2]
  if (c.grayIsContent) {
    console.log(
      s.survived < 0.3
        ? `\n  ⇒ 【结论】strong 档会抹掉浅灰内容（存活率 ${(s.survived * 100).toFixed(1)}%）。\n` +
          `     这不是 bug 本身 —— 对扫描件抹灰正是目的；但对数字原生 PDF 是内容丢失，\n` +
          `     必须在 UI 上如实告知，不能默认用户手上的都是扫描件。`
        : `\n  ⇒ 浅灰内容基本保留（存活率 ${(s.survived * 100).toFixed(1)}%）。`
    )
  } else {
    console.log(`\n  ⇒ 脏纸底被抹掉（存活率 ${(s.survived * 100).toFixed(1)}%），符合预期。`)
  }
}
