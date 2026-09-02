/* 灵墨工作台 · 数据表存储核心（SQLite 引擎，纯逻辑，不依赖 electron，便于无头测试）
 *
 * 存储：root/tables/lingmo.db（node:sqlite 内置模块，零第三方依赖；Electron 43 内置 Node 24
 * 与托管 Node 22.22 均原生支持，无需原生编译 / electron-rebuild）
 *   tables(id PK, name, fields_json, created_at, updated_at)
 *   rows(table_id, row_id, ord, data)  PK(table_id, row_id) + INDEX(table_id, ord)
 *
 * 行级存储：每行是一个紧凑 JSON（Record<fieldId, FieldValue>）。
 * - updateCell：主键定位单行 → 改一个键 → 写回，毫秒级。旧 JSON 文件方案改一格要重写整表
 *   （20 万×20 约 5.5s、109 万行约 30s+），那是大表编辑卡顿的最后根源；
 * - updateTable（导入/结构变更）：事务内整表替换，百万行约秒级，与旧方案持平。
 *
 * 自动迁移（原文件改名 .migrated 保留备份，绝不删除）：
 *   v2  tables/index.json + tables/<id>.json（上一代分文件布局）
 *   v0  tables.json（更早的单文件布局）
 */
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, promises as fs } from 'fs'
import { join } from 'path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type {
  AggregateFilter,
  AggregateGroup,
  AggregateKind,
  AggregateRequest,
  AggregateResult,
  DataTable,
  FieldValue,
  TableImportInput,
  TableImportResult,
  TableMeta
} from '../shared/types'

interface RowRecord {
  id: string
  values: Record<string, FieldValue>
}

interface StmtSet {
  listTables: StatementSync
  getTable: StatementSync
  getRowsPacked: StatementSync
  upsertTable: StatementSync
  deleteRows: StatementSync
  getCellRow: StatementSync
  updateCellRow: StatementSync
  touchTable: StatementSync
  deleteTable: StatementSync
}

interface DbHandle {
  db: DatabaseSync
  stmts: StmtSet
  /** 200 行/批的多行 INSERT（800 参数，低于 SQLITE_MAX_VARIABLE_NUMBER 默认上限），惰性编译 */
  batchInsert: StatementSync | null
}

/** 已初始化的数据库句柄，按 root 缓存（含预编译语句，避免热路径反复 prepare） */
const dbCache = new Map<string, DbHandle>()
/** 已迁移过的 root，避免每次操作都去探测旧文件 */
const migrated = new Set<string>()

/* ---------- 路径 ---------- */
function dirOf(root: string): string {
  return join(root, 'tables')
}
function dbFileOf(root: string): string {
  return join(dirOf(root), 'lingmo.db')
}
function safeId(id: string): string {
  return String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '')
}

/* ---------- 打开 / 建库 ---------- */
const DDL = `
CREATE TABLE IF NOT EXISTS tables (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rows (
  table_id TEXT NOT NULL,
  row_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (table_id, row_id)
);
CREATE INDEX IF NOT EXISTS idx_rows_order ON rows(table_id, ord);
`

function openDb(root: string): DbHandle {
  const cached = dbCache.get(root)
  if (cached) return cached
  mkdirSync(dirOf(root), { recursive: true })
  const db = new DatabaseSync(dbFileOf(root))
  // 8K 页在百兆级大表上写读均快 ~35%（必须在首个表创建前设置，因此放在 DDL 之前）
  db.exec('PRAGMA page_size = 8192')
  // WAL：写不走全库锁，读写互不阻塞；NORMAL 配合 WAL 已有足够持久性
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA cache_size = -32768')
  db.exec(DDL)
  const stmts: StmtSet = {
    listTables: db.prepare(
      `SELECT t.id, t.name, t.fields_json, t.created_at AS createdAt, t.updated_at AS updatedAt,
              (SELECT COUNT(*) FROM rows r WHERE r.table_id = t.id) AS rowCount
       FROM tables t ORDER BY t.created_at DESC, t.rowid DESC`
    ),
    getTable: db.prepare('SELECT id, name, fields_json, created_at, updated_at FROM tables WHERE id = ?'),
    // group_concat 按子查询的 ord 顺序拼接，主线程侧一次 JSON.parse 完成整表反序列化。
    // 分隔符用逗号：拼接对象是完整的 JSON 文本，逗号恰好是数组元素分隔符（对象内部逗号互不干扰）
    getRowsPacked: db.prepare(
      `SELECT group_concat(row_id, ',') AS ids, group_concat(data, ',') AS datas
       FROM (SELECT row_id, data FROM rows WHERE table_id = ? ORDER BY ord)`
    ),
    upsertTable: db.prepare(
      `INSERT INTO tables(id, name, fields_json, created_at, updated_at) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, fields_json = excluded.fields_json, updated_at = excluded.updated_at`
    ),
    deleteRows: db.prepare('DELETE FROM rows WHERE table_id = ?'),
    getCellRow: db.prepare('SELECT data FROM rows WHERE table_id = ? AND row_id = ?'),
    updateCellRow: db.prepare('UPDATE rows SET data = ? WHERE table_id = ? AND row_id = ?'),
    touchTable: db.prepare('UPDATE tables SET updated_at = ? WHERE id = ?'),
    deleteTable: db.prepare('DELETE FROM tables WHERE id = ?')
  }
  const handle: DbHandle = { db, stmts, batchInsert: null }
  dbCache.set(root, handle)
  return handle
}

/* ---------- 行级读写 ---------- */
const ROWS_BATCH = 200

function batchInsertSql(n: number): string {
  const tuple = '(?, ?, ?, ?)'
  return `INSERT OR REPLACE INTO rows(table_id, row_id, ord, data) VALUES ${Array.from({ length: n }, () => tuple).join(', ')}`
}

/** 整表写入（导入 / 结构变更）。事务内先删后插，保证原子性。 */
function writeTableRows(root: string, t: DataTable): void {
  const handle = openDb(root)
  const { db, stmts } = handle
  db.exec('BEGIN')
  try {
    stmts.upsertTable.run(t.id, t.name, JSON.stringify(t.fields), t.createdAt, t.updatedAt)
    stmts.deleteRows.run(t.id)
    const rows = t.rows
    // 200 行/批的多行 INSERT：把 Node↔SQLite 的跨界次数降 200 倍，百万行导入从分钟级压到秒级
    let i = 0
    while (i + ROWS_BATCH <= rows.length) {
      if (!handle.batchInsert) handle.batchInsert = db.prepare(batchInsertSql(ROWS_BATCH))
      const params: Array<string | number> = []
      for (let k = 0; k < ROWS_BATCH; k++) {
        const r = rows[i + k] as unknown as RowRecord
        params.push(t.id, String(rows[i + k].id), i + k, JSON.stringify(r.values ?? {}))
      }
      ;(handle.batchInsert as StatementSync).run(...params)
      i += ROWS_BATCH
    }
    if (i < rows.length) {
      const tail = rows.length - i
      const stmt = db.prepare(batchInsertSql(tail))
      const params: Array<string | number> = []
      for (let k = 0; k < tail; k++) {
        const r = rows[i + k] as unknown as RowRecord
        params.push(t.id, String(rows[i + k].id), i + k, JSON.stringify(r.values ?? {}))
      }
      stmt.run(...params)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

function metaFromRow(row: {
  id: unknown
  name: unknown
  fields_json: unknown
  createdAt: unknown
  updatedAt: unknown
  rowCount: unknown
}): TableMeta {
  let fieldCount = 0
  try {
    fieldCount = (JSON.parse(String(row.fields_json)) as unknown[]).length
  } catch {
    fieldCount = 0
  }
  return {
    id: String(row.id),
    name: String(row.name),
    fieldCount,
    rowCount: Number(row.rowCount),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt)
  }
}

/* ---------- 旧数据迁移 ---------- */
async function migrateV2(root: string): Promise<void> {
  const idxFile = join(dirOf(root), 'index.json')
  let metas: Array<{ id?: string }>
  try {
    metas = (JSON.parse(await fs.readFile(idxFile, 'utf-8')) as { tables?: Array<{ id?: string }> }).tables ?? []
  } catch {
    return // 无 v2 布局
  }
  for (const meta of metas) {
    if (!meta || typeof meta.id !== 'string') continue
    const file = join(dirOf(root), safeId(meta.id) + '.json')
    try {
      const t = JSON.parse(await fs.readFile(file, 'utf-8')) as DataTable
      if (!t || typeof t.id !== 'string' || !Array.isArray(t.rows) || !Array.isArray(t.fields)) continue
      writeTableRows(root, t)
      await fs.rename(file, file + '.migrated')
    } catch {
      /* 单表损坏跳过，不阻塞其余迁移 */
    }
  }
  try {
    await fs.rename(idxFile, idxFile + '.migrated')
  } catch {
    /* 重命名失败不影响新布局 */
  }
}

async function migrateV0(root: string): Promise<void> {
  const legacyFile = join(root, 'tables.json')
  let raw: string
  try {
    raw = await fs.readFile(legacyFile, 'utf-8')
  } catch {
    return // 无 v0 布局
  }
  let old: { tables?: DataTable[] } = {}
  try {
    old = JSON.parse(raw) as { tables?: DataTable[] }
  } catch {
    // 旧文件损坏：留原地不动，不阻塞新数据写入
    return
  }
  const list = Array.isArray(old.tables) ? old.tables : []
  for (const t of list) {
    if (!t || typeof t.id !== 'string' || !Array.isArray(t.rows)) continue
    writeTableRows(root, t)
  }
  try {
    await fs.rename(legacyFile, legacyFile + '.migrated')
  } catch {
    /* 重命名失败不影响新布局 */
  }
}

async function ensureMigrated(root: string): Promise<void> {
  if (migrated.has(root)) return
  const { db } = openDb(root)
  const c = db.prepare('SELECT COUNT(*) AS c FROM tables').get() as { c: number | bigint }
  if (Number(c.c) === 0) {
    // 空库才尝试迁移，避免覆盖用户在新引擎里建的数据
    await migrateV2(root)
    await migrateV0(root)
  }
  migrated.add(root)
}

/* ---------- 对外 API：一律只返回摘要，绝不返回整表 ---------- */
export async function listTables(root: string): Promise<TableMeta[]> {
  await ensureMigrated(root)
  const { stmts } = openDb(root)
  return (stmts.listTables.all() as unknown[]).map((r) => metaFromRow(r as Parameters<typeof metaFromRow>[0]))
}

export async function getTable(root: string, id: string): Promise<DataTable | null> {
  await ensureMigrated(root)
  const { stmts } = openDb(root)
  const tr = stmts.getTable.get(id) as
    | { id: unknown; name: unknown; fields_json: unknown; created_at: unknown; updated_at: unknown }
    | undefined
  if (!tr) return null
  let fields: DataTable['fields'] = []
  try {
    fields = JSON.parse(String(tr.fields_json)) as DataTable['fields']
  } catch {
    fields = []
  }
  const rows: RowRecord[] = []
  const packed = stmts.getRowsPacked.get(id) as { ids: unknown; datas: unknown } | undefined
  if (packed && packed.ids != null && packed.datas != null) {
    // row_id（UUID）不含逗号，可安全 split；data 按逗号分隔成完整 JSON 文本序列
    const ids = String(packed.ids).split(',')
    const valuesArr = JSON.parse('[' + String(packed.datas) + ']') as Record<string, FieldValue>[]
    for (let k = 0; k < ids.length; k++) {
      rows.push({ id: ids[k], values: valuesArr[k] ?? {} })
    }
  }
  return {
    id: String(tr.id),
    name: String(tr.name),
    fields,
    rows,
    createdAt: Number(tr.created_at),
    updatedAt: Number(tr.updated_at)
  }
}

export async function createTable(root: string, name: string): Promise<TableMeta[]> {
  await ensureMigrated(root)
  const now = Date.now()
  const fields: DataTable['fields'] = [
    { id: randomUUID(), name: '名称', type: 'text' },
    { id: randomUUID(), name: '状态', type: 'select', options: ['未开始', '进行中', '已完成'] }
  ]
  const table: DataTable = {
    id: randomUUID(),
    name: name.trim() || '未命名表',
    fields,
    rows: [],
    createdAt: now,
    updatedAt: now
  }
  writeTableRows(root, table)
  return listTables(root)
}

export async function updateTable(root: string, payload: DataTable): Promise<TableMeta[]> {
  await ensureMigrated(root)
  const next: DataTable = { ...payload, updatedAt: Date.now() }
  writeTableRows(root, next)
  return listTables(root)
}

export async function removeTable(root: string, id: string): Promise<TableMeta[]> {
  await ensureMigrated(root)
  const { stmts } = openDb(root)
  stmts.deleteTable.run(id)
  stmts.deleteRows.run(id)
  return listTables(root)
}

/**
 * 单元格级增量更新：渲染进程只需传 4 个标量。
 * SQLite 主键定位单行 → 改一个键 → 写回，毫秒级，与表规模无关。
 */
export async function updateCell(
  root: string,
  tableId: string,
  rowId: string,
  fieldId: string,
  value: FieldValue
): Promise<TableMeta[]> {
  await ensureMigrated(root)
  const { stmts } = openDb(root)
  const rec = stmts.getCellRow.get(tableId, rowId) as { data: unknown } | undefined
  if (!rec) return listTables(root)
  let values: Record<string, FieldValue>
  try {
    values = JSON.parse(String(rec.data)) as Record<string, FieldValue>
  } catch {
    values = {}
  }
  values[fieldId] = value
  stmts.updateCellRow.run(JSON.stringify(values), tableId, rowId)
  stmts.touchTable.run(Date.now(), tableId)
  return listTables(root)
}

/* ---------- 导入：单次 IPC + 单事务落库 ---------- */
/**
 * 导入整表：id/createdAt/updatedAt 由主进程生成，单事务落库（失败 ROLLBACK，无半张脏表）。
 * 渲染层解析完成后只调这一次，省掉旧链路 create→update 的二次整表传输与二次写盘。
 */
export async function importTable(root: string, input: TableImportInput): Promise<TableImportResult> {
  await ensureMigrated(root)
  const now = Date.now()
  const table: DataTable = {
    id: randomUUID(),
    name: input.name.trim() || '导入数据',
    fields: input.fields,
    rows: input.rows,
    createdAt: now,
    updatedAt: now
  }
  writeTableRows(root, table)
  return { id: table.id, metas: await listTables(root) }
}

/* ---------- 跨模块聚合：SQL 优先 + 内存归并兜底 ---------- */
/** 超过该行数改用内存归并（json_extract 逐行解析在大表上线性劣化，group_concat 单次传输更省） */
const AGG_IN_MEMORY_THRESHOLD = 300_000
const AGG_TOP_N_MAX = 5000
const AGG_SAMPLE_MAX = 5000

/**
 * SQL 数值判定：与渲染层 `isFinite(Number(v))` 语义对齐。
 * CAST→REAL 与原文比较：'12.5'（可无损转换→true）、'abc'/'12abc'/'（不可转→false）、
 * 数字→true、null→false、''→false。唯一已知偏差：'0x10' 之类十六进制文本（SQLite 不解析→false，
 * JS Number 会解析→true），脏文本边缘场景，可接受。
 */
const NUMERIC_SQL = `CAST(json_extract(data, ?) AS REAL) = json_extract(data, ?)`

/** 数值判定（内存路线，与渲染层 `isFinite(Number(v))` 语义一致：数字/布尔/可转数字字符串均计入） */
function isNumericValue(v: FieldValue | undefined): v is number {
  return typeof v === 'number' || typeof v === 'boolean'
    ? Number.isFinite(Number(v))
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
}

function jsonPathOf(fieldId: string): string {
  return '$."' + fieldId + '"'
}

/** 渲染层与内存路线共用的行级筛选判定（与 SQL buildFilterSql 语义对齐） */
function passFilters(values: Record<string, FieldValue>, filters: AggregateFilter[]): boolean {
  for (const f of filters) {
    const raw = values[f.fieldId]
    if (f.op === 'isMissing') {
      if (raw !== null && raw !== undefined && !(typeof raw === 'string' && raw.trim() === '')) return false
      continue
    }
    const s = raw == null ? '' : String(raw)
    if (f.op === 'eq') {
      if (s !== f.value) return false
    } else if (f.op === 'neq') {
      if (s === f.value) return false
    } else if (f.op === 'contains') {
      if (!s.includes(f.value)) return false
    } else {
      const n = Number(s)
      const t = Number(f.value)
      if (!Number.isFinite(n) || !Number.isFinite(t)) return false
      if (f.op === 'gt' && !(n > t)) return false
      else if (f.op === 'gte' && !(n >= t)) return false
      else if (f.op === 'lt' && !(n < t)) return false
      else if (f.op === 'lte' && !(n <= t)) return false
    }
  }
  return true
}

/** 构建 SQL WHERE 片段（仅数据库表聚合用）；fieldId 来自表结构，视作可信，直接内联 JSON 路径 */
function buildFilterSql(filters: AggregateFilter[]): { clause: string; params: string[] } {
  if (filters.length === 0) return { clause: '', params: [] }
  const parts: string[] = []
  const params: string[] = []
  for (const f of filters) {
    const p = jsonPathOf(f.fieldId)
    if (f.op === 'isMissing') {
      parts.push(`(json_extract(data, '${p}') IS NULL OR json_extract(data, '${p}') = '')`)
      continue
    }
    if (f.op === 'gt' || f.op === 'gte' || f.op === 'lt' || f.op === 'lte') {
      const sym = f.op === 'gt' ? '>' : f.op === 'gte' ? '>=' : f.op === 'lt' ? '<' : '<='
      parts.push(`CAST(json_extract(data, '${p}') AS REAL) ${sym} ?`)
      params.push(f.value)
    } else if (f.op === 'eq') {
      parts.push(`json_extract(data, '${p}') = ?`)
      params.push(f.value)
    } else if (f.op === 'neq') {
      parts.push(`(json_extract(data, '${p}') IS NULL OR json_extract(data, '${p}') <> ?)`)
      params.push(f.value)
    } else if (f.op === 'contains') {
      parts.push(`json_extract(data, '${p}') LIKE ?`)
      params.push(`%${f.value}%`)
    }
  }
  return { clause: parts.map((x) => `(${x})`).join(' AND '), params }
}

/** 内存归并兜底：group_concat 整表取回主进程，Map 聚合（topN 截断前先全量统计，保证 matched 准确） */
function aggregateInMemory(root: string, req: AggregateRequest, totalRows: number, updatedAt: number): AggregateResult {
  const { stmts } = openDb(root)
  const packed = stmts.getRowsPacked.get(req.tableId) as { ids: unknown; datas: unknown } | undefined
  const valuesArr: Record<string, FieldValue>[] = []
  if (packed && packed.ids != null && packed.datas != null) {
    try {
      valuesArr.push(...(JSON.parse('[' + String(packed.datas) + ']') as Record<string, FieldValue>[]))
    } catch {
      /* 损坏数据：返回空聚合 */
    }
  }
  const filters = req.filters ?? []
  const rows = filters.length > 0 ? valuesArr.filter((v) => passFilters(v, filters)) : valuesArr
  const map = new Map<string, { cnt: number; n: number; s: number }>()
  let matched = 0
  for (const values of rows) {
    const xv = values[req.xFieldId]
    const name = xv == null ? '' : String(xv)
    const entry = map.get(name) ?? { cnt: 0, n: 0, s: 0 }
    entry.cnt++
    const yv = values[req.yFieldId ?? '']
    if (req.agg !== 'count' && isNumericValue(yv)) {
      entry.n++
      entry.s += Number(yv)
      matched++
    }
    map.set(name, entry)
  }
  const topN = Math.min(req.topN && req.topN > 0 ? req.topN : 200, AGG_TOP_N_MAX)
  const groups: AggregateGroup[] = [...map.entries()]
    .map(([name, e]) => {
      const value = req.agg === 'count' ? e.cnt : req.agg === 'sum' ? e.s : e.n > 0 ? e.s / e.n : 0
      return { name, value: Number(value.toFixed(4)) }
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, topN)
  return {
    tableId: req.tableId,
    updatedAt,
    totalRows,
    matchedRows: req.agg === 'count' ? totalRows : matched,
    groups
  }
}

/** raw 模式：按行序取前 N 行（预览/原始序列），y 值取数值语义 */
function aggregateRaw(root: string, req: AggregateRequest, totalRows: number, updatedAt: number): AggregateResult {
  const { db } = openDb(root)
  const sampleRows = Math.min(req.sampleRows && req.sampleRows > 0 ? req.sampleRows : 1000, AGG_SAMPLE_MAX)
  const rawRows = db
    .prepare('SELECT data FROM rows WHERE table_id = ? ORDER BY ord LIMIT ?')
    .all(req.tableId, sampleRows) as Array<{ data: unknown }>
  const filters = req.filters ?? []
  const groups: AggregateGroup[] = []
  let matched = 0
  for (const r of rawRows) {
    let values: Record<string, FieldValue> = {}
    try {
      values = JSON.parse(String(r.data)) as Record<string, FieldValue>
    } catch {
      continue
    }
    if (filters.length > 0 && !passFilters(values, filters)) continue
    const xv = values[req.xFieldId]
    const name = xv == null ? '' : String(xv)
    const yv = values[req.yFieldId ?? '']
    if (req.yFieldId && isNumericValue(yv)) {
      groups.push({ name, value: Number(Number(yv).toFixed(4)) })
      matched++
    } else if (!req.yFieldId) {
      groups.push({ name, value: 0 })
    }
  }
  return { tableId: req.tableId, updatedAt, totalRows, matchedRows: matched, groups }
}

/**
 * 跨模块聚合：Analytics 选中 DataLab 表时不再整表过 IPC，主进程算好只回聚合结果。
 * sum/avg/count 走单条 SQL（GROUP BY + json_extract + LIMIT）；行数超阈值切内存归并；
 * raw 走行序采样。matchedRows = 参与聚合的行数，供结论区使用。
 */
export async function aggregateTable(root: string, req: AggregateRequest): Promise<AggregateResult> {
  await ensureMigrated(root)
  const { db, stmts } = openDb(root)
  const tr = stmts.getTable.get(req.tableId) as { updated_at: unknown } | undefined
  if (!tr) throw new Error('表不存在')
  const updatedAt = Number(tr.updated_at)
  const totalRows = Number(db.prepare('SELECT COUNT(*) AS c FROM rows WHERE table_id = ?').get(req.tableId)?.c ?? 0)
  const topN = Math.min(req.topN && req.topN > 0 ? req.topN : 200, AGG_TOP_N_MAX)

  if (req.agg === 'raw') return aggregateRaw(root, req, totalRows, updatedAt)
  if (totalRows > AGG_IN_MEMORY_THRESHOLD) return aggregateInMemory(root, req, totalRows, updatedAt)

  const xPath = jsonPathOf(req.xFieldId)
  const yPath = req.yFieldId ? jsonPathOf(req.yFieldId) : xPath
  const orderBy = req.agg === 'count' ? 'cnt' : req.agg === 'sum' ? 's' : 's / MAX(n, 1)'
  const filter = buildFilterSql(req.filters ?? [])
  const rows = db
    .prepare(
      `SELECT json_extract(data, ?) AS k,
              COUNT(*) AS cnt,
              COUNT(CASE WHEN ${NUMERIC_SQL} THEN 1 END) AS n,
              SUM(CASE WHEN ${NUMERIC_SQL} THEN CAST(json_extract(data, ?) AS REAL) END) AS s
       FROM rows WHERE table_id = ?${filter.clause ? ' AND ' + filter.clause : ''}
       GROUP BY k
       ORDER BY ${orderBy} DESC
       LIMIT ?`
    )
    .all(xPath, yPath, yPath, yPath, yPath, yPath, req.tableId, ...filter.params, topN) as Array<{ k: unknown; cnt: number; n: number; s: number | null }>

  // matched：参与聚合的行数（count 用全表，sum/avg 用 y 数值行数），单独一条计数查询
  let matched = totalRows
  if (req.agg !== 'count') {
    matched = Number(
      db
        .prepare(`SELECT COUNT(*) AS c FROM rows WHERE table_id = ?${filter.clause ? ' AND ' + filter.clause : ''} AND ${NUMERIC_SQL}`)
        .get(req.tableId, ...filter.params, yPath, yPath)?.c ?? 0
    )
  }
  const groups: AggregateGroup[] = rows.map((r) => {
    const s = r.s ?? 0
    const value = req.agg === 'count' ? Number(r.cnt) : req.agg === 'sum' ? s : r.n > 0 ? s / Number(r.n) : 0
    return { name: r.k == null ? '' : String(r.k), value: Number(value.toFixed(4)) }
  })
  return { tableId: req.tableId, updatedAt, totalRows, matchedRows: matched, groups }
}

/** 仅供测试：重置迁移缓存并关闭已打开的数据库句柄 */
export function __resetMigratedCache(): void {
  migrated.clear()
  for (const h of dbCache.values()) {
    try {
      h.db.close()
    } catch {
      /* 已关闭则忽略 */
    }
  }
  dbCache.clear()
}

/** 仅供测试/备份工具：判断旧布局文件是否仍存在（未迁移） */
export function hasLegacyFiles(root: string): boolean {
  return existsSync(join(dirOf(root), 'index.json')) || existsSync(join(root, 'tables.json'))
}
