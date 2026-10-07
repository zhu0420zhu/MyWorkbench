// 无头测试：tablesCore.aggregateTable —— 跨模块聚合（SQL 优先 + raw 采样）
// 运行：node --experimental-strip-types tests/tablesAggregate.test.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __resetMigratedCache,
  aggregateTable,
  importTable
} from '../src/main/tablesCore.ts'
import type { TableField, TableRow } from '../src/shared/types.ts'

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error('  FAIL -', msg)
    process.exit(1)
  }
  console.log('  ok  -', msg)
}

const root = mkdtempSync(join(tmpdir(), 'lm-tables-agg-'))

const fields: TableField[] = [
  { id: 'f_cat', name: '分类', type: 'text' },
  { id: 'f_val', name: '数值', type: 'number' }
]
// 数值语义探针：数字、'5.5'（可转）、true（JSON 布尔经 SQLite 读出为 1）应计入；'abc'/'12abc'（不可转）、null、'' 不计入
const rows: TableRow[] = [
  { id: 'r1', values: { f_cat: 'A', f_val: 10 } },
  { id: 'r2', values: { f_cat: 'A', f_val: 20 } },
  { id: 'r3', values: { f_cat: 'B', f_val: '5.5' } },
  { id: 'r4', values: { f_cat: 'B', f_val: 'abc' } },
  { id: 'r5', values: { f_cat: 'B', f_val: '12abc' } },
  { id: 'r6', values: { f_cat: 'C', f_val: null } },
  { id: 'r7', values: { f_cat: 'C', f_val: '' } },
  { id: 'r8', values: { f_cat: 'C', f_val: true } }
]

async function run(): Promise<void> {
  console.log('=== tablesCore.aggregateTable 聚合（count/sum/avg/raw） ===')
  const { id } = await importTable(root, { name: '聚合源', fields, rows })

  // count：按 x 分组计行，全部行都参与（不看 y 数值）
  const cnt = await aggregateTable(root, { tableId: id, xFieldId: 'f_cat', agg: 'count' })
  assert(cnt.totalRows === 8, 'totalRows = 8')
  assert(cnt.matchedRows === 8, 'count 的 matchedRows = totalRows')
  assert(cnt.groups.length === 3, 'count 分组 3 类（A/B/C）')
  const cntA = cnt.groups.find((g) => g.name === 'A')
  const cntB = cnt.groups.find((g) => g.name === 'B')
  assert(cntA !== undefined && cntA.value === 2, 'A 计 2 行')
  assert(cntB !== undefined && cntB.value === 3, 'B 计 3 行（含非数值行）')
  assert(cnt.groups[0].value === 3, 'count 按 cnt 降序（并列 3 时顺序不保证，但最大值在首位）')

  // sum：只累计 y 数值行（10+20 + 5.5 + true→1），'abc'/'12abc'/null/'' 不计
  const sum = await aggregateTable(root, { tableId: id, xFieldId: 'f_cat', yFieldId: 'f_val', agg: 'sum' })
  assert(sum.matchedRows === 4, 'sum 的 matchedRows = 4 个数值行（含 true→1）')
  const sumA = sum.groups.find((g) => g.name === 'A')
  const sumB = sum.groups.find((g) => g.name === 'B')
  const sumC = sum.groups.find((g) => g.name === 'C')
  assert(sumA !== undefined && sumA.value === 30, 'A sum = 30')
  assert(sumB !== undefined && Math.abs(sumB.value - 5.5) < 1e-9, 'B sum = 5.5（仅字符串「5.5」计入）')
  assert(sumC !== undefined && sumC.value === 1, 'C sum = 1（true→1 计入）')
  assert(sum.groups[0].name === 'A', 'sum 按值降序，A(30) 排第一')

  // avg：30/2=15、5.5/1=5.5、C true→1/1=1
  const avg = await aggregateTable(root, { tableId: id, xFieldId: 'f_cat', yFieldId: 'f_val', agg: 'avg' })
  const avgA = avg.groups.find((g) => g.name === 'A')
  const avgB = avg.groups.find((g) => g.name === 'B')
  const avgC = avg.groups.find((g) => g.name === 'C')
  assert(avgA !== undefined && avgA.value === 15, 'A avg = 15')
  assert(avgB !== undefined && Math.abs(avgB.value - 5.5) < 1e-9, 'B avg = 5.5')
  assert(avgC !== undefined && avgC.value === 1, 'C avg = 1')

  // topN：截断返回类目数
  const top1 = await aggregateTable(root, { tableId: id, xFieldId: 'f_cat', yFieldId: 'f_val', agg: 'sum', topN: 1 })
  assert(top1.groups.length === 1 && top1.groups[0].name === 'A', 'topN=1 只返回 A')
  const top1Cnt = await aggregateTable(root, { tableId: id, xFieldId: 'f_cat', agg: 'count', topN: 1 })
  assert(top1Cnt.groups.length === 1 && top1Cnt.groups[0].value === 3, 'count 模式 topN=1 返回最大值（cnt=3）')

  // raw：按行序采样前 N 行，y 取数值语义
  const raw = await aggregateTable(root, { tableId: id, xFieldId: 'f_cat', yFieldId: 'f_val', agg: 'raw', sampleRows: 4 })
  assert(raw.matchedRows === 3, 'raw 采样 4 行中 3 行 y 为有效数值（r4 的「abc」被滤掉）')
  assert(raw.groups.length === 3, 'raw 滤除非数值 y 行')
  assert(raw.groups[0].name === 'A' && raw.groups[0].value === 10, 'raw 保持行序（A=10 在最前）')

  // 无 yField：count 分组语义不受影响
  const noY = await aggregateTable(root, { tableId: id, xFieldId: 'f_cat', agg: 'count', topN: 10 })
  assert(noY.groups.length === 3 && noY.groups.every((g) => Number.isInteger(g.value)), '无 y 字段 count 正常分组')

  // 表不存在 → 抛错
  let threw = false
  try {
    await aggregateTable(root, { tableId: 'no-such-table', xFieldId: 'f_cat', agg: 'count' })
  } catch {
    threw = true
  }
  assert(threw, '表不存在抛错')

  __resetMigratedCache()
  rmSync(root, { recursive: true, force: true })
  console.log('\n聚合测试全部通过：SQL 侧 count/sum/avg/raw 数值语义、matchedRows、topN、行序均符合预期。')
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
