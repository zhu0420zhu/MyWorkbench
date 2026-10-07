/* pdfToHtml 单测：中文逐字拼接、英文补空格、标题/列表启发式、空行分段、无文本层判定
 *
 * 运行：
 *   NODE_OPTIONS="" /c/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe \
 *     --experimental-strip-types tests/test-pdf-to-html.ts
 */
import {
  joinTextItems,
  textPagesToHtml,
  buildPdfHtmlResult,
  pdfBytesToHtml,
  type PdfTextLine,
  type PdfTextItem
} from '../src/renderer/src/utils/pdfToHtml.ts'

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
  const ok = actual === expected
  if (ok) {
    passed++
    console.log('  ✓ ' + msg)
  } else {
    failed++
    console.error(
      '  ✗ FAIL: ' + msg + '\n      期望: ' + JSON.stringify(expected) + '\n      实际: ' + JSON.stringify(actual)
    )
  }
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

console.log('pdfToHtml.test')

console.log('\n[A] 中文逐字拼接不加空格（joinTextItems）')
assertEq(
  joinTextItems([item('中', 0, 12), item('文', 12, 12)]),
  '中文',
  '相邻汉字逐字 item 直接拼接'
)
assertEq(
  joinTextItems([item('中', 0, 12), item(' ', 12, 4), item('文', 16, 12), item(' ', 28, 4), item('编', 32, 12), item('辑', 44, 12)]),
  '中文编辑',
  'item 之间的空格 item 被吃掉（绝不出现「中 文」）'
)
assertEq(
  joinTextItems([item('中 文 编 辑', 0, 48)]),
  '中文编辑',
  '单个 item 内部被插的空格也要塌掉'
)
assertEq(
  joinTextItems([item('你好', 0, 24), item('，', 24, 12), item('世界', 36, 24)]),
  '你好，世界',
  '中文标点紧贴不加空格'
)
assertEq(
  joinTextItems([item('中文', 0, 24), item('PDF', 24, 24)]),
  '中文PDF',
  '中英紧贴且源里无空格时，不会凭空补空格'
)
assertEq(
  joinTextItems([item('验证', 0, 24), item(' ', 24, 6), item('PDF', 30, 22)]),
  '验证 PDF',
  '中英之间源里原有的空格要保留（原稿保真）'
)
assertEq(
  joinTextItems([item('中文', 0, 24), item(' ', 24, 6), item('English', 30, 42)]),
  '中文 English',
  '汉字与英文之间的空格保留，但汉字之间仍不许有空格'
)
assert(
  !/[\u4E00-\u9FFF] [\u4E00-\u9FFF]/.test(
    joinTextItems([item('中', 0, 12), item(' ', 12, 4), item('文', 16, 12), item(' ', 28, 4), item('编', 32, 12), item('辑', 44, 12)])
  ),
  '结果里不存在「汉字 空格 汉字」'
)

console.log('\n[B] 半角英文按间距补空格')
assertEq(
  joinTextItems([item('Hello', 0, 30), item('World', 34, 30)]),
  'Hello World',
  'x 间距 4pt > 0.22em 补一个空格'
)
assertEq(
  joinTextItems([item('Hello', 0, 30), item(' ', 30, 4), item('World', 34, 30)]),
  'Hello World',
  '源里带空格 item 时不重复补空格'
)
assertEq(joinTextItems([item('Hel', 0, 18), item('lo', 18, 12)]), 'Hello', '字母紧贴（gap 0）不补空格')
assertEq(
  joinTextItems([item('  Hello', 0, 40), item(' ', 40, 4)]),
  'Hello',
  '行首缩进与行尾空白被 trim'
)

console.log('\n[C] 标题判定（textPagesToHtml）')
const h1Html = textPagesToHtml([{ page: 1, lines: [line('文档标题', 760, 24), ...body()] }])
assert(h1Html.includes('<h1>文档标题</h1>'), '24pt 短行 → <h1>')
assert(!h1Html.includes('<h2>文档标题</h2>'), '24pt 不会同时被当成 h2')
assert(
  h1Html.includes('<p>正文第一行正文第二行正文第三行正文第四行</p>'),
  '标题后的正文合成一个 <p>（中文直拼）'
)
const h2Html = textPagesToHtml([{ page: 1, lines: [line('文档标题', 760, 17), ...body()] }])
assert(h2Html.includes('<h2>文档标题</h2>'), '17pt 短行 → <h2>')
assert(!h2Html.includes('<h1>'), '17pt 不会被当成 h1')
const longHtml = textPagesToHtml([
  { page: 1, lines: body() },
  { page: 2, lines: [line('长'.repeat(45), 760, 18)] }
])
assert(longHtml.includes('<p>' + '长'.repeat(45) + '</p>'), '18pt 但超过 40 字 → 仍按 <p> 处理')
assert(!/<h[12]>/.test(longHtml), '超长行不会变成标题')
assertEq(
  textPagesToHtml([{ page: 1, lines: [line('第一行文字', 700), line('第二行文字', 688)] }]),
  '<p>第一行文字第二行文字</p>',
  '同段两行中文直接拼接'
)

console.log('\n[D] 无序/有序列表判定')
const listHtml = textPagesToHtml([
  {
    page: 1,
    lines: [
      line('- 第一项', 600),
      line('· 第二项', 588),
      line('正文一段', 576),
      line('1. 甲', 564),
      line('2. 乙', 552)
    ]
  }
])
assertEq(
  listHtml,
  '<ul>\n<li>第一项</li>\n<li>第二项</li>\n</ul>\n<p>正文一段</p>\n<ol>\n<li>甲</li>\n<li>乙</li>\n</ol>',
  '·/•/-/* → <ul>，数字加点 → <ol>，段落夹在中间顺序正确'
)
assertEq(listHtml.split('<ul>').length - 1, 1, '相邻无序项合成一个 <ul>')
assertEq(listHtml.split('<ol>').length - 1, 1, '相邻有序项合成一个 <ol>')
assertEq(textPagesToHtml([{ page: 1, lines: [line('-5℃', 700)] }]), '<p>-5℃</p>', '标记后无空白不算列表项')
// 实测 LibreOffice 导出的中文 PDF：项目符号/序号是独立 item，与正文之间没有空格
assertEq(
  textPagesToHtml([{ page: 1, lines: [line('•无序列表第一项', 600), line('•无序列表第二项', 588)] }]),
  '<ul>\n<li>无序列表第一项</li>\n<li>无序列表第二项</li>\n</ul>',
  '「•正文」紧贴无空格 → 仍识别为 <ul>'
)
assertEq(
  textPagesToHtml([{ page: 1, lines: [line('1.有序列表第一项', 600), line('2.有序列表第二项', 588)] }]),
  '<ol>\n<li>有序列表第一项</li>\n<li>有序列表第二项</li>\n</ol>',
  '「1.正文」紧贴无空格 → 仍识别为 <ol>'
)
assertEq(
  textPagesToHtml([{ page: 1, lines: [line('1.5倍增长', 700)] }]),
  '<p>1.5倍增长</p>',
  '行首小数（1.5倍）不会被当成有序列表'
)
assertEq(
  textPagesToHtml([{ page: 1, lines: [line('2026年展望', 700)] }]),
  '<p>2026年展望</p>',
  '行首年份（2026年）不会被当成有序列表'
)

console.log('\n[E] 空行 / 行距分段')
assertEq(
  textPagesToHtml([
    { page: 1, lines: [line('第一段', 700), line('', 690), line('第二段', 680)] }
  ]),
  '<p>第一段</p>\n<p>第二段</p>',
  '显式空行 → 分成两个 <p>'
)
assertEq(
  textPagesToHtml([
    { page: 1, lines: [line('甲行', 700), line('乙行', 688), line('丙行', 676), line('丁行', 630)] }
  ]),
  '<p>甲行乙行丙行</p>\n<p>丁行</p>',
  '行距突变（46pt vs 常规 12pt）→ 分段'
)
assertEq(
  textPagesToHtml([{ page: 1, lines: [line('甲行', 700), line('乙行', 688)] }]),
  '<p>甲行乙行</p>',
  '常规行距不分段'
)
// 实测数据（LibreOffice 导出中文 PDF）：行内行距 16.65/16.75、段距 29.9，
// 若用所有行距的中位数（20.8）做基准，阈值会宽到 32.2 而漏判分段
assertEq(
  textPagesToHtml([
    {
      page: 1,
      lines: [
        line('技术方案说明', 781.54, 20),
        line('第一段第一行', 760.74),
        line('第一段第二行', 744.09),
        line('第二段开头', 714.19)
      ]
    }
  ]),
  '<h2>技术方案说明</h2>\n<p>第一段第一行第一段第二行</p>\n<p>第二段开头</p>',
  '段距较大时不能被行距中位数吞掉（中位数污染回归）'
)
assertEq(textPagesToHtml([]), '', '空输入 → 空字符串')

console.log('\n[F] 无文本层 → needOcr 与 note（buildPdfHtmlResult）')
const empty = buildPdfHtmlResult([{ page: 1, lines: [] }], 1)
assertEq(empty.html, '', '空页 html 为空内容占位')
assertEq(empty.pages, 1, '空页 pages 透传总页数')
assertEq(empty.chars, 0, '空页 chars = 0')
assertEq(empty.needOcr, true, '空页 needOcr = true')
assertEq(empty.note, '未检测到文本层（可能是扫描件），可用 OCR 识别后编辑', '空页 note 为约定提示语')
const few = buildPdfHtmlResult([{ page: 1, lines: [line('字'.repeat(19), 700)] }], 1)
assertEq(few.chars, 19, '19 个非空白字符')
assertEq(few.needOcr, true, '19 字 < 20 → needOcr = true')
assertEq(few.html, '', '19 字 → html 为空内容占位')
const enough = buildPdfHtmlResult([{ page: 1, lines: [line('字'.repeat(20), 700)] }], 3)
assertEq(enough.chars, 20, '20 个非空白字符')
assertEq(enough.needOcr, false, '20 字（边界）→ needOcr = false')
assertEq(enough.note, undefined, '有文本层时不给 note')
assertEq(enough.pages, 3, 'pages 用真实总页数')
assertEq(enough.html, '<p>' + '字'.repeat(20) + '</p>', '有文本层时 html 为结构化段落')

console.log('\n[G] HTML 转义')
assertEq(
  textPagesToHtml([{ page: 1, lines: [line('a < b & c > d', 700)] }]),
  '<p>a &lt; b &amp; c &gt; d</p>',
  '正文里的尖括号与 & 被转义'
)

console.log('\n[H] 模块形态（证明无头可加载、未静态拉进 pdf.js/electron）')
assert(typeof pdfBytesToHtml === 'function', 'pdfBytesToHtml 是函数')
assertEq(pdfBytesToHtml.constructor.name, 'AsyncFunction', 'pdfBytesToHtml 是 async 函数')

console.log('\n通过 ' + passed + '/' + (passed + failed))
if (failed > 0) {
  console.error('失败 ' + failed + ' 项')
  process.exitCode = 1
}
