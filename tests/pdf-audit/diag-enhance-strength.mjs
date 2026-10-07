/**
 * 三档强度非单调的诊断 —— 精确定位「strong 为什么反而最弱」。
 *
 * 已知（QA 报告 + 读码确认）：strong 的 lowPercentile=0.12 / highPercentile=0.88
 * 双双落进纸底平台 → white-black<16 → 命中 autoLevels 的退化保护 → 色阶整段关闭。
 *
 * 待确认的第二层疑问：strong 的 darkRatio 从 medium 的 4.9% 掉到 0.6%，
 * 即「墨迹几乎消失」。是无填充导致，还是白化把文字一起推白了？
 * 这决定修复方案——若白化啃掉了墨迹，那就不只是「不够强」，而是「会删内容」。
 */
import {
  enhanceImageData,
  analyze,
  otsuThreshold,
  autoLevels,
  STRENGTH_PRESETS
} from '../../src/renderer/src/utils/pdfEnhance.ts'

/**
 * 合成「发灰扫描件」。
 * density 控制墨迹覆盖率 —— 这是关键变量：
 * 墨迹占比高时百分位能落进墨迹，纸底占绝对多数（真实扫描件）时就会落进纸底平台。
 */
function makeFadedScan(w, h, paperLuma, inkLuma, noise, inkProb, rowDensity) {
  const data = new Uint8ClampedArray(w * h * 4)
  let seed = 12345
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const rowH = Math.max(1, Math.round(h * rowDensity))
  const gap = Math.max(rowH + 1, Math.round(rowH * 2.2))
  for (let y = 0; y < h; y++) {
    const inTextRow = y % gap < rowH
    for (let x = 0; x < w; x++) {
      const isInk = inTextRow && rnd() < inkProb
      const base = isInk ? inkLuma : paperLuma
      const v = base + (rnd() - 0.5) * 2 * noise
      const i = (y * w + x) * 4
      data[i] = v
      data[i + 1] = v
      data[i + 2] = v
      data[i + 3] = 255
    }
  }
  return data
}

const LAYOUTS = [
  { name: '墨迹密集（占 26%）', inkProb: 0.55, rowDensity: 0.022 },
  { name: '真实扫描件（纸底主导，墨迹 <8%）', inkProb: 0.28, rowDensity: 0.008 },
  { name: '稀疏扫描件（纸底 >88%，触发退化保护）', inkProb: 0.16, rowDensity: 0.006 }
]

const W = 600
const H = 800
const PAPER = 215
const INK = 150

console.log('='.repeat(78))
console.log('三档强度非单调诊断')
console.log('='.repeat(78))
console.log(`画布 ${W}x${H}  纸底 luma=${PAPER}  墨迹 luma=${INK}  噪声±8`)

for (const layout of LAYOUTS) {
  console.log('\n' + '█'.repeat(78))
  console.log('■ ' + layout.name + `  (inkProb=${layout.inkProb} rowDensity=${layout.rowDensity})`)
  console.log('█'.repeat(78))

  const src = makeFadedScan(W, H, PAPER, INK, 8, layout.inkProb, layout.rowDensity)
  const srcStats = analyze(src)
  const srcOtsu = otsuThreshold(src)
  const INK_CUT = PAPER - 30
  let srcInkPx = 0
  let srcPaperPx = 0
  for (let i = 0; i < src.length; i += 4) {
    const y = (src[i] * 299 + src[i + 1] * 587 + src[i + 2] * 114) / 1000
    if (y < INK_CUT) srcInkPx++
    else if (y > srcOtsu) srcPaperPx++
  }
  const paperShare = (srcPaperPx / (W * H)) * 100

  console.log(
    `源图: mean=${srcStats.meanLuma.toFixed(1)} std=${srcStats.stdLuma.toFixed(1)} ` +
      `dark=${(srcStats.darkRatio * 100).toFixed(1)}% light=${(srcStats.lightRatio * 100).toFixed(1)}% ` +
      `haze=${(srcStats.hazeRatio * 100).toFixed(1)}%  Otsu=${srcOtsu}`
  )
  console.log(`纸底占比 = ${paperShare.toFixed(1)}%   墨迹像素 = ${srcInkPx}` +
    `  ${paperShare > 88 ? '← 纸底占绝对多数，这是真实扫描件的典型形态' : ''}`)

  console.log('\n' + '─'.repeat(78))
  console.log('逐档处理')
  console.log('─'.repeat(78))

  const rows = []
  for (const strength of ['light', 'medium', 'strong']) {
    const data = new Uint8ClampedArray(src)
    const preset = STRENGTH_PRESETS[strength]
    const { auto, whitenThreshold } = enhanceImageData(data, W, H, strength)
    const st = analyze(data)

    let whitenedPx = 0
    let inkErased = 0
    for (let i = 0; i < data.length; i += 4) {
      const before = (src[i] * 299 + src[i + 1] * 587 + src[i + 2] * 114) / 1000
      if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) {
        whitenedPx++
        if (before < INK_CUT) inkErased++
      }
    }
    const degenerate = auto.blackPoint === 0 && auto.whitePoint === 1
    rows.push({ strength, st, auto, whitenThreshold, whitenedPx, inkErased, degenerate })

    console.log(`\n【${strength}】blackQ=${preset.blackQ} whiteQ=${preset.whiteQ} ` +
      `gamma=${preset.gamma} sharpen=${preset.sharpen} whiten=${preset.whiten}`)
    console.log(`  色阶: black=${auto.blackPoint.toFixed(4)}(${(auto.blackPoint * 255).toFixed(0)}) ` +
      `white=${auto.whitePoint.toFixed(4)}(${(auto.whitePoint * 255).toFixed(0)})` +
      (degenerate ? '  ⚠ 退化保护命中 → 色阶整段关闭' : ''))
    console.log(`  白化阈值=${whitenThreshold}   （源图 Otsu=${srcOtsu}，墨迹均值≈${INK}；` +
      `阈值低于墨迹亮度就会啃掉文字）`)
    console.log(`  结果: std=${st.stdLuma.toFixed(1)}  dark=${(st.darkRatio * 100).toFixed(2)}%  ` +
      `light=${(st.lightRatio * 100).toFixed(1)}%  haze=${(st.hazeRatio * 100).toFixed(1)}%`)
    console.log(`  被推纯白=${whitenedPx}，其中原本是墨迹的=${inkErased} ` +
      `(${((inkErased / Math.max(1, srcInkPx)) * 100).toFixed(2)}% 墨迹被吃掉)`)
  }

  console.log('\n' + '─'.repeat(78))
  console.log('单调性判定')
  console.log('─'.repeat(78))
  const byName = Object.fromEntries(rows.map((r) => [r.strength, r]))
  const checks = [
    ['对比度 std 递增', (s) => s.st.stdLuma, 'up'],
    ['暗像素占比 递增', (s) => s.st.darkRatio, 'up'],
    ['灰雾占比 递减', (s) => s.st.hazeRatio, 'down'],
    ['墨迹损失 不递增', (s) => s.inkErased / Math.max(1, srcInkPx), 'down']
  ]
  for (const [label, get, dir] of checks) {
    const v = ['light', 'medium', 'strong'].map((k) => get(byName[k]))
    const ok = dir === 'up' ? v[0] <= v[1] && v[1] <= v[2] : v[0] >= v[1] && v[1] >= v[2]
    console.log(
      `  ${ok ? '✅' : '❌'} ${label.padEnd(16)} ` +
        v.map((x, i) => `${['light', 'medium', 'strong'][i]}=${typeof x === 'number' && x < 1 ? x.toFixed(4) : x.toFixed(2)}`).join('  ')
    )
  }
}

console.log('\n' + '─'.repeat(78))
console.log('机理：对全图取百分位，纸底一多就落进纸底平台')
console.log('─'.repeat(78))
const srcRef = makeFadedScan(W, H, PAPER, INK, 8, 0.28, 0.008)
for (const s of ['light', 'medium', 'strong']) {
  const p = STRENGTH_PRESETS[s]
  const lv = autoLevels(srcRef, p.blackQ, p.whiteQ)
  console.log(
    `  纸底主导页 ${s.padEnd(7)} blackQ=${p.blackQ} → black=${(lv.blackPoint * 255).toFixed(0)}   ` +
      `whiteQ=${p.whiteQ} → white=${(lv.whitePoint * 255).toFixed(0)}` +
      (lv.blackPoint === 0 && lv.whitePoint === 1 ? '   ⚠ 退化保护' : '')
  )
}
console.log(`\n参照：纸底 luma=${PAPER}，墨迹 luma=${INK}。`)
console.log('black 若落在 200 附近 → 「百分位」取到的是纸底，不是墨迹，色阶失去意义。')
