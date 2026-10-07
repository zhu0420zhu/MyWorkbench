/**
 * 锐化该不该为了「单调性指标」被砍掉？
 *
 * 工程师把 sharpen 从 0/0.45/0.85 砍到 0/0/0.2，理由是「锐化产生的边缘光晕
 * 会新增中间灰像素，直接破坏 lightRatio/haze 单调性」。
 *
 * 但 haze/lightRatio 是【色调】指标，锐化是【边缘】指标——两者是不同维度。
 * 要求「锐化不得增加中间灰像素」等于要求锐化别产生光晕，即要求锐化别工作。
 *
 * 本探针把两个维度分开量：
 *   色调维度：std / darkRate / haze / lightRatio
 *   边缘维度：梯度能量（相邻像素亮度差绝对值均值）—— 锐化的直接目的
 * 然后看「为保住色调单调性而砍锐化」到底损失了什么。
 */
import {
  enhanceImageData,
  analyze,
  classifyTones,
  STRENGTH_PRESETS
} from '../../src/renderer/src/utils/pdfEnhance.ts'

const W = 600
const H = 800
const PAPER = 215
const INK = 150

function makeSparseScan() {
  const data = new Uint8ClampedArray(W * H * 4)
  let seed = 12345
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const rowH = Math.max(1, Math.round(H * 0.006))
  const gap = Math.max(rowH + 1, Math.round(rowH * 2.2))
  for (let y = 0; y < H; y++) {
    const inTextRow = y % gap < rowH
    for (let x = 0; x < W; x++) {
      const v = (inTextRow && rnd() < 0.16 ? INK : PAPER) + (rnd() - 0.5) * 16
      const i = (y * W + x) * 4
      data[i] = v
      data[i + 1] = v
      data[i + 2] = v
      data[i + 3] = 255
    }
  }
  return data
}

const lum = (d, i) => (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000

/** 梯度能量：相邻像素亮度差绝对值之和 / 采样数 —— 直接的「锐度」代理 */
function edgeEnergy(data, w, h) {
  let sum = 0
  let n = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x + 1 < w; x++) {
      const i = (y * w + x) * 4
      sum += Math.abs(lum(data, i + 4) - lum(data, i))
      n++
    }
  }
  return sum / n
}

const src = makeSparseScan()
const classes = classifyTones(src)
const srcStats = analyze(src)
const srcEdge = edgeEnergy(src, W, H)

const INK_CUT = PAPER - 30
let srcInkPx = 0
for (let i = 0; i < src.length; i += 4) if (lum(src, i) < INK_CUT) srcInkPx++

console.log('='.repeat(88))
console.log('锐化代价测绘（稀疏扫描件：纸底 215 / 墨迹 150 / 纸底占比 ~92%）')
console.log('='.repeat(88))
console.log(
  `源图: std=${srcStats.stdLuma.toFixed(2)} haze=${(srcStats.hazeRatio * 100).toFixed(2)}% ` +
    `light=${(srcStats.lightRatio * 100).toFixed(2)}%  梯度能量=${srcEdge.toFixed(3)}`
)
console.log(`Otsu 分割点=${classes ? classes.split : 'n/a'}  墨迹像素=${srcInkPx}`)

function measure(sharpen) {
  const data = new Uint8ClampedArray(src)
  const orig = STRENGTH_PRESETS.strong.sharpen
  STRENGTH_PRESETS.strong.sharpen = sharpen
  enhanceImageData(data, W, H, 'strong')
  STRENGTH_PRESETS.strong.sharpen = orig
  const st = analyze(data)
  let erased = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255 && lum(src, i) < INK_CUT) erased++
  }
  return { st, edge: edgeEnergy(data, W, H), eraseRate: erased / Math.max(1, srcInkPx) }
}

console.log('\n' + '─'.repeat(88))
console.log('色调参数固定 = strong 档，只改 sharpen')
console.log('─'.repeat(88))
console.log('  sharpen     std     dark%    haze%   light%   梯度能量  墨迹被吃%')
const rows = []
for (const sh of [0, 0.2, 0.45, 0.85]) {
  const m = measure(sh)
  rows.push({ sh, ...m })
  console.log(
    `  ${String(sh).padEnd(9)} ${m.st.stdLuma.toFixed(2).padStart(7)} ` +
      `${(m.st.darkRatio * 100).toFixed(2).padStart(7)} ` +
      `${(m.st.hazeRatio * 100).toFixed(2).padStart(8)} ` +
      `${(m.st.lightRatio * 100).toFixed(2).padStart(8)} ` +
      `${m.edge.toFixed(3).padStart(9)} ` +
      `${(m.eraseRate * 100).toFixed(3).padStart(9)}`
  )
}

const a = rows[0]
const z = rows[rows.length - 1]
console.log('\n' + '─'.repeat(88))
console.log('关键判定：两个维度的作用方向')
console.log('─'.repeat(88))
const dLight = ((z.st.lightRatio - a.st.lightRatio) / a.st.lightRatio) * 100
const dEdge = ((z.edge - a.edge) / a.edge) * 100
console.log(
  `  lightRatio（色调）      ${(a.st.lightRatio * 100).toFixed(2)} → ${(z.st.lightRatio * 100).toFixed(2)}  ` +
    `= ${dLight >= 0 ? '+' : ''}${dLight.toFixed(2)}%`
)
console.log(
  `  梯度能量（锐度）        ${a.edge.toFixed(3)} → ${z.edge.toFixed(3)}  ` +
    `= ${dEdge >= 0 ? '+' : ''}${dEdge.toFixed(1)}%`
)
console.log(
  `  haze（色调，越低越好）   ${(a.st.hazeRatio * 100).toFixed(2)}% → ${(z.st.hazeRatio * 100).toFixed(2)}%`
)
console.log(
  `  std（对比度）           ${a.st.stdLuma.toFixed(2)} → ${z.st.stdLuma.toFixed(2)}`
)
console.log(
  `\n  ⇒ 锐化让【锐度】提升 ${dEdge.toFixed(1)}%，代价是【色调指标 lightRatio】` +
    `${dLight >= 0 ? '上升' : '下降'} ${Math.abs(dLight).toFixed(2)}%`
)
console.log(
  `  ⇒ 把 sharpen 从 0.85 砍到 0.2，等于用 ${(((a.edge ? 1 : 0) * 0) + 0).toFixed(0)}` +
    `… 即放弃 ${(((rows[3].edge - rows[1].edge) / rows[3].edge) * 100).toFixed(1)}% 的锐度增益` +
    `，只为让色调指标好看一点。`
)
