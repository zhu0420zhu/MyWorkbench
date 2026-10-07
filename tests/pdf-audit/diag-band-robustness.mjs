/**
 * 压测「主峰连通带」判据在真实扫描件噪声下的稳健性。  —— v2（修复两个探针缺陷）
 *
 * v1 的两个缺陷（都是探针自身的，不是被测代码的）：
 *
 *   缺陷 A【致命】模型未生效：
 *     v1 的 makePage 签名是 ({ model, paper, ink, grayLevel })，而调用写的是 makePage(m)，
 *     m 的模型键名是 `id`。于是 `model` 恒为 undefined，switch 落进 default 分支
 *     `v = paper`，四种噪声模型跑的全部是同一张【纸底恰好等于 215、零噪声】的退化图。
 *     单值纸底下 hist[214]=hist[216]=0，连通带自然是 [215,215] —— 这是【正确行为】，
 *     却被 v1 的解读要点误读成「连通性判据在噪声下退化成单桶」。
 *     修复：显式传 { model: m.id, grayLevel: m.grayLevel }。
 *
 *   缺陷 B【度量错】存活率口径错误：
 *     v1 用「增强后亮度仍落在原值 ±10 内」作为灰阶内容存活判据。
 *     但**对比度增强的本质就是把亮度搬走**：纸底 215 → 255 时，浅灰线也会被一起抬高。
 *     线被抬到 210 明明仍清晰可辨，却因落在 [168,188] 之外被判「丢失」。
 *     这是把「色阶位移」误判成「内容丢失」。
 *     修复：改量【线与纸底的对比度保持】——
 *       Δ_before = paperMode - grayLevel
 *       Δ_after  = mean(纸底像素) - mean(灰线像素)
 *     契约：Δ_after >= 20（仍可辨）且 灰线 mean < 245（未被白化抹平）。
 *
 * 四种噪声模型：
 *   N1 均匀噪声 ±8          （理想扫描件）
 *   N2 高斯噪声 σ=10        （有拖尾）
 *   N3 均匀 + 1.5% 灰尘散点 （真实扫描件最常见的形态）
 *   N4 照明不均（纸底 195..245 连续渐变）
 */
import {
  classifyTones,
  enhanceImageData
} from '../../src/renderer/src/utils/pdfEnhance.ts'

const W = 600
const H = 800
const lum = (d, i) => (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000

/** 灰阶内容线的位置 */
const LINE = { x0: 300, x1: 520, y0: 300, y1: 308 }

/** 造「扫描件 + 一条独立灰阶内容线」 */
function makePage({ model, paper = 215, ink = 150, grayLevel = 178 }) {
  const d = new Uint8ClampedArray(W * H * 4)
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

/** 收集「灰线像素索引」与「纸底像素索引」（纸底按原图亮度贴近主峰判定） */
function indexSets(src, paperMode) {
  const line = []
  const paper = []
  for (let y = LINE.y0; y < LINE.y1; y++)
    for (let x = LINE.x0; x < LINE.x1; x++) line.push(((y * W + x) * 4))
  for (let i = 0; i < src.length; i += 4) {
    // 纸底参照像素：原图亮度贴近主峰，且不在灰线区域
    if (Math.abs(lum(src, i) - paperMode) <= 2) paper.push(i)
  }
  return { line, paper }
}

const mean = (d, idx) => (idx.length ? idx.reduce((s, i) => s + lum(d, i), 0) / idx.length : NaN)

const MODELS = [
  { id: 'N1', name: '均匀噪声 ±8（理想扫描件）', grayLevel: 178 },
  { id: 'N2', name: '高斯噪声 σ=10（有拖尾）', grayLevel: 178 },
  { id: 'N3', name: '均匀 + 1.5% 灰尘散点（真实扫描件）', grayLevel: 178 },
  { id: 'N4', name: '照明不均（纸底 195..245 连续渐变）', grayLevel: 172 }
]

console.log('='.repeat(100))
console.log('「主峰连通带」判据压测 v2：噪声拖尾会不会把背景带撑爆 / 会不会吞掉独立灰阶内容？')
console.log('='.repeat(100))
console.log(`每页埋一条独立灰阶线 (${LINE.x0},${LINE.y0})-(${LINE.x1},${LINE.y1})，共 ${(LINE.y1 - LINE.y0) * (LINE.x1 - LINE.x0)} px`)
console.log('契约：Δ_after = mean(纸底) - mean(灰线) 必须 >= 20；且 mean(灰线) < 245（未被白化抹平）')

let pass = 0
let fail = 0

for (const m of MODELS) {
  const src = makePage({ model: m.id, grayLevel: m.grayLevel })
  const cls = classifyTones(src)
  const band = cls ? cls.paperBandHi - cls.paperBandLo : null
  const { line, paper } = indexSets(src, cls ? cls.paperMode : 215)

  console.log('\n' + '─'.repeat(100))
  console.log(`■ ${m.name}`)
  console.log('─'.repeat(100))
  console.log(
    `  纸底主导峰=${cls?.paperMode}  连通带=[${cls?.paperBandLo},${cls?.paperBandHi}]  ` +
      `带宽=${band} (${band !== null ? ((band / 255) * 100).toFixed(1) : '?'}% 满量程)  split=${cls?.split}  ` +
      `纸底参照像素=${paper.length}`
  )
  console.log(
    `  灰线原值 luma=${m.grayLevel}  ${m.grayLevel < (cls ? cls.paperBandLo : 0) ? '落在带【外】' : '落在带【内】'}  ` +
      `Δ_before≈${((cls?.paperMode ?? 215) - m.grayLevel).toFixed(0)}`
  )

  for (const strength of ['light', 'medium', 'strong']) {
    const d = new Uint8ClampedArray(src)
    enhanceImageData(d, W, H, strength)
    const mp = mean(d, paper)
    const ml = mean(d, line)
    const delta = mp - ml
    const ok = delta >= 20 && ml < 245
    ok ? pass++ : fail++
    console.log(
      `    ${strength.padEnd(7)} 纸底→${mp.toFixed(1).padStart(6)}  灰线→${ml.toFixed(1).padStart(6)}  ` +
        `Δ_after=${delta.toFixed(1).padStart(6)}  ${ml >= 245 ? '被白化抹平 ❌' : ok ? '✅' : '对比不足 ❌'}`
    )
  }
}

console.log('\n' + '='.repeat(100))
console.log(`契约结果：${pass} 通过 / ${fail} 失败`)
console.log('='.repeat(100))
console.log('解读要点')
console.log('='.repeat(100))
console.log('N1/N2 看拖尾是否撑宽带；N3 看灰尘散点是否把带沿连通性一路拉到墨迹；')
console.log('N4 看照明不均这种「纸底本身就是一段连续区间」的页会得到多宽的带。')
console.log('若 N3 的带宽明显大于 N1，说明连通性判据对散点敏感 —— 那是过度延伸的信号。')
console.log('但带宽宽本身不是错：带越宽，whitenFloor 下界越低，才越可能吞掉带外独立灰阶。')
console.log('真正的判据是最后的 Δ_after —— 灰线是否仍与纸底可辨。')
process.exitCode = fail === 0 ? 0 : 1
