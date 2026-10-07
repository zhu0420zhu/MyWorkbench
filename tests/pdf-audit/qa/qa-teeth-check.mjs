/**
 * 任务 #12 ① —— 「牙齿检验」：证明 Δ≥20（+ mean(灰线)<245）这条断言【能判别】。
 *
 * 主理人实测：N1（纸底 215、连通带下沿 207）灰线压到 204 时，strong 档 Δ 塌到 19（不达 20）。
 * 本脚本用【QA 自有造图器】复算，并在 203/204/205/206/207 逐点量出真实拐点。
 *
 * 运行：
 *   NODE_OPTIONS="" "<node>" --experimental-loader=./tests/loader.mjs \
 *     --experimental-strip-types tests/pdf-audit/qa/qa-teeth-check.mjs
 */
import { classifyTones, enhanceImageData } from '../../../src/renderer/src/utils/pdfEnhance.ts'
import { makeScanPage, lineIndices, paperIndices, meanLumaAt, intersectSize } from './qa-noise-gen.mjs'

const W = 600
const H = 800
const LINE = { x0: 300, x1: 520, y0: 300, y1: 308 }
const STRENGTHS = ['light', 'medium', 'strong']

let pass = 0
let fail = 0
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? '  → ' + detail : ''}`)
  cond ? pass++ : fail++
}

console.log('='.repeat(96))
console.log('① 牙齿检验：Δ≥20 契约在 N1（纸底 215 / 带下沿 207）下的可失效性 + 拐点定位')
console.log('='.repeat(96))
console.log(`QA 自有造图器  ${W}x${H}  N1 均匀±8  灰线 ${LINE.x1 - LINE.x0}×${LINE.y1 - LINE.y0} = ${(LINE.x1 - LINE.x0) * (LINE.y1 - LINE.y0)} px`)

const LEVELS = [178, 200, 202, 203, 204, 205, 206, 207, 208, 210]
const rows = []

console.log('\n  灰线  带下沿  带=[lo,hi]       带外? | light Δ/pass   medium Δ/pass   strong Δ/pass   mean(strong)')
console.log('  ' + '-'.repeat(92))

for (const g of LEVELS) {
  const { data } = makeScanPage(W, H, { model: 'N1', paper: 215, ink: 150, grayLevel: g, line: LINE })
  const cls = classifyTones(data)
  const outside = cls.paperBandLo > g
  const lineIdx = lineIndices(W, LINE)
  const paperIdx = paperIndices(data, W, cls.paperMode)
  const row = { g, bandLo: cls.paperBandLo, bandHi: cls.paperBandHi, outside, per: {} }
  let cells = ''
  for (const s of STRENGTHS) {
    const d = new Uint8ClampedArray(data)
    enhanceImageData(d, W, H, s)
    const delta = meanLumaAt(d, paperIdx) - meanLumaAt(d, lineIdx)
    const ml = meanLumaAt(d, lineIdx)
    const ok = delta >= 20 && ml < 245
    row.per[s] = { delta, ml, ok }
    cells += `  ${delta.toFixed(1).padStart(5)}/${ok ? '✅' : '❌'}`
  }
  rows.push(row)
  console.log(
    `  ${String(g).padStart(4)}  ${String(cls.paperBandLo).padStart(5)}   [${cls.paperBandLo},${cls.paperBandHi}]`.padEnd(34) +
      `  ${String(outside).padStart(4)}  |${cells}   ${row.per.strong.ml.toFixed(1)}`
  )
}

/* ---------- 结论断言 ---------- */
console.log('\n' + '='.repeat(96))
console.log('结论断言')
console.log('='.repeat(96))

const at = (g) => rows.find((r) => r.g === g)

// 1) 断言不是恒真：低亮度灰线（178）三档必须全过
{
  const r = at(178)
  const allOk = STRENGTHS.every((s) => r.per[s].ok)
  check('恒真性否证：灰线=178（明显在带外）三档 Δ≥20 全过', allOk,
    STRENGTHS.map((s) => `${s} Δ=${r.per[s].delta.toFixed(1)}`).join(', '))
}

// 2) 复现主理人实测：灰线=204 → strong Δ < 20（契约失败）
{
  const r = at(204)
  const d = r.per.strong.delta
  check('复现主理人实测：灰线=204 → strong 档 Δ<20（不通过契约）', !r.per.strong.ok,
    `强 Δ=${d.toFixed(1)}（契约要求 ≥20，差 ${(20 - d).toFixed(1)}）  mean(灰线)=${r.per.strong.ml.toFixed(1)}`)
}

// 3) 逐点量出拐点：strong 档首个性失效的灰线亮度
{
  const firstFail = rows.find((r) => !r.per.strong.ok)
  const lastPass = [...rows].reverse().find((r) => r.g < (firstFail ? firstFail.g : 999) && r.per.strong.ok)
  check('拐点可定位：strong 档存在「先过后败」的真实分界', !!firstFail && !!lastPass,
    lastPass && firstFail
      ? `灰线 ${lastPass.g} 通过(Δ=${lastPass.per.strong.delta.toFixed(1)})，灰线 ${firstFail.g} 失败(Δ=${firstFail.per.strong.delta.toFixed(1)})`
      : '未找到分界')
  console.log(`     ⇒ strong 档在 N1 上的 Δ≥20 拐点落在灰线亮度 ${lastPass ? lastPass.g : '?'} 与 ${firstFail ? firstFail.g : '?'} 之间`)
}

// 4) 204/205/206/207 四个点逐点报（主理人点名）
console.log('\n  点名复核 204/205/206/207（strong 档）：')
for (const g of [204, 205, 206, 207]) {
  const r = at(g)
  const s = r.per.strong
  console.log(
    `    灰线=${g}  带=[${r.bandLo},${r.bandHi}] 带外=${r.outside}  ` +
      `Δ=${s.delta.toFixed(1)}  mean(灰线)=${s.ml.toFixed(1)}  → 契约${s.ok ? '通过 ✅' : '不通过 ❌'}`
  )
}

// 5) 206/207 起灰线进入连通带（属于「脏背景」，被设计为白化）
{
  const in204 = at(204).outside
  const in206 = at(206).outside
  check('带外→带内 的转换点可测（204 在带外，206 已入带）', in204 === true && in206 === false,
    `204 带外=${in204}（带下沿 ${at(204).bandLo}）；206 带外=${in206}（带下沿 ${at(206).bandLo}）`)
}

/* ---------- 互斥性（顺带，正式的 ③ 在 qa-noise-models.mjs） ---------- */
{
  const r = at(204)
  const { data } = makeScanPage(W, H, { model: 'N1', paper: 215, ink: 150, grayLevel: 204, line: LINE })
  const cls = classifyTones(data)
  const inter = intersectSize(lineIndices(W, LINE), paperIndices(data, W, cls.paperMode))
  check('灰线像素集合与纸底参照集合互斥（不在高亮区重复计入）', inter === 0, `交集=${inter}`)
}

console.log('\n' + '='.repeat(96))
console.log(`牙齿检验汇总: ${pass} 项通过, ${fail} 项失败`)
console.log('判定：Δ≥20 断言【可失效】（灰线=204 时 strong 实测不达 20），故非恒真、具备判别力。')
console.log('='.repeat(96))
process.exit(fail ? 1 : 0)
