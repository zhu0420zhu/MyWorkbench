/* 灵墨工作台 · 解析 Worker 客户端（主线程侧）
 * Vite 会在构建时把 new Worker(new URL('./parseWorker.ts', import.meta.url)) 打成独立 chunk。
 * 每次调用新建独立 Worker、用完即销毁：解析是低频重活，省去常驻 Worker 的队列管理。
 */
import type { ParsedTable } from '../utils/csv'
import type { DataTable } from '@shared/types'
import type { ImportFormat } from '../utils/ioFormats'
import type { ParseWorkerRequest, ParseWorkerResult } from './parseWorker'

export interface CsvParseOk {
  text: string
  resolvedEncoding: string
  table: ParsedTable
}

export interface TextImportOk {
  text: string
  resolvedEncoding: string
  table: Omit<DataTable, 'id' | 'createdAt' | 'updatedAt'>
}

function runWorker(req: ParseWorkerRequest): Promise<Extract<ParseWorkerResult, { ok: true }>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./parseWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<ParseWorkerResult>) => {
      worker.terminate()
      if (e.data.ok) resolve(e.data)
      else reject(new Error(e.data.error))
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message || '解析失败'))
    }
    worker.postMessage(req)
  })
}

/** 数据分析：在 Worker 中解码 + 解析 CSV 文本为图表数据 */
export async function parseCsvTableInWorker(bytes: Uint8Array, encoding: string): Promise<CsvParseOk> {
  const res = await runWorker({ kind: 'csv-table', bytes, encoding, name: '' })
  if (res.kind !== 'csv-table') throw new Error('解析 Worker 返回类型不匹配')
  return { text: res.text, resolvedEncoding: res.resolvedEncoding, table: res.table }
}

/** 数据整理：在 Worker 中解码 + 解析 csv/json/tsv 为数据表 */
export async function parseTextImportInWorker(
  bytes: Uint8Array,
  encoding: string,
  name: string,
  format: ImportFormat
): Promise<TextImportOk> {
  const res = await runWorker({ kind: 'text-import', bytes, encoding, name, format })
  if (res.kind !== 'text-import') throw new Error('解析 Worker 返回类型不匹配')
  return { text: res.text, resolvedEncoding: res.resolvedEncoding, table: res.table }
}

/** 数据整理：在 Worker 中解析 Excel 工作簿（XLSX 库在子线程运行，大工作簿不冻结主线程） */
export async function parseExcelImportInWorker(bytes: Uint8Array, name: string): Promise<TextImportOk> {
  const res = await runWorker({ kind: 'excel-import', bytes, encoding: '', name })
  if (res.kind !== 'excel-import') throw new Error('解析 Worker 返回类型不匹配')
  return { text: '', resolvedEncoding: '', table: res.table }
}
