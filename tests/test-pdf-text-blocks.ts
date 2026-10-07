/* pdfTextBlocks 纯函数单测：中文逐字无空格拼接、行聚合（基线/字号/横向间距）、
 * 颜色采样（白底黑字 / 深蓝底白字 / 纯色回退 / 透明度）、水平对齐判定、id 与 rect 自洽。
 *
 * 运行：
 *   NODE_OPTIONS="" /c/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe \
 *     --experimental-strip-types tests/test-pdf-text-blocks.ts
 */
import {
  FALLBACK_FONT,
  groupItemsToRuns,
  pdfBytesToTextRuns,
  sampleColors,
  type PdfTextRunItem
} from '../src/renderer/src/utils/pdfTextBlocks.ts'

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log('  ✓ ' + msg)
  } else {
    failed++
    console.error('  ✗ FAIL: ' + msg)
  }
}

function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual === expected) {
    passed++
    console.log('  ✓ ' + msg)
  } else {
    failed++
    console.error(
      '  ✗ FAIL: ' + msg + '\n      期望: ' + JSON.stringify(expected) + '\n      实际: ' + JSON.stringify(actual)
    )
  }
}

function assertNear(actual: number, expected: number, tol: number, msg: string): void {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tol
  if (ok) {
    passed++
    console.log('  ✓ ' + msg + '（' + actual.toFixed(4) + ' ≈ ' + expected + '，容差 ' + tol + '）')
  } else {
    failed++
    console.error('  ✗ FAIL: ' + msg + '\n      期望: ' + expected + ' ± ' + tol + '\n      实际: ' + actual)
  }
}

function mkItem(
  str: string,
  x: number,
  width: number,
  opts: { baseline?: number; fontSize?: number; height?: number; fontFamily?: string } = {}
): PdfTextRunItem {
  const baseline = opts.baseline ?? 700
  const fontSize = opts.fontSize ?? 12
  return {
    str,
    x,
    y: baseline,
    baseline,
    width,
    height: opts.height ?? fontSize,
    fontSize,
    fontFamily: opts.fontFamily ?? FALLBACK_FONT
  }
}

/** 拼一段 RGBA 像素（parts 按给定顺序块状排列，n 是像素个数） */
function px(parts: Array<{ r: number; g: number; b: number; a?: number; n: number }>): Uint8ClampedArray {
  let total = 0
  for (const p of parts) total += p.n
  const out = new Uint8ClampedArray(total * 4)
  let i = 0
  for (const p of parts) {
    for (let k = 0; k < p.n; k++) {
      out[i++] = p.r
      out[i++] = p.g
      out[i++] = p.b
      out[i++] = p.a ?? 255
    }
  }
  return out
}

const PAGE_W = 595

console.log('pdfTextBlocks.test')

console.log('\n[A] 中文逐字 item 合成一行且无多余空格')
const zh = groupItemsToRuns(
  [mkItem('中', 0, 12), mkItem('文', 12, 12), mkItem('编', 24, 12), mkItem('辑', 36, 12)],
  0,
  PAGE_W
)
assertEq(zh.length, 1, '四个逐字 item 合成 1 个 run')
assertEq(zh[0].text, '中文编辑', '拼接结果就是「中文编辑」')
assert(!/[\u4E00-\u9FFF] [\u4E00-\u9FFF]/.test(zh[0].text), '结果里不存在「汉字 空格 汉字」')
assertEq(zh[0].id, 'p0-r0', 'id 形如 p0-r0')
assertEq(zh[0].page, 0, 'page 透传 0 基页号')

const zhWithSpaceItems = groupItemsToRuns(
  [
    mkItem('中', 0, 12),
    mkItem(' ', 12, 4),
    mkItem('文', 16, 12),
    mkItem(' ', 28, 4),
    mkItem('编', 32, 12),
    mkItem('辑', 44, 12)
  ],
  0,
  PAGE_W
)
assertEq(zhWithSpaceItems.length, 1, '夹着空格 item 也仍是 1 个 run')
assertEq(zhWithSpaceItems[0].text, '中文编辑', 'pdf.js 插入的空格 item 被吃掉（绝不出现「中 文」）')

const zhMixed = groupItemsToRuns(
  [
    mkItem('验证', 0, 24),
    mkItem(' ', 24, 6),
    mkItem('PDF', 30, 22),
    mkItem(' ', 52, 6),
    mkItem('文本层', 58, 36)
  ],
  0,
  PAGE_W
)
assertEq(zhMixed.length, 1, '中英混排仍是一行')
assertEq(zhMixed[0].text, '验证 PDF 文本层', '原稿里本有的中英空格保留、汉字之间不加空格')

console.log('\n[B] 行聚合边界：基线 / 字号 / 横向间距')
const twoLines = groupItemsToRuns(
  [mkItem('第一行文字', 0, 60), mkItem('第二行文字', 0, 60, { baseline: 680 })],
  0,
  PAGE_W
)
assertEq(twoLines.length, 2, '基线差 20pt（> 2pt）不合并 → 2 个 run')
assertEq(twoLines[0].text, '第一行文字', '靠上的行在前（baseline 降序）')
assertEq(twoLines[1].text, '第二行文字', '靠下的行在后')
assertEq(twoLines[0].id + '/' + twoLines[1].id, 'p0-r0/p0-r1', 'id 按输出顺序递增')

const sameLineDrift = groupItemsToRuns(
  [mkItem('上标', 0, 24, { baseline: 700 }), mkItem('正文', 40, 24, { baseline: 699 })],
  0,
  PAGE_W
)
assertEq(sameLineDrift.length, 1, '基线差 1pt（≤ 2pt）仍算同一行')

const sizeDiff = groupItemsToRuns(
  [mkItem('小字', 0, 24, { fontSize: 12 }), mkItem('大字', 60, 48, { fontSize: 24 })],
  0,
  PAGE_W
)
assertEq(sizeDiff.length, 2, '同基线但字号差 12pt（> 20%×24）不合并 → 2 个 run')
assertEq(sizeDiff[0].fontSize, 12, '小字 run 字号 12')
assertEq(sizeDiff[1].fontSize, 24, '大字 run 字号 24')

const sizeClose = groupItemsToRuns(
  [mkItem('甲', 0, 24, { fontSize: 12 }), mkItem('乙', 24, 24, { fontSize: 12.5 })],
  0,
  PAGE_W
)
assertEq(sizeClose.length, 1, '字号差 0.5pt（≤ 20%）仍合并')

const farApart = groupItemsToRuns([mkItem('左', 0, 12), mkItem('右', 40, 12)], 0, PAGE_W)
assertEq(farApart.length, 2, '横向间距 28pt（> 1.5×12）→ 切成 2 个 run')
assertEq(farApart[0].text, '左', '左段文字正确')
assertEq(farApart[1].text, '右', '右段文字正确')

const closeApart = groupItemsToRuns([mkItem('左', 0, 12), mkItem('右', 20, 12)], 0, PAGE_W)
assertEq(closeApart.length, 1, '横向间距 8pt（≤ 1.5×12）→ 仍是一行')

const leftTitleRightPageNo = groupItemsToRuns(
  [mkItem('页眉标题', 30, 60), mkItem('7', 540, 7)],
  0,
  PAGE_W
)
assertEq(leftTitleRightPageNo.length, 2, '同基线但左右分处两端（左标题 + 右页码）→ 2 个 run')
assertEq(leftTitleRightPageNo[1].align, 'right', '右侧页码判为 right')

console.log('\n[C] rect / baseline / 字段自洽')
const single = zh[0]
assertNear(single.rect.x, 0, 1e-9, 'rect.x = 最小左边缘')
assertNear(single.rect.width, 48, 1e-9, 'rect.width = 最右端 - 最左端')
assertNear(single.rect.height, 12, 1e-9, 'rect.height = 行高（item.height）')
assertNear(single.baseline, 700, 1e-9, 'baseline 透传')
assert(single.rect.y < single.baseline, 'rect.y（下边缘）低于基线')
assert(single.rect.y + single.rect.height > single.baseline, 'rect 上边缘高于基线 → 基线落在框内')
assertNear(single.rect.y, 700 - 12 * 0.2, 1e-9, 'rect.y = baseline - 0.2×行高')
assertEq(single.fontFamily, FALLBACK_FONT, 'fontFamily 透传（此处即回退字体名）')

const customFont = groupItemsToRuns([mkItem('A', 0, 10, { fontFamily: 'MicrosoftYaHei' })], 0, PAGE_W)
assertEq(customFont[0].fontFamily, 'MicrosoftYaHei', '真实字体名原样透传')

console.log('\n[D] 水平对齐判定（pageWidth = 600）')
assertEq(groupItemsToRuns([mkItem('左对齐', 20, 300)], 0, 600)[0].align, 'left', '左边距 20pt（< 10%）→ left')
assertEq(groupItemsToRuns([mkItem('右对齐', 280, 300)], 0, 600)[0].align, 'right', '右边距 20pt（< 10%）→ right')
assertEq(
  groupItemsToRuns([mkItem('居中标题', 90, 420)], 0, 600)[0].align,
  'center',
  '左右边距各 90pt（差 0 < 5%，且都 < 25%）→ center'
)
assertEq(
  groupItemsToRuns([mkItem('边距对称但很大', 200, 200)], 0, 600)[0].align,
  'left',
  '左右边距相等但都是 200pt（≥ 25% 页宽）→ 按规格仍判 left'
)
assertEq(
  groupItemsToRuns([mkItem('不贴边也不居中', 100, 200)], 0, 600)[0].align,
  'left',
  '左右边距各 100/300pt 且相差大 → 其余按 left'
)
assertEq(groupItemsToRuns([mkItem('无页宽', 0, 10)], 0, 0)[0].align, 'left', 'pageWidth ≤ 0 → left（不抛错）')

console.log('\n[E] 空输入 / 纯空白')
assertEq(groupItemsToRuns([], 0, PAGE_W).length, 0, '空数组 → 0 个 run')
assertEq(groupItemsToRuns([mkItem('', 0, 0)], 0, PAGE_W).length, 0, '空串 item → 0 个 run')
assertEq(groupItemsToRuns([mkItem('   ', 0, 6)], 0, PAGE_W).length, 0, '纯空白 item → 0 个 run（不产出空行）')
assertEq(
  groupItemsToRuns([mkItem('甲', 0, 12), mkItem('   ', 12, 6), mkItem('乙', 18, 12)], 0, PAGE_W).length,
  1,
  '行中飘着的空白 item 不额外产出 run'
)

console.log('\n[F] sampleColors：白底黑字')
const whiteBlack = sampleColors(px([{ r: 255, g: 255, b: 255, n: 70 }, { r: 0, g: 0, b: 0, n: 30 }]))
assertNear(whiteBlack.bgColor.r, 1, 0.06, 'bgColor.r ≈ 1（白底）')
assertNear(whiteBlack.bgColor.g, 1, 0.06, 'bgColor.g ≈ 1（白底）')
assertNear(whiteBlack.bgColor.b, 1, 0.06, 'bgColor.b ≈ 1（白底）')
assertNear(whiteBlack.color.r, 0, 0.15, 'color.r ≈ 0（黑字）')
assertNear(whiteBlack.color.g, 0, 0.15, 'color.g ≈ 0（黑字）')
assertNear(whiteBlack.color.b, 0, 0.15, 'color.b ≈ 0（黑字）')

const grayOnWhite = sampleColors(px([{ r: 255, g: 255, b: 255, n: 60 }, { r: 40, g: 40, b: 40, n: 40 }]))
assertNear(grayOnWhite.bgColor.r, 1, 0.06, '浅色为主的区域仍判白底')
assert(grayOnWhite.color.r < 0.25, '深灰字被采出来（' + grayOnWhite.color.r.toFixed(3) + ' < 0.25）')

console.log('\n[G] sampleColors：深蓝底白字')
const blueWhite = sampleColors(px([{ r: 20, g: 40, b: 120, n: 70 }, { r: 255, g: 255, b: 255, n: 30 }]))
assertNear(blueWhite.bgColor.r, 20 / 255, 0.08, 'bgColor.r ≈ 20/255（深蓝底）')
assertNear(blueWhite.bgColor.g, 40 / 255, 0.08, 'bgColor.g ≈ 40/255（深蓝底）')
assertNear(blueWhite.bgColor.b, 120 / 255, 0.08, 'bgColor.b ≈ 120/255（深蓝底）')
assert(blueWhite.color.r > 0.9 && blueWhite.color.g > 0.9 && blueWhite.color.b > 0.9, '白字被采出来（各通道 > 0.9）')

const blueWhiteDark = sampleColors(px([{ r: 10, g: 15, b: 70, n: 80 }, { r: 250, g: 250, b: 250, n: 20 }]))
assertNear(blueWhiteDark.bgColor.b, 70 / 255, 0.08, '更深的海军蓝底仍能判定为背景')
assert(blueWhiteDark.color.b > 0.85, '浅字被采出来（b > 0.85）')

console.log('\n[H] sampleColors：回退与透明度')
const plainWhite = sampleColors(px([{ r: 255, g: 255, b: 255, n: 64 }]))
assertNear(plainWhite.bgColor.r, 1, 1e-9, '纯白区域 bgColor = 1')
assertEq(plainWhite.color.r, 0.13, '无文字差异 → color.r 回退 0.13')
assertEq(plainWhite.color.g, 0.13, '无文字差异 → color.g 回退 0.13')
assertEq(plainWhite.color.b, 0.13, '无文字差异 → color.b 回退 0.13')

const transparentIgnored = sampleColors(px([{ r: 255, g: 255, b: 255, n: 64 }, { r: 0, g: 0, b: 0, a: 0, n: 64 }]))
assertNear(transparentIgnored.bgColor.r, 1, 1e-9, 'a=0 的黑像素不参与统计，底色仍是白')
assertEq(transparentIgnored.color.r, 0.13, '被忽略的黑像素不会把文字色带成黑')

const halfAlpha = sampleColors(px([{ r: 255, g: 255, b: 255, n: 64 }, { r: 0, g: 0, b: 0, a: 127, n: 64 }]))
assertEq(halfAlpha.color.r, 0.13, 'a=127（< 128）同样被忽略')

assertEq(sampleColors(new Uint8ClampedArray(0)).color.r, 0.13, '空像素 → 回退文字色')
assertEq(sampleColors(new Uint8ClampedArray(0)).bgColor.r, 1, '空像素 → 回退背景色')
assertEq(
  sampleColors(px([{ r: 0, g: 0, b: 0, a: 0, n: 8 }])).bgColor.r,
  1,
  '全部像素透明 → 回退背景色'
)

console.log('\n[I] 采样结果与输入无共享引用（调用方可直接改）')
const isolated = sampleColors(px([{ r: 255, g: 255, b: 255, n: 4 }]))
isolated.color.r = 0.5
assertEq(sampleColors(px([{ r: 255, g: 255, b: 255, n: 4 }])).color.r, 0.13, '回退色不是同一个对象（改动不会串味）')

console.log('\n[J] 模块形态（证明无头可加载、未静态拉进 pdf.js/electron）')
assert(typeof pdfBytesToTextRuns === 'function', 'pdfBytesToTextRuns 是函数')
assertEq(pdfBytesToTextRuns.constructor.name, 'AsyncFunction', 'pdfBytesToTextRuns 是 async 函数')
assertEq(typeof groupItemsToRuns, 'function', 'groupItemsToRuns 是函数')
assertEq(FALLBACK_FONT, 'Microsoft YaHei', '回退字体名 = Microsoft YaHei')

console.log('\n--- 样例输出（供人工核对字段形状）---')
console.log(JSON.stringify(zhMixed[0], null, 2))

console.log('\n通过 ' + passed + '/' + (passed + failed))
if (failed > 0) {
  console.error('失败 ' + failed + ' 项')
  process.exitCode = 1
}
