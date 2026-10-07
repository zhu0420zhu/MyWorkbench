// textTools 单测（node 24 type-stripping 直接跑）
import {
  dedupeLines,
  countDuplicates,
  sortLines,
  reverseLines,
  reverseChars,
  removeEmptyLines,
  trimLines,
  addLineNumbers,
  changeCase,
  wrapQuotes,
  unwrapQuotes,
  base64Encode,
  base64Decode,
  urlEncode,
  urlDecode,
  formatJson,
  regexReplace,
  escapeHtml,
  highlightKeywords,
  diffLines,
  countStats,
  addSymbols,
  addQuotesAndSymbols,
  SYMBOL_PRESETS_EN,
  SYMBOL_PRESETS_ZH
} from '../src/renderer/src/utils/textTools.ts'

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

// 去重
assert(dedupeLines('a\nb\na\nc\nb') === 'a\nb\nc', '去重：保留首次出现')
assert(dedupeLines('A\na', { ignoreCase: true }) === 'A', '去重：忽略大小写')
assert(dedupeLines('a\nb\na', { keepLast: true }) === 'b\na', '去重：保留末次出现')
assert(countDuplicates('a\nb\na\na') === '3\ta\n1\tb', '重复统计（按次数降序）')

// 排序
assert(sortLines('b\na\nc') === 'a\nb\nc', '排序：升序')
assert(sortLines('b\na\nc', { desc: true }) === 'c\nb\na', '排序：降序')
assert(sortLines('B\na', { ignoreCase: true }) === 'a\nB', '排序：忽略大小写')

// 行操作
assert(reverseLines('1\n2\n3') === '3\n2\n1', '反转行')
assert(reverseChars('abc') === 'cba', '反转字符')
assert(removeEmptyLines('a\n\nb\n  \n') === 'a\nb\n  ', '去空行（保留空白行）')
assert(removeEmptyLines('a\n  \nb', true) === 'a\nb', '去空白行')
assert(trimLines('  a  \n b ') === 'a\nb', 'trim 行')
assert(trimLines('a b c', true) === 'abc', '移除全部空白')
assert(addLineNumbers('a\nb') === '1. a\n2. b', '加行号')

// 大小写
assert(changeCase('hello world', 'upper') === 'HELLO WORLD', '转大写')
assert(changeCase('Hello World', 'lower') === 'hello world', '转小写')
assert(changeCase('hello world', 'title') === 'Hello World', '首字母大写')

// 引号
assert(wrapQuotes('a\nb') === '"a"\n"b"', '每行加双引号')
assert(wrapQuotes('a"b', '"', true) === '"a\\"b"', '加引号 + 转义')
assert(unwrapQuotes('"a"\n"b"') === 'a\nb', '去引号')
assert(unwrapQuotes("'x'") === 'x', '去单引号')

// 编解码
assert(base64Encode('你好') === '5L2g5aW9', 'Base64 编码（Unicode）')
assert(base64Decode('5L2g5aW9') === '你好', 'Base64 解码（Unicode）')
assert(urlEncode('a b&c') === 'a%20b%26c', 'URL 编码')
assert(urlDecode('a%20b%26c') === 'a b&c', 'URL 解码')

// JSON
const fmt = formatJson('{"b":1,"a":2}')
assert(fmt.ok && fmt.value === '{\n  "b": 1,\n  "a": 2\n}', 'JSON 格式化')
const fmtBad = formatJson('{bad')
assert(!fmtBad.ok && fmtBad.error.length > 0, 'JSON 错误提示')

// 正则
const rr = regexReplace('foo 123 bar 456', '\\d+', 'g', '#')
assert(rr.ok && rr.value === 'foo # bar #', '正则替换')

// 高亮
assert(escapeHtml('<a>&"') === '&lt;a&gt;&amp;&quot;', 'HTML 转义')
const hl = highlightKeywords('hello world hello', ['hello'])
assert(hl === '<mark>hello</mark> world <mark>hello</mark>', '关键词高亮')
const hl2 = highlightKeywords('alpha beta', ['beta', 'alpha'])
assert(hl2 === '<mark>alpha</mark> <mark>beta</mark>', '多关键词高亮（长词优先）')

// diff
const d = diffLines('a\nb\nc', 'a\nx\nc')
assert(
  JSON.stringify(d) ===
    JSON.stringify([
      { type: 'same', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'add', text: 'x' },
      { type: 'same', text: 'c' }
    ]),
  '行级 diff（LCS 对齐）'
)

// 统计
const st = countStats('a b\nc')
assert(st.lines === 2 && st.chars === 5 && st.words === 3, '统计行/字符/词')

// 符号添加
assert(
  addSymbols('a\nb', { symbols: [',', '%'] }) === 'a,\na%\nb,\nb%',
  '符号添加：多个符号独立成行（行×符号组合）'
)
assert(
  addSymbols('a\nb', { symbols: [',', '%', '.'] }) === 'a,\na%\na.\nb,\nb%\nb.',
  '符号添加：同时添加 3 个符号（逗号+百分号+句号）'
)
assert(
  addSymbols('a\nb', { symbols: [',', '%', '.', '!'], combine: 'all' }) === 'a,%.!\nb,%.!',
  '符号添加：同时添加 4 个符号顺序追加'
)
assert(
  addSymbols('a\nb', { symbols: [',', '%'], combine: 'all' }) === 'a,%\nb,%',
  '符号添加：多个符号按顺序追加到同一行'
)
assert(addSymbols('a', { symbols: ['+'], position: 'before' }) === '+a', '符号添加：加在行首')
assert(addSymbols('', { symbols: [','] }) === '', '符号添加：空输入')
assert(
  addSymbols('a\nb', { symbols: [',', '%'], combine: 'all', position: 'before' }) === ',%a\n,%b',
  '符号添加：行首 + 顺序追加'
)
assert(addSymbols('a\nb', { symbols: [] }) === 'a\nb', '符号添加：空符号列表原样返回')
assert(SYMBOL_PRESETS_EN.includes(',') && SYMBOL_PRESETS_EN.includes('%'), '英文预设含逗号和百分号')
assert(SYMBOL_PRESETS_ZH.includes('，') && SYMBOL_PRESETS_ZH.includes('。'), '中文预设含中文标点')

// 符号添加：位置 both（首尾同时）+ 引号与符号同时
assert(addSymbols('a\nb', { symbols: [','], position: 'both' }) === ',a,\n,b,', '符号添加：both 首尾同时')
assert(
  addSymbols('a\nb', { symbols: [',', '%'], position: 'both', combine: 'all' }) === ',%a,%\n,%b,%',
  '符号添加：both + 顺序追加'
)
assert(
  addQuotesAndSymbols('a', { quote: '"', symbols: [','], position: 'both' }) === '"a"\n,a,',
  '引号+符号同时添加（both）：每行分别加引号和逗号'
)
assert(addQuotesAndSymbols('hello', { quote: '"', position: 'both' }) === '"hello"', '仅引号 both：包裹内容')
assert(
  addQuotesAndSymbols('a\nb', { quote: "'", symbols: [',', '%'], combine: 'all' }) === "a',%\nb',%",
  '引号+多符号顺序追加'
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
