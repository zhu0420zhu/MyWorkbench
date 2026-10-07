// 端到端集成测试：直接调用应用真实使用的 main 进程模块 src/main/tables.ts
// （经 electron-stub 提供 userData 路径），验证返回类型与行为，而非仅测纯逻辑 core。
import { createTable, getTable, listTables, removeTable, updateCell, updateTable } from '../src/main/tables.ts'
import type { DataTable, TableField } from '../src/shared/types.ts'

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error('  FAIL -', msg)
    process.exit(1)
  }
  console.log('  ok  -', msg)
}

async function run(): Promise<void> {
  console.log('=== 真实 tables.ts 包装层（经 electron stub）端到端 ===')

  let list = await createTable('集成测试')
  assert(Array.isArray(list) && list.length === 1, 'createTable 返回 TableMeta[]')
  const meta = list[0]
  assert(typeof meta.id === 'string' && typeof meta.fieldCount === 'number' && typeof meta.rowCount === 'number', 'TableMeta 含 id/fieldCount/rowCount')
  assert(meta.fieldCount === 2 && meta.rowCount === 0, '新表默认 2 字段 / 0 行（摘要，不含行）')

  const fields: TableField[] = [
    { id: 'f1', name: '名称', type: 'text' },
    { id: 'f2', name: '状态', type: 'select', options: ['x', 'y'] }
  ]
  const full: DataTable = {
    id: meta.id,
    name: '集成测试',
    fields,
    rows: [{ id: 'r1', values: { f1: 'a', f2: 'x' } }],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  list = await updateTable(full)
  assert(list[0].rowCount === 1, 'updateTable 后 rowCount 更新为 1（无需回传整表也能得到正确摘要）')

  const got = await getTable(meta.id)
  assert(got !== null && got.rows.length === 1 && got.fields.length === 2, 'getTable 返回完整 DataTable（含行与字段）')

  list = await updateCell(meta.id, 'r1', 'f2', 'y')
  assert(Array.isArray(list) && list[0].rowCount === 1, 'updateCell 返回 TableMeta[] 且 rowCount 不变（跨进程仅传 4 标量）')

  const got2 = await getTable(meta.id)
  assert(got2 !== null && got2.rows[0].values['f2'] === 'y', 'updateCell 的标量已正确落盘')

  // 行序保持：group_concat 依赖有序子查询，100 行乱序 id 读回必须与写入顺序一致
  const orderFields: TableField[] = [{ id: 'fx', name: 'X', type: 'text' }]
  const orderRows = Array.from({ length: 100 }, (_, i) => ({ id: 'row' + (99 - i), values: { fx: i } }))
  const orderTable: DataTable = {
    id: meta.id,
    name: '集成测试',
    fields: orderFields,
    rows: orderRows,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  await updateTable(orderTable)
  const got3 = await getTable(meta.id)
  const orderOk =
    got3 !== null && got3.rows.length === 100 && got3.rows.every((r, i) => r.id === 'row' + (99 - i) && r.values.fx === i)
  assert(orderOk, '100 行乱序 id 的行序在读回后与写入顺序完全一致')

  // 布尔/空值往返：FieldValue 三态经 JSON 存储不变形（'row99' 写入时在数组下标 0）
  await updateCell(meta.id, 'row99', 'fx', true)
  const got4 = await getTable(meta.id)
  assert(got4 !== null && got4.rows[0].values.fx === true, 'updateCell 布尔值往返不变形')

  list = await removeTable(meta.id)
  assert(list.length === 0, 'removeTable 后列表清空')
  const gone = await getTable(meta.id)
  assert(gone === null, 'removeTable 后 getTable 返回 null')

  console.log('\n集成测试全部通过：应用真实使用的 tables.ts 包装层行为正确（list/get/updateCell 返回类型与持久化均符合预期）。')
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
