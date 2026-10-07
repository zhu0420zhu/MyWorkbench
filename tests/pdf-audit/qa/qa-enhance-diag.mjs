/**
 * 任务 #6 诊断：三档强度在各素材上的实际表现 + 退化保护触发情况。
 */
import './qa-dom-shim.mjs'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { autoLevels, analyze, STRENGTH_PRESETS } from '../../../src/renderer/src/utils/pdfEnhance.ts'
import { renderPagePixels } from './qa-render.mjs'
import { enhancePdf } from './_gen-pdftools.ts'
import { makeVectorScan, makeRasterScan } from './qa-sources.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'qa-work')
const FIX = join(HERE, '..', 'fixtures')
mkdirSync(OUT, { recursive: true })

function buckets(data) {
  const b = [0, 0, 0, 0, 0]
  const n = data.length / 4
  for (let i = 0; i < data.length; i += 4) {
    const y = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000
    if (y < 100) b[0]++; else if (y < 140) b[1]++; else if (y < 200) b[2]++; else if (y < 240) b[3]++; else b[4]++
  }
  return b.map((v) => (100 * v / n).toFixed(1))
}

const srcs = [
  ['稀疏矢量(93%背景)', await makeVectorScan(false)],
  ['密集矢量', await makeVectorScan(true)],
  ['噪点栅格扫描件', await makeRasterScan()],
  ['既有 enhance-source.pdf', readFileSync(join(FIX, 'enhance-source.pdf'))]
]

for (const [label, src] of srcs) {
  console.log('\n' + '='.repeat(84))
  console.log('源：' + label)
  console.log('='.repeat(84))
  const srcPix = await renderPagePixels(src, 0, 1.0)
  console.log('  源分桶[<100,100-139,140-199,200-239,≥240]%= ' + JSON.stringify(buckets(srcPix.data)))
  for (const strength of ['light', 'medium', 'strong']) {
    const pre = STRENGTH_PRESETS[strength]
    const lv = autoLevels(srcPix.data, pre.lowPercentile, pre.highPercentile)
    const degenerate = lv.blackPoint === 0 && lv.whitePoint === 1
    const { out, stats } = await enhancePdf(src, strength, 'png')
    writeFileSync(join(OUT, `diag2-${label.slice(0, 4)}-${strength}.pdf`), Buffer.from(out))
    const st = analyze((await renderPagePixels(out, 0, 1.0)).data)
    console.log(`  ${strength.padEnd(6)} levels(black=${lv.blackPoint.toFixed(2)},white=${lv.whitePoint.toFixed(2)})` +
      `${degenerate ? ' [退化/满量程]' : '              '} ` +
      `=> std=${st.stdLuma.toFixed(1)} dark=${(100 * st.darkRatio).toFixed(1)}% haze=${(100 * st.hazeRatio).toFixed(1)}% light=${(100 * st.lightRatio).toFixed(1)}% ` +
      `| 产品自报 after.std=${stats[0].after.stdLuma.toFixed(1)}`)
  }
}
