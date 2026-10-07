/* CSV 解析正确性回归：覆盖引号、转义、嵌入换行、CRLF/CR、空行等边界
 * 运行：node --experimental-strip-types tests/verify-csv-parse.ts
 */
import { parseTextImport } from '../src/renderer/src/utils/ioFormats.ts'
import { parseCsvToTable } from '../src/renderer/src/utils/csv.ts'

let pass = 0
let fail = 0

function check(name: string, text: string, expected: string[][]) {
  const t = parseTextImport('t', text, 'csv')
  const got = t.rows.map((r) => t.fields.map((f) => String(r.values[f.id] ?? '')))
  const ok = JSON.stringify(got) === JSON.stringify(expected)
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(got)}`)
  }
}

const H = 'a,b,c'

console.log('CSV 解析边界回归：')
check('普通行', `${H}\n1,2,3`, [['1', '2', '3']])

check('引号内含逗号', `${H}\n1,"x,y",3`, [['1', 'x,y', '3']])

check('引号内转义双引号', `${H}\n1,"say ""hi""",3`, [['1', 'say "hi"', '3']])

check('引号内嵌入换行', `${H}\n1,"line1\nline2",3`, [['1', 'line1\nline2', '3']])

check('CRLF 行尾', `${H}\r\n1,2,3\r\n4,5,6`, [
  ['1', '2', '3'],
  ['4', '5', '6']
])

check('CR-only 行尾（旧 Mac）', `${H}\r1,2,3\r4,5,6`, [
  ['1', '2', '3'],
  ['4', '5', '6']
])

check('结尾换行不产生空行', `${H}\n1,2,3\n`, [['1', '2', '3']])

check('中间空行被跳过', `${H}\n1,2,3\n\n4,5,6`, [
  ['1', '2', '3'],
  ['4', '5', '6']
])

check('全空字段行被跳过', `${H}\n1,2,3\n,,\n4,5,6`, [
  ['1', '2', '3'],
  ['4', '5', '6']
])

check('缺列补空', `${H}\n1,2`, [[['1', '2', ''][0], '2', '']])

check('引号字段后跟分隔符', `${H}\n"a","b","c"`, [['a', 'b', 'c']])

// TSV
{
  const t = parseTextImport('t', 'a\tb\n1\t2', 'tsv')
  const got = t.rows.map((r) => t.fields.map((f) => String(r.values[f.id] ?? '')))
  const ok = JSON.stringify(got) === JSON.stringify([['1', '2']])
  console.log(ok ? '  ✓ TSV 制表符分隔' : `  ✗ TSV 制表符分隔 → ${JSON.stringify(got)}`)
  ok ? pass++ : fail++
}

// ---- csv.ts（Analytics 使用）----
console.log('\ncsv.ts（Analytics）边界回归：')
function checkTable(name: string, text: string, expected: string[][]) {
  const t = parseCsvToTable(text)
  const got = t.rows.map((r) => t.columns.map((c) => String(r[c] ?? '')))
  const ok = JSON.stringify(got) === JSON.stringify(expected)
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(got)}`)
  }
}
checkTable('引号内含逗号', `${H}\n1,"x,y",3`, [['1', 'x,y', '3']])
checkTable('引号内嵌入换行', `${H}\n1,"line1\nline2",3`, [['1', 'line1\nline2', '3']])
checkTable('转义双引号', `${H}\n1,"say ""hi""",3`, [['1', 'say "hi"', '3']])
checkTable('CRLF 行尾', `${H}\r\n1,2,3\r\n4,5,6`, [
  ['1', '2', '3'],
  ['4', '5', '6']
])
checkTable('CR-only 行尾', `${H}\r1,2,3\r4,5,6`, [
  ['1', '2', '3'],
  ['4', '5', '6']
])
checkTable('空行被跳过', `${H}\n1,2,3\n\n4,5,6`, [
  ['1', '2', '3'],
  ['4', '5', '6']
])
{
  const t = parseCsvToTable(`${H}\n1,2,3\n4,5,6`)
  const ok = t.numericColumns.length === 3 && t.rows.every((r) => typeof r['a'] === 'number')
  console.log(ok ? '  ✓ 数值列自动转 number' : `  ✗ 数值列自动转 number → ${JSON.stringify(t.numericColumns)}`)
  ok ? pass++ : fail++
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
