/**
 * 「保版式改字」样式生效取证：用**像素数字**与**对象级字体名**证明
 * fontFamily / fontSize / color / bold / italic / underline 真的改了输出，
 * 而不是"看图正常"。
 *
 * 样本：tests/pdf-audit/scratch/out/zh-edit-src.pdf 第 1 页（3 页样本，含中文行、
 *       ASCII 行、内嵌位图）。两个待替换行的几何取自 out/candidate-reps.json。
 *
 * 运行：node --experimental-loader=./tests/loader.mjs --experimental-strip-types \
 *       tests/pdf-audit/scratch/verify-inplace-style.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')
const SRC = join(OUT, 'zh-edit-src.pdf')

/* canvas 替身：必须在调用 replacePdfText 之前装好 */
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error('替身未实现 createElement: ' + tag)
    const c = createCanvas(1, 1)
    c.toBlob = (cb, type) => {
      try {
        cb(new Blob([c.toBuffer(type || 'image/png')], { type: type || 'image/png' }))
      } catch {
        cb(null)
      }
    }
    return c
  }
}

const { replacePdfText } = await import('../../../src/renderer/src/utils/pdfInPlaceReplace.ts')
const M = await import('./pdf-region-metrics.mjs')

const sha = (b) => createHash('sha256').update(b).digest('hex')
const f3 = (v) => (typeof v === 'number' ? v.toFixed(3) : String(v))

let pass = 0
let fail = 0
function check(label, cond, detail = '') {
  if (cond) {
    pass++
    console.log('  ✅ ' + label + (detail ? '  → ' + detail : ''))
  } else {
    fail++
    console.log('  ❌ ' + label + (detail ? '  → ' + detail : ''))
  }
}

/* ---------- 待替换行的几何（来自 out/candidate-reps.json，已由 pdf.js 实测） ---------- */
const ZH = {
  page: 0,
  rect: { x: 62.8, y: 639.849, width: 336, height: 12 },
  baseline: 642.489,
  fontSize: 12,
  color: { r: 0, g: 0, b: 0 },
  bgColor: { r: 1, g: 1, b: 1 },
  align: 'left'
}
const ASCII = {
  page: 0,
  rect: { x: 62.8, y: 697.899, width: 65.844, height: 12 },
  baseline: 700.539,
  fontSize: 12,
  color: { r: 0, g: 0, b: 0 },
  bgColor: { r: 1, g: 1, b: 1 },
  align: 'left'
}
const ZH_TEXT = '本合同自双方签字之日起生效'

/* 度量区域（PDF 用户坐标）。刻意避开相邻行，避免把别的行的墨迹算进来 */
const REG_ZH = { x: 56, y: 632, width: 380, height: 32 } // 中文行：左侧留白 → 行上下各留 8pt
const REG_ASCII = { x: 56, y: 692, width: 200, height: 22 }
const REG_BLANK = { x: 480, y: 700, width: 60, height: 30 } // 右页边空白，应几乎全白

const srcBytes = new Uint8Array(await readFile(SRC))
await mkdir(OUT, { recursive: true })

console.log('='.repeat(96))
console.log('样式生效取证（像素数字 + 字体名）')
console.log('='.repeat(96))
console.log('样本 : ' + SRC + '  (' + srcBytes.length + ' 字节, sha ' + sha(srcBytes).slice(0, 16) + ')')
console.log('中文行 rect=' + JSON.stringify(ZH.rect) + ' baseline=' + ZH.baseline)
console.log('ASCII行 rect=' + JSON.stringify(ASCII.rect) + ' baseline=' + ASCII.baseline)

/* ---------- S0 工具自检 + 源文件基线 ---------- */
console.log('\n' + '-'.repeat(96))
console.log('[S0] 工具自检 + 源文件基线（scale=2）')
console.log('-'.repeat(96))
const srcRender = await M.renderPage(srcBytes, 1, 2)
console.log('  canvas      = ' + srcRender.canvas.width + 'x' + srcRender.canvas.height)
const blankMean = M.meanColor(srcRender, REG_BLANK)
const blankRed = M.redInkCount(srcRender, REG_BLANK)
const blankInk = M.inkCount(srcRender, REG_BLANK)
console.log('  空白区 meanColor = (' + f3(blankMean.r) + ',' + f3(blankMean.g) + ',' + f3(blankMean.b) + ')')
console.log('  空白区 redInk=' + blankRed + '  ink=' + blankInk)
check('工具自检：右页边空白区几乎全白', blankMean.r > 0.98 && blankMean.g > 0.98 && blankMean.b > 0.98, JSON.stringify(blankMean))
check('工具自检：空白区无红色像素', blankRed === 0, 'redInk=' + blankRed)

const srcZh = M.inkBBox(srcRender, REG_ZH)
const srcAscii = M.inkBBox(srcRender, REG_ASCII)
const srcZhSub = M.subBaselineInkCount(srcRender, ZH.rect, ZH.baseline)
const srcAsciiSub = M.subBaselineInkCount(srcRender, ASCII.rect, ASCII.baseline)
console.log('  源·中文行墨迹 bbox=' + JSON.stringify(srcZh.bbox) + ' ink=' + srcZh.ink)
console.log('  源·中文行基线下方墨迹=' + srcZhSub)
console.log('  源·ASCII行墨迹 bbox=' + JSON.stringify(srcAscii.bbox) + ' ink=' + srcAscii.ink)
console.log('  源·ASCII行基线下方墨迹=' + srcAsciiSub)
console.log('  源·中文行区域 redInk=' + M.redInkCount(srcRender, REG_ZH))
check('源·正文是黑字（红像素≈0）', M.redInkCount(srcRender, REG_ZH) < 20, 'redInk=' + M.redInkCount(srcRender, REG_ZH))
// 注意：基线下方那条带里会有几十个像素的抗锯齿灰边（"Y"的下沿），
// 因此"无下划线"的判据是量级（<120），而不是严格 0；有无下划线看的是增量。
check('源·ASCII 行基线下方只有抗锯齿边（无下划线）', srcAsciiSub < 120, 'subBaselineInk=' + srcAsciiSub)

/* ---------- 渲染工具 ---------- */
async function renderOut(label, reps, annotations) {
  const out = await replacePdfText(srcBytes, reps, annotations)
  await writeFile(join(OUT, 'style-' + label + '.pdf'), out)
  const rendered = await M.renderPage(out, 1, 2)
  return { out, rendered }
}

/* ---------- C1 字号 12 → 20（中文，栅格路径） ---------- */
console.log('\n' + '-'.repeat(96))
console.log('[C1] 字号 12 → 20（中文栅格路径）：墨迹包围盒应变高')
console.log('-'.repeat(96))
const c1a = await renderOut('c1-size12', [{ ...ZH, newText: ZH_TEXT, fontSize: 12 }])
const c1b = await renderOut('c1-size20', [{ ...ZH, newText: ZH_TEXT, fontSize: 20 }])
const bb12 = M.inkBBox(c1a.rendered, REG_ZH)
const bb20 = M.inkBBox(c1b.rendered, REG_ZH)
console.log('  12pt 墨迹 bbox height=' + f3(bb12.bbox.height) + '  ink=' + bb12.ink + '  (bbox=' + JSON.stringify(bb12.bbox) + ')')
console.log('  20pt 墨迹 bbox height=' + f3(bb20.bbox.height) + '  ink=' + bb20.ink + '  (bbox=' + JSON.stringify(bb20.bbox) + ')')
console.log('  高度比 = ' + f3(bb20.bbox.height / bb12.bbox.height) + '   （理论 ≈ 20/12 = 1.667）')
check('20pt 墨迹包围盒明显变高', bb20.bbox.height > bb12.bbox.height * 1.4,
  f3(bb12.bbox.height) + ' → ' + f3(bb20.bbox.height) + ' pt（比 ' + f3(bb20.bbox.height / bb12.bbox.height) + '×）')
check('20pt 墨迹像素数明显增多', bb20.ink > bb12.ink * 1.5, bb12.ink + ' → ' + bb20.ink)
check('12pt 对照与源文件同量级（说明度量区域没算进别的行）', Math.abs(bb12.bbox.height - srcZh.bbox.height) < 2,
  '源 ' + f3(srcZh.bbox.height) + ' vs 12pt 改后 ' + f3(bb12.bbox.height))

/* ---------- C2 颜色改红（中文，栅格路径） ---------- */
console.log('\n' + '-'.repeat(96))
console.log('[C2] 颜色改红：红像素应从 0 变成一大片')
console.log('-'.repeat(96))
const c2 = await renderOut('c2-red', [{ ...ZH, newText: ZH_TEXT, color: { r: 1, g: 0, b: 0 } }])
// 紧框：只框住新文字的落位（13 字 × 12pt ≈ 156pt 宽），让"偏红"信号最集中
const TIGHT_ZH = { x: 62.8, y: 639.849, width: 160, height: 14 }
const c2Red = M.redInkCount(c2.rendered, REG_ZH)
const c2Tight = M.meanColor(c2.rendered, TIGHT_ZH)
const srcTight = M.meanColor(srcRender, TIGHT_ZH)
const srcZhMean = M.meanColor(srcRender, REG_ZH)
const c2Mean = M.meanColor(c2.rendered, REG_ZH)
console.log('  源·中文行区域  redInk=' + M.redInkCount(srcRender, REG_ZH) + '  meanColor=(' + f3(srcZhMean.r) + ',' + f3(srcZhMean.g) + ',' + f3(srcZhMean.b) + ')')
console.log('  改红后         redInk=' + c2Red + '  meanColor=(' + f3(c2Mean.r) + ',' + f3(c2Mean.g) + ',' + f3(c2Mean.b) + ')')
console.log('  紧框(160x14) 源 meanColor=(' + f3(srcTight.r) + ',' + f3(srcTight.g) + ',' + f3(srcTight.b) + ')  r-g=' + f3(srcTight.r - srcTight.g))
console.log('  紧框(160x14) 红 meanColor=(' + f3(c2Tight.r) + ',' + f3(c2Tight.g) + ',' + f3(c2Tight.b) + ')  r-g=' + f3(c2Tight.r - c2Tight.g))
check('改红后红像素显著增加', c2Red > 200, '0 → ' + c2Red)
check('改红后紧框内红通道显著高于绿/蓝（偏红）',
  c2Tight.r - c2Tight.g > 0.03 && c2Tight.r - c2Tight.b > 0.03,
  '源 r-g=' + f3(srcTight.r - srcTight.g) + ' → 改后 r-g=' + f3(c2Tight.r - c2Tight.g) +
    '，r-b=' + f3(c2Tight.r - c2Tight.b))

/* ---------- C3 粗体（中文，栅格路径） ---------- */
console.log('\n' + '-'.repeat(96))
console.log('[C3] bold:true（中文栅格路径）：同字号同文字，墨迹应更重')
console.log('-'.repeat(96))
const c3a = await renderOut('c3-regular', [{ ...ZH, newText: ZH_TEXT, bold: false }])
const c3b = await renderOut('c3-bold', [{ ...ZH, newText: ZH_TEXT, bold: true }])
const inkRegular = M.inkCount(c3a.rendered, REG_ZH)
const inkBold = M.inkCount(c3b.rendered, REG_ZH)
console.log('  bold=false ink=' + inkRegular + '   bold=true ink=' + inkBold + '   比 = ' + f3(inkBold / inkRegular))
check('bold 后墨迹像素数增加', inkBold > inkRegular * 1.05, inkRegular + ' → ' + inkBold + '（' + f3(inkBold / inkRegular) + '×）')

/* ---------- C4 下划线（中文，栅格路径） ---------- */
console.log('\n' + '-'.repeat(96))
console.log('[C4] underline:true（中文栅格路径）：基线下方应凭空出现一条墨迹')
console.log('-'.repeat(96))
const c4 = await renderOut('c4-underline', [{ ...ZH, newText: ZH_TEXT, underline: true }])
const c4sub = M.subBaselineInkCount(c4.rendered, ZH.rect, ZH.baseline)
const c4ink = M.inkCount(c4.rendered, REG_ZH)
// 对照组必须用【同一段文字、同一字号、只是没下划线】的 c1a，而不是源文件
//（源文件那一行是 27 字的整句，墨迹量本来就不一样，拿它比没有意义）
const c1aSub = M.subBaselineInkCount(c1a.rendered, ZH.rect, ZH.baseline)
console.log('  对照(同文字/12pt/无下划线) 基线下方墨迹=' + c1aSub + '   区域 ink=' + bb12.ink)
console.log('  加下划线                   基线下方墨迹=' + c4sub + '   区域 ink=' + c4ink)
console.log('  （参考）源整句 基线下方墨迹=' + srcZhSub + '，区域 ink=' + srcZh.ink)
check('下划线在基线下方产生墨迹', c4sub > c1aSub + 50, c1aSub + ' → ' + c4sub + '（+ ' + (c4sub - c1aSub) + '）')
check('区域总墨迹也随之增加（同文字对照）', c4ink > bb12.ink * 1.05,
  bb12.ink + ' → ' + c4ink + '（' + f3(c4ink / bb12.ink) + '×）')

/* ---------- C5 仅高亮注解，不改文字 ---------- */
console.log('\n' + '-'.repeat(96))
console.log('[C5] 只加一条 highlight（不改任何文字）：区域色应偏黄，文字层不变')
console.log('-'.repeat(96))
const hlRect = { x: 62.8, y: 639.849, width: 336, height: 14 }
const c5 = await renderOut('c5-highlight-only', [], [
  { page: 0, rect: hlRect, kind: 'highlight', color: { r: 1, g: 0.9, b: 0 } }
])
const c5Mean = M.meanColor(c5.rendered, REG_ZH)
const c5Tight = M.meanColor(c5.rendered, hlRect)
const srcHlTight = M.meanColor(srcRender, hlRect)
console.log('  源·区域 meanColor=(' + f3(srcZhMean.r) + ',' + f3(srcZhMean.g) + ',' + f3(srcZhMean.b) + ')')
console.log('  高亮后      meanColor=(' + f3(c5Mean.r) + ',' + f3(c5Mean.g) + ',' + f3(c5Mean.b) + ')')
console.log('  高亮矩形内 源 meanColor=(' + f3(srcHlTight.r) + ',' + f3(srcHlTight.g) + ',' + f3(srcHlTight.b) + ')  r-b=' + f3(srcHlTight.r - srcHlTight.b))
console.log('  高亮矩形内 后 meanColor=(' + f3(c5Tight.r) + ',' + f3(c5Tight.g) + ',' + f3(c5Tight.b) + ')  r-b=' + f3(c5Tight.r - c5Tight.b) + ' g-b=' + f3(c5Tight.g - c5Tight.b))
console.log('  高亮后区域 redInk=' + M.redInkCount(c5.rendered, REG_ZH) + '（黄色不算红）')
check('高亮矩形内呈黄色主导（r、g 明显高于 b）',
  c5Tight.r - c5Tight.b > 0.15 && c5Tight.g - c5Tight.b > 0.15,
  'r-b=' + f3(c5Tight.r - c5Tight.b) + '，g-b=' + f3(c5Tight.g - c5Tight.b))
check('源·同一矩形内是中性色（r≈g≈b，无高亮）', Math.abs(srcHlTight.r - srcHlTight.b) < 0.02 && Math.abs(srcHlTight.r - srcHlTight.g) < 0.02,
  '(' + f3(srcHlTight.r) + ',' + f3(srcHlTight.g) + ',' + f3(srcHlTight.b) + ')')
check('高亮后区域整体蓝通道下降', c5Mean.b < srcZhMean.b - 0.08,
  'b ' + f3(srcZhMean.b) + ' → ' + f3(c5Mean.b) + '（Δ=' + f3(c5Mean.b - srcZhMean.b) + '）')
const srcTextP1 = await M.pageText(srcBytes, 1)
const c5TextP1 = await M.pageText(c5.out, 1)
check('只加注解时文字层完全不变', c5TextP1 === srcTextP1,
  '源 ' + srcTextP1.length + ' 字符 vs 产物 ' + c5TextP1.length + ' 字符')

/* ---------- C6 矢量路径：bold/italic 换字体族（对象级证据） ---------- */
console.log('\n' + '-'.repeat(96))
console.log('[C6] 矢量路径（纯 ASCII）bold/italic → /BaseFont 应换字面')
console.log('-'.repeat(96))
const fontCases = [
  ['plain', {}, 'Helvetica'],
  ['bold', { bold: true }, 'Helvetica-Bold'],
  ['italic', { italic: true }, 'Helvetica-Oblique'],
  ['bold+italic', { bold: true, italic: true }, 'Helvetica-BoldOblique']
]
const srcFonts = await M.pageBaseFonts(srcBytes, 1)
console.log('  源·第1页 /BaseFont = ' + JSON.stringify(srcFonts))
for (const [name, style, expect] of fontCases) {
  const r = await renderOut('c6-' + name.replace('+', ''), [{ ...ASCII, newText: 'FINAL-2026-APPROVED', ...style }])
  const fonts = await M.pageBaseFonts(r.out, 1)
  const hit = fonts.find((x) => x === expect)
  console.log('  ' + name.padEnd(12) + ' /BaseFont = ' + JSON.stringify(fonts) + '   期望含 ' + expect + ' → ' + (hit ? '命中' : '未命中'))
  check('[矢量] ' + name + ' 使用 ' + expect, !!hit, JSON.stringify(fonts))
}

/* ---------- C7 矢量路径下划线 ---------- */
console.log('\n' + '-'.repeat(96))
console.log('[C7] 矢量路径（纯 ASCII）underline:true → 基线下方出现墨迹')
console.log('-'.repeat(96))
const c7 = await renderOut('c7-vector-underline', [{ ...ASCII, newText: 'FINAL-2026-APPROVED', underline: true }])
const c7sub = M.subBaselineInkCount(c7.rendered, ASCII.rect, ASCII.baseline)
console.log('  源·ASCII 基线下方墨迹=' + srcAsciiSub + '   改后=' + c7sub)
check('矢量下划线在基线下方产生墨迹', c7sub > srcAsciiSub + 30, srcAsciiSub + ' → ' + c7sub)

/* ---------- C8 矢量路径：用 pdf.js 提取几何证明字号/基线真的按新值写回 ---------- */
console.log('\n' + '-'.repeat(96))
console.log('[C8] 矢量路径（纯 ASCII）字号 12 → 20：pdf.js 提取的几何应显示 20pt')
console.log('-'.repeat(96))
{
  const newText = 'ENLARGED-TEXT-20'
  const c8 = await renderOut('c8-vector-size20', [{ ...ASCII, newText, fontSize: 20 }])
  const geo = await M.textGeometry(c8.out, 1)
  const hit = geo.find((it) => it.str.includes(newText))
  if (!hit) {
    check('C8 找到新写入的矢量文字几何', false, '未找到 ' + newText)
  } else {
    console.log('  pdf.js 几何: x=' + f3(hit.x) + ' baseline=' + f3(hit.baseline) + ' size=' + f3(hit.fontSize) + ' width=' + f3(hit.width))
    check('C8 新矢量文字字号 = 20（原 12）', Math.abs(hit.fontSize - 20) < 0.01, f3(hit.fontSize) + ' vs 20')
    check('C8 新矢量文字基线 = 原 baseline', Math.abs(hit.baseline - ASCII.baseline) < 0.01, f3(hit.baseline) + ' vs ' + ASCII.baseline)
    check('C8 新矢量文字 x = rect.x（align=left）', Math.abs(hit.x - ASCII.rect.x) < 0.01, f3(hit.x) + ' vs ' + ASCII.rect.x)
  }
}

/* ---------- C9 note 批注：图标（矢量路径）+ 中文便签（栅格图片） ---------- */
console.log('\n' + '-'.repeat(96))
console.log('[C9] note 批注：画出图标，中文便签走栅格图片；不产生文字算子')
console.log('-'.repeat(96))
{
  const c9 = await renderOut('c9-note', [], [
    { page: 0, rect: ZH.rect, kind: 'note', color: { r: 0.95, g: 0.6, b: 0.1 }, text: '待复核' }
  ])
  const icon = M.meanColor(c9.rendered, { x: ZH.rect.x + ZH.rect.width - 14, y: ZH.rect.y + ZH.rect.height - 14, width: 14, height: 14 })
  console.log('  图标区域(14x14) meanColor=(' + f3(icon.r) + ',' + f3(icon.g) + ',' + f3(icon.b) + ')  期望≈(0.95,0.6,0.1)')
  check('C9 图标区域被填成批注色（橙）', icon.r > 0.8 && icon.g > 0.45 && icon.g < 0.75 && icon.b < 0.3,
    '(' + f3(icon.r) + ',' + f3(icon.g) + ',' + f3(icon.b) + ')')
  const label = M.inkBBox(c9.rendered, { x: ZH.rect.x + ZH.rect.width, y: ZH.rect.y + ZH.rect.height - 22, width: 60, height: 22 })
  console.log('  便签文字区域墨迹: ink=' + label.ink + ' bbox=' + JSON.stringify(label.bbox))
  check('C9 便签中文被画出（图标右侧有墨迹）', label.ink > 50, 'ink=' + label.ink)
}

/* ---------- C10 fontFamily 真正生效（栅格路径） ---------- */
console.log('\n' + '-'.repeat(96))
console.log('[C10] fontFamily（栅格路径）：换字体族应改变落位宽度与墨迹')
console.log('-'.repeat(96))
{
  const c10a = await renderOut('c10-yahei', [{ ...ZH, newText: ZH_TEXT, fontFamily: 'Microsoft YaHei' }])
  const c10b = await renderOut('c10-simsun', [{ ...ZH, newText: ZH_TEXT, fontFamily: 'SimSun' }])
  const bbA = M.inkBBox(c10a.rendered, REG_ZH)
  const bbB = M.inkBBox(c10b.rendered, REG_ZH)
  console.log('  Microsoft YaHei: bbox width=' + f3(bbA.bbox.width) + ' height=' + f3(bbA.bbox.height) + ' ink=' + bbA.ink)
  console.log('  SimSun         : bbox width=' + f3(bbB.bbox.width) + ' height=' + f3(bbB.bbox.height) + ' ink=' + bbB.ink)
  console.log('  宽度比 = ' + f3(bbB.bbox.width / bbA.bbox.width) + '   墨迹比 = ' + f3(bbB.ink / bbA.ink) +
    '  （CJK 两族都是全角，故前进宽度几乎一样；差别体现在字形笔画：宋体更细）')
  // 注意：中日韩字在两种字体里都是全角（advance 相同），所以不能用宽度判据，
  // 必须看字形本身——宋体的笔画明显更细，墨迹像素数会大幅下降。
  check('C10 不同 fontFamily 产生不同字形（墨迹像素数显著不同）', Math.abs(bbA.ink - bbB.ink) / bbA.ink > 0.2,
    bbA.ink + ' vs ' + bbB.ink + '（比 ' + f3(bbB.ink / bbA.ink) + '）')
  check('C10 墨迹包围盒高度也不同（字形升降部不同）', Math.abs(bbA.bbox.height - bbB.bbox.height) > 0.2,
    f3(bbA.bbox.height) + ' vs ' + f3(bbB.bbox.height) + ' pt')
}

console.log('\n' + '='.repeat(96))
console.log('汇总: ' + pass + ' 项通过, ' + fail + ' 项失败')
console.log('='.repeat(96))
process.exit(fail ? 1 : 0)
