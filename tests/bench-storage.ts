/* 灵墨工作台 · 存储层基准（无头，直测 tablesCore 纯逻辑）
 * 验证分表改造：create/updateTable/updateCell(增量)/getTable/listTables 的耗时。
 * 注意：tablesCore 的 updateCell 仍会重写整表文件（文件存储的固有下限），
 * 但其跨进程载荷只有 4 个标量，且渲染层是 400ms 防抖触发，远优于旧实现「每次编辑都整表 IPC + 美化重写」。
 */
import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DataTable, FieldValue, TableField, TableRow } from '../src/shared/types.ts'
import {
  __resetMigratedCache,
  createTable,
  getTable,
  listTables,
  removeTable,
  updateCell,
  updateTable
} from '../src/main/tablesCore.ts'

function buildTable(rows: number, cols: number): { fields: TableField[]; rowObjs: TableRow[] } {
  const fields: TableField[] = []
  for (let c = 0; c < cols; c++) {
    fields.push({ id: 'f' + c, name: '列' + (c + 1), type: c === 1 ? 'number' : 'text' })
  }
  const rowObjs: TableRow[] = []
  for (let r = 0; r < rows; r++) {
    const values: Record<string, FieldValue> = {}
    for (let c = 0; c < cols; c++) {
      values['f' + c] = c === 1 ? r : '值' + r + '-' + c
    }
    rowObjs.push({ id: 'r' + r, values })
  }
  return { fields, rowObjs }
}

async function time<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
  const t0 = performance.now()
  const r = await fn()
  const t1 = performance.now()
  console.log(`  ${label.padEnd(26)} ${(t1 - t0).toFixed(0)} ms`)
  return r
}

async function run(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'lm-storage-bench-'))
  try {
    for (const [rows, cols] of [[50000, 5], [200000, 5], [200000, 20]] as const) {
      console.log(`\n=== ${rows.toLocaleString()} 行 × ${cols} 列 ===`)
      const { fields, rowObjs } = buildTable(rows, cols)

      let metaList = await time('createTable', () => createTable(root, 'bench'))
      const id = metaList[0].id

      const full: DataTable = { id, name: 'bench', fields, rows: rowObjs, createdAt: Date.now(), updatedAt: Date.now() }
      await time('updateTable(整表写入)', () => updateTable(root, full))
      // 释放解析期的本地引用，避免与回读副本叠加挤爆内存（产品内 import 后即有 full，无需再读）
      const totalRows = full.rows.length
      // @ts-expect-error 主动断开引用便于 GC
      full.rows = null

      await time('updateCell × 5（增量）', async () => {
        for (let i = 0; i < 5; i++) {
          await updateCell(root, id, 'r' + i, 'f1', i * 2)
        }
      })

      const reread = await time('getTable(回读整表)', () => getTable(root, id))
      if (!reread || reread.rows.length !== totalRows) throw new Error('回读行数不符：' + (reread?.rows.length ?? 'null'))

      const meta = await time('listTables(仅摘要)', () => listTables(root))
      if (meta[0].rowCount !== totalRows) throw new Error('摘要行数不符：' + meta[0].rowCount)

      await time('removeTable', () => removeTable(root, id))
    }
    console.log('\n全部通过：分表存储基准正常，回读/摘要行数一致。')
  } finally {
    // 先关闭 SQLite 句柄（WAL 文件在 Windows 上持有锁），否则临时目录清理会 EBUSY
    __resetMigratedCache()
    rmSync(root, { recursive: true, force: true })
  }
}

run().catch((e) => {
  console.error('基准失败：', e)
  process.exit(1)
})
