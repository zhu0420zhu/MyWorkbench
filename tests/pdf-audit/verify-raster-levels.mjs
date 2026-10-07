/**
 * 验收「图像化压缩的档位语义与结构压缩一致」（审计 P1#4 / 本轮拍板①）。
 *
 * 修复前：同一「压缩」面板里两种模式的「低/中/高」方向是反的 ——
 *   结构压缩 低 = 压得最轻、高 = 压得最狠；
 *   图像化压缩 低 = scale 1.0 / JPEG 55%（压得最狠）、高 = 2.0 / 85%（压得最轻）。
 * 用户按同一面板的直觉选「低」，在两种模式下会拿到相反的结果。
 *
 * 断言：
 *   1) 档位参数（分辨率 / JPEG 质量 / 长边上限）随「低→高」单调递减 = 压缩强度递增
 *   2) 结构压缩在同一素材上的字节数也是「低 > 中 > 高」（两模式同向，可交叉比对）
 *   3) 档位提示文案由 preset 数值生成，且按「结果」命名（高画质 / 均衡 / 最小体积），
 *      不含与实际参数矛盾的旧说法
 *   4) 真实产出确实分化：图像主导素材上三档字节数严格递减、互不相同
 *   5) 与结构压缩共用兜底政策：栅格化必然变大的纯文字文件上，三档都保留原文件
 *
 * 图像化压缩走**真实生产实现**（pdfRasterCompress.rasterCompressPdf），
 * 仅把 canvas 后端换成 pdf.js + @napi-rs/canvas（见 lib/node-render-backend.mjs）。
 *
 * 运行：
 *   NODE_OPTIONS="" node --experimental-loader=./tests/loader.mjs \
 *     --experimental-strip-types tests/pdf-audit/verify-raster-levels.mjs
 */
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import {
  RASTER_LEVELS,
  RASTER_PRESETS,
  rasterCompressPdf,
  rasterLevelHint
} from '../../src/renderer/src/utils/pdfRasterCompress.ts'
import { structureCompressPdf } from '../../src/renderer/src/utils/pdfCompress.ts'
import { nodeRender, noiseJpeg, installCanvasShim } from './lib/node-render-backend.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CN = { low: '低', medium: '中', high: '高' }

// rasterCompressPdf 内部要合成白底（透明画布 JPEG 编码会变黑页），node 下需 document shim
installCanvasShim()

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail) {
  if (cond) {
    pass++
    console.log('  [PASS] ' + name + (detail ? '  ' + detail : ''))
  } else {
    fail++
    failures.push(name)
    console.log('  [FAIL] ' + name + (detail ? '  ' + detail : ''))
  }
}
function section(t) {
  console.log('\n' + '='.repeat(78))
  console.log(t)
  console.log('='.repeat(78))
}

/** 图像主导素材：1 页 595×842，铺一张高熵 JPEG（栅格化压缩在这种文件上才该有收益） */
async function imageHeavyPdf() {
  const doc = await PDFDocument.create()
  const jpg = await doc.embedJpg(noiseJpeg(1600, 1100, 90))
  const page = doc.addPage([595, 842])
  page.drawImage(jpg, { x: 0, y: 0, width: 595, height: 842 })
  return await doc.save()
}

/* ────────────────────────────────────────────────────────────────────── */
section('1. 档位参数：低 → 高压得越来越狠（压缩强度递增）')
{
  const p = RASTER_PRESETS
  for (const k of ['scale', 'jpeg', 'maxSide']) {
    const vals = RASTER_LEVELS.map((l) => p[l][k])
    check(
      k + ' 随档位单调递减（低 > 中 > 高）',
      vals[0] > vals[1] && vals[1] > vals[2],
      vals.join(' > ')
    )
  }
  check('三档定义齐全且顺序为 低/中/高', RASTER_LEVELS.join(',') === 'low,medium,high', RASTER_LEVELS.join(','))
  for (const l of RASTER_LEVELS) {
    console.log(
      '      ' + CN[l] + '：scale=' + p[l].scale + '  jpeg=' + Math.round(p[l].jpeg * 100) + '%' +
      '  长边上限=' + p[l].maxSide + 'px  结果=' + p[l].result
    )
  }
}

/* ────────────────────────────────────────────────────────────────────── */
section('2. 与结构压缩同向（同一素材上两模式的字节数排序一致）')
const heavy = await imageHeavyPdf()
{
  const structSizes = {}
  for (const l of RASTER_LEVELS) structSizes[l] = (await structureCompressPdf(heavy, l)).bytes.byteLength
  console.log('      结构压缩：' + RASTER_LEVELS.map((l) => CN[l] + '=' + structSizes[l]).join('  '))
  check(
    '结构压缩也是 低 > 中 > 高（压缩强度递增）',
    structSizes.low > structSizes.medium && structSizes.medium > structSizes.high,
    RASTER_LEVELS.map((l) => structSizes[l]).join(' > ')
  )

  const rasterSizes = {}
  for (const l of RASTER_LEVELS) {
    const r = await rasterCompressPdf(heavy, l, nodeRender)
    rasterSizes[l] = { size: r.bytes.byteLength, kept: r.keptOriginal }
  }
  console.log(
    '      图像化压缩：' +
      RASTER_LEVELS.map((l) => CN[l] + '=' + rasterSizes[l].size + (rasterSizes[l].kept ? '(留原)' : '')).join('  ') +
      '   原文件=' + heavy.byteLength
  )
  check(
    '图像化压缩也是 低 > 中 > 高（两模式方向一致）',
    rasterSizes.low.size > rasterSizes.medium.size && rasterSizes.medium.size > rasterSizes.high.size,
    RASTER_LEVELS.map((l) => rasterSizes[l].size).join(' > ')
  )
  check('三档产出互不相同（旧实现只有两种行为）', new Set(RASTER_LEVELS.map((l) => rasterSizes[l].size)).size === 3)
  check(
    '两模式在同一素材上的档位排序一致',
    (structSizes.low > structSizes.medium && structSizes.medium > structSizes.high) ===
      (rasterSizes.low.size > rasterSizes.medium.size && rasterSizes.medium.size > rasterSizes.high.size)
  )
}

/* ────────────────────────────────────────────────────────────────────── */
section('3. 档位文案 = 实现（由 preset 数值生成，按结果命名）')
{
  const hints = {}
  for (const l of RASTER_LEVELS) hints[l] = rasterLevelHint(l)
  for (const l of RASTER_LEVELS) {
    const p = RASTER_PRESETS[l]
    console.log('      ' + CN[l] + '：' + hints[l])
    check(
      CN[l] + '档文案含实际参数（' + p.scale + ' 倍 / ' + Math.round(p.jpeg * 100) + '% / ' + p.maxSide + 'px）',
      hints[l].includes(String(p.scale)) &&
        hints[l].includes(String(Math.round(p.jpeg * 100))) &&
        hints[l].includes(String(p.maxSide))
    )
    check(CN[l] + '档文案含按结果命名的说法', hints[l].includes(p.result), JSON.stringify(p.result))
  }
  check('低档明确「体积最大」', /体积最大/.test(hints.low))
  check('高档明确「最小体积」', /最小体积/.test(hints.high))
  // 旧文案是反向的（低=画质最差/压缩最狠）；这里断言反向说法已消失
  check(
    '不再出现反向说法（低档不得被描述为压缩最狠/画质最低）',
    !/压缩最狠|画质最低/.test(hints.low) && !/压缩最轻|画质最好/.test(hints.high)
  )

  // 面板确实用这套文案（而不是另写一套字符）
  const panel = await readFile(join(HERE, '..', '..', 'src', 'renderer', 'src', 'pages', 'PdfTools.tsx'), 'utf8')
  check('面板档位提示由 rasterLevelHint 生成', /rasterLevelHint\('low'\)/.test(panel) && /rasterLevelHint\('high'\)/.test(panel))
  check('面板档位参数取自 RASTER_PRESETS（不再内联字面量）', /RASTER_PRESETS\[level\]/.test(panel))
  check(
    '面板未再内联旧的写死档位文案',
    !/渲染分辨率与画质最低、体积最小/.test(panel) && !/画质最好、体积最大/.test(panel)
  )
}

/* ────────────────────────────────────────────────────────────────────── */
section('4. 兜底：栅格化必然变大的纯文字文件 → 三档都保留原文件')
{
  const text = await readFile(join(HERE, 'fixtures', 'enhance-source.pdf'))
  console.log('      素材 enhance-source.pdf（纯文字 3 页）' + text.byteLength + ' B')
  for (const l of RASTER_LEVELS) {
    const r = await rasterCompressPdf(text, l, nodeRender)
    check(
      CN[l] + '档不输出更大的文件（保留原文件并如实标记）',
      r.keptOriginal === true && r.bytes.byteLength === text.byteLength,
      'keptOriginal=' + r.keptOriginal + '  ' + r.bytes.byteLength + ' B'
    )
  }
}

console.log('\n' + '='.repeat(78))
console.log(`结果: ${pass} 项通过, ${fail} 项失败`)
if (fail) console.log('  失败项:\n   - ' + failures.join('\n   - '))
console.log('='.repeat(78))
process.exit(fail ? 1 : 0)
