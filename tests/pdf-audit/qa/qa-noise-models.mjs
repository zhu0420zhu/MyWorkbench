/**
 * 任务 #12 ②③④ —— 用【QA 自有种子/尺寸/线位】重建 N1/N2/N3/N4 噪音模型，独立复核：
 *   ② 各模型的主峰连通带宽度与三档 Δ_after（判据只看 Δ≥20 且 mean<245）
 *   ③ 「纸底参照像素集」与「灰线像素集」必须互斥（否则度量在自证）
 *   ④ 契约 a（保留带外独立灰阶）不得以牺牲契约 b（带内脏背景/带内灰必须被白化）为代价
 *   ⑤ 墨迹保全：任何真值墨迹像素都不得被推成纯白 255
 *
 * 与 test-enhance-algo.mjs §13/§14 的区别：种子、画布尺寸、灰线位置全部不同，
 * 用于检验结论不是「恰好被那组参数选中」。
 *
 * 运行：
 *   NODE_OPTIONS="" "<node>" --experimental-loader=./tests/loader.mjs \
 *     --experimental-strip-types tests/pdf-audit/qa/qa-noise-models.mjs
 */
import { classifyTones, enhanceImageData, analyze, whitenFloor, STRENGTH_PRESETS } from '../../../src/renderer/src/utils/pdfEnhance.ts'
import { makeScanPage, lineIndices, paperIndices, meanLumaAt, intersectSize } from './qa-noise-gen.mjs'

const W = 480
const H = 640
const SEED = 777 // QA 自有种子（非 20260928）
const STRENGTHS = ['light', 'medium', 'strong']
/** QA 自有线位（非 300..520 / 300..308） */
const POS = [
  { name: 'P1', line: { x0: 120, x1: 340, y0: 420, y1: 428 } },
  { name: 'P2', line: { x0: 60, x1: 180, y0: 150, y1: 156 } }
]
const MODELS = [
  { id: 'N1', grayLevel: 178 },
  { id: 'N2', grayLevel: 178 },
  { id: 'N3', grayLevel: 178 },
  { id: 'N4', grayLevel: 172 }
]

let pass = 0
let fail = 0
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? '  → ' + detail : ''}`)
  cond ? pass++ : fail++
}

const NOISE_DEFECT_NOISE = [] // 记录不构成契约失败的观察（不报为缺陷）

console.log('='.repeat(104))
console.log('②③④ 噪音模型独立重建（QA 种子/尺寸/线位）')
console.log('='.repeat(104))
console.log(`画布 ${W}x${H}  seed=${SEED}  线位 P1/P2 各 ${(340 - 120) * 8} / ${(180 - 60) * 6} px`)
console.log('契约：带外 ⇔ paperBandLo > 灰线；Δ_after=mean(纸底)−mean(灰线) ≥ 20；mean(灰线) < 245')

const summary = [] // 供最终报告

for (const pos of POS) {
  for (const m of MODELS) {
    const { data: src, inkMask } = makeScanPage(W, H, {
      model: m.id,
      paper: 215,
      ink: 150,
      grayLevel: m.grayLevel,
      seed: SEED,
      line: pos.line
    })
    const cls = classifyTones(src)
    const bandWidth = cls.paperBandHi - cls.paperBandLo
    const lineIdx = lineIndices(W, pos.line)
    const paperIdx = paperIndices(src, W, cls.paperMode)
    const disjoint = intersectSize(lineIdx, paperIdx)

    // 灰线在原图是否精确等于 grayLevel（真值锚定）
    let exact = 0
    for (const i of lineIdx) if (Math.abs(parseInt(src[i]) - m.grayLevel) === 0) exact++

    console.log('\n' + '─'.repeat(104))
    console.log(`■ ${pos.name} ${m.id}  主峰=${cls.paperMode} 连通带=[${cls.paperBandLo},${cls.paperBandHi}] ` +
      `带宽=${bandWidth} (${((bandWidth / 255) * 100).toFixed(1)}% 满量程) split=${cls.split} ` +
      `纸底参照=${paperIdx.length}px 灰线 luma=${m.grayLevel} Δ_before≈${(cls.paperMode - m.grayLevel).toFixed(0)}`)

    check(`${pos.name}/${m.id}: 灰线落在连通带之外（带外独立灰阶）`, cls.paperBandLo > m.grayLevel,
      `灰线=${m.grayLevel} 带下沿=${cls.paperBandLo} 带宽=${bandWidth}`)
    check(`${pos.name}/${m.id}: 纸底参照集 ∩ 灰线集 = ∅（度量互斥）`, disjoint === 0,
      `|纸底|=${paperIdx.length} |灰线|=${lineIdx.length} 交集=${disjoint}`)
    check(`${pos.name}/${m.id}: 灰线像素源码亮度精确 = ${m.grayLevel}`, exact === lineIdx.length,
      `${exact}/${lineIdx.length}`)

    const row = { pos: pos.name, model: m.id, bandWidth, bandLo: cls.paperBandLo, bandHi: cls.paperBandHi, gray: m.grayLevel, deltas: {}, ml: {}, haze: {}, inkErased: {} }
    for (const s of STRENGTHS) {
      const d = new Uint8ClampedArray(src)
      enhanceImageData(d, W, H, s)
      const mp = meanLumaAt(d, paperIdx)
      const ml = meanLumaAt(d, lineIdx)
      const delta = mp - ml
      const ok = delta >= 20 && ml < 245
      // 墨迹保全：真值墨迹像素被推成纯白 255 的数量
      let erased = 0
      for (let p = 0; p < inkMask.length; p++) {
        if (!inkMask[p]) continue
        const i = p * 4
        if (d[i] >= 255 && d[i + 1] >= 255 && d[i + 2] >= 255) erased++
      }
      const st = analyze(d)
      row.deltas[s] = delta
      row.ml[s] = ml
      row.haze[s] = st.hazeRatio
      row.inkErased[s] = erased
      console.log(
        `    ${s.padEnd(7)} 纸底→${mp.toFixed(1).padStart(6)}  灰线→${ml.toFixed(1).padStart(6)}  ` +
          `Δ=${delta.toFixed(1).padStart(6)} ${ok ? '✅' : '❌'}  haze=${(st.hazeRatio * 100).toFixed(2)}%  ` +
          `墨迹被推白=${erased}`
      )
      check(`${pos.name}/${m.id} · ${s}: 灰线与纸底仍可辨（Δ≥20 且 mean<245）`, ok,
        `Δ=${delta.toFixed(1)} mean=${ml.toFixed(1)} 带宽=${bandWidth}`)
      check(`${pos.name}/${m.id} · ${s}: 墨迹像素零被白（被推纯白=0）`, erased === 0, `${erased} px 被推纯白`)
    }
    summary.push(row)
  }
}

/* ==================== ④ 契约 b：带内灰必须被白化（a 不得禁用 b） ==================== */
console.log('\n' + '='.repeat(104))
console.log('④ 契约 b：带【内】像素在 medium/strong 下必须被白化（不得为保内容而关掉白化）')
console.log('='.repeat(104))
console.log('说明：whitenFloor = bandLo + spread·(1−tol)。strong(tol=1.0) → 下沿=bandLo（整条带全推白）；')
console.log('      medium(tol=0.5) → 只推带上半段。故「带内任意一点都被白化」并非契约——按设计口径验证。')
{
  for (const pos of POS) {
    for (const m of MODELS) {
      const base = makeScanPage(W, H, { model: m.id, paper: 215, ink: 150, grayLevel: m.grayLevel, seed: SEED, line: pos.line })
      const cls0 = classifyTones(base.data)
      const spread = cls0.paperBandHi - cls0.paperBandLo
      const floorStrong = whitenFloor(cls0, STRENGTH_PRESETS.strong.whiten)
      const floorMedium = whitenFloor(cls0, STRENGTH_PRESETS.medium.whiten)
      console.log(`\n  ── ${pos.name}/${m.id}  带=[${cls0.paperBandLo},${cls0.paperBandHi}] spread=${spread} ` +
        `floor strong=${floorStrong} medium=${floorMedium}`)

      // (b1) strong 口径：白化下界 = 带下沿 → 整条带必须被推纯白（在下沿处实测）
      check(`${pos.name}/${m.id}: strong 白化下界 = 带下沿（整条带覆盖）`, floorStrong === cls0.paperBandLo,
        `floor=${floorStrong} bandLo=${cls0.paperBandLo}`)
      {
        const { data: srcS } = makeScanPage(W, H, { model: m.id, paper: 215, ink: 150, grayLevel: cls0.paperBandLo, seed: SEED, line: pos.line })
        const clsS = classifyTones(srcS)
        const lineIdx = lineIndices(W, pos.line)
        const d = new Uint8ClampedArray(srcS)
        enhanceImageData(d, W, H, 'strong')
        const ml = meanLumaAt(d, lineIdx)
        check(`${pos.name}/${m.id}: strong 把带下沿灰(luma=${clsS.paperBandLo}) 推纯白`, ml >= 254,
          `mean=${ml.toFixed(1)}`)
      }

      // (b2) 脏背景主体（paperMode 处的带内灰）在 medium/strong 下都必须被清（≥250）
      {
        const { data: srcM } = makeScanPage(W, H, { model: m.id, paper: 215, ink: 150, grayLevel: cls0.paperMode, seed: SEED, line: pos.line })
        const clsM = classifyTones(srcM)
        const inBand = cls0.paperMode >= clsM.paperBandLo && cls0.paperMode <= clsM.paperBandHi
        check(`${pos.name}/${m.id}: 主体灰(luma=${cls0.paperMode}) 落在连通带内`, inBand,
          `带=[${clsM.paperBandLo},${clsM.paperBandHi}]`)
        const lineIdx = lineIndices(W, pos.line)
        for (const s of ['medium', 'strong']) {
          const d = new Uint8ClampedArray(srcM)
          enhanceImageData(d, W, H, s)
          const ml = meanLumaAt(d, lineIdx)
          check(`${pos.name}/${m.id} · ${s}: 带内主体灰被白化（mean ≥ 250）`, ml >= 250, `mean=${ml.toFixed(1)}`)
        }
      }
    }
  }

  // (b3) §12 契约 b 原文口径：发灰扫描件（无独立灰线）的脏纸底 haze 在 medium/strong 下须 ≤ 1%
  console.log('\n  ── (b3) 脏纸底清理（§12 原文口径：发灰扫描件、无独立灰线）')
  for (const m of ['N1', 'N3']) {
    const { data: src } = makeScanPage(W, H, { model: m, paper: 215, ink: 150, seed: SEED, line: null })
    const s0 = analyze(src)
    for (const s of ['medium', 'strong']) {
      const d = new Uint8ClampedArray(src)
      enhanceImageData(d, W, H, s)
      const st = analyze(d)
      check(`${m} 脏纸底 · ${s}: haze ≤ 1%（源 ${(s0.hazeRatio * 100).toFixed(2)}%）`, st.hazeRatio <= 0.01,
        `${(s0.hazeRatio * 100).toFixed(2)}% → ${(st.hazeRatio * 100).toFixed(2)}%`)
    }
  }
}

/* ==================== ⑤ 墨迹保全：专用低对比墨迹页 ==================== */
console.log('\n' + '='.repeat(104))
console.log('⑤ 墨迹保全补强：低对比墨迹（纸底 215 / 墨迹 185，暗差仅 30）不得被推纯白')
console.log('='.repeat(104))
{
  const { data: src, inkMask } = makeScanPage(W, H, { model: 'N1', paper: 215, ink: 185, grayLevel: 178, seed: 31337, line: POS[0].line, inkProb: 0.3 })
  let inkTotal = 0
  for (let p = 0; p < inkMask.length; p++) inkTotal += inkMask[p]
  for (const s of STRENGTHS) {
    const d = new Uint8ClampedArray(src)
    enhanceImageData(d, W, H, s)
    let erased = 0
    for (let p = 0; p < inkMask.length; p++) {
      if (!inkMask[p]) continue
      const i = p * 4
      if (d[i] >= 255 && d[i + 1] >= 255 && d[i + 2] >= 255) erased++
    }
    check(`低对比墨迹 · ${s}: 墨迹被推纯白 = 0`, erased === 0, `${erased}/${inkTotal} px`)
  }
}

/* ==================== ② 汇总表 ==================== */
console.log('\n' + '='.repeat(104))
console.log('② 汇总：带宽与三档 Δ_after（判据只看 Δ≥20，不看 Δ 是否单调）')
console.log('='.repeat(104))
console.log('  线位 模型  带宽  带=[lo,hi]      灰线 |   light Δ    medium Δ    strong Δ  | 判定')
for (const r of summary) {
  const ds = STRENGTHS.map((s) => r.deltas[s])
  const okAll = STRENGTHS.every((s) => r.deltas[s] >= 20 && r.ml[s] < 245)
  console.log(
    `  ${r.pos}   ${r.model}   ${String(r.bandWidth).padStart(3)}   [${String(r.bandLo).padStart(3)},${String(r.bandHi).padStart(3)}]` +
      `   ${String(r.gray).padStart(4)} |` +
      ds.map((d) => d.toFixed(1).padStart(10)).join(' ') +
      `  | ${okAll ? '全部达标 ✅' : '有失败 ❌'}`
  )
}

// 观察（非契约）：Δ 不必随强度单调——契约只约束 Δ≥20。此处仅记录，不作为缺陷上报。
{
  const n2 = summary.find((r) => r.pos === 'P1' && r.model === 'N2')
  const seq = STRENGTHS.map((s) => n2.deltas[s])
  const monotone = seq[0] <= seq[1] + 1e-9 && seq[1] <= seq[2] + 1e-9
  if (!monotone) {
    NOISE_DEFECT_NOISE.push(`N2/P1 Δ 序列 ${seq.map((v) => v.toFixed(1)).join('/')} 非单调（契约不要求单调，仅 Δ≥20；判为正常）`)
  }
}

console.log('\n' + '='.repeat(104))
console.log(`②③④⑤ 汇总: ${pass} 项通过, ${fail} 项失败`)
if (NOISE_DEFECT_NOISE.length) {
  console.log('契约外观察（不作为缺陷）：')
  for (const o of NOISE_DEFECT_NOISE) console.log('  - ' + o)
}
console.log('='.repeat(104))
process.exit(fail ? 1 : 0)
