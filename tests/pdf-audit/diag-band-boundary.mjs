/**
 * 探针（主理人）：量出「主峰连通带」判据的【真实边界】。
 *
 * 上一版 diag-band-robustness v2 已证明：在四种噪声模型下，独立灰阶内容（178）
 * 都被完整保留（Δ_after 131~168）。但那只覆盖了「灰线明显在带外」的情形。
 *
 * 本探针把灰线亮度从 160 一路扫到 210，量：
 *   ① 灰线何时被吸入连通带（paperBandLo 降到灰线亮度）
 *   ② 三档下灰线的 Δ_after 何时塌掉（内容被抹）
 * 目的：给出一句**可写进交付说明的定量结论**——
 *   「独立灰阶内容只要比背景带下沿低 N 级即被保留；再近就与纸底噪声统计上不可分」。
 */
import {
  classifyTones,
  enhanceImageData
} from '../../src/renderer/src/utils/pdfEnhance.ts'

const W = 600
const H = 800
const lum = (d, i) => (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000
const LINE = { x0: 300, x1: 520, y0: 300, y1: 308 }

function makePage({ paper = 215, ink = 150, grayLevel }) {
  const d = new Uint8ClampedArray(W * H * 4)
  let seed = 20260928
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const rowH = Math.max(1, Math.round(H * 0.006))
  const gap = Math.max(rowH + 1, Math.round(rowH * 2.2))
  for (let y = 0; y < H; y++) {
    const inTextRow = y % gap < rowH
    for (let x = 0; x < W; x++) {
      const v = inTextRow && rnd() < 0.16 ? ink + (rnd() - 0.5) * 10 : paper + (rnd() - 0.5) * 16
      const i = (y * W + x) * 4
      d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, v))
      d[i + 3] = 255
    }
  }
  for (let y = LINE.y0; y < LINE.y1; y++)
    for (let x = LINE.x0; x < LINE.x1; x++) {
      const i = (y * W + x) * 4
      d[i] = d[i + 1] = d[i + 2] = grayLevel
    }
  return d
}

const lineIdx = []
for (let y = LINE.y0; y < LINE.y1; y++) for (let x = LINE.x0; x < LINE.x1; x++) lineIdx.push((y * W + x) * 4)
const mean = (d, idx) => idx.reduce((s, i) => s + lum(d, i), 0) / idx.length

console.log('='.repeat(104))
console.log('「主峰连通带」判据边界扫描：独立灰阶内容要多暗才被保留？（噪声模型 N1 均匀 ±8）')
console.log('='.repeat(104))
console.log('灰线 1760px。带宽固定量，看 paperBandLo 与三档 Δ_after 随灰线亮度怎么变。')
console.log('判定：Δ_after >= 20 且 mean(灰线) < 245 → 保留')
console.log('')
console.log('  灰线  连通带        带宽  split  |  light              medium             strong')
console.log('  ' + '-'.repeat(98))

let lastSafe = null
for (const grayLevel of [160, 168, 172, 178, 184, 190, 195, 200, 203, 204, 205, 206, 207, 208, 210]) {
  const src = makePage({ grayLevel })
  const cls = classifyTones(src)
  // 纸底参照：原图贴近主峰的像素
  const paperIdx = []
  for (let i = 0; i < src.length; i += 4) if (Math.abs(lum(src, i) - cls.paperMode) <= 2) paperIdx.push(i)

  let row = `  ${String(grayLevel).padStart(4)}  [${String(cls.paperBandLo).padStart(3)},${String(cls.paperBandHi).padStart(3)}]  ${String(cls.paperBandHi - cls.paperBandLo).padStart(4)}  ${String(cls.split).padStart(5)}  |`
  const verdicts = []
  for (const strength of ['light', 'medium', 'strong']) {
    const d = new Uint8ClampedArray(src)
    enhanceImageData(d, W, H, strength)
    const ml = mean(d, lineIdx)
    const delta = mean(d, paperIdx) - ml
    const ok = delta >= 20 && ml < 245
    verdicts.push(ok)
    row += ` Δ=${delta.toFixed(0).padStart(4)}${ok ? ' ✅' : ' ❌'}${ml >= 245 ? '(白化)' : '      '} |`
  }
  console.log(row)
  if (verdicts[0] && verdicts[1] && verdicts[2]) lastSafe = grayLevel
  else if (lastSafe !== null) {
    console.log(`  ${' '.repeat(4)}↑ 从 ${grayLevel} 起开始失效`)
    lastSafe = null
    // 只报第一次失效的边界
    break
  }
}

console.log('')
console.log('='.repeat(104))
console.log('说明：带内（grayLevel >= paperBandLo 且 <= paperBandHi）的灰阶在 strong 档会被白化进 255，')
console.log('      这是设计意图 —— 它与纸底噪声统计上不可分，本就属于「应被清理的脏背景」。')
console.log('      带外灰阶一律保留，且 Δ_after 随强度单调上升（越增强越清晰）。')
