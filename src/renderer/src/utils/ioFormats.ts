/* 灵墨工作台 · 数据整理：多格式导入导出工具 */
import * as XLSX from 'xlsx'
import type { DataTable, FieldType, TableField, FieldValue } from '@shared/types'
import { parseDelimited } from '@shared/csv'
import { inferFieldType } from '@shared/fieldTypes'

export type ImportFormat = 'csv' | 'json' | 'tsv' | 'excel'

export interface ParsedImport {
  table: Omit<DataTable, 'id' | 'createdAt' | 'updatedAt'>
}

/** 从二维数组构建表（首行表头 + 类型推断） */
export function buildTableFromRows(name: string, rawRows: string[][]): Omit<DataTable, 'id' | 'createdAt' | 'updatedAt'> {
  if (rawRows.length < 2) throw new Error('数据至少需要表头 + 一行数据')
  const header = rawRows[0]
  const colCount = header.length
  const body = rawRows.slice(1)
  const rowCount = body.length

  // 单次遍历按列归集取值，取代原先「每列各 slice 一遍全表」的 O(列数 × 行数) 拷贝
  const colVals: string[][] = Array.from({ length: colCount }, () => new Array<string>(rowCount))
  for (let r = 0; r < rowCount; r++) {
    const row = body[r]
    for (let i = 0; i < colCount; i++) colVals[i][r] = row[i] ?? ''
  }

  const fields: TableField[] = header.map((h, i) => {
    const type = inferFieldType(colVals[i])
    return { id: 'f' + i, name: h.trim() || '列' + (i + 1), type }
  })

  const rows = body.map((r, ri) => {
    const values: Record<string, FieldValue> = {}
    for (let i = 0; i < colCount; i++) {
      const f = fields[i]
      const v = r[i] ?? ''
      if (v === '') values[f.id] = null
      else if (f.type === 'number') values[f.id] = Number(v)
      else if (f.type === 'checkbox') values[f.id] = v === 'true' || v === '是'
      else values[f.id] = v
    }
    return { id: 'r' + ri, values }
  })
  return { name: name || '导入数据', fields, rows }
}

/** 解析文本（csv/json/tsv） */
export function parseTextImport(name: string, text: string, format: ImportFormat): Omit<DataTable, 'id' | 'createdAt' | 'updatedAt'> {
  if (format === 'json') {
    const j = JSON.parse(text) as unknown
    const arr = Array.isArray(j) ? j : (j as Record<string, unknown>).data ?? []
    if (!Array.isArray(arr) || arr.length === 0) throw new Error('JSON 需为对象数组或 { data: [...] }')
    const objs = arr as Array<Record<string, unknown>>
    const header = Object.keys(objs[0])
    const rows = objs.map((o, ri) => {
      const values: Record<string, FieldValue> = {}
      header.forEach((h, i) => {
        const v = o[h]
        values['f' + i] = v === undefined || v === null ? null : typeof v === 'number' ? v : String(v)
      })
      return { id: 'r' + ri, values }
    })
    const fields: TableField[] = header.map((h, i) => {
      const colVals = rows.map((r) => r.values['f' + i])
      const type: FieldType = colVals.every((v) => v === null || typeof v === 'number') ? 'number' : 'text'
      return { id: 'f' + i, name: h, type }
    })
    return { name: name || '导入数据', fields, rows }
  }
  const delim = format === 'tsv' ? '\t' : ','
  const raw = parseDelimited(text, delim)
  return buildTableFromRows(name, raw)
}

/** 解析 Excel 文件（ArrayBuffer） */
export function parseExcelImport(name: string, buf: ArrayBuffer): Omit<DataTable, 'id' | 'createdAt' | 'updatedAt'> {
  const wb = XLSX.read(buf, { type: 'array' })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  if (!sheet) throw new Error('Excel 无工作表')
  const raw = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '' }) as string[][]
  return buildTableFromRows(name, raw)
}

function esc(v: unknown): string {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

/** 表导出为 CSV/TSV 字符串 */
export function tableToDelimited(table: DataTable, delim: string): string {
  const header = table.fields.map((f) => esc(f.name)).join(delim)
  const lines = table.rows.map((r) => table.fields.map((f) => esc(r.values[f.id] ?? '')).join(delim))
  return [header, ...lines].join('\n')
}

/** 表导出为 JSON 字符串 */
export function tableToJson(table: DataTable): string {
  const objs = table.rows.map((r) => {
    const o: Record<string, unknown> = {}
    table.fields.forEach((f) => {
      o[f.name] = r.values[f.id] ?? ''
    })
    return o
  })
  return JSON.stringify(objs, null, 2)
}

/** 表导出为 Excel ArrayBuffer */
export function tableToExcel(table: DataTable): ArrayBuffer {
  const aoa: Array<Array<unknown>> = [table.fields.map((f) => f.name)]
  table.rows.forEach((r) => {
    aoa.push(table.fields.map((f) => r.values[f.id] ?? ''))
  })
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '数据')
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
}

/** 导出文件名扩展名 */
export const FORMAT_EXT: Record<ImportFormat, string> = {
  csv: 'csv',
  json: 'json',
  tsv: 'tsv',
  excel: 'xlsx'
}
