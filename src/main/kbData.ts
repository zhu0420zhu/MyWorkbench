/* ============================================================
 * KB 数据型资产薄包装（类 src/main/tables.ts）
 *
 * 把「登记进知识库的数据表」聚合/读取请求，统一路由到独立 KB 数据表库
 *   root = userData/kb → tables/lingmo.db
 * 渲染层只拿到 tableId，路径对渲染层不透明（竞品全生态空白、灵墨独占点）。
 * 仅依赖 electron 的 app.getPath，不引入其它第三方依赖。
 * ============================================================ */

import { app } from 'electron'
import { join } from 'node:path'
import { aggregateTable, getTable, listTables } from './tablesCore'
import type { AggregateResult, AggregateRequest, DataTable, TableMeta } from '../shared/types'

/** KB 数据表库根目录：所有数据型资产落库位置（userData/kb/tables/lingmo.db） */
export function kbRoot(): string {
  return join(app.getPath('userData'), 'kb')
}

/** 直接聚合 KB 数据型资产表（复用 tablesCore.aggregateTable 100% 逻辑） */
export function aggregateKbData(req: AggregateRequest): Promise<AggregateResult> {
  return aggregateTable(kbRoot(), req)
}

/** 取 KB 数据表完整内容（字段 + 行），供分析/整理视图载入编辑 */
export function getKbDataTable(id: string): Promise<DataTable | null> {
  return getTable(kbRoot(), id)
}

/** 列出 KB 数据表摘要（不含行），供分析视图选表 */
export function listKbDataTables(): Promise<TableMeta[]> {
  return listTables(kbRoot())
}
