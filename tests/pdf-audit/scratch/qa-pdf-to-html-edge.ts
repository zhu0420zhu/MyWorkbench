/* 独立验证者补的边界用例（证伪用）：纯数字行 / 超长单行 / 中英混排同一行 / joinTextItems 退化输入
 *
 * 运行：
 *   NODE_OPTIONS="" /c/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe \
 *     --experimental-strip-types tests/pdf-audit/scratch/qa-pdf-to-html-edge.ts
 */
import {
  joinTextItems,
  textPagesToHtml,
  buildPdfHtmlResult,
  type PdfTextLine,
  type PdfTextItem
} from '../../../src/renderer/src/utils/pdfToHtml.ts'

let n = 0
let bad = 0
function show(name: string, actual: unknown, expected: unknown): void {
  n++
  const ok = actual === expected
  if (!ok) bad++
  console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}`)
  if (!ok) {
    console.log('      期望: ' + JSON.stringify(expected))
    console.log('      实际: ' + JSON.stringify(actual))
  }
}
function note(name: string, value: unknown): void {
  console.log(`  · [观察] ${name}: ${JSON.stringify(value)}`)
}

const item = (str: string, x: number, width: number, size = 12): PdfTextItem => ({ str, x, width, size })
const line = (text: string, y: number, size = 12): PdfTextLine => ({ text, y, size })
/** 4 行 12pt 正文：把字号中位数钉在 12 */
const body = (): PdfTextLine[] => [
  line('正文第一行', 740),
  line('正文第二行', 728),
  line('正文第三行', 716),
  line('正文第四行', 704)
]

console.log('qa-edge: 纯数字行')
show('纯数字 12345（正常字号）→ <p>', textPagesToHtml([{ page: 1, lines: body().concat([line('12345', 600)]) }]).includes('<p>12345</p>'), true)
show('小数 3.14159 不被当成有序列表', textPagesToHtml([{ page: 1, lines: [line('3.14159', 700)] }]), '<p>3.14159</p>')
show('端口号风格 8080? 不列表', textPagesToHtml([{ page: 1, lines: [line('8080', 700)] }]), '<p>8080</p>')
show('年份 2026 单独成行 → <p>', textPagesToHtml([{ page: 1, lines: [line('2026', 700)] }]), '<p>2026</p>')
show('"1) 第一项" → <ol>', textPagesToHtml([{ page: 1, lines: [line('1) 第一项', 700)] }]), '<ol>\n<li>第一项</li>\n</ol>')
// 大字号纯数字：字号 24pt（>= 12*1.8）且短行 → 会被判 h1
note('大字号纯数字行 "12345"@24pt 的判定', textPagesToHtml([{ page: 1, lines: [line('12345', 760, 24)].concat(body()) }]).split('\n')[0])

console.log('\nqa-edge: 超长单行')
const long = '长'.repeat(3000)
const t0 = Date.now()
const longHtml = textPagesToHtml([{ page: 1, lines: [line(long, 700)] }])
const dt = Date.now() - t0
show('3000 汉字单行不被判标题', /<h[12]>/.test(longHtml), false)
show('3000 汉字单行整段落在 <p> 里', longHtml === '<p>' + long + '</p>', true)
note('3000 汉字耗时(ms)', dt)
const longAscii = 'A'.repeat(5000) + ' ' + 'B'.repeat(5000)
const asciiHtml = textPagesToHtml([{ page: 1, lines: [line(longAscii, 700)] }])
show('10001 半角单行不被判标题', /<h[12]>/.test(asciiHtml), false)
show('10001 半角单行无空格被吃掉（原样保留）', asciiHtml.includes('A'.repeat(5000) + ' ' + 'B'.repeat(5000)), true)
// 超长行且以 "- " 开头：按现实现应被当列表项（观察点）
const longList = '- ' + '内'.repeat(3000)
const longListHtml = textPagesToHtml([{ page: 1, lines: [line(longList, 700)] }])
note('超长行以 "- " 开头是否落入 <ul>', longListHtml.startsWith('<ul>'))
show('超长行以 "- " 开头 → <ul><li>', longListHtml.startsWith('<ul>\n<li>') && longListHtml.endsWith('</li>\n</ul>'), true)

console.log('\nqa-edge: 中英混排同一行')
// 逐字中文 + 英文 item，源里无空格：不应凭空补空格
show(
  '中文+Hello+世界（源无空格）→ 中文Hello世界',
  joinTextItems([item('中文', 0, 24), item('Hello', 26, 30), item('世界', 58, 24)]),
  '中文Hello世界'
)
show(
  '中文 + 空格item + Hello + 空格item + 世界 → 保空格',
  joinTextItems([
    item('中文', 0, 24), item(' ', 26, 4), item('Hello', 30, 30), item(' ', 60, 4), item('世界', 64, 24)
  ]),
  '中文 Hello 世界'
)
// 汉字之间的空格必须被吃掉；汉字与英文之间源里**有**空格则保留
// （注意：'文' 与 'Hello' 之间插了 ' ' item，属源里真实空格，保留才对）
const mixed = joinTextItems([
  item('中', 0, 12), item(' ', 12, 4), item('文', 16, 12), item(' ', 26, 4), item('Hello', 30, 30), item('世', 62, 12), item(' ', 74, 4), item('界', 78, 12)
])
show('混排行结果 = 中文 Hello世界（汉字间空格塌掉、源里中英间空格保留）', mixed, '中文 Hello世界')
show('混排行不含「汉字 空格 汉字」', /[\u4E00-\u9FFF] [\u4E00-\u9FFF]/.test(mixed), false)
// 中英之间**无**空格 item 时不得凭空补空格
const mixedNoSpace = joinTextItems([
  item('中', 0, 12), item(' ', 12, 4), item('文', 16, 12), item('Hello', 30, 30), item('世', 62, 12), item(' ', 74, 4), item('界', 78, 12)
])
show('中英无空格 item → 中文Hello世界', mixedNoSpace, '中文Hello世界')
// 数字与中文紧贴：不得被拆开
show('中文2026年 → 不插空格', joinTextItems([item('中文', 0, 24), item('2026', 24, 24), item('年', 48, 12)]), '中文2026年')
// 半角数字与半角字母之间按间距补空格
show('ABC + x间距6 + 123 → ABC 123', joinTextItems([item('ABC', 0, 30), item('123', 36, 24)]), 'ABC 123')
show('ABC + x间距1 + 123 → ABC123（不补）', joinTextItems([item('ABC', 0, 30), item('123', 31, 24)]), 'ABC123')

console.log('\nqa-edge: joinTextItems 退化输入')
show('空数组 → 空串', joinTextItems([]), '')
show('只有空白 item → 空串', joinTextItems([item('   ', 0, 10)]), '')
show('只有空串 item → 空串', joinTextItems([item('', 0, 10)]), '')
show('同一 x（稳定排序）保留插入顺序', joinTextItems([item('A', 0, 10), item('B', 0, 10)]), 'AB')
show('全角空格也归入 CJK 处理', joinTextItems([item('中', 0, 12), item('\u3000', 12, 12), item('文', 24, 12)]), '中文')

console.log('\nqa-edge: 阈值边界（20 字）')
const just19 = buildPdfHtmlResult([{ page: 1, lines: [line('一二三四五六七八九十一二三四五六七八九', 700)] }], 1)
show('19 字 → needOcr=true', just19.needOcr, true)
const just20 = buildPdfHtmlResult([{ page: 1, lines: [line('一二三四五六七八九十一二三四五六七八九十', 700)] }], 1)
show('20 字 → needOcr=false', just20.needOcr, false)
// 纯数字/符号也算字符（观察：MIN_TEXT_CHARS 按非空白字符计数）
const nums = buildPdfHtmlResult([{ page: 1, lines: [line('12345678901234567890', 700)] }], 1)
note('20 位纯数字的 needOcr', nums.needOcr)

console.log('\nqa-edge 结果: ' + (n - bad) + '/' + n + ' 通过')
if (bad > 0) process.exitCode = 1
