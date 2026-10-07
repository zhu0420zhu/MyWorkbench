/**
 * 数据分析页 · 黄框筛选 → 主进程聚合 链路验证（无头）
 *
 * 覆盖三框修复里「筛选条件真正落到数据库聚合」这一未被 marker-grep 覆盖的环节：
 *  - SQL 聚合路径（小表默认）：buildFilterSql 生成 WHERE 片段
 *  - raw 路径：passFilters 行级判定（与 SQL 语义对齐）
 *  - 多操作符：eq / neq / gt / contains / isMissing
 *
 * 运行：npm run test:analytics-filters
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { importTable, aggregateTable, __resetMigratedCache } from '../src/main/tablesCore.ts'

const ROOT = join('tests', '.tmp-filter-db')
let passed = 0
let failed = 0

function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name} ${extra}`)
  }
}

function names(groups: { name: string; value: number }[]): string[] {
  return groups.map((g) => g.name)
}
function sumOf(groups: { name: string; value: number }[], name: string): number {
  return groups.find((g) => g.name === name)?.value ?? 0
}

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true })
  __resetMigratedCache()

  const fields = [
    { id: 'region', name: '地区', type: 'text' as const },
    { id: 'amount', name: '金额', type: 'number' as const },
    { id: 'note', name: '备注', type: 'text' as const }
  ]
  const rows = [
    { id: 'r1', values: { region: '华东', amount: 120, note: '重要客户' } },
    { id: 'r2', values: { region: '华东', amount: 80, note: '普通' } },
    { id: 'r3', values: { region: '华北', amount: 200, note: '重要' } },
    { id: 'r4', values: { region: '华北', amount: 50, note: '' } },
    { id: 'r5', values: { region: '华南', amount: 150, note: null } },
    { id: 'r6', values: { region: '华南', amount: 300, note: '重要' } }
  ]
  const { id: tableId } = await importTable(ROOT, { name: '销售', fields, rows })

  console.log('SQL 聚合路径（buildFilterSql → WHERE）')
  // 1. 无筛选：3 个地区，求和正确
  const base = await aggregateTable(ROOT, { tableId, xFieldId: 'region', yFieldId: 'amount', agg: 'sum' })
  ok('无筛选返回 3 个地区', base.groups.length === 3, `got ${names(base.groups)}`)
  ok('华东求和=200', sumOf(base.groups, '华东') === 200, `got ${sumOf(base.groups, '华东')}`)
  ok('华南求和=450', sumOf(base.groups, '华南') === 450, `got ${sumOf(base.groups, '华南')}`)
  ok('数值行 matchedRows=6', base.matchedRows === 6, `got ${base.matchedRows}`)

  // 2. eq：仅华东
  const eq = await aggregateTable(ROOT, { tableId, xFieldId: 'region', yFieldId: 'amount', agg: 'sum', filters: [{ fieldId: 'region', op: 'eq', value: '华东' }] })
  ok('eq 仅华东 1 组', eq.groups.length === 1 && eq.groups[0].name === '华东', `got ${names(eq.groups)}`)
  ok('eq 华东求和=200', sumOf(eq.groups, '华东') === 200)

  // 3. neq：华北+华南
  const neq = await aggregateTable(ROOT, { tableId, xFieldId: 'region', yFieldId: 'amount', agg: 'sum', filters: [{ fieldId: 'region', op: 'neq', value: '华东' }] })
  ok('neq 排除华东 → 2 组', neq.groups.length === 2 && !names(neq.groups).includes('华东'), `got ${names(neq.groups)}`)

  // 4. gt：金额>100（count 模式，按地区计行数）
  const gt = await aggregateTable(ROOT, { tableId, xFieldId: 'region', yFieldId: 'amount', agg: 'count', filters: [{ fieldId: 'amount', op: 'gt', value: '100' }] })
  ok('gt 金额>100 → 4 行（华东1/华北1/华南2）', gt.groups.length === 3, `got ${names(gt.groups)}`)
  ok('gt 华南计数=2', sumOf(gt.groups, '华南') === 2, `got ${sumOf(gt.groups, '华南')}`)

  // 5. contains：备注含「重要」
  const contains = await aggregateTable(ROOT, { tableId, xFieldId: 'region', yFieldId: 'amount', agg: 'count', filters: [{ fieldId: 'note', op: 'contains', value: '重要' }] })
  ok('contains 重要 → 3 行（华东1/华北1/华南1）', contains.groups.length === 3, `got ${names(contains.groups)}`)

  // 6. isMissing：备注为空/null
  const missing = await aggregateTable(ROOT, { tableId, xFieldId: 'region', yFieldId: 'amount', agg: 'count', filters: [{ fieldId: 'note', op: 'isMissing', value: '' }] })
  ok('isMissing → 2 行（华北空/华南null）', missing.groups.length === 2, `got ${names(missing.groups)}`)

  console.log('raw 路径（passFilters 行级判定，与 SQL 语义对齐）')
  // 7. raw + eq 华东：逐行出点，验证 passFilters 与 buildFilterSql 一致
  const raw = await aggregateTable(ROOT, { tableId, xFieldId: 'region', yFieldId: 'amount', agg: 'raw', filters: [{ fieldId: 'region', op: 'eq', value: '华东' }] })
  ok('raw+eq 华东 → 2 行出点', raw.groups.length === 2, `got ${raw.groups.length}`)

  cleanup()
  console.log(`\n结果：${passed} PASS / ${failed} FAIL`)
  if (failed > 0) process.exit(1)
}

function cleanup(): void {
  try {
    __resetMigratedCache() // 关闭已打开的 db 句柄，释放 WAL 锁，Windows 下才能删目录
  } catch {
    /* 忽略 */
  }
  try {
    rmSync(ROOT, { recursive: true, force: true })
  } catch {
    /* 忽略清理失败 */
  }
}

main().catch((e) => {
  cleanup()
  console.error(e)
  process.exit(1)
})
