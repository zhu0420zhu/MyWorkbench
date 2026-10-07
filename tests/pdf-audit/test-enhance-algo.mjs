/**
 * PDF 文字增强算法的无头验证（任务 #9 重写）。
 *
 * 背景：旧实现有三个缺陷，导致「strong 实际比 medium 弱」且「白化啃掉墨迹」：
 *   D1  autoLevels 对【全图】取百分位——纸底占比 >88% 时两个百分位双双落进纸底平台，
 *       触发 white-black<16 的退化保护 → strong 的色阶被整段关闭。
 *   D2  whitenBackground 在【已拉过色阶的图】上重算 Otsu → 直方图空档使阈值塌到墨迹下沿，
 *       把 3.3%~3.5% 的墨迹像素推成纯白（内容丢失）。
 *   D3  gamma 注释与实现相反（实为「压暗中间调」）。
 *
 * 本测试的**强制**断言（对应修复目标）：
 *   1. 单调性：在 ≥4 种版式上，对比度(std)/暗像素占比 随强度【非递减】，
 *      灰雾占比【非递增】，墨迹损失【非递增】。容差 = EPS（构造上单调，EPS≈0）。
 *   2. 内容保全：被推成纯白的像素中，【原本是墨迹】的比例必须 ≤ 0.5%。
 *      判定用【合成时记录的真值墨迹掩膜】，与算法无关 → 独立判据。
 *   3. 纸底主导页不得关闭色阶：可分类（classifyTones 非 null）时，黑场>0 且 白场<1。
 *   4. 阈值落在正确的分布里：黑场*255 ≤ Otsu 分割点 ≤ 白场*255，且白化阈值(paperFloor) > 分割点。
 *
 * 任务 #10 追加的两条 §1 契约（同样常驻）：
 *   契约 a【独立灰阶内容必须保留】——数字原生页上的浅灰表格线（与背景主峰之间有直方图空档）
 *          属独立灰阶，白化不得触碰：三档存活率 ≥ 95%（真值灰掩膜判定，见 §11）。
 *   契约 b【脏纸底仍必须被清理】——修复不能以"少白化"换内容保全：发灰扫描件在
 *          medium/strong 下灰雾必须接近 0（见 §12）；否则等于白化失效。
 *   两条互相拉扯，必须同时成立——这是白化下界算法的核心约束。
 *
 * 任务 #11 追加（§13/§14）：契约 a 的【宽连通带】覆盖。§11 只用「纯白底、带宽 0」的极端用例，
 *   而独立灰阶唯一可能被吞的条件是【宽带】——噪声拖尾/照明不均把纸底主峰连通带撑宽。
 *   故用四种噪声模型（N1 均匀/N2 高斯拖尾/N3 灰尘散点/N4 照明不均）分别验证：
 *   灰线确在带外、增强后 Δ_after = mean(纸底) − mean(灰线) ≥ 20 且 mean(灰线) < 245。
 *   §14 再把灰线压到贴近带下沿（paperBandLo − 4）确认边界仍保留。
 *
 * 断言标注：
 *   [独立] 判据锚定在「合成真值 / 解析期望」上，不依赖被测代码自身的度量。
 *   [自洽] 判据用被测模块自己的 analyze()/classifyTones() 度量——仅作自洽性回归，
 *          不能单独证明视觉正确（正是旧测试的非判别性所在，故显式标注）。
 */
import {
  enhanceImageData,
  analyze,
  autoLevels,
  otsuThreshold,
  classifyTones,
  applySharpen,
  applyLevels,
  STRENGTH_PRESETS
} from '../../src/renderer/src/utils/pdfEnhance.ts'

let pass = 0
let fail = 0
function check(label, cond, detail = '', tag = '') {
  const t = tag ? ` [${tag}]` : ''
  if (cond) {
    pass++
    console.log('  ✅ ' + label + t + (detail ? '  → ' + detail : ''))
  } else {
    fail++
    console.log('  ❌ ' + label + t + (detail ? '  → ' + detail : ''))
  }
}

/** 单调性容差：构造上严格单调，仅留一个远小于量化步长的浮点容差 */
const EPS = 1e-9
const nonDec = (v) => v[0] <= v[1] + EPS && v[1] <= v[2] + EPS
const nonInc = (v) => v[0] >= v[1] - EPS && v[1] >= v[2] - EPS

/**
 * 合成「发灰扫描件」并**同时返回真值墨迹掩膜**。
 * inkProb/rowDensity 控制墨迹覆盖率——这是关键变量：
 * 墨迹占比高时百分位能落进墨迹；纸底占绝对多数（真实扫描件）时旧实现会落进纸底平台。
 */
function makeScan(w, h, { paperLuma = 215, inkLuma = 150, noise = 8, inkProb = 0.28, rowDensity = 0.008 } = {}) {
  const data = new Uint8ClampedArray(w * h * 4)
  const inkMask = new Uint8Array(w * h)
  let seed = 12345
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const rowH = Math.max(1, Math.round(h * rowDensity))
  const gap = Math.max(rowH + 1, Math.round(rowH * 2.2))
  for (let y = 0; y < h; y++) {
    const inTextRow = y % gap < rowH
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const isInk = inTextRow && rnd() < inkProb
      const base = isInk ? inkLuma : paperLuma
      const v = base + (rnd() - 0.5) * 2 * noise
      const i = p * 4
      data[i] = v
      data[i + 1] = v
      data[i + 2] = v
      data[i + 3] = 255
      inkMask[p] = isInk ? 1 : 0
    }
  }
  return { data, inkMask }
}

/** 墨迹保全：真值掩膜里的像素有多少被推成纯白（≥255 三通道） */
function inkErased(data, inkMask) {
  let ink = 0
  let erased = 0
  for (let p = 0; p < inkMask.length; p++) {
    if (!inkMask[p]) continue
    ink++
    const i = p * 4
    if (data[i] >= 255 && data[i + 1] >= 255 && data[i + 2] >= 255) erased++
  }
  return { ink, erased, pct: ink ? erased / ink : 0 }
}

/**
 * 构造「数字原生页」：纯白底 255 + 黑字 + 【浅灰表格线】。
 *
 * 与 makeScan（发灰扫描件）相对照：这里的浅灰线是【独立灰阶内容】——
 * 在 luma 上虽落入纸底类，但与背景主峰之间有【直方图空档】。
 * 白化只应作用于与主峰连成一片的背景，绝不能把这条独立灰阶一起提纯。
 * 返回真值 grayMask（最终 luma 恰为 grayLuma 的像素），供内容保全断言独立判定。
 */
function makeDigitalWithGrayRules(
  w,
  h,
  { paperLuma = 255, inkLuma = 20, grayLuma = 200, rowStep = 26, ruleStep = 40, colStep = 80 } = {}
) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = paperLuma
    data[i + 3] = 255
  }
  const paint = (x0, y0, x1, y1, v) => {
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
        const i = (y * w + x) * 4
        data[i] = data[i + 1] = data[i + 2] = v
      }
  }
  for (let r = 60; r < h - 100; r += rowStep) paint(70, r, w - 70, r + 6, inkLuma) // 黑字
  for (let r = 40; r < h - 40; r += ruleStep) paint(60, r, w - 60, r + 1, grayLuma) // 浅灰横线
  for (let c = 60; c < w - 60; c += colStep) paint(c, 40, c + 1, h - 40, grayLuma) // 浅灰竖线
  // 真值 grayMask：最终 luma 恰为 grayLuma 的像素（paint 无混合，值精确）
  const grayMask = new Uint8Array(w * h)
  for (let p = 0; p < w * h; p++) {
    grayMask[p] = data[p * 4] === grayLuma ? 1 : 0
  }
  return { data, grayMask }
}

/** Rec.601 亮度（与 pdfEnhance 内部一致；测试侧独立实现，避免依赖被测代码） */
const lumaOf = (d, i) => (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000

/** 独立灰阶内容线在页面的位置（与 diag-band-robustness.mjs 一致：220×8 = 1760 px） */
const GRAY_LINE = { x0: 300, x1: 520, y0: 300, y1: 308 }

/**
 * 造「发灰扫描件 + 一条独立灰阶内容线」，噪声模型可选。
 *
 * 与 makeScan 的区别：makeScan 只造「纸底 + 墨迹」两电平、无独立灰阶；
 * 本 helper 专门用于压测「主峰连通带」判据在真实噪声下的稳健性——
 * 噪声越强（N2 高斯拖尾、N4 照明不均），背景连通带越宽，越可能把带外独立灰阶误吞。
 *
 * ⚠ 四种噪声模型：
 *   N1 均匀 ±8（理想扫描件） / N2 高斯 σ=10（有拖尾） /
 *   N3 均匀 + 1.5% 灰尘散点（真实扫描件常见） / N4 照明不均（纸底 195..245 连续渐变）
 * 参考实现见 tests/pdf-audit/diag-band-robustness.mjs v2（该脚本显式传 model id）。
 */
function makeNoisyScan(model, { paper = 215, ink = 150, grayLevel = 178 } = {}) {
  const data = new Uint8ClampedArray(W * H * 4)
  let seed = 20260928
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const gauss = () => {
    const u = Math.max(1e-9, rnd())
    const v = rnd()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
  const rowH = Math.max(1, Math.round(H * 0.006))
  const gap = Math.max(rowH + 1, Math.round(rowH * 2.2))
  for (let y = 0; y < H; y++) {
    const inTextRow = y % gap < rowH
    for (let x = 0; x < W; x++) {
      let v
      if (inTextRow && rnd() < 0.16) {
        v = ink + (rnd() - 0.5) * 10
      } else {
        switch (model) {
          case 'N1':
            v = paper + (rnd() - 0.5) * 16
            break
          case 'N2':
            v = paper + gauss() * 10
            break
          case 'N3':
            v = rnd() < 0.015 ? 150 + rnd() * 60 : paper + (rnd() - 0.5) * 16
            break
          case 'N4':
            v = 195 + ((x / W) * 0.6 + (y / H) * 0.4) * 50 + (rnd() - 0.5) * 6
            break
          default:
            throw new Error(`未知噪声模型: ${model}`)
        }
      }
      const i = (y * W + x) * 4
      data[i] = data[i + 1] = data[i + 2] = Math.max(0, Math.min(255, v))
      data[i + 3] = 255
    }
  }
  // 埋一条独立灰阶内容线（与脏纸底/背景峰之间的连通性取决于噪声强度）
  for (let y = GRAY_LINE.y0; y < GRAY_LINE.y1; y++)
    for (let x = GRAY_LINE.x0; x < GRAY_LINE.x1; x++) {
      const i = (y * W + x) * 4
      data[i] = data[i + 1] = data[i + 2] = grayLevel
    }
  return data
}

/** 收集「灰线像素索引」与「纸底参照像素索引」（纸底按原图亮度贴近主峰 ±2 判定） */
function bandIndexSets(src, paperMode) {
  const line = []
  const paperIdx = []
  for (let y = GRAY_LINE.y0; y < GRAY_LINE.y1; y++)
    for (let x = GRAY_LINE.x0; x < GRAY_LINE.x1; x++) line.push(((y * W + x) * 4))
  for (let i = 0; i < src.length; i += 4) {
    if (Math.abs(lumaOf(src, i) - paperMode) <= 2) paperIdx.push(i)
  }
  return { line, paperIdx }
}

/** 对一组像素索引求平均亮度 */
const meanLumaOf = (d, idx) => (idx.length ? idx.reduce((s, i) => s + lumaOf(d, i), 0) / idx.length : NaN)

/** 接近纯白（≥250）占比 */
function nearWhite(data) {
  let c = 0
  for (let i = 0; i < data.length; i += 4) if (data[i] >= 250) c++
  return c / (data.length / 4)
}

const W = 600
const H = 800
const PAPER = 215
const INK = 150

const LAYOUTS = [
  { name: '墨迹密集（占约 25%）', opts: { inkProb: 0.55, rowDensity: 0.022 } },
  { name: '中等墨迹（占约 19%）', opts: { inkProb: 0.42, rowDensity: 0.016 } },
  { name: '真实扫描件（纸底主导）', opts: { inkProb: 0.28, rowDensity: 0.008 } },
  { name: '稀疏扫描件（纸底 >88%）', opts: { inkProb: 0.16, rowDensity: 0.006 } },
  { name: '真实扫描件（高噪点 ±25）', opts: { inkProb: 0.28, rowDensity: 0.008, noise: 25 } }
]
const STRENGTHS = ['light', 'medium', 'strong']

console.log('='.repeat(80))
console.log('PDF 文字增强算法验证（pdfEnhance.ts）— 单调性 / 内容保全 / 阈值分布')
console.log('='.repeat(80))
console.log(`画布 ${W}x${H}  纸底 luma=${PAPER}  墨迹 luma=${INK}  单调性容差 EPS=${EPS}`)

/* ==================== 逐版式 × 逐档 度量 ==================== */
const allMetrics = {}

for (const layout of LAYOUTS) {
  console.log('\n' + '█'.repeat(80))
  console.log('■ ' + layout.name + `  (${JSON.stringify(layout.opts)})`)
  console.log('█'.repeat(80))

  const { data: src, inkMask } = makeScan(W, H, layout.opts)
  const srcStats = analyze(src)
  const srcOtsu = otsuThreshold(src)
  const classes = classifyTones(src)
  let inkTotal = 0
  for (let p = 0; p < inkMask.length; p++) inkTotal += inkMask[p]
  const paperShare = 1 - inkTotal / (W * H)

  console.log(
    `  源图: mean=${srcStats.meanLuma.toFixed(1)} std=${srcStats.stdLuma.toFixed(1)} ` +
      `dark=${(srcStats.darkRatio * 100).toFixed(1)}% light=${(srcStats.lightRatio * 100).toFixed(1)}% ` +
      `haze=${(srcStats.hazeRatio * 100).toFixed(1)}%  Otsu=${srcOtsu}`
  )
  console.log(
    `  真值墨迹 ${inkTotal} px（${((inkTotal / (W * H)) * 100).toFixed(1)}%），纸底 ${(paperShare * 100).toFixed(1)}%` +
      `  分类=${classes ? 'split=' + classes.split : 'null（不可分）'}` +
      (paperShare > 0.85 ? '   ← 纸底主导，旧实现会在此关闭色阶' : '')
  )

  const per = {}
  for (const strength of STRENGTHS) {
    const data = new Uint8ClampedArray(src)
    const { auto, whitenThreshold } = enhanceImageData(data, W, H, strength)
    const st = analyze(data)
    const erased = inkErased(data, inkMask)
    const degenerate = auto.blackPoint === 0 && auto.whitePoint === 1
    per[strength] = { st, auto, whitenThreshold, erased, degenerate, white: nearWhite(data) }
    const p = STRENGTH_PRESETS[strength]
    console.log(
      `  ${strength.padEnd(7)} blackQ=${p.blackQ} whiteQ=${p.whiteQ} → ` +
        `std=${st.stdLuma.toFixed(2)} dark=${(st.darkRatio * 100).toFixed(2)}% ` +
        `haze=${(st.hazeRatio * 100).toFixed(2)}% light=${(st.lightRatio * 100).toFixed(1)}% | ` +
        `色阶[${(auto.blackPoint * 255).toFixed(0)},${(auto.whitePoint * 255).toFixed(0)}] ` +
        `白化阈值=${whitenThreshold} 墨迹被吃=${(erased.pct * 100).toFixed(3)}%` +
        (degenerate ? '  ⚠ 色阶被关闭' : '')
    )
  }
  allMetrics[layout.name] = { per, srcOtsu, classes, paperShare }
}

/* ==================== 断言 1：单调性（≥4 版式） ==================== */
console.log('\n' + '='.repeat(80))
console.log('断言 1  单调性（对比度/暗像素占比 非递减；灰雾/墨迹损失 非递增）')
console.log('='.repeat(80))
{
  const metricDefs = [
    ['对比度 std', (m) => m.st.stdLuma, 'up'],
    ['暗像素占比 darkRatio', (m) => m.st.darkRatio, 'up'],
    ['灰雾占比 hazeRatio', (m) => m.st.hazeRatio, 'down'],
    ['墨迹损失 比例', (m) => m.erased.pct, 'down'],
    ['纸底纯白比例(≥250)', (m) => m.white, 'up']
  ]
  console.log('  版式'.padEnd(26) + metricDefs.map((d) => d[0].padStart(20)).join('  '))
  for (const [name, m] of Object.entries(allMetrics)) {
    const cells = metricDefs.map(([, get]) => {
      const v = STRENGTHS.map((s) => get(m.per[s]))
      const ok = metricDefs.find((d) => d[1] === get)[2]
      return v.map((x) => x.toFixed(4)).join('/')
    })
    console.log('  ' + name.padEnd(24) + metricDefs.map((d, i) => {
      const v = STRENGTHS.map((s) => d[1](m.per[s]))
      const ok = d[2] === 'up' ? nonDec(v) : nonInc(v)
      return ((ok ? '✅' : '❌') + ' ' + cells[i]).padStart(20)
    }).join('  '))
  }

  for (const [name, m] of Object.entries(allMetrics)) {
    const std = STRENGTHS.map((s) => m.per[s].st.stdLuma)
    const dark = STRENGTHS.map((s) => m.per[s].st.darkRatio)
    const haze = STRENGTHS.map((s) => m.per[s].st.hazeRatio)
    const loss = STRENGTHS.map((s) => m.per[s].erased.pct)
    check(`${name}: 对比度 std 随强度非递减`, nonDec(std),
      STRENGTHS.map((s, i) => `${s}=${std[i].toFixed(2)}`).join(' ≤ '), '自洽')
    check(`${name}: 暗像素占比 非递减`, nonDec(dark),
      STRENGTHS.map((s, i) => `${s}=${(dark[i] * 100).toFixed(2)}%`).join(' ≤ '), '自洽')
    check(`${name}: 灰雾占比 非递增`, nonInc(haze),
      STRENGTHS.map((s, i) => `${s}=${(haze[i] * 100).toFixed(2)}%`).join(' ≥ '), '自洽')
    check(`${name}: 墨迹损失 非递增`, nonInc(loss),
      STRENGTHS.map((s, i) => `${s}=${(loss[i] * 100).toFixed(3)}%`).join(' ≥ '), '独立')
  }
}

/* ==================== 断言 2：内容保全（≤ 0.5% 墨迹被白化） ==================== */
console.log('\n' + '='.repeat(80))
console.log('断言 2  内容保全：真值墨迹被推成纯白的比例必须 ≤ 0.5%')
console.log('='.repeat(80))
{
  for (const [name, m] of Object.entries(allMetrics)) {
    for (const s of STRENGTHS) {
      const e = m.per[s].erased
      const tag = '独立'
      check(`${name} · ${s}: 墨迹被吃 ≤ 0.5%`, e.pct <= 0.005,
        `${e.erased}/${e.ink} px = ${(e.pct * 100).toFixed(3)}%`, tag)
    }
  }
  // 极限情形：极低墨迹对比（墨迹仅比纸底暗 25）——最容易误伤
  const { data: low, inkMask: lowMask } = makeScan(W, H, { paperLuma: 210, inkLuma: 185, noise: 6, inkProb: 0.2, rowDensity: 0.006 })
  for (const s of STRENGTHS) {
    const d = new Uint8ClampedArray(low)
    enhanceImageData(d, W, H, s)
    const e = inkErased(d, lowMask)
    check(`低对比度墨迹(暗差仅25) · ${s}: 墨迹被吃 ≤ 0.5%`, e.pct <= 0.005,
      `${e.erased}/${e.ink} px = ${(e.pct * 100).toFixed(3)}%`, '独立')
  }
}

/* ==================== 断言 3：纸底主导页不得关闭色阶 ==================== */
console.log('\n' + '='.repeat(80))
console.log('断言 3  可分类（classifyTones 非 null）时，色阶不得被整段关闭（black>0 且 white<1）')
console.log('='.repeat(80))
{
  for (const [name, m] of Object.entries(allMetrics)) {
    if (!m.classes) {
      console.log(`  ⏭  ${name}: classifyTones=null（无墨迹，豁免）`)
      continue
    }
    for (const s of STRENGTHS) {
      const a = m.per[s].auto
      check(`${name} · ${s}: 色阶生效（黑场>0 且 白场<1）`,
        a.blackPoint > 0 && a.whitePoint < 1,
        `black=${(a.blackPoint * 255).toFixed(0)} white=${(a.whitePoint * 255).toFixed(0)}` +
          `（纸底 ${(m.paperShare * 100).toFixed(1)}%）`, '自洽')
    }
  }
  // 明示：纸底主导页在旧实现下会命中退化保护
  const heavy = Object.entries(allMetrics).filter(([, m]) => m.paperShare > 0.85)
  check(`存在纸底主导版式（>85%）可用于回归`, heavy.length >= 1,
    heavy.map(([n, m]) => `${n}=${(m.paperShare * 100).toFixed(1)}%`).join(', '), '独立')
}

/* ==================== 断言 4：阈值落在正确的分布里 ==================== */
console.log('\n' + '='.repeat(80))
console.log('断言 4  黑场 ≤ Otsu 分割点 ≤ 白场；白化阈值(paperFloor) > 分割点')
console.log('='.repeat(80))
{
  for (const [name, m] of Object.entries(allMetrics)) {
    if (!m.classes) {
      console.log(`  ⏭  ${name}: classifyTones=null（豁免）`)
      continue
    }
    const split = m.classes.split
    for (const s of STRENGTHS) {
      const a = m.per[s].auto
      const black = a.blackPoint * 255
      const white = a.whitePoint * 255
      check(`${name} · ${s}: 黑场(${black.toFixed(0)}) ≤ 分割点(${split})`, black <= split + 0.5,
        `差 ${(split - black).toFixed(1)}`, '自洽')
      check(`${name} · ${s}: 白场(${white.toFixed(0)}) ≥ 分割点(${split})`, white >= split - 0.5,
        `差 ${(white - split).toFixed(1)}`, '自洽')
      const wf = m.per[s].whitenThreshold
      const expected = STRENGTH_PRESETS[s].whiten > 0
      check(`${name} · ${s}: 白化阈值${expected ? '(应 > 分割点，构造上不啃墨迹)' : '(whiten=0 → 256 不白化)'}`,
        expected ? wf > split : wf === 256, `paperFloor=${wf} 分割点=${split}`, '独立')
    }
  }
}

/* ==================== 5. 发灰扫描件的整体增强效果 ==================== */
console.log('\n' + '='.repeat(80))
console.log('5  发灰扫描件整体效果 + 三档产出互异')
console.log('='.repeat(80))
{
  const { data: src } = makeScan(W, H, { paperLuma: 215, inkLuma: 150, noise: 8, inkProb: 0.42, rowDensity: 0.016 })
  const s0 = analyze(src)
  const res = {}
  for (const st of STRENGTHS) {
    const img = new Uint8ClampedArray(src)
    enhanceImageData(img, W, H, st)
    res[st] = analyze(img)
  }
  for (const st of STRENGTHS) {
    check(`${st}: 对比度上升`, res[st].stdLuma > s0.stdLuma,
      `${s0.stdLuma.toFixed(1)} → ${res[st].stdLuma.toFixed(1)}`, '自洽')
    check(`${st}: 文字变黑（darkRatio 上升）`, res[st].darkRatio > s0.darkRatio,
      `${(s0.darkRatio * 100).toFixed(1)}% → ${(res[st].darkRatio * 100).toFixed(1)}%`, '自洽')
    check(`${st}: 灰雾减少`, res[st].hazeRatio < s0.hazeRatio,
      `${(s0.hazeRatio * 100).toFixed(1)}% → ${(res[st].hazeRatio * 100).toFixed(1)}%`, '自洽')
  }
  check('三档产出互异（原实现三档完全相同）',
    res.light.stdLuma !== res.medium.stdLuma && res.medium.stdLuma !== res.strong.stdLuma,
    `light=${res.light.stdLuma.toFixed(2)} medium=${res.medium.stdLuma.toFixed(2)} strong=${res.strong.stdLuma.toFixed(2)}`, '自洽')
}

/* ==================== 6. Otsu 分割点落在两簇之间（解析期望） ==================== */
console.log('\n' + '='.repeat(80))
console.log('6  Otsu 阈值解析性检查（纸底 215 / 墨迹 150）')
console.log('='.repeat(80))
{
  const { data, inkMask } = makeScan(W, H, { paperLuma: 215, inkLuma: 150, noise: 6, inkProb: 0.4, rowDensity: 0.02 })
  const t = otsuThreshold(data)
  // 离散直方图在墨迹簇与纸底簇之间有空隙时，类间方差在空隙内恒定，
  // 实现取「首个」最大值 → 阈值落在【墨迹簇上沿】。故断言落在两簇均值之间即可。
  check('Otsu 位于墨迹簇(≈150) 与纸底簇(≈215) 之间', t >= INK && t < PAPER, `Otsu=${t}`, '独立')
  const c = classifyTones(data)
  check('classifyTones 给出有效分割', c !== null && c.split === t, `split=${c && c.split}`, '独立')
  // 强判据：分割点必须把【真值】墨迹/纸底完全分开
  let inkViolate = 0
  let paperViolate = 0
  for (let p = 0; p < inkMask.length; p++) {
    const luma = data[p * 4] // 三通道同值（灰度合成）
    if (inkMask[p]) {
      if (luma > c.split) inkViolate++
    } else if (luma <= c.split) paperViolate++
  }
  check('真值墨迹像素全部 ≤ 分割点', inkViolate === 0, `违规 ${inkViolate}`, '独立')
  check('真值纸底像素全部 > 分割点', paperViolate === 0, `违规 ${paperViolate}`, '独立')
  check('墨迹类内分位都 ≤ split', (() => {
    for (const q of [0, 0.3, 0.6, 0.88, 1]) if (c.inkQuantile(q) > c.split) return false
    return true
  })(), '', '自洽')
  check('纸底类内分位都 > split', (() => {
    for (const q of [0, 0.03, 0.15, 0.35, 1]) if (c.paperQuantile(q) <= c.split) return false
    return true
  })(), '', '自洽')
}

/* ==================== 7. 安全阀：清晰图像不被破坏 ==================== */
console.log('\n' + '='.repeat(80))
console.log('7  安全阀：本来就清晰的图像（纸底 245 / 文字 30）')
console.log('='.repeat(80))
{
  const { data } = makeScan(W, H, { paperLuma: 245, inkLuma: 30, noise: 3, inkProb: 0.3, rowDensity: 0.02 })
  const s0 = analyze(data)
  const bak = Uint8ClampedArray.from(data)
  enhanceImageData(data, W, H, 'light')
  const s1 = analyze(data)
  let maxDelta = 0
  for (let i = 0; i < data.length; i++) maxDelta = Math.max(maxDelta, Math.abs(data[i] - bak[i]))
  console.log(`    前: std=${s0.stdLuma.toFixed(1)}  后: std=${s1.stdLuma.toFixed(1)}  最大像素改动=${maxDelta}`)
  check('清晰图像不被过度处理（最大改动 < 60）', maxDelta < 60, `maxDelta=${maxDelta}`, '独立')
  check('对比度未被削弱', s1.stdLuma >= s0.stdLuma * 0.9, `${s0.stdLuma.toFixed(1)} → ${s1.stdLuma.toFixed(1)}`, '自洽')
}

/* ==================== 8. 退化输入保护（纯色页） ==================== */
console.log('\n' + '='.repeat(80))
console.log('8  退化输入：纯色页（无动态范围）')
console.log('='.repeat(80))
{
  const flat = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < flat.length; i += 4) {
    flat[i] = 240
    flat[i + 1] = 240
    flat[i + 2] = 240
    flat[i + 3] = 255
  }
  check('纯色页 classifyTones=null（真·不可分）', classifyTones(flat) === null, '', '独立')
  const lv = autoLevels(flat, 0.3, 0.35)
  check('纯色页自动色阶退回满量程（不放大噪点）', lv.blackPoint === 0 && lv.whitePoint === 1,
    `[${lv.blackPoint},${lv.whitePoint}]`, '独立')
  enhanceImageData(flat, W, H, 'strong')
  check('纯色页处理后仍为纯色', analyze(flat).stdLuma === 0, `std=${analyze(flat).stdLuma}`, '独立')
}

/* ==================== 9. 锐化：单调、可复现、对纯色无副作用 ==================== */
console.log('\n' + '='.repeat(80))
console.log('9  反锐化掩模')
console.log('='.repeat(80))
{
  const { data } = makeScan(W, H, { paperLuma: 215, inkLuma: 150, noise: 4, inkProb: 0.4, rowDensity: 0.02 })
  const base = analyze(data).stdLuma
  const a0 = Uint8ClampedArray.from(data)
  applySharpen(a0, W, H, 0)
  check('amount=0 时锐化为空操作', Buffer.compare(Buffer.from(a0), Buffer.from(data)) === 0, '', '独立')
  const a1 = Uint8ClampedArray.from(data)
  applySharpen(a1, W, H, 0.8)
  const s1 = analyze(a1).stdLuma
  check('锐化提升局部对比度（std 上升）', s1 > base, `${base.toFixed(2)} → ${s1.toFixed(2)}`, '自洽')
  // 纯色页锐化无副作用
  const flat = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < flat.length; i += 4) {
    flat[i] = 200
    flat[i + 1] = 200
    flat[i + 2] = 200
    flat[i + 3] = 255
  }
  const flatBak = Uint8ClampedArray.from(flat)
  applySharpen(flat, W, H, 0.9)
  check('纯色页锐化为空操作', Buffer.compare(Buffer.from(flat), Buffer.from(flatBak)) === 0, '', '独立')
}

/* ==================== 10. LUT 语义：白化阈值以上全白、以下按色阶 ==================== */
console.log('\n' + '='.repeat(80))
console.log('10  applyLevels / LUT 语义')
console.log('='.repeat(80))
{
  // 灰度斜坡 0..255，用于观察「色阶 + 白化折入 LUT」
  const rampOf = () => {
    const r = new Uint8ClampedArray(256 * 4)
    for (let v = 0; v < 256; v++) {
      r[v * 4] = v
      r[v * 4 + 1] = v
      r[v * 4 + 2] = v
      r[v * 4 + 3] = 255
    }
    return r
  }
  // A. 色阶：黑场 0.2*255=51 → 0；白场 1.0；paperFloor=220 折入白化
  const p = { blackPoint: 0.2, whitePoint: 1, gamma: 1, sharpen: 0, grayscale: true, whiten: 1 }
  const ramp = rampOf()
  applyLevels(ramp, p, 220)
  check('paperFloor(220) 及以上一律映射为 255', (() => {
    for (let v = 220; v < 256; v++) if (ramp[v * 4] !== 255) return false
    return true
  })(), '', '独立')
  check('paperFloor 以下仍按色阶（黑场 51 处 → 0；20 处 → 0）',
    ramp[51 * 4] === 0 && ramp[20 * 4] === 0, `lut[51]=${ramp[51 * 4]} lut[20]=${ramp[20 * 4]}`, '独立')
  check('色阶中段线性映射正确（v=200 → round((200-51)/204*255)=186）',
    Math.abs(ramp[200 * 4] - 186) <= 1, `lut[200]=${ramp[200 * 4]}`, '独立')

  // B. 无白化（paperFloor=256）：高亮度按色阶恒等，不被强推纯白
  const pNo = { blackPoint: 0, whitePoint: 1, gamma: 1, sharpen: 0, grayscale: true, whiten: 1 }
  const rNo = rampOf()
  applyLevels(rNo, pNo, 256)
  check('paperFloor=256 时不做白化（v=240 → 240，非 255）', rNo[240 * 4] === 240,
    `lut[240]=${rNo[240 * 4]}`, '独立')
  // C. 同一输入开启白化（paperFloor=220）：v=240 被推成 255
  const rYes = rampOf()
  applyLevels(rYes, pNo, 220)
  check('paperFloor=220 时 v=240 被白化为 255（与 B 形成对照）', rYes[240 * 4] === 255,
    `lut[240]=${rYes[240 * 4]}`, '独立')
}

/* ==================== 11. §1 契约 a：独立灰阶内容必须保留 ==================== */
console.log('\n' + '='.repeat(80))
console.log('11  §1 契约 a：独立灰阶（数字原生页的浅灰表格线）三档存活率 ≥ 95%')
console.log('='.repeat(80))
{
  const GRAY = 200
  const { data: src, grayMask } = makeDigitalWithGrayRules(W, H, { paperLuma: 255, inkLuma: 20, grayLuma: GRAY })
  let grayTotal = 0
  for (let p = 0; p < grayMask.length; p++) grayTotal += grayMask[p]
  const cls = classifyTones(src)
  console.log(
    `  数字原生页：背景 255 / 黑字 20 / 浅灰表格线 ${GRAY}` +
      `  真值灰阶像素 ${grayTotal} px  Otsu 分割点=${cls ? cls.split : 'n/a'}`
  )
  console.log(
    `  纸底主导峰=${cls ? cls.paperMode : 'n/a'}  主峰连通带=[${cls ? cls.paperBandLo : 'n/a'},${cls ? cls.paperBandHi : 'n/a'}]` +
      `（灰线 ${GRAY} 应落在带【外】，即与背景峰之间有直方图空档）`
  )
  check('浅灰线确实落在背景主峰连通带之外（属独立灰阶）',
    !!cls && GRAY < cls.paperBandLo, `灰线=${GRAY} 带下界=${cls ? cls.paperBandLo : 'n/a'}`, '独立')
  for (const s of STRENGTHS) {
    const d = new Uint8ClampedArray(src)
    enhanceImageData(d, W, H, s)
    // 「保留」= 灰阶像素未被推成纯白（输出亮度 < 250）
    let stayed = 0
    for (let p = 0; p < grayMask.length; p++) {
      if (!grayMask[p]) continue
      if (d[p * 4] < 250) stayed++
    }
    const survived = grayTotal ? stayed / grayTotal : 0
    check(`独立灰阶内容保留 ≥ 95% · ${s}`, survived >= 0.95,
      `${stayed}/${grayTotal} px = ${(survived * 100).toFixed(1)}%`, '独立')
  }
}

/* ==================== 12. §1 契约 b：脏纸底仍必须被清理 ==================== */
console.log('\n' + '='.repeat(80))
console.log('12  §1 契约 b：发灰扫描件的脏纸底在 medium/strong 下灰雾必须接近 0')
console.log('='.repeat(80))
{
  const { data: src } = makeScan(W, H, { paperLuma: 215, inkLuma: 150, noise: 8, inkProb: 0.42, rowDensity: 0.016 })
  const s0 = analyze(src)
  console.log(`  源图灰雾(140–210) = ${(s0.hazeRatio * 100).toFixed(2)}%`)
  for (const s of STRENGTHS) {
    const d = new Uint8ClampedArray(src)
    enhanceImageData(d, W, H, s)
    const st = analyze(d)
    if (s === 'light') {
      // 轻度 whiten=0，不做白化——只要求灰雾较源图下降，不与内容保全抢
      check('light: 灰雾较源图下降（本档不做白化，不苛求清零）', st.hazeRatio < s0.hazeRatio,
        `${(s0.hazeRatio * 100).toFixed(2)}% → ${(st.hazeRatio * 100).toFixed(2)}%`, '自洽')
    } else {
      check(`${s}: 脏纸底被清理（灰雾 ≤ 1%）`, st.hazeRatio <= 0.01,
        `${(s0.hazeRatio * 100).toFixed(2)}% → ${(st.hazeRatio * 100).toFixed(2)}%`, '独立')
    }
  }
}

/* ==================== 13. §1 契约 a（扩展）：噪声模型下的独立灰阶保全 ==================== */
console.log('\n' + '='.repeat(80))
console.log('13  §1 契约 a（扩展）：四种噪声模型下的独立灰阶保全（覆盖【宽连通带】）')
console.log('='.repeat(80))
{
  // §11 只覆盖了「纯白底、带宽 0」这一种情形——那是独立灰阶最不容易被吞的极端。
  // 真正危险的场景是【宽连通带】：噪声拖尾 / 照明不均会把纸底类主峰连通带撑得很宽，
  // 带越宽，白化下界 paperBandLo 越低，越可能把带外的独立灰阶（浅灰表格线/批注）一并吞掉。
  // 本段用四种噪声模型把这条契约钉死。
  //
  // 判据（对齐 diag-band-robustness.mjs v2 的口径）：
  //   ① cls.paperBandLo > grayLevel  —— 灰线确在带【外】（证明它是「独立灰阶」而非「脏背景」）
  //   ② Δ_after = mean(纸底) − mean(灰线) ≥ 20  —— 增强后灰线仍与纸底可辨（对比度保持）
  //   ③ mean(灰线) < 245  —— 灰线未被白化抹平
  // 注：不用「亮度是否还在原值 ±10 内」——对比度增强的本质就是把亮度搬走，
  //     灰线被一起抬高并不等于丢失（这是 diag v1 的度量缺陷）。
  const NOISE_MODELS = [
    { id: 'N1', name: '均匀噪声 ±8（理想扫描件）', grayLevel: 178 },
    { id: 'N2', name: '高斯噪声 σ=10（有拖尾 → 宽连通带）', grayLevel: 178 },
    { id: 'N3', name: '均匀 + 1.5% 灰尘散点（真实扫描件）', grayLevel: 178 },
    { id: 'N4', name: '照明不均（纸底 195..245 连续渐变 → 宽连通带）', grayLevel: 172 }
  ]
  for (const m of NOISE_MODELS) {
    const src = makeNoisyScan(m.id, { grayLevel: m.grayLevel })
    const cls = classifyTones(src)
    if (!cls) {
      check(`[${m.id}] 可分类（classifyTones 非 null）`, false, '分类为 null，无法后续判定', '独立')
      continue
    }
    const bandWidth = cls.paperBandHi - cls.paperBandLo
    const bandPct = (bandWidth / 255) * 100
    const { line, paperIdx } = bandIndexSets(src, cls.paperMode)
    // 宽带必须在日志里可见——本段存在的意义就是覆盖宽带
    console.log(
      `  ■ ${m.id} ${m.name}` +
        `\n      主峰=${cls.paperMode} 连通带=[${cls.paperBandLo},${cls.paperBandHi}] ` +
        `带宽=${bandWidth} (${bandPct.toFixed(1)}% 满量程) split=${cls.split} ` +
        `纸底参照像素=${paperIdx.length} 灰线 luma=${m.grayLevel}`
    )
    check(`[${m.id}] 灰线落在主峰连通带之外（独立灰阶）`, cls.paperBandLo > m.grayLevel,
      `灰线=${m.grayLevel} 带=[${cls.paperBandLo},${cls.paperBandHi}] 带宽=${bandWidth}(${bandPct.toFixed(1)}%)`, '独立')
    for (const s of STRENGTHS) {
      const d = new Uint8ClampedArray(src)
      enhanceImageData(d, W, H, s)
      const mp = meanLumaOf(d, paperIdx)
      const ml = meanLumaOf(d, line)
      const delta = mp - ml
      check(`[${m.id}] ${s}: 灰线与纸底仍可辨（Δ_after ≥ 20）`, delta >= 20,
        `纸底→${mp.toFixed(1)} 灰线→${ml.toFixed(1)} Δ=${delta.toFixed(1)} 带宽=${bandWidth}`, '独立')
      check(`[${m.id}] ${s}: 灰线未被白化抹平（mean < 245）`, ml < 245,
        `mean(灰线)=${ml.toFixed(1)}`, '独立')
    }
  }
}

/* ==================== 14. §1 契约 a（边界）：灰线降到贴近带下沿仍应保留 ==================== */
console.log('\n' + '='.repeat(80))
console.log('14  §1 契约 a（边界）：灰线降到带下沿附近时三档仍应保留')
console.log('='.repeat(80))
{
  // 探测「灰线低到多少才失效」：以 N1（理想扫描件，纸底 215、带下沿≈207）为基准，
  // 把灰线压到带下沿 − 4 级处。预期：灰线 ≤ paperBandLo − 3 时三档 Δ_after 仍 ≥ 20。
  const probe = makeNoisyScan('N1', { grayLevel: 178 })
  const cls0 = classifyTones(probe)
  const grayLevel = cls0.paperBandLo - 4
  const src = makeNoisyScan('N1', { grayLevel })
  const cls = classifyTones(src)
  const bandWidth = cls.paperBandHi - cls.paperBandLo
  const { line, paperIdx } = bandIndexSets(src, cls.paperMode)
  console.log(
    `  N1 带下沿=${cls0.paperBandLo} → 取灰线 luma=${grayLevel}（= 带下沿 − 4，仍应在带外）` +
      `\n      主峰=${cls.paperMode} 连通带=[${cls.paperBandLo},${cls.paperBandHi}] 带宽=${bandWidth} split=${cls.split}`
  )
  check('边界灰线仍落在连通带之外', cls.paperBandLo > grayLevel,
    `灰线=${grayLevel} 带下界=${cls.paperBandLo}`, '独立')
  for (const s of STRENGTHS) {
    const d = new Uint8ClampedArray(src)
    enhanceImageData(d, W, H, s)
    const delta = meanLumaOf(d, paperIdx) - meanLumaOf(d, line)
    check(`边界灰线 · ${s}: Δ_after ≥ 20`, delta >= 20, `Δ=${delta.toFixed(1)}`, '独立')
  }
}

console.log('\n' + '='.repeat(80))
console.log('汇总: ' + pass + ' 项通过, ' + fail + ' 项失败')
console.log('='.repeat(80))
process.exit(fail ? 1 : 0)
