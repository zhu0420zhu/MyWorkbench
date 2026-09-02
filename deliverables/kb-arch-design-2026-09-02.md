# 灵墨工作台「一键导入本地知识库」技术设计文档 v1.0

> **文档版本**：v1.0（架构设计，供工程师实现 / QA 验证）
> **日期**：2026-09-02
> **作者**：高见远（架构师）
> **输入**：`deliverables/kb-oneclick-import-spec-2026-09-02.md`（交互规格 v1.0）、`deliverables/kb-competitor-research-2026-09-02.md`（竞品调研）、现有代码探明事实
> **范围声明**：本文档**只做设计**，不修改任何 `src/` 源码；所有改造点均精确到文件与接口签名，可直接作为实现清单。

---

## 0. 设计原则与约束（来自项目长期规范）

| 约束 | 落地要求 |
|---|---|
| 主进程零第三方依赖 | 数据资产登记用 `node:sqlite` / 原生 `fs`；XLSX 解析复用既有 `convert` 转换引擎（`.xlsx→.csv`） |
| IPC 每模块一个 `registerXxxIpc()` | 新增 `kbDataIpc.ts`（`registerKbDataIpc()`）、扩展 `knowledgeBaseIpc.ts` |
| 契约类型放 `src/shared/types.ts` | preload 不得 import `src/main` 类型；所有新契约写入 `shared/types.ts` |
| 纯逻辑下沉 `*Core.ts`，主进程薄包装 | `dataAssets.ts`（纯逻辑、可无头测试） + `kbData.ts`（薄包装仅提供 `userData/kb` 路径） |
| 文件化、数据自主（JSON / SQLite 落 `userData`） | 引用记录 + 数据资产登记全部落 `userData/kb/`，被备份覆盖 |
| 主进程禁 TS 参数属性、禁 `execFileSync` | 新增 class 用显式字段声明；XLSX 走 convert 引擎，不用 shell |

---

## 1. 概述

把「本地知识库」定位为**贯穿六场景的底层供给层**（竞品调研结论 5：reor 归档警示——知识库本身不是卖点，场景耦合才是）。本设计聚焦规格的三要素落地：

1. **范式 B 触发**（`#` + L1/L2/L3 三层作用域 + 全文/RAG 双通道）；
2. **资产类型区分**（doc 走向量/分块索引；data 走结构化登记，注入的是 Schema+样例行+句柄而非文本块）；
3. **P0 独占点**（数据型资产 → 数据分析 / 数据整理引擎，复用既有 `aggregateTable` 链路）。

设计目标：**最小侵入现有代码**。doc 资产零改动沿用 `Indexer`；data 资产新增独立结构化登记 + 一个独立的 KB 数据表库；`#` 触发在前端统一一层覆盖五场景。

---

## 2. 现有架构盘点（代码事实依据）

| 文件（行号） | 当前角色 | 与规格的缺口 |
|---|---|---|
| `src/main/knowledgeBase/builder.ts:56` | `TEXT_TARGETS = ['.txt','.md','.html','.csv']` | ⚠️ **缺陷**：`.csv` 被当文本块 `ingestText` 索引，违反「data 资产结构化登记」要求 |
| `src/main/knowledgeBase/builder.ts:60-178` | `KnowledgeBuilder.build()` 编排 convert→index | 无 data 资产路由；无 `kbId` 归属；`KnowledgeBuildItem` 无 `dataAssetId` |
| `src/main/knowledgeBase/index.ts:14` | `getKnowledgeBuilder()` 注入真实依赖 | 未注入 data 资产登记器 |
| `src/main/knowledgeBase/knowledgeBaseIpc.ts:13` | 仅 `knowledgeBase:build` | 缺 data 资产查询 / 引用记录 IPC |
| `src/main/searchIndex/types.ts:3-29` | `IndexChunk`/`IndexDoc` 仅含 `origin: text|image|converted` | **无 `assetType` 维度、无 `kbId`** |
| `src/main/searchIndex/indexer.ts:255-278` | `queryChunks(q, topK, scope)` 返回 `ScoredChunk{score}` | score = 命中不同 token 数；可作为 RAG 相关度阈值依据 |
| `src/main/searchIndex/contextOptimizer.ts:87` | `selectContext(chunks, budget)` + `estimateTokens` | ✅ 可直接复用做多资产 token 预算裁剪 |
| `src/main/searchIndex/qa.ts` | `QaService.ask()` 带 `QaCitation[]` 引用定位 | ✅ 与引用记录模型对齐，可复用 |
| `src/main/sillytavern/worlds.ts:61` | `collectLoreEntries(world, text, maxDepth)` 关键词注入 | 既有「全文注入」机制；存 `worlds/*.json`（SillyTavern 兼容） |
| `src/main/tablesCore.ts:555` | `aggregateTable(root, req)` 跨模块聚合 | `root/tables/lingmo.db`；薄片 `tables.ts:25 root()=userData` |
| `src/main/tablesCore.ts:244` | `FieldType = 'text'|'number'|'select'|'date'|'checkbox'` | data 资产列类型必须对齐此枚举 |
| `src/renderer/src/utils/ioFormats.ts:71` | `inferType(values): FieldType`（**仅 renderer**） | 列类型推断在渲染层，主进程登记时**无法复用** → 需下沉 shared |
| `src/main/configStore.ts:11` | `ConfigStore<T>` 原子写 `userData/${name}.json` | ✅ 引用记录 / dataAssets 登记复用此范式 |
| `src/main/data.ts:98-110` | `backupData()` 递归复制 `userData`（排除运行时缓存） | `kb/` 落 `userData` 即被备份覆盖；但 `importData` 仅复制 `DATA_FILES`，需追加 `'kb'` |
| `src/shared/types.ts:244,300-334,788-824` | `FieldType`/`Aggregate*`/`KnowledgeBuild*` 契约 | 追加 `ReferenceRecord`/`DataAssetRecord`/`TableHandle` 等 |

---

## 3. 目标架构（模块依赖）

```
                          ┌─────────────────────────────────────────┐
   五场景输入控件           │           前端 统一 # 触发层              │
  (Writing/Copywriting/    │  KbReferenceService + KbTriggerProvider   │
   Notes/Analytics/Clean)  │  useKbTrigger() / <KbTriggerInput>        │
        │ 键入 #            └───────────────┬───────────┬─────────────┘
                                            │           │
                     doc/RAG 候选          data 候选        worldbook 候选
                            │               │               │
              searchIndex:query          kb:listDataAssets   sillytavern:worlds-*
              searchIndex:ask             kb:assetColumns     (collectLoreEntries)
                            │               │               │
   ┌────────────────────────▼───────────────▼───────────────▼──────────┐
   │                        主进程 IPC 边界                               │
   └────────────────────────┬───────────────┬───────────────┬──────────┘
              │              │                │               │
   KnowledgeBuilder   DataAssetRegistry   KbDataWrapper   Worlds(既有)
   (builder.ts)      (dataAssets.ts 纯逻辑) (kbData.ts)    sillytavern/worlds.ts
        │  doc→Indexer        │ 解析+推断+入库   │ kbRoot()=    │
        ▼                     ▼               │ userData/kb   ▼
   Indexer(search-index.json)  userData/kb/    │             worlds/*.json
        │                   dataAssets.json    │
        │                     + 导入表到        ▼
        │                     userData/kb/      aggregateTableCore(kbRoot, req)
        │                     tables/lingmo.db        │
        │                            └────────►  tablesCore.ts（复用）
        ▼
   reference records → userData/kb/references.json (ConfigStore 范式)
```

**三层作用域 / 双通道 / 资产类型** 映射：

| 概念 | 落点 |
|---|---|
| L1 场景默认 KB | `userData/kb/sceneDefaultKB.json` |
| L2 项目绑定 KB | `userData/projects/<projectId>/meta.json` → `linkedKB[]` |
| L3 会话临时 | 内存为主；可选持久 `userData/projects/<id>/sessions/<sid>.json` |
| 全文注入通道 | 世界书 `worlds/*.json`（`collectLoreEntries`） |
| RAG 检索通道 | `Indexer`（doc 资产，新增 `assetType`/`kbId`） |
| 载入为表通道 | `DataAssetRegistry` + `userData/kb/tables/lingmo.db` |

---

## 4. ① 引用记录（Reference Record）数据模型 + userData 落库方案

### 4.1 数据模型（写入 `src/shared/types.ts`，置于 Knowledge Build 段之后，约 line 824）

```ts
/* ---- 知识库引用记录（每次挂载一条，落 userData/kb/references.json） ---- */
export type AssetType = 'doc' | 'data' | 'worldbook'
export type ReferenceScope = 'scene-default' | 'project' | 'session'
export type ReferenceChannel = 'full-text' | 'rag' | 'load-as-table'

export interface ReferenceRecord {
  id: string                // randomUUID()
  kbId: string             // 所属知识库 id（data/doc/worldbook 均有归属 kb 或 worldId）
  assetId: string          // 资产 id（doc=docId / data=assetId / worldbook=worldEntry uid）
  assetType: AssetType
  scope: ReferenceScope
  channel: ReferenceChannel
  /** 注入位置标识：docId / sessionId / noteBlockId / analyticsSessionId */
  referencePosition: string
  createdAt: number        // Date.now()
  /** data 资产：选中的 tableId（仅 channel='load-as-table'） */
  tableRef?: string
  /** data 资产：选中列 fieldId（#表名.列 用） */
  columnRef?: string
}
```

> 字段与规格 §5.1 一一对应；额外补 `id`（审计主键）与 `columnRef`（支撑 `#表名.列` 列级引用）。

### 4.2 三处绑定配置的落库（与既有 `ConfigStore` 同范式）

```ts
// userData/kb/sceneDefaultKB.json
export interface SceneDefaultKb { sceneDefaultKB: Record<string, string[]> } // sceneId -> kbId[]

// userData/projects/<projectId>/meta.json（若现有项目元数据不在该路径，则在本项目结构内追加该字段）
export interface ProjectMeta { linkedKB: string[]; /* 现有其它字段保留 */ }

// userData/projects/<id>/sessions/<sessionId>.json
export interface SessionMounts { mountedRefs: string[] } // 仅存引用 id 清单
```

### 4.3 引用记录存储（复用 `ConfigStore` 范式）

新增 `src/main/knowledgeBase/referenceStore.ts`（纯逻辑 + `fs`）：

```ts
import { ConfigStore } from '../configStore.ts'
interface ReferenceState { records: ReferenceRecord[] }
const store = new ConfigStore<ReferenceState>('kb/references', { records: [] })
// 注：ConfigStore 内部 join(userData, `${name}.json`)，此处 name='kb/references'
//     → 实际落 userData/kb/references.json（ConfigStore 的 join 已支持子目录）

export async function addReference(rec: ReferenceRecord): Promise<void> {
  const s = await store.get()
  await store.set({ records: [...s.records, rec] })
}
export async function listReferences(opts?: {
  scope?: ReferenceScope; referencePosition?: string
}): Promise<ReferenceRecord[]> { /* 过滤返回 */ }
```

### 4.4 备份覆盖验证（依据 `data.ts` 实证）

- `backupData()`（`data.ts:98`）执行 `fs.cp(app.getPath('userData'), dest, { recursive, filter })`，`filter` 仅排除 `EXCLUDED`（Cache/GPUCache/… 运行时缓存）。
- 本设计所有产出均落 `userData/kb/**`（含 `references.json`、`dataAssets.json`、`tables/lingmo.db`、`sources/<assetId>.*`）→ **全部被备份覆盖** ✅。
- `importData()`（`data.ts:119`）目前仅复制 `DATA_FILES = ['shortcuts.json','automations.json','tables','ai-config.json','notes','boards']`。**需追加 `'kb'`** 以实现导入回环（实施步骤 S-12）。

---

## 5. ② KB 索引改造点（assetType 维度 + dataAssets 结构化登记）

**决策（待定项 1）**：双管齐下——

- **(A) 给 `Indexer` 增加 `assetType` 维度**：doc 资产仍走现有分块索引，仅给 `IndexDoc` 补 `assetType`/`kbId`，便于选择器按 KB 过滤与未来 scope 检索；不影响既有 `query/queryChunks` 行为。
- **(B) data 资产不走 `Indexer`**，改为独立**结构化登记** `DataAssetRegistry`，落 `userData/kb/dataAssets.json` + 导入到 `userData/kb/tables/lingmo.db`。

理由：data 资产不是文本块，塞进倒排索引会污染检索、浪费内存，且无法表达 Schema/样本/句柄；独立登记 + 独立表库最干净，且重建 KB 时可整体 DROP 而不动用户自有表。

### 5.1 `src/shared/types.ts` 新增（Data Asset 契约）

```ts
/* ---- 知识库数据型资产（结构化登记，非文本块） ---- */
export interface DataAssetColumn {
  fieldId: string          // 'f0'.. 与引擎 TableField.id 对齐
  name: string
  type: FieldType          // 复用引擎 FieldType，保证 #表名.列 类型对齐
}
export interface DataAssetRecord {
  assetId: string
  kbId: string
  sourcePath: string       // 原始 CSV/XLSX 路径（可能外部）
  localFilePath: string    // 落库副本 userData/kb/sources/<assetId>.<ext>（句柄/溯源，受备份覆盖）
  fileName: string
  tableName: string        // 展示名（去扩展名）
  tableId: string          // KB 数据表库中的 id（userData/kb/tables/lingmo.db）
  columns: DataAssetColumn[]
  rowCount: number
  sampleRows: Record<string, FieldValue>[]  // 前 N 行（让模型理解结构）
  createdAt: number
  updatedAt: number
}
export interface DataAssetRegInput {
  path: string             // 原始文件
  kbId: string
  sampleRows?: number      // 默认 5
}

/* ---- 数据型资产 → 分析/整理引擎 句柄 ---- */
export type TableHandle =
  | { kind: 'userTable'; tableId: string }   // root = userData（既有用户表）
  | { kind: 'kbData'; tableId: string }      // root = userData/kb（KB 数据资产）
  | { kind: 'csvPath'; path: string }        // 引擎直接打开 CSV（兜底）
```

### 5.2 `src/main/searchIndex/types.ts` 改造（assetType 维度，决策 1-A）

```ts
export interface IndexDoc {
  docId: string
  filePath: string
  fileName: string
  extension: string
  size: number
  indexedAt: number
  chunkCount: number
  origin?: 'text' | 'image' | 'converted'
  assetType?: 'doc' | 'data' | 'worldbook'   // 新增：归属资产类型
  kbId?: string                               // 新增：归属知识库（便于按 KB 过滤）
}
// IndexChunk 同步补 assetType?/kbId?（可选，供未来块级 scope）
```

### 5.3 `src/main/searchIndex/indexer.ts` 改造

- `ingestText(filePath, text, origin, meta?: { assetType?: ...; kbId?: string })`：把 `meta` 写入 `IndexDoc.assetType`/`kbId`（向后兼容，缺省 `doc`）。
- 现有 `query`/`queryChunks` 行为不变（data 资产已不再进入，无需过滤逻辑）；`IndexStats` 不变。

### 5.4 `src/main/searchIndex/index.ts`

- 仅 `export` 新增类型即可，无逻辑改动。

### 5.5 `src/main/knowledgeBase/builder.ts` 改造（关键缺陷修复）

```ts
// 删除 .csv；新增数据型扩展名常量
const TEXT_TARGETS = ['.txt', '.md', '.html']                 // 原含 .csv → 移除
const DATA_EXTS = ['.csv', '.tsv', '.xlsx', '.xls']          // 新增

export interface BuilderDataRegistry {
  register(path: string, kbId: string): Promise<DataAssetRecord>
}
export interface KnowledgeBuilderDeps {
  registry: BuilderRegistry
  indexer: BuilderIndexer
  tempCleaner: BuilderTempCleaner
  describer?: (p: string) => Promise<string | null>
  dataRegistry?: BuilderDataRegistry   // 新增
  kbId?: string                        // 新增：本次构建归属
  logger?: { info: (m: string) => void; warning: (m: string) => void }
}
// KnowledgeBuildOptions 新增：
export interface KnowledgeBuildOptions {
  recursive?: boolean
  includeImages?: boolean
  includeDataAssets?: boolean   // 新增，默认 true
  kbId?: string                 // 新增：外部指定 KB id（缺省内部生成）
}
// KnowledgeBuildItem 新增：
export interface KnowledgeBuildItem {
  sourcePath: string
  status: KnowledgeBuildStatus
  chunkCount: number
  viaPath?: string
  dataAssetId?: string          // 新增：登记为数据资产时回填
  error?: string
}

// processFile 顶部插入（在任何 ingest 之前）：
const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
if ((opts.includeDataAssets ?? true) && DATA_EXTS.includes(ext) && this.deps.dataRegistry) {
  try {
    const rec = await this.deps.dataRegistry.register(filePath, this.deps.kbId ?? 'default')
    addItem(filePath, 'ingested', 0, { dataAssetId: rec.assetId })
  } catch (err) {
    addItem(filePath, 'error', 0, { error: `数据资产登记失败: ${(err as Error).message}` })
  }
  return
}
// …原有 direct ingest / convert→ingestText 逻辑保持不变
```

> 这样 `.csv/.xlsx` 在 `indexer.ingest` 之前就被拦截，彻底消除「CSV 被当文本块索引」缺陷（原 `builder.ts:56` + `indexer.ts:81` 的 `extractText` 命中路径）。

### 5.6 新增 `src/main/knowledgeBase/dataAssets.ts`（纯逻辑，无 electron）

```ts
export class DataAssetRegistry {
  constructor(
    private readonly kbRoot: () => string,                       // = () => join(userData,'kb')
    private readonly importTable: (root: string, input: TableImportInput) => Promise<TableImportResult>,
    private readonly getConverter: (src: string, tgt: string) => string | undefined,
    private readonly convert: (input: ConvertInput) => Promise<ConversionResult>,
    private readonly atomicWrite: (file: string, obj: unknown) => Promise<void>,
    private readonly readState: () => Promise<{ assets: DataAssetRecord[] }>
  ) {}

  /** 解析 CSV/XLSX → 字段(含 FieldType) + 行；XLSX 经 convert 引擎 .xlsx→.csv */
  private async parse(path: string): Promise<Omit<DataTable,'id'|'createdAt'|'updatedAt'>> { /* ... */ }

  /** 登记：复制源文件到 userData/kb/sources/<assetId>.<ext>，解析+推断类型，
   *  导入到 KB 数据表库(userData/kb/tables/lingmo.db) 取得 tableId，
   *  取前 N 行样本，写入 dataAssets.json，返回 DataAssetRecord */
  async register(input: DataAssetRegInput): Promise<DataAssetRecord> { /* ... */ }

  async list(kbId?: string): Promise<DataAssetRecord[]> { /* ... */ }
  async get(assetId: string): Promise<DataAssetRecord | null> { /* ... */ }
  async columns(assetId: string): Promise<DataAssetColumn[]> { /* ... */ }
}
```

- **列类型推断（待定项 5 核心）**：`parse()` 复用**下沉后的共享 `inferType`**（见 §6.3），返回 `FieldType`，与引擎 `TableField.type` 完全一致 → `#表名.列` 天然对齐。
- **落库**：`userData/kb/dataAssets.json`（数组）；源文件副本 `userData/kb/sources/<assetId>.<ext>`（句柄稳定 + 备份覆盖）。

### 5.7 `src/main/knowledgeBase/index.ts` 改造

```ts
export function getKnowledgeBuilder(): KnowledgeBuilder {
  if (!_builder) {
    _builder = new KnowledgeBuilder({
      registry: getConverterRegistry(),
      indexer: getIndexer(),
      tempCleaner: getTempCleaner(),
      describer: describeImageForIndex,
      dataRegistry: getDataAssetRegistry(),   // 新增
      // kbId 在 build() 调用时由包装层注入
    })
  }
  return _builder
}
export function getDataAssetRegistry(): DataAssetRegistry { /* 单例，注入 kbRoot()/importTableCore/getConverterRegistry()/convert/原子写 */ }
```

### 5.8 `src/main/knowledgeBase/knowledgeBaseIpc.ts` 扩展

```ts
export function registerKnowledgeBaseIpc(): void {
  const builder = getKnowledgeBuilder()
  ipcMain.handle('knowledgeBase:build', (_e, inputs, opts) => builder.build(inputs, opts ?? {}))
  // 新增：
  ipcMain.handle('knowledgeBase:listDataAssets', (_e, kbId?: string) => getDataAssetRegistry().list(kbId))
  ipcMain.handle('knowledgeBase:getDataAsset', (_e, assetId: string) => getDataAssetRegistry().get(assetId))
  ipcMain.handle('knowledgeBase:assetColumns', (_e, assetId: string) => getDataAssetRegistry().columns(assetId))
  ipcMain.handle('knowledgeBase:addReference', (_e, rec: ReferenceRecord) => addReference(rec))
  ipcMain.handle('knowledgeBase:listReferences', (_e, scope?, refPos?) => listReferences({ scope, referencePosition: refPos }))
}
```

---

## 6. ③ 数据型资产 → 分析 / 整理引擎的句柄传递接口

**决策**：data 资产在登记时即导入到**独立的 KB 数据表库** `userData/kb/tables/lingmo.db`（`root = userData/kb`），复用 `aggregateTable(root, req)` 100% 逻辑。前端分析场景经**新 IPC `kbData:aggregate`** 传入 `tableId`，薄包装注入 `kbRoot()`，路径对渲染层不透明。

### 6.1 新增 `src/main/kbData.ts`（薄包装，类 `tables.ts`）

```ts
import { app } from 'electron'
import { join } from 'node:path'
import { aggregateTable as aggregateTableCore, type AggregateResult, type AggregateRequest } from './tablesCore.ts'

function kbRoot(): string { return join(app.getPath('userData'), 'kb') }  // → userData/kb/tables/lingmo.db

export function aggregateKbData(req: AggregateRequest): Promise<AggregateResult> {
  return aggregateTableCore(kbRoot(), req)
}
export function getKbDataTable(id: string) { return getTableCore(kbRoot(), id) }  // 供分析视图取字段元数据
export function listKbDataTables() { return listTablesCore(kbRoot()) }
```

### 6.2 新增 `src/main/kbDataIpc.ts`

```ts
export function registerKbDataIpc(): void {
  ipcMain.handle('kbData:aggregate', (_e, req: AggregateRequest) => aggregateKbData(req))
  // 可选：kbData:getTable / kbData:listTables 供分析视图渲染表头/列选择
}
```

### 6.3 主进程 / IPC 接线草图（P0 数据分析流程）

```
渲染层 Analytics.tsx
  │ 用户 # 选数据资产 → 取 DataAssetRecord.tableId (kind:'kbData')
  ▼
ipcRenderer.invoke('kbData:aggregate', { tableId, xFieldId, yFieldId?, agg:'count'|'sum'|'avg'|'raw', filters? })
  │
  ▼ 主进程 registerKbDataIpc
aggregateKbData(req)  →  aggregateTableCore(kbRoot()=userData/kb, req)
  │  // 内部 openDb(userData/kb) → tables/lingmo.db → SQL GROUP BY json_extract
  ▼
AggregateResult { tableId, groups, totalRows, matchedRows, updatedAt }
  │
  ▼ 渲染层 buildCsvChartModel 同形消费（AggregateGroup 与 chartData 同形，零转换）
生成图表 + 规则化结论（复用 analysisCore）
```

> 数据整理（P0）同理：`CleanSection.tsx` 取 `tableId` 后走既有清洗/导入视图（复用 `importTableCore(kbRoot(), ...)` 或 `getKbDataTable` 载入整表编辑）。句柄统一为 `TableHandle`（`src/shared/types.ts`），分析= `{kind:'kbData',tableId}`，整理=同 handle 交给清洗视图。

### 6.4 列类型对齐（待定项 5 落地）

- **现状缺口**：`inferType`（`ioFormats.ts:71`）只在 renderer，主进程登记时无法调用；且其仅产出 `number|checkbox|text`。
- **决策**：将 `inferType` 下沉为 `src/shared/analysisCore.ts`（或新建 `src/shared/fieldTypes.ts`）的 `export function inferFieldType(values: string[]): FieldType`，**渲染层 `ioFormats.ts` 与 主进程 `dataAssets.ts` 同时 import 它**。
  - 可顺带补全 `date`/`select` 检测（如 ISO 日期正则 / 低基数枚举），两处同时受益，类型判定一致。
- **保证**：`DataAssetRecord.columns[].type === TableField.type`，`fieldId` 同为 `f0..`；`#表名.列` 解析出 `assetId+fieldId` 后直接喂 `aggregateTable` 的 `xFieldId/yFieldId`，零转换、零歧义。

---

## 7. ④ `#` 触发在前端各输入控件的统一接入层

**决策（待定项 4 & 8）**：worldbook 与 KB 索引**存储独立、访问统一**——三者（doc/RAG、data/载入表、worldbook/全文）全部经**一个统一触发层** `KbReferenceService` 聚合候选；worldbook 仍走 `collectLoreEntries` 全文注入，不并入索引。

### 7.1 前端服务层 `src/renderer/src/services/kbReference.ts`

```ts
export type KbCandidate =
  | { kind:'doc'; assetId:string; name:string; kbId:string; channel:'rag'|'full-text'; score?:number }
  | { kind:'data'; assetId:string; name:string; kbId:string; channel:'load-as-table'; tableId:string; columns:DataAssetColumn[] }
  | { kind:'worldbook'; assetId:string; name:string; worldId:string; channel:'full-text' }

export class KbReferenceService {
  /** 键入 # 后实时检索：聚合三源 */
  async query(text: string, scene: SceneId): Promise<KbCandidate[]> {
    const [docs, datas, worlds] = await Promise.all([
      window.api.searchIndex.query(text),                 // 既有：searchIndex:query
      window.api.knowledgeBase.listDataAssets(),          // 新增
      window.api.sillytavern.worldsList()                 // 既有：sillytavern:worlds-list
    ])
    // doc 候选：按 SearchHit 映射；data 候选：按 tableName/列名 匹配(待定项6)
    // worldbook 候选：worlds 条目名匹配
    return mergeByScope(docs, datas, worlds, scene)       // L1/L2/L3 分区（见 §7.3）
  }
  /** 选中后：注入内容 + 写引用记录 */
  async apply(c: KbCandidate, position: string): Promise<ResolvedInjection> { /* ... */ }
}
```

### 7.2 统一触发组件 / Hook

- `KbTriggerProvider`（React Context）：持有 `KbReferenceService` 单例 + 当前 scene。
- `useKbTrigger(scene)`：返回 `{ open(token), onSelect, insertToken }`，监听输入区 `#` 键。
- `<KbTriggerInput scene value onChange>`：包裹任意文本输入，自动唤起候选弹层 `<KbReferencePopover>`（搜索框 + L1/L2/L3 三分区 + 类型图标 + 通道开关 + 上次引用时间 + 数据表子展开）。
- 选中后：① 在文本插入引用标记（`#表名.列` 或 `#资产名`）；② 调 `knowledgeBase:addReference` 落 `ReferenceRecord`；③ 按 channel 触发后续：
  - doc + RAG → 调 `searchIndex:ask`/`queryChunks` 取 Top-K chunk（复用 `selectContext` 预算）；
  - worldbook + 全文 → 调 `collectLoreEntries`（既有）注入完整内容；
  - **data + 载入为表** → 跳分析/整理视图，传 `TableHandle{kind:'kbData',tableId}`（见 §6）。

### 7.3 五场景接入清单（待定项 8）

| 场景 | 输入控件 | 接入方式 | 默认通道 |
|---|---|---|---|
| 写作 `Writing.tsx` | 编辑器文本区 | `<KbTriggerInput scene="writing">` | doc→RAG / worldbook→全文 |
| 文案 `Copywriting.tsx` | 文本输入区 | 同上 `scene="copywriting"` | 同上 |
| 笔记 `Notes.tsx` | 编辑器 + 「插入世界书」按钮 | 同上 `scene="notes"`；按钮复用 trigger 并预筛 `worldbook` | doc→RAG或全文 / worldbook→全文 |
| 数据分析 `Analytics.tsx` | 输入区 + 资产选择 | 同上 `scene="analytics"`，data 候选展开「数据表子列表」→`kbData:aggregate` | **data→载入为表** |
| 数据整理 `CleanSection.tsx` | 入口（非纯文本框，可做成下拉/按钮） | 复用 `<KbReferencePopover>` 仅列 `data` 候选 → 清洗视图 | **data→载入为表** |

> 数据整理入口非文本框，规范允许「另定触发入口」——即用同一 `<KbReferencePopover>` 组件但由按钮而非 `#` 唤起，保证体验一致。

### 7.4 与 worldbook 协同（既有机制不动）

- 世界书仍存 `worlds/*.json`，注入仍由 `collectLoreEntries(world, text, maxDepth)` 完成。
- `#` 触发层只**读取** worlds 列表作为 `worldbook` 候选，选中后以 `full-text` 通道走既有注入；笔记「插入世界书」按钮 = 该通道的快捷入口。
- **不**把 worldbook 并入 `Indexer` 或 `dataAssets`，避免破坏 SillyTavern 兼容格式。

---

## 8. 八项待定项决策表

| # | 待定项 | 决策 | 落地点 |
|---|---|---|---|
| 1 | KB 索引是否区分 doc/data | **双管齐下**：`Indexer` 加 `assetType`/`kbId`（doc 仍分块）；data 走独立 `DataAssetRegistry` 结构化登记 | `searchIndex/types.ts`、`knowledgeBase/dataAssets.ts` |
| 2 | data 资产索引时机 | **导入时即登记**（`knowledgeBase:build` 阶段解析+入库），分析场景零冷启 | `builder.ts` `processFile` 顶部拦截 |
| 3 | userData 落库路径 | 引用记录 `userData/kb/references.json`；dataAssets `userData/kb/dataAssets.json` + `userData/kb/tables/lingmo.db` + `userData/kb/sources/<id>.<ext>`；L1 `userData/kb/sceneDefaultKB.json`；L2 `userData/projects/<id>/meta.json`；L3 内存+可选 `sessions/<sid>.json` | 全部 `userData` 内，被 `backupData` 覆盖 |
| 4 | worldbook 与 KB 关系 | **并存 + 统一到 `#` 触发层**：存储独立，接入统一；worldbook 仍 `collectLoreEntries` 全文注入 | `kbReference.ts`、`sillytavern/worlds.ts` |
| 5 | 列类型对齐 | 下沉 `inferFieldType` 到 `shared`（渲染层+主进程共用），`DataAssetColumn.type === FieldType` | `shared/fieldTypes.ts`、`ioFormats.ts`、`dataAssets.ts` |
| 6 | 相关度阈值 | doc/RAG：`queryChunks` 的 `score`（=命中不同 token 数）。候选上屏 `score>=1`；标记「低相关」当最高分 `< RAG_LOW_RELEVANCE=2`。data：名称/列名 精确或包含匹配（不评分）。worldbook：关键词命中即注入 | `kbReference.ts` 常量 `RAG_SCORE_MIN=1, RAG_LOW_RELEVANCE=2` |
| 7 | 多资产上下文预算 | 复用 `contextOptimizer.ts` 的 `selectContext` + `estimateTokens`；新增 `planReferenceContext(refs[], budget)` 按 类型/优先级 分配（data 固定小预算给 Schema+样本；worldbook 全文封顶；doc chunk 贪心填） | 新增 `src/main/searchIndex/referenceBudget.ts` 或并入 `contextOptimizer.ts` |
| 8 | `#` 触发接入范围 | 五场景均接入（写作/文案/笔记/数据分析/数据整理），数据整理用按钮唤起同一弹层 | `KbTriggerInput`/`useKbTrigger` + 各页面包裹 |

---

## 9. 风险与开放问题

1. **KB 数据表库与用户表库分离带来的「重复导入」**：同一 CSV 既是用户表又是 KB 资产时存两份。缓解：data 资产 `localFilePath` 溯源，UI 提示「已在知识库」。非阻塞。
2. **XLSX 解析依赖 convert 引擎**：若 `convert` 未装 XLSX 转换器，`register` 失败 → 退化为 `error` 状态（已在 builder 兜底），不阻塞其它文件。
3. **`inferFieldType` 下沉的回归风险**：需让 renderer 既有 `buildTableFromRows` 改用共享函数，并补单测保证行为一致（尤其 `checkbox`/新增 `date`/`select`）。
4. **`importData` 回环**：必须在 `data.ts` 的 `DATA_FILES` 追加 `'kb'`，否则导入时不带 KB 数据（备份能带、导入不带的不一致）。
5. **L2 项目存储路径对齐**：规格路径 `userData/projects/<id>/meta.json` 为逻辑占位；实施前需确认现有项目元数据真实落点（若不同，则在本项目结构内追加 `linkedKB` 字段，不新建结构）。
6. **大表 sampleRows 成本**：`sampleRows` 仅取前 N 行（默认 5），不复制全表，成本可忽略；KB 表库整表导入成本与既有 `importTable` 一致。
7. **开放问题**：L3 会话是否持久化引用记录到 `sessions/<sid>.json` 待前端会话模型确认；本设计默认内存 + 写 `references.json` 审计即可。

---

## 10. 给工程师的实施步骤清单（按依赖排序，可直接建 PR）

- **S-1（契约）** `src/shared/types.ts`：追加 §4.1 / §5.1 全部类型（`AssetType`/`ReferenceRecord`/`DataAssetColumn`/`DataAssetRecord`/`DataAssetRegInput`/`TableHandle`/`SceneDefaultKb` 等）。
- **S-2（类型推断下沉）** 新建 `src/shared/fieldTypes.ts` 放 `inferFieldType(values:string[]):FieldType`；`ioFormats.ts` 改为 import 它（行为不变，可补 `date`/`select`）。
- **S-3（dataAssets 纯逻辑）** 新建 `src/main/knowledgeBase/dataAssets.ts`：`DataAssetRegistry`（parse / register / list / get / columns），复用 `importTableCore`、`getConverterRegistry`、原子写。
- **S-4（KB 数据表薄包装）** 新建 `src/main/kbData.ts`：`kbRoot()` + `aggregateKbData` + `getKbDataTable` + `listKbDataTables`。
- **S-5（KB 索引维度）** `searchIndex/types.ts` 给 `IndexDoc` 加 `assetType?`/`kbId?`；`searchIndex/indexer.ts` 的 `ingestText` 透传并落库；`searchIndex/index.ts` 导出。
- **S-6（Builder 缺陷修复）** `knowledgeBase/builder.ts`：移除 `.csv`、加 `DATA_EXTS`、注入 `dataRegistry`/`kbId`、拦截数据型文件、`KnowledgeBuildItem` 补 `dataAssetId`、`Options` 补 `includeDataAssets`/`kbId`。
- **S-7（装配）** `knowledgeBase/index.ts`：`getDataAssetRegistry()` 单例 + `getKnowledgeBuilder` 注入。
- **S-8（IPC）** 扩展 `knowledgeBaseIpc.ts`（listDataAssets/getDataAsset/assetColumns/addReference/listReferences）；新建 `kbDataIpc.ts`（`kbData:aggregate` 等）；`src/main/index.ts` 调用 `registerKbDataIpc()`。
- **S-9（引用记录存储）** 新建 `knowledgeBase/referenceStore.ts`（基于 `ConfigStore` 写 `kb/references`）；L1 `sceneDefaultKB` store。
- **S-10（预算复用）** 在 `contextOptimizer.ts` 加 `planReferenceContext(refs, budget)`（待定项 7），复用 `selectContext`/`estimateTokens`。
- **S-11（preload 双写）** `preload/index.ts` + `index.d.ts` 暴露 `knowledgeBase:*`(新)、`kbData:aggregate`、`sillytavern:worlds-list`（既有）、`searchIndex:query/ask`（既有）。
- **S-12（备份回环）** `data.ts` 的 `DATA_FILES` 追加 `'kb'`。
- **S-13（前端统一触发层）** 新建 `renderer/src/services/kbReference.ts` + `KbTriggerProvider`/`useKbTrigger`/`<KbTriggerInput>`/`<KbReferencePopover>`。
- **S-14（五场景接入）** 包裹 `Writing`/`Copywriting`/`Notes`/`Analytics` 文本区；`CleanSection` 按钮唤起；`Analytics` data 候选走 `kbData:aggregate`。
- **S-15（验收）** 逐条对照规格 §7 可点测清单；重点验证「注入的是 Schema+样本+句柄而非文本块」（查 `kbData:aggregate` 入参为 `tableId` 且 `dataAssets.json` 无文本块）。

---

## 11. Done 标准（本设计交付判定）

- [x] **8 项待定项均有明确决策**（见 §8 决策表：①双管齐下 ②导入即登记 ③`userData/kb/*` 具体路径 ④并存+统一触发层 ⑤下沉 `inferFieldType` 对齐 `FieldType` ⑥doc score 阈值 + data 名称匹配 ⑦复用 `selectContext` ⑧五场景接入清单）。
- [x] **4 块设计完整**：①引用记录模型+落库（§4）②KB 索引改造点精确到文件与签名（§5）③data→引擎句柄接口 `TableHandle`+`kbData:aggregate`（§6）④`#` 统一触发层（§7）。
- [x] **每个改造点精确到文件与接口签名**：涉及 `shared/types.ts`、`searchIndex/{types,indexer,index}.ts`、`knowledgeBase/{builder,index,knowledgeBaseIpc,dataAssets,referenceStore}.ts`、新增 `kbData.ts`/`kbDataIpc.ts`、`configStore.ts`(复用)、`data.ts`(DATA_FILES)、`ioFormats.ts`(改用共享推断)、preload 双写、renderer 服务层/组件。
- [x] **未修改任何 `src/` 源码**：本交付为纯设计文本，由接收方写入 `deliverables/kb-arch-design-2026-09-02.md`。

---

**说明**：文中所有文件路径、行号、接口签名均来自对现有代码的实读（`builder.ts:56`、`tablesCore.ts:555/244`、`ioFormats.ts:71`、`configStore.ts:11`、`data.ts:98/119`、`sillytavern/worlds.ts:61`、`searchIndexIpc.ts:67` 等），可作为工程师直接执行的依据。
