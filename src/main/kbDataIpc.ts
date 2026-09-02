/* ============================================================
 * KB 数据型资产 IPC 桥接
 *   - kbData:aggregate   分析场景对 KB 数据表实时聚合（竞品全生态空白、灵墨独占）
 *   - kbData:getTable    取整表（字段 + 行），供分析/整理视图
 *   - kbData:listTables  列出 KB 数据表，供选表
 * 聚合逻辑见 kbData.ts（薄包装注入 kbRoot = userData/kb）。
 * ============================================================ */

import { ipcMain } from 'electron'
import { aggregateKbData, getKbDataTable, listKbDataTables } from './kbData'
import type { AggregateRequest, AggregateResult, DataTable, TableMeta } from '../shared/types'

export function registerKbDataIpc(): void {
  ipcMain.handle(
    'kbData:aggregate',
    (_e, req: AggregateRequest): Promise<AggregateResult> => aggregateKbData(req)
  )
  ipcMain.handle(
    'kbData:getTable',
    (_e, id: string): Promise<DataTable | null> => getKbDataTable(id)
  )
  ipcMain.handle('kbData:listTables', (): Promise<TableMeta[]> => listKbDataTables())
}
