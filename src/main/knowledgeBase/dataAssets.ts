/* ============================================================
 * 知识库数据型资产登记（纯逻辑，不依赖 electron，可在 Node 下无头测试）
 *
 * 职责：把本地 CSV/TSV/XLSX 作为结构化数据资产登记进知识库，
 *   - 解析为字段(含 FieldType) + 行；
 *   - 复制源文件到 userData/kb/sources/<assetId>.<ext>（句柄/溯源）；
 *   - 导入到独立的 KB 数据表库 userData/kb/tables/lingmo.db 取得 tableId；
 *   - 取前 N 行样本，写入 userData/kb/dataAssets.json；
 *   - 返回 DataAssetRecord。
 *
 * 复用既有 aggregateTable 聚合引擎：分析/整理场景经 kbData 薄包装（kbRoot=userData/kb）
 * 直接聚合登记后的表，做到「竞品全生态空白、灵墨独占」的实时聚合点。
 * ============================================================ */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type {
  DataAssetColumn,
  DataAssetRecord,
  DataAssetRegInput,
  DataTable,
  FieldType,
  FieldValue,
  TableField,
  TableImportInput,
  TableImportResult,
  TableMeta,
  TableRow
} from '../../shared/types.ts'
import type { ConvertInput, ConversionResult } from '../convert/types.ts'
import { parseDelimited } from '../../shared/csv.ts'
import { inferFieldType } from '../../shared/fieldTypes.ts'

/** 可登记为结构化数据资产的数据型扩展名 */
export const DATA_EXTS = ['.csv', '.tsv', '.xlsx', '.xls'] as const

export interface DataAssetRegistryDeps {
  /** 返回 KB 根目录（库位于 kbRoot()/tables/lingmo.db） */
  kbRoot: () => string
  importTable: (root: string, input: TableImportInput) => Promise<TableImportResult>
  getTable: (root: string, id: string) => Promise<DataTable | null>
  listTables: (root: string) => Promise<TableMeta[]>
  /** 寻找 src→tgt 转换器（封装 ConverterRegistry.findConverter），未安装返回 undefined */
  getConverter: (src: string, tgt: string) => string | undefined
  /** 执行格式转换（封装 ConverterRegistry.convert），用于 XLSX → CSV */
  convert: (input: ConvertInput) => Promise<ConversionResult>
  /** 原子写：tmp + rename，避免半截 JSON（仿 configStore） */
  atomicWrite: (file: string, obj: unknown) => Promise<void>
  /** 读取当前资产状态（{ assets: DataAssetRecord[] }），缺省返回空数组 */
  readState: () => Promise<{ assets: DataAssetRecord[] }>
}

export class DataAssetRegistry {
  private readonly kbRoot: () => string
  private readonly importTable: (root: string, input: TableImportInput) => Promise<TableImportResult>
  private readonly getTable: (root: string, id: string) => Promise<DataTable | null>
  private readonly listTables: (root: string) => Promise<TableMeta[]>
  private readonly getConverter: (src: string, tgt: string) => string | undefined
  private readonly convert: (input: ConvertInput) => Promise<ConversionResult>
  private readonly atomicWrite: (file: string, obj: unknown) => Promise<void>
  private readonly readState: () => Promise<{ assets: DataAssetRecord[] }>

  constructor(deps: DataAssetRegistryDeps) {
    this.kbRoot = deps.kbRoot
    this.importTable = deps.importTable
    this.getTable = deps.getTable
    this.listTables = deps.listTables
    this.getConverter = deps.getConverter
    this.convert = deps.convert
    this.atomicWrite = deps.atomicWrite
    this.readState = deps.readState
  }

  /** 把解析后的二维数组构建为字段(含类型) + 行（值与 ioFormats.buildTableFromRows 同语义） */
  private buildFromRaw(raw: string[][]): { fields: TableField[]; rows: TableRow[] } {
    if (raw.length < 2) throw new Error('数据至少需要表头 + 一行数据')
    const header = raw[0]
    const colCount = header.length
    const body = raw.slice(1)
    const rowCount = body.length

    // 单次遍历按列归集取值，取代原先「每列各 slice 一遍全表」的 O(列数 × 行数) 拷贝
    const colVals: string[][] = Array.from({ length: colCount }, () => new Array<string>(rowCount))
    for (let r = 0; r < rowCount; r++) {
      const row = body[r]
      for (let i = 0; i < colCount; i++) colVals[i][r] = row[i] ?? ''
    }

    const fields: TableField[] = header.map((h, i) => ({
      id: 'f' + i,
      name: h.trim() || '列' + (i + 1),
      type: inferFieldType(colVals[i])
    }))

    const rows: TableRow[] = body.map((r, ri) => {
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
    return { fields, rows }
  }

  /**
   * 登记一个本地数据文件为结构化数据资产。
   * CSV/TSV 直接解析；XLSX/XLS 经转换引擎 .xlsx→.csv 再解析。
   * 任何失败抛错，由调用方（builder）兜底为 error 状态。
   */
  async register(input: DataAssetRegInput): Promise<DataAssetRecord> {
    const filePath = input.path
    const kbId = input.kbId
    const sampleRows = input.sampleRows ?? 5
    const ext = extname(filePath).toLowerCase()
    const root = this.kbRoot()

    let fields: TableField[]
    let rows: TableRow[]
    if (ext === '.csv' || ext === '.tsv') {
      const text = await fs.readFile(filePath, 'utf-8')
      const delim = ext === '.tsv' ? '\t' : ','
      const raw = parseDelimited(text, delim)
      const parsed = this.buildFromRaw(raw)
      fields = parsed.fields
      rows = parsed.rows
    } else if (ext === '.xlsx' || ext === '.xls') {
      const converterName = this.getConverter(ext, '.csv')
      if (!converterName) {
        throw new Error(`未找到 ${ext} → csv 转换器（请安装 LibreOffice / Pandoc 等转换后端）`)
      }
      const tmpDir = join(root, 'tmp')
      mkdirSync(tmpDir, { recursive: true })
      const res = await this.convert({ sourcePath: filePath, targetFormat: '.csv', outputDir: tmpDir })
      if (!res.success || !res.targetPath) {
        throw new Error(`XLSX 转换失败: ${res.error || '未知错误'}`)
      }
      const text = await fs.readFile(res.targetPath, 'utf-8')
      const raw = parseDelimited(text, ',')
      const parsed = this.buildFromRaw(raw)
      fields = parsed.fields
      rows = parsed.rows
    } else {
      throw new Error(`不支持的数据资产扩展名: ${ext}`)
    }

    if (fields.length === 0) throw new Error('解析后无字段（空表头）')

    // 复制源文件到 sources/<assetId>.<ext>（句柄/溯源，受备份覆盖）
    const assetId = randomUUID()
    const sourcesDir = join(root, 'sources')
    mkdirSync(sourcesDir, { recursive: true })
    const localFilePath = join(sourcesDir, assetId + ext)
    await fs.copyFile(filePath, localFilePath)

    // 导入到 KB 数据表库，取得 tableId
    const tableName = basename(filePath, ext) || '数据资产'
    const result = await this.importTable(root, { name: tableName, fields, rows })
    const tableId = result.id

    // 取前 N 行样本（让模型/前端理解结构，不复制全表）
    const full = await this.getTable(root, tableId)
    const sample = full ? full.rows.slice(0, sampleRows).map((r) => r.values) : []

    const now = Date.now()
    const record: DataAssetRecord = {
      assetId,
      kbId,
      sourcePath: filePath,
      localFilePath,
      fileName: basename(filePath),
      tableName,
      tableId,
      columns: fields.map((f) => ({ fieldId: f.id, name: f.name, type: f.type as FieldType })),
      rowCount: rows.length,
      sampleRows: sample,
      createdAt: now,
      updatedAt: now
    }

    // 原子追加进 dataAssets.json（结构上 { assets: DataAssetRecord[] }）
    const stateFile = join(root, 'dataAssets.json')
    const state = await this.readState()
    state.assets.push(record)
    await this.atomicWrite(stateFile, state)

    return record
  }

  /** 列出已登记的数据资产（可按 kbId 过滤） */
  async list(kbId?: string): Promise<DataAssetRecord[]> {
    const s = await this.readState()
    return kbId ? s.assets.filter((a) => a.kbId === kbId) : s.assets
  }

  /** 按 assetId 取单个资产 */
  async get(assetId: string): Promise<DataAssetRecord | null> {
    const s = await this.readState()
    return s.assets.find((a) => a.assetId === assetId) ?? null
  }

  /** 按 assetId 取列定义（DataAssetColumn[]） */
  async columns(assetId: string): Promise<DataAssetColumn[]> {
    const rec = await this.get(assetId)
    return rec ? rec.columns : []
  }
}

/** 判断扩展名是否为可登记的数据型资产 */
export function isDataAssetExt(ext: string): boolean {
  const e = ext.toLowerCase()
  return (DATA_EXTS as readonly string[]).includes(e) || DATA_EXTS.includes(e as (typeof DATA_EXTS)[number])
}

/** 供无头测试：源文件是否已存在（防御性校验） */
export function dataAssetSourceExists(path: string): boolean {
  return existsSync(path)
}
