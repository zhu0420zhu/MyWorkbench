/* 灵墨工作台 · 解析 Worker：把「解码 + CSV/TSV/JSON 解析」搬离主线程
 * 大文件（百万行级）解析动辄数秒，放在主线程会冻结界面；
 * Worker 里跑同样的纯函数（csv.ts / ioFormats.ts / encoding.ts 均无 electron 依赖），
 * 结果经结构化克隆回传主线程。
 */
import { parseCsvToTable, type ParsedTable } from '../utils/csv'
import { parseExcelImport, parseTextImport, type ImportFormat } from '../utils/ioFormats'
import { decodeBytes, resolveEncoding } from '../utils/encoding'
import type { DataTable } from '@shared/types'

export interface ParseWorkerRequest {
  /** csv-table：数据分析用；text-import：数据整理导入用（csv/json/tsv）；excel-import：Excel 工作簿 */
  kind: 'csv-table' | 'text-import' | 'excel-import'
  bytes: Uint8Array
  encoding: string
  name: string
  /** kind=text-import 时必填 */
  format?: ImportFormat
}

export interface ParseWorkerOkBase {
  ok: true
  text: string
  resolvedEncoding: string
}

export interface ParseWorkerCsvOk extends ParseWorkerOkBase {
  kind: 'csv-table'
  table: ParsedTable
}

export interface ParseWorkerImportOk extends ParseWorkerOkBase {
  kind: 'text-import'
  table: Omit<DataTable, 'id' | 'createdAt' | 'updatedAt'>
}

export interface ParseWorkerExcelOk extends ParseWorkerOkBase {
  kind: 'excel-import'
  table: Omit<DataTable, 'id' | 'createdAt' | 'updatedAt'>
}

export type ParseWorkerResult = ParseWorkerCsvOk | ParseWorkerImportOk | ParseWorkerExcelOk | { ok: false; error: string }

// tsconfig.web 是 DOM lib，这里显式收窄 self 的类型，避免 Window.postMessage 签名干扰
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ParseWorkerRequest>) => void) | null
  postMessage: (msg: ParseWorkerResult) => void
}

ctx.onmessage = (e: MessageEvent<ParseWorkerRequest>) => {
  const req = e.data
  try {
    if (req.kind === 'excel-import') {
      // Excel 无编码概念；XLSX 库较重，由 tree-shaking 决定是否进入 worker chunk
      const buf = req.bytes.slice().buffer as ArrayBuffer
      ctx.postMessage({
        ok: true,
        kind: 'excel-import',
        text: '',
        resolvedEncoding: '',
        table: parseExcelImport(req.name, buf)
      })
      return
    }
    const text = decodeBytes(req.bytes, req.encoding)
    const resolvedEncoding = resolveEncoding(req.bytes, req.encoding)
    if (req.kind === 'csv-table') {
      ctx.postMessage({ ok: true, kind: 'csv-table', text, resolvedEncoding, table: parseCsvToTable(text) })
    } else {
      ctx.postMessage({
        ok: true,
        kind: 'text-import',
        text,
        resolvedEncoding,
        table: parseTextImport(req.name, text, req.format ?? 'csv')
      })
    }
  } catch (err) {
    ctx.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
