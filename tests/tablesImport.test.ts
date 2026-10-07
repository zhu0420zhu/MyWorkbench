// 无头测试：tablesCore.importTable —— 单次 IPC 导入（旧链路 create→update 的替代）
// 运行：node --experimental-strip-types tests/tablesImport.test.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __resetMigratedCache,
  getTable,
  importTable,
  listTables
} from '../src/main/tablesCore.ts'
import type { TableField, TableRow } from '../src/shared/types.ts'

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error('  FAIL -', msg)
    process.exit(1)
  }
  console.log('  ok  -', msg)
}

const root = mkdtempSync(join(tmpdir(), 'lm-tables-import-'))

const fields: TableField[] = [
  { id: 'f_cat', name: '分类', type: 'text' },
  { id: 'f_val', name: '数值', type: 'number' }
]
const rows: TableRow[] = [
  { id: 'r1', values: { f_cat: 'A', f_val: 10 } },
  { id: 'r2', values: { f_cat: 'A', f_val: 20 } },
  { id: 'r3', values: { f_cat: 'B', f_val: '5.5' } },
  { id: 'r4', values: { f_cat: 'B', f_val: null } },
  { id: 'r5', values: { f_cat: 'C', f_val: true } }
]

async function run(): Promise<void> {
  console.log('=== tablesCore.importTable 单事务导入 ===')

  const res = await importTable(root, { name: '  销售数据  ', fields, rows })
  assert(typeof res.id === 'string' && res.id.length > 0, '返回新表 id')
  assert(Array.isArray(res.metas) && res.metas.length === 1, '返回最新 TableMeta[]')
  const meta = res.metas[0]
  assert(meta.id === res.id, 'metas[0].id 与返回 id 一致')
  assert(meta.fieldCount === 2, 'fieldCount = 2')
  assert(meta.rowCount === 5, 'rowCount = 5（摘要含行数，无需回读整表）')

  const got = await getTable(root, res.id)
  assert(got !== null, 'getTable 可读回')
  assert(got.name === '销售数据', '名称去除首尾空白')
  assert(got.fields.length === 2 && got.fields[0].id === 'f_cat', '字段按序保留')
  assert(got.rows.length === 5, '行数一致')
  assert(got.rows[2].values.f_val === '5.5', '字符串数值往返不变形')
  assert(got.rows[4].values.f_val === true, '布尔值往返不变形')

  const def = await importTable(root, { name: '   ', fields: [], rows: [] })
  const gotDef = await getTable(root, def.id)
  assert(gotDef !== null && gotDef.name === '导入数据', '空名称回退默认「导入数据」')
  assert(gotDef.rows.length === 0, '空表导入 rowCount = 0')

  const res2 = await importTable(root, { name: '第二张', fields, rows: rows.slice(0, 2) })
  assert(res2.metas.length === 3, '再次导入追加新表，不覆盖既有表（列表 3 张）')
  const list = await listTables(root)
  assert(list.length === 3, 'listTables 与摘要一致')

  __resetMigratedCache()
  rmSync(root, { recursive: true, force: true })
  console.log('\n导入测试全部通过：单次导入返回 id+摘要，数据完整往返，多次导入互不覆盖。')
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
