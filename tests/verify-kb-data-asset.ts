/**
 * 数据型资产登记 → 聚合 链路验证（无头，不依赖 electron）
 *
 * 覆盖 P0 垂直切片核心：
 *  - DataAssetRegistry.register 解析 CSV → 字段(含 FieldType) + 行
 *  - 导入到独立 KB 数据表库（用临时 ROOT 替代 userData/kb/tables/lingmo.db）
 *  - 列类型推断与 FieldType 对齐（number / text）
 *  - 样本行采样（前 N 行）
 *  - 经 aggregateTable 实时聚合（竞品全生态空白、灵墨独占点）
 *
 * 不 import kbData.ts（其引 electron）；convert 以 stub 注入，CSV 路径不触发。
 * 运行：npm run test:kb-data-asset
 */
import { rmSync } from 'node:fs'
import { mkdir, writeFile, rm, readFile, rename } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { DataAssetRegistry } from '../src/main/knowledgeBase/dataAssets.ts'
import { importTable, getTable, listTables, aggregateTable, __resetMigratedCache } from '../src/main/tablesCore.ts'
import type { DataAssetRecord, ConvertInput, ConversionResult } from '../src/shared/types.ts'

const ROOT = join('tests', '.tmp-kb-data-asset-db')
let passed = 0
let failed = 0

function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name} ${extra}`)
  }
}

function sumOf(groups: { name: string; value: number }[], name: string): number {
  return groups.find((g) => g.name === name)?.value ?? 0
}

// 仅 CSV 路径使用：convert 永不触发，stub 即可（避免拉入 electron / getConverterRegistry）
const getConverter = (_src: string, _tgt: string): string | undefined => undefined
const convert = async (_input: ConvertInput): Promise<ConversionResult> =>
  ({
    success: false,
    sourcePath: '',
    targetFormat: '',
    converterName: '',
    duration: 0,
    error: 'stub'
  }) as ConversionResult

async function atomicWrite(file: string, obj: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8')
    await rename(tmp, file)
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}

async function readState(): Promise<{ assets: DataAssetRecord[] }> {
  try {
    const raw = await readFile(join(ROOT, 'dataAssets.json'), 'utf-8')
    const parsed = JSON.parse(raw) as { assets?: DataAssetRecord[] }
    return { assets: Array.isArray(parsed.assets) ? parsed.assets : [] }
  } catch {
    return { assets: [] }
  }
}

const registry = new DataAssetRegistry({
  kbRoot: () => ROOT,
  importTable,
  getTable,
  listTables,
  getConverter,
  convert,
  atomicWrite,
  readState
})

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true })
  __resetMigratedCache()

  const csvPath = join(ROOT, 'sample.csv')
  await mkdir(ROOT, { recursive: true })
  await writeFile(
    csvPath,
    'name,score,city\nAlice,90,Beijing\nBob,75,Shanghai\nCarol,88,Beijing\nDave,60,Shanghai\n',
    'utf-8'
  )

  const rec = await registry.register({ path: csvPath, kbId: 'kb-test', sampleRows: 2 })

  ok('assetId 非空', Boolean(rec.assetId))
  ok('tableId 非空（已导入 KB 数据表库）', Boolean(rec.tableId), `got ${rec.tableId}`)
  ok('列数 = 3', rec.columns.length === 3, `got ${rec.columns.length}`)
  ok('列0 name/text', rec.columns[0].name === 'name' && rec.columns[0].type === 'text')
  ok('列1 score/number', rec.columns[1].name === 'score' && rec.columns[1].type === 'number')
  ok('列2 city/text', rec.columns[2].name === 'city' && rec.columns[2].type === 'text')
  ok('rowCount = 4', rec.rowCount === 4, `got ${rec.rowCount}`)
  ok('sampleRows = 2', rec.sampleRows.length === 2, `got ${rec.sampleRows.length}`)

  const listed = await registry.list('kb-test')
  ok('list(kb-test) 返回 1 条', listed.length === 1, `got ${listed.length}`)
  const got = await registry.get(rec.assetId)
  ok('get(assetId) 命中', got?.assetId === rec.assetId)
  const cols = await registry.columns(rec.assetId)
  ok('columns(assetId) = 3', cols.length === 3, `got ${cols.length}`)

  // 实时聚合（竞品全生态空白、灵墨独占点）
  const agg = await aggregateTable(ROOT, {
    tableId: rec.tableId,
    xFieldId: 'f2',
    yFieldId: 'f1',
    agg: 'sum'
  })
  ok('聚合分组 = 2（Beijing / Shanghai）', agg.groups.length === 2, `got ${agg.groups.length}`)
  ok('Beijing 求和 = 178', sumOf(agg.groups, 'Beijing') === 178, `got ${sumOf(agg.groups, 'Beijing')}`)
  ok('Shanghai 求和 = 135', sumOf(agg.groups, 'Shanghai') === 135, `got ${sumOf(agg.groups, 'Shanghai')}`)

  cleanup()
  console.log(`\n结果：${passed} PASS / ${failed} FAIL`)
  if (failed > 0) process.exit(1)
}

function cleanup(): void {
  try {
    __resetMigratedCache() // 关闭已打开的 db 句柄，释放 WAL 锁，Windows 下才能删目录
  } catch {
    /* 忽略 */
  }
  try {
    rmSync(ROOT, { recursive: true, force: true })
  } catch {
    /* 忽略清理失败 */
  }
}

main().catch((e) => {
  cleanup()
  console.error(e)
  process.exit(1)
})
