/* 灵墨工作台 · 数据表存储（electron 薄包装：仅负责提供 userData 路径）
 * 真正的存储逻辑在 tablesCore.ts（纯逻辑、可无头测试）。
 */
import { app } from 'electron'
import type {
  AggregateRequest,
  AggregateResult,
  DataTable,
  FieldValue,
  TableImportInput,
  TableImportResult,
  TableMeta
} from '../shared/types'
import {
  aggregateTable as aggregateTableCore,
  createTable as createTableCore,
  getTable as getTableCore,
  importTable as importTableCore,
  listTables as listTablesCore,
  removeTable as removeTableCore,
  updateCell as updateCellCore,
  updateTable as updateTableCore
} from './tablesCore'

function root(): string {
  return app.getPath('userData')
}

export function listTables(): Promise<TableMeta[]> {
  return listTablesCore(root())
}

export function getTable(id: string): Promise<DataTable | null> {
  return getTableCore(root(), id)
}

export function createTable(name: string): Promise<TableMeta[]> {
  return createTableCore(root(), name)
}

export function updateTable(payload: DataTable): Promise<TableMeta[]> {
  return updateTableCore(root(), payload)
}

export function removeTable(id: string): Promise<TableMeta[]> {
  return removeTableCore(root(), id)
}

export function updateCell(tableId: string, rowId: string, fieldId: string, value: FieldValue): Promise<TableMeta[]> {
  return updateCellCore(root(), tableId, rowId, fieldId, value)
}

export function importTable(input: TableImportInput): Promise<TableImportResult> {
  return importTableCore(root(), input)
}

export function aggregateTable(req: AggregateRequest): Promise<AggregateResult> {
  return aggregateTableCore(root(), req)
}
