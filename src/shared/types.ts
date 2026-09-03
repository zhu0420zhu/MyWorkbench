export interface Shortcut {
  id: string
  name: string
  type: 'url' | 'command'
  target: string
  icon: string
  color: string
  createdAt: number
}

export type ShortcutInput = Omit<Shortcut, 'id' | 'createdAt'>

export interface NoteMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** 笔记标签（名称列表） */
  tags?: string[]
  /** 分类（手动或自动分配） */
  category?: string
  /** 分类来源：auto=规则引擎 / manual=用户手动 */
  categorizedBy?: 'auto' | 'manual'
}

export interface Note extends NoteMeta {
  content: string
}

/** 标签元数据 */
export interface NoteTag {
  name: string
  color?: string
  createdAt: number
}

/** 智能分类规则（关键词命中引擎） */
export interface CategoryRule {
  id: string
  name: string
  /** 命中任一关键词即归入该分类 */
  keywords: string[]
  category: string
  createdAt: number
}

/** 可自定义检索表（索引表） */
export interface NoteIndexTable {
  id: string
  name: string
  /** 关键词维度（内容包含任一即命中） */
  keywords?: string[]
  /** 标签维度 */
  tags?: string[]
  /** 日期范围（ms 时间戳，可选） */
  dateFrom?: number
  dateTo?: number
  createdAt: number
  updatedAt: number
}

/** 检索表生成结果（命中条目） */
export interface IndexHit {
  noteId: string
  title: string
  category?: string
  tags: string[]
  createdAt: number
  updatedAt: number
  /** 命中的关键词 */
  matchedKeywords: string[]
  /** 命中的标签 */
  matchedTags: string[]
}

/** 一键导出/导入的数据包 */
export interface NoteExportBundle {
  version: 1
  exportedAt: number
  tags: NoteTag[]
  rules: CategoryRule[]
  indexTables: NoteIndexTable[]
  notes: Array<NoteMeta & { content: string }>
}

export interface NoteImportResult {
  ok: boolean
  error?: string
  counts?: { notes: number; tags: number; rules: number; indexTables: number }
}

export interface Automation {
  id: string
  name: string
  command: string
  cwd: string
  createdAt: number
}

export type AutomationInput = Omit<Automation, 'id' | 'createdAt'>

export interface AutomationOutputChunk {
  id: string
  chunk: string
  isError?: boolean
}

export interface AutomationDoneEvent {
  id: string
  exitCode: number | null
}

/** 命令面板可触发的应用内命令（Ctrl+K / 主页快捷入口共用） */
export type AppCommand =
  | 'new-note'
  | 'new-automation'
  | 'ai-chat'
  | 'filetools'
  | 'knowledge'
  | 'toggle-theme'
  | 'open-search'

export interface SearchResult {
  kind: 'shortcut' | 'note' | 'automation' | 'page' | 'command'
  id: string
  title: string
  subtitle: string
  /** shortcut 类型专用：直接打开动作 */
  action?: 'url' | 'command'
  target?: string
  /** page 类型：导航目标页（值为 PageKey 字符串，渲染进程转换） */
  page?: string
  /** command 类型：可触发的应用内命令 */
  command?: AppCommand
  /** 命令 / 页面快捷键提示，命令面板展示用 */
  shortcut?: string
}

export interface AiConfig {
  endpoint: string
  apiKey: string
  model: string
  systemPrompt: string
  /** 可选次模型（双模型模式）：与主模型并行生成对照/补充回复 */
  secondaryModel?: string
}

/** 写作会话草稿（自动保存到本地） */
export interface AiWritingDraft {
  sessionId: string
  title: string
  messages: AiChatMessage[]
  primaryModel: string
  secondaryModel?: string
  skills: string[]
  updatedAt: number
}

export type AiChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content?: string; tool_calls?: AiToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string }

/** 一个可被 LLM 调用的函数工具（OpenAI 兼容 tool 描述） */
export interface AiToolFunction {
  name: string
  description: string
  /** JSON Schema 参数定义 */
  parameters: Record<string, unknown>
}

export interface AiTool {
  type: 'function'
  function: AiToolFunction
}

/** LLM 返回的工具调用请求 */
export interface AiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** 工具感知的 LLM 调用契约：可携带 tools，返回 tool_calls */
export type ToolAwareLlm = (
  messages: AiChatMessage[],
  opts?: { tools?: AiTool[] }
) => Promise<{ ok: boolean; text?: string; toolCalls?: AiToolCall[]; error?: string }>

/** 单次工具调用执行结果（用于问答透明度 / 引用） */
export interface ToolInvocation {
  /** 工具所属 server 标识（MCP 场景为 serverId） */
  serverId: string
  /** 工具名 */
  name: string
  /** 解析后的入参 */
  arguments: Record<string, unknown>
  /** 工具返回文本 */
  result: string
  /** 是否为错误结果 */
  isError: boolean
}

/** 工具增强循环的完整结果 */
export interface ToolLoopResult {
  ok: boolean
  answer: string
  /** 完整对话（含 assistant 工具调用与 tool 结果回合） */
  messages: AiChatMessage[]
  invocations: ToolInvocation[]
  error?: string
}

/** 工具桥：为 LLM 提供可调用工具并执行（MCP 桥实现之，QA/智能体复用） */
export interface ToolBridge {
  getAiTools(): Promise<AiTool[]>
  runToolLoop(
    llm: ToolAwareLlm,
    messages: AiChatMessage[],
    opts?: { maxIterations?: number; tools?: AiTool[] }
  ): Promise<ToolLoopResult>
}

export interface AiChunkEvent {
  sessionId: string
  chunk: string
}

export interface AiDoneEvent {
  sessionId: string
  ok: boolean
}

export interface DataInfo {
  dataDir: string
  shortcuts: number
  notes: number
  automations: number
  aiConfigured: boolean
}

/* ---- 数据库（表格/看板） ---- */
export type FieldType = 'text' | 'number' | 'select' | 'date' | 'checkbox'

export interface TableField {
  id: string
  name: string
  type: FieldType
  /** select 类型：可选值列表 */
  options?: string[]
}

export type FieldValue = string | number | boolean | null

export interface TableRow {
  id: string
  values: Record<string, FieldValue>
}

export interface DataTable {
  id: string
  name: string
  fields: TableField[]
  rows: TableRow[]
  createdAt: number
  updatedAt: number
}

/**
 * 数据表摘要（不含行数据）。
 * 列表 / 增 / 删 / 改 一律只返回摘要，避免把整表（可达数十万行）跨进程来回传输。
 */
export interface TableMeta {
  id: string
  name: string
  fieldCount: number
  rowCount: number
  createdAt: number
  updatedAt: number
}

/** 导入输入：解析结果整表一次过 IPC，主进程单事务落库（id/时间戳由主进程生成） */
export interface TableImportInput {
  name: string
  fields: TableField[]
  rows: TableRow[]
}

/** 导入结果：新表 id + 最新表摘要列表（渲染层不回读整表） */
export interface TableImportResult {
  id: string
  metas: TableMeta[]
}

/* ---- 数据分析：跨模块聚合 IPC 契约 ---- */
export type AggregateKind = 'raw' | 'sum' | 'avg' | 'count'

/** 聚合筛选条件（数据库表模式走 SQL WHERE；CSV 模式在渲染层过滤） */
export interface AggregateFilter {
  fieldId: string
  /** eq 等于 / neq 不等于 / contains 包含 / gt 大于 / gte 大于等于 / lt 小于 / lte 小于等于 / isMissing 缺失 */
  op: 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'isMissing'
  value: string
}

/** 聚合请求：一律传 fieldId（字段可重名），不传列名 */
export interface AggregateRequest {
  tableId: string
  xFieldId: string
  yFieldId?: string | null
  agg: AggregateKind
  /** 返回类目上限，默认 200（SQL LIMIT 用） */
  topN?: number
  /** raw 模式采样行数，默认 1000（与预览表 PREVIEW_MAX 同级） */
  sampleRows?: number
  /** 行级筛选条件（数据库表模式在 SQL 内过滤，减少下发给渲染层的载荷） */
  filters?: AggregateFilter[]
}

/** 聚合分组：与图表 chartData 元素同形，渲染层零转换 */
export interface AggregateGroup {
  name: string
  value: number
}

/** 聚合结果：matchedRows = 参与聚合的行数（结论区用），updatedAt 供缓存失效 */
export interface AggregateResult {
  tableId: string
  updatedAt: number
  totalRows: number
  matchedRows: number
  groups: AggregateGroup[]
}

/* ---- 数据分析：统计摘要与规则化结论（纯逻辑 analysisCore 的契约） ---- */
export interface ColumnStats {
  column: string
  /** 是否为数值列（至少含一个可转数值的值）：决定 min/max/mean/median/std 是否有意义 */
  numeric: boolean
  count: number
  missing: number
  missingRate: number
  min: number
  max: number
  mean: number
  median: number
  std: number
}

/** 结论条目：kind 用于渲染着色与 Markdown 导出分组；id 为稳定标识（按 kind+组内序号生成），供删除/编辑/隐藏状态定位 */
export interface ConclusionItem {
  kind: 'overview' | 'top' | 'extreme' | 'trend' | 'missing'
  text: string
  /** 稳定标识：kind + 同组出现序号（如 top / extreme-1 / extreme-2），重算后保持稳定 */
  id: string
}

/* ---- 白板 ---- */
export interface BoardMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

/* ---- OCR ---- */
export interface OcrImageInfo {
  dataUrl: string
  name: string
  size: number
}

export interface OcrLineResult {
  text: string
  score: number
  /** 归一化后的文本框四点 [x1,y1,x2,y2,x3,y3,x4,y4] */
  box: number[]
}

/* ---- 便利贴 ---- */
export interface StickyNote {
  id: string
  title: string
  content: string
  color: string
  pinned: boolean
  /** 任务日期 yyyy-mm-dd（可选，日历视图用） */
  date?: string
  /** 展开态点击「打开程序」时执行的命令（可选，复用 command:run 纯字符串约定；旧数据无此字段则按钮不显示） */
  command?: string
  createdAt: number
  updatedAt: number
}

export type StickyNoteInput = Omit<StickyNote, 'id' | 'createdAt' | 'updatedAt'>

export interface HotItem {
  title: string
  url: string
  hot: number
}

export interface HotEventSource {
  platform: string
  title: string
  url: string
  hot: number
}

export interface HotEvent {
  id: string
  title: string
  score: number
  hot: number
  sources: HotEventSource[]
  firstSeen: number
}

export interface HotPlatformStatus {
  id: string
  name: string
  status: 'ok' | 'error'
  count: number
  error?: string
}

export interface HotFetchResult {
  events: HotEvent[]
  platforms: HotPlatformStatus[]
  updatedAt: number
}

export type PublishJobStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped'

export interface PublishPlatformInfo {
  id: string
  name: string
  status: 'ready' | 'skeleton'
  modeLabel: string
  loggedIn?: boolean
}

export interface PublishJobInfo {
  id: string
  contentId: string
  title: string
  content: string
  platformId: string
  status: PublishJobStatus
  scheduledAt?: number
  mode?: string
  externalId?: string
  error?: string
  retryCount: number
  createdAt: number
  updatedAt: number
}

export interface PublishCreateInput {
  title: string
  content: string
  targets: string[]
  contentId?: string
  scheduledAt?: number
}

export interface PublishStats {
  total: number
  success: number
  failed: number
  pending: number
  scheduled: number
  byPlatform: Record<string, { total: number; success: number; failed: number; pending: number }>
}

export interface AiAssistResult {
  ok: boolean
  text?: string
  error?: string
}

export interface HotNotifySettings {
  enabled: boolean
  intervalMinutes: number
  topCount: number
}

export interface HotNotifierStatus {
  enabled: boolean
  running: boolean
  intervalMinutes: number
  topCount: number
  lastRunAt: number | null
  lastNotified: number
}

export interface GzhConfigInfo {
  appId: string
  hasSecret: boolean
}

/* ============================================================
 * 移植自 ck 的三个功能模块 — 渲染进程 / 主进程 IPC 契约类型
 * 主进程实现：src/main/{organize,convert,searchIndex}
 * 渲染进程调用：window.api.{organize,convert,searchIndex}
 * 这些类型同时被 node 与 web 两个编译目标引用，故置于 shared。
 * ============================================================ */

/* ---- 智能分类与整理执行（organize） ---- */
export type OrganizeActionType = 'move' | 'rename' | 'copy' | 'delete'
export type OrganizeMode = 'category' | 'date' | 'size'

export interface OrganizeAction {
  actionType: OrganizeActionType
  sourcePath: string
  /** move/copy/rename 的目标完整路径；delete 为 null */
  targetPath: string | null
  reason: string
  success: boolean
  error: string
}

export interface OrganizePlanPreview {
  totalFiles: number
  estimatedSavings: number
  estimatedSavingsFormatted: string
  createdAt: string
  actions: OrganizeAction[]
}

export interface OrganizeOptions {
  targetBase?: string
  useAi?: boolean
  mode?: OrganizeMode
}

export interface ExecuteResult {
  successCount: number
  failedCount: number
  totalFiles: number
  actions: OrganizeAction[]
  executedAt: string
}

/* ---- 格式转换引擎（convert） ---- */
export interface ConversionResult {
  success: boolean
  sourcePath: string
  targetPath: string | null
  targetFormat: string
  converterName: string
  duration: number
  error: string
  fileSizeBefore: number
  fileSizeAfter: number
}

export interface ConvertInput {
  sourcePath: string
  targetFormat: string
  outputDir?: string
  quality?: string
  /** 转换器特定参数（ffmpeg 的 videoCodec/audioCodec、imagemagick 的 resize/density 等） */
  kwargs?: Record<string, unknown>
}

export interface ConvertConverterInfo {
  name: string
  available: boolean
  sourceFormats: string[]
  formatCount: number
}

export interface ConvertTempStatus {
  tempDir: string
  exists: boolean
  totalFiles: number
  totalSize: number
}

export interface ConvertCleanupResult {
  cleanedFiles: number
  cleanedDirs: number
  freedSpace: number
}

/* ---- 全文检索索引（searchIndex） ---- */
export interface IndexDoc {
  docId: string
  filePath: string
  fileName: string
  extension: string
  size: number
  indexedAt: number
  chunkCount: number
}

export interface SearchHit {
  docId: string
  filePath: string
  fileName: string
  score: number
  snippets: string[]
  chunkCount: number
}

export interface IngestResult {
  success: boolean
  filePath: string
  docId?: string
  chunkCount: number
  error?: string
}

export interface IndexStats {
  docCount: number
  chunkCount: number
  tokenCount: number
  available: boolean
}

/* ---- 与本地文件对话（searchIndex Q&A，移植自 awesome-llm-apps RAG / Chat with X） ---- */
export type QaMode = 'basic' | 'graded'

export interface QaCitation {
  /** 引用编号，对应回答中的 [n] */
  index: number
  filePath: string
  /** 在原文中的字符起始偏移（来自切分元数据） */
  startChar: number
  snippet: string
  heading?: string
}

export interface AskRequest {
  question: string
  topK?: number
  /** 限定检索范围：文件完整路径或目录前缀（目录以分隔符结尾精确匹配） */
  scope?: string
  /** basic=直接召回；graded=CRAG 检索质量增强（默认） */
  mode?: QaMode
  /** 个性化问答偏好（记忆与个性化） */
  prefs?: QaPrefs
  /** 上下文 token 总预算（覆盖服务默认，用于 Token/上下文优化） */
  maxTokens?: number
}

export interface AskResult {
  ok: boolean
  answer: string
  citations: QaCitation[]
  usedChunks: number
  mode: QaMode
  /** generated=正常生成；retrieval-only=LLM 不可用仅返回检索片段；empty=无命中 */
  answerMode: 'generated' | 'retrieval-only' | 'empty'
  /** 实际喂给 LLM 的上下文 token 估值（Token/上下文优化） */
  contextTokens?: number
  /** 上下文是否因 token 预算被截断/压缩 */
  truncated?: boolean
  /** 本次问答调用的外部工具（MCP 工具桥），用于透明度展示 */
  mcpToolCalls?: ToolInvocation[]
  error?: string
}

export interface QaHistoryEntry {
  id: string
  question: string
  answer: string
  mode: QaMode
  citationCount: number
  at: number
}

/* ============================================================
 * 记忆与个性化 / 多模态视觉 / 常驻智能体 — 移植自 awesome-llm-apps
 * 对应类别：七(记忆与个性化)、五(多模态)、四/二-3(常驻智能体)
 * 这些契约同时被 node 与 web 两个编译目标引用，故置于 shared。
 * ============================================================ */

/* ---- 分类纠正记忆（organize 个性化，移植自 Memory #11 Personalized Memory） ---- */
export interface ClassificationMemoryEntry {
  /** 记忆键：文件扩展名小写（含点，如 ".pdf"）或 "__noext__" */
  pattern: string
  category: string
  /** 学习次数（达到阈值后分类时优先采用） */
  count: number
  updatedAt: number
}

/* ---- 问答个性化偏好（searchIndex Q&A，记忆与个性化） ---- */
export type QaAnswerStyle = 'concise' | 'detailed'

export interface QaPrefs {
  /** 回答风格：简洁 / 详细 */
  answerStyle?: QaAnswerStyle
  /** 返回引用的最大条数（默认由 QaService 控制） */
  maxCitations?: number
  /** 回答语言（默认中文） */
  language?: string
}

/* ---- 多模态：视觉消息（Vision RAG，移植自 Multimodal #5） ---- */
export type AiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface AiVisionMessage {
  role: 'user' | 'assistant' | 'system'
  /** 文本 或 多模态内容块（文本 + 图片 URL） */
  content: string | AiContentPart[]
}

/* ---- 常驻智能体（Always-on Agents #4：HN 简报 / Release Radar） ---- */
export interface AgentConfig {
  enabled: boolean
  /** 周期毫秒 */
  intervalMs: number
}

export interface AgentsConfig extends Record<string, unknown> {
  jobs: Record<string, AgentConfig>
  /** Release Radar 关注的 GitHub 仓库（owner/repo） */
  releaseRepos: string[]
}

export interface AgentResultItem {
  title: string
  url?: string
  meta?: string
}

export interface AgentRunResult {
  ok: boolean
  /** 人类可读摘要 */
  summary: string
  items: AgentResultItem[]
  error?: string
}

export interface AgentRunRecord {
  id: string
  jobId: string
  at: number
  ok: boolean
  summary: string
  itemCount: number
  /** 运行结果条目（如 HN 简报链接 / Release 条目）。未落库时为 undefined。 */
  items?: AgentResultItem[]
  error?: string
}

/* ---- 提示词记录（写作 / AI 对话模块自动沉淀，落本地 JSON 作「本地知识库」载体） ---- */
export type PromptLogSource = 'ai' | 'writing'

export interface PromptLogItem {
  id: string
  /** 用户输入的提示词（已 trim） */
  text: string
  /** 创建时间戳（ms） */
  at: number
  /** 来源：AI 对话 / 写作 */
  source: PromptLogSource
  /** 可选：使用的模型标识 */
  model?: string
}

export interface PromptLogAddInput {
  text: string
  source: PromptLogSource
  model?: string
}

export interface AgentJobInfo {
  id: string
  name: string
  description: string
  enabled: boolean
  intervalMs: number
  lastRunAt: number | null
  lastStatus: 'idle' | 'ok' | 'error'
  lastSummary?: string
}

/* ---- 知识库流水线（P1：convert → index → QA 协同，移植自 awesome-llm-apps RAG/知识库） ---- */
export type KnowledgeBuildStatus = 'ingested' | 'ingested-converted' | 'skipped' | 'error'

export interface KnowledgeBuildInput {
  /** 文件完整路径 或 目录路径 */
  path: string
  kind: 'file' | 'dir'
}

export interface KnowledgeBuildItem {
  /** 原始文件路径（转换场景下为被索引的原始文档，而非临时中间文件） */
  sourcePath: string
  status: KnowledgeBuildStatus
  /** 经转换索引时的中间文件路径（已清理，仅记录用于排查） */
  viaPath?: string
  chunkCount: number
  /** 命中数据型资产拦截并登记为结构化数据资产时回填的资产 id */
  dataAssetId?: string
  error?: string
}

export interface KnowledgeBuildOptions {
  /** 目录是否递归（默认 true） */
  recursive?: boolean
  /** 是否对图片做视觉描述索引（默认 true） */
  includeImages?: boolean
  /** P0：是否拦截数据型扩展名（.csv/.tsv/.xlsx/.xls）并登记为结构化数据资产 */
  includeDataAssets?: boolean
  /** P0：目标知识库 id（数据型资产登记归属；省略时归属默认库） */
  kbId?: string
}

export interface KnowledgeBuildResult {
  ok: boolean
  total: number
  /** 直接建索引（文本/HTML/图片） */
  ingested: number
  /** 经格式转换后建索引（docx/pdf/xlsx 等） */
  ingestedConverted: number
  /** 无可用文本目标或未安装转换器，被跳过 */
  skipped: number
  /** 索引写入失败 */
  failed: number
  items: KnowledgeBuildItem[]
  message: string
}

/* ============================================================
 * 知识库 · 数据型资产（P0：本地 CSV/TSV/XLSX 作为结构化数据资产登记）
 *
 * 这些契约被主进程（src/main/knowledgeBase、src/main/kbDataIpc）、
 * 渲染进程（preload 双写）与分析场景共用，故置于 shared。
 * ============================================================ */

/** 资产大类：文档 / 数据表 / 世界书 */
export type AssetType = 'doc' | 'data' | 'worldbook'

/** 引用作用域：场景默认 / 项目 / 会话 */
export type ReferenceScope = 'scene-default' | 'project' | 'session'

/** 引用通道：全文 / RAG / 作为数据表加载 */
export type ReferenceChannel = 'full-text' | 'rag' | 'load-as-table'

/** 一条引用记录（资产如何被某个知识库引用） */
export interface ReferenceRecord {
  id: string
  /** 归属知识库 id */
  kbId: string
  /** 被引用的资产 id */
  assetId: string
  /** 被引用资产类型 */
  assetType: AssetType
  /** 引用作用域 */
  scope: ReferenceScope
  /** 引用通道 */
  channel: ReferenceChannel
  /** 引用落点（如 system / user / context）：由调用方决定语义 */
  referencePosition: string
  /** 创建时间戳（ms） */
  createdAt: number
  /** load-as-table 通道下引用的表字段（可选） */
  tableRef?: string
  /** load-as-table 通道下列级引用（可选） */
  columnRef?: string
}

/** 场景默认知识库映射（场景名 → 知识库 id 列表） */
export interface SceneDefaultKb {
  sceneDefaultKB: Record<string, string[]>
}

/** 数据型资产的单个列定义 */
export interface DataAssetColumn {
  /** 与底层数据表字段 id 对应 */
  fieldId: string
  name: string
  type: FieldType
}

/** 一个已登记的数据型资产记录 */
export interface DataAssetRecord {
  /** 资产唯一 id（UUID） */
  assetId: string
  /** 归属知识库 id */
  kbId: string
  /** 用户原始文件路径（句柄/溯源） */
  sourcePath: string
  /** 复制到 userData/kb/sources/<assetId>.<ext> 的本地路径 */
  localFilePath: string
  /** 文件名 */
  fileName: string
  /** 底层数据表名 */
  tableName: string
  /** 底层数据表 id（来自 tablesCore.importTable） */
  tableId: string
  /** 列定义（含类型） */
  columns: DataAssetColumn[]
  /** 总行数 */
  rowCount: number
  /** 前 N 行样本（让模型/前端理解结构，不复制全表） */
  sampleRows: Array<Record<string, FieldValue>>
  /** 创建时间戳（ms） */
  createdAt: number
  /** 更新时间戳（ms） */
  updatedAt: number
}

/** 登记一个本地数据文件为数据型资产的输入 */
export interface DataAssetRegInput {
  /** 本地数据文件路径（CSV/TSV/XLSX/XLS） */
  path: string
  /** 目标知识库 id */
  kbId: string
  /** 采样行数（默认 5） */
  sampleRows?: number
}

/** 数据表句柄（用户表 / KB 数据表 / CSV 路径 三选一） */
export type TableHandle =
  | { kind: 'userTable'; tableId: string }
  | { kind: 'kbData'; tableId: string }
  | { kind: 'csvPath'; path: string }

/* ============================================================
 * MCP 集成契约（Model Context Protocol）
 * 对应 awesome-llm-apps 的 MCP 类别：连接外部 MCP server、聚合并调用其 Tools。
 * 这些契约被主进程（src/main/mcp）与渲染进程（preload）共用，故置于 shared。
 * ============================================================ */

/** MCP server 连接配置（持久化于 userData） */
export interface McpServerConfig {
  id: string
  name: string
  /** 启动命令（如 npx、node、python） */
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  enabled?: boolean
}

/** 工具信息（来自 tools/list，聚合时带 serverId 命名空间） */
export interface McpToolInfo {
  serverId: string
  serverName: string
  name: string
  description?: string
  inputSchema?: unknown
}

/** server 运行态（供 UI 展示） */
export interface McpServerState {
  id: string
  name: string
  command: string
  status: 'connected' | 'connecting' | 'error' | 'disabled'
  toolCount: number
  error?: string
  /** 该 server 暴露的工具名（connected 时有效） */
  tools: string[]
}

/** callTool 入参 */
export interface McpCallInput {
  serverId: string
  name: string
  arguments?: Record<string, unknown>
}

/** 工具调用结果（规范化 MCP content 数组） */
export interface McpCallResult {
  ok: boolean
  content: Array<{ type: string; text?: string }>
  isError?: boolean
  error?: string
}
/* ---- 版本快照（笔记 / 写作草稿 / 章节） ---- */

/** 快照目标类型：note=笔记，draft=写作草稿，chapter=长篇作品章节 */
export type SnapshotKind = 'note' | 'draft' | 'chapter'
/** 快照来源：manual=手动保存点 / auto=自动保存 / pre-restore=回滚前自动留存 / import=导入 */
export type SnapshotReason = 'manual' | 'auto' | 'pre-restore' | 'import'

export interface SnapshotMeta {
  id: string
  createdAt: number
  reason: SnapshotReason
  label?: string
  /** 字符数（含空白） */
  chars: number
  /** 字数：CJK 按字计，英文数字按词计 */
  words: number
}

/* ---- 导出成书 ---- */

export type BookFormat = 'epub' | 'docx' | 'pdf' | 'html' | 'md' | 'txt'

export interface BookSourceRef {
  kind: SnapshotKind
  id: string
}

export interface BookSourceItem {
  kind: SnapshotKind
  id: string
  title: string
  words: number
  updatedAt: number
}

export interface BookExportInput {
  /** 按此顺序拼装成书 */
  items: BookSourceRef[]
  format: BookFormat
  bookTitle: string
  author?: string
  /** 是否生成目录（EPUB / DOCX / PDF / HTML 生效） */
  toc: boolean
  /** 封面图绝对路径（仅 EPUB 生效，留空则不带封面） */
  coverImage?: string
  /** 是否注入中文排版样式（EPUB / HTML 生效，默认 true） */
  typeset?: boolean
}

export interface BookExportResult {
  ok: boolean
  path?: string
  error?: string
  /** 实际写入的字数 */
  words?: number
}

/** 内置封面模板 */
export type BookCoverTemplate = 'classic' | 'minimal' | 'gradient' | 'ink'

export interface BookCoverOptions {
  title: string
  author?: string
  /** 副标题 / 类型标签，如「东方玄幻」 */
  subtitle?: string
  template?: BookCoverTemplate
  /** 主色，十六进制，如 #1f3a5f */
  accent?: string
  /** 像素尺寸，默认 1200x1600（3:4，主流电子书封面比例） */
  width?: number
  height?: number
}

export interface BookCoverResult {
  ok: boolean
  /** 生成的 PNG 绝对路径 */
  path?: string
  /** data:image/png;base64 预览（便于渲染层直接展示缩略图） */
  dataUrl?: string
  error?: string
}

/* ---- 长篇作品：作品 / 分卷 / 章节 ---- */

/** 章节状态：细纲 → 初稿 → 已修订 → 定稿 */
export type ChapterStatus = 'outline' | 'draft' | 'revised' | 'final'

/** 作品元数据（列表用，不含章节正文） */
export interface NovelProjectMeta {
  id: string
  title: string
  /** 题材：玄幻 / 都市 / 科幻 … */
  genre: string
  /** 一句话梗概 */
  synopsis: string
  /** 全书目标字数 */
  targetWords: number
  /** 累计正文字数（由章节汇总，非实时写入） */
  wordCount: number
  chapterCount: number
  createdAt: number
  updatedAt: number
}

/** 分卷 */
export interface Volume {
  id: string
  projectId: string
  index: number
  title: string
  /** 本卷概要 */
  summary: string
}

/** 章节元数据（不含正文，正文单独存 .md） */
export interface ChapterMeta {
  id: string
  projectId: string
  volumeId: string
  index: number
  title: string
  /** 本章细纲：上下文编排的主要输入 */
  summary: string
  status: ChapterStatus
  /** 本章字数目标 */
  wordGoal: number
  wordCount: number
  updatedAt: number
}

/** 章节全文 = 元数据 + 正文 */
export interface Chapter extends ChapterMeta {
  content: string
}

/** 作品完整数据：元信息 + 分卷 + 章节元数据 */
export interface NovelProject {
  meta: NovelProjectMeta
  volumes: Volume[]
  chapters: ChapterMeta[]
}

/* ---- 长篇作品：设定库实体化 ---- */

/** 设定实体类型：人物 / 地点 / 势力 / 物品 / 概念 / 事件 */
export type EntityKind = 'character' | 'location' | 'faction' | 'item' | 'concept' | 'event'

/** 六类实体的中文名与配色（列表与关系图共用） */
export const ENTITY_KIND_META: Record<
  EntityKind,
  { label: string; color: string }
> = {
  character: { label: '人物', color: '#d4380d' },
  location: { label: '地点', color: '#08979c' },
  faction: { label: '势力', color: '#531dab' },
  item: { label: '物品', color: '#d46b08' },
  concept: { label: '概念', color: '#c41d7f' },
  event: { label: '事件', color: '#389e0d' }
}

/** 设定实体卡（元数据；设定正文单独存 .md） */
export interface EntityMeta {
  id: string
  projectId: string
  kind: EntityKind
  name: string
  /** 别名：正文中出现任一字面量即视为指代该实体（如「萧炎」「炎帝」「萧家三少」） */
  aliases: string[]
  /** 一句话简介，列表与上下文摘要里显示 */
  tagline: string
  /** 钉住：始终进入上下文编排 */
  pinned: boolean
  index: number
  /** 首次登场的章节 id */
  firstChapterId?: string
  createdAt: number
  updatedAt: number
}

/** 实体全文 = 元数据 + 设定正文 */
export interface Entity extends EntityMeta {
  /** 设定卡正文（Markdown）：外貌 / 性格 / 出身 / 能力…随 kind 而异 */
  content: string
}

/** 实体的动态状态：随章节推进而变化（人物当前处境、地点归属、物品去向） */
export interface EntityState {
  id: string
  projectId: string
  entityId: string
  /** 生效起点章节 id：该章开始后此状态成立 */
  chapterId: string
  text: string
  createdAt: number
}

/** 实体关系（有向边） */
export interface EntityRelation {
  id: string
  projectId: string
  fromId: string
  toId: string
  /** 关系标签：师徒 / 敌对 / 恋人 / 隶属 / 持有… */
  label: string
  /** 双向（如「挚友」）或单向（如「暗恋」） */
  bidirectional: boolean
}

/** 正文中识别出的实体提及（别名识别结果） */
export interface EntityMention {
  entityId: string
  name: string
  kind: EntityKind
  /** 命中的字面量（可能是别名而非本名） */
  matched: string
  count: number
}

/* ---- 长篇作品：上下文编排器（ContextBundle） ---- */

/** 上下文块类型 */
export type ContextBlockKind =
  | 'synopsis' // 作品设定：书名 / 题材 / 梗概
  | 'summary-chain' // 前 N 章摘要链
  | 'prev-tail' // 上一章结尾原文
  | 'outline' // 本章细纲
  | 'entities' // 本章出场实体（设定 + 动态状态 + 一跳关系）
  | 'retrieval' // 本地检索召回的旧章片段
  | 'note' // 作者钉住的备忘

/** 上下文块：上下文面板里可见、可勾选、可增删、可排序的一行 */
export interface ContextBlock {
  id: string
  kind: ContextBlockKind
  title: string
  text: string
  /** token 估算（中英文混合启发式，仅用于预算分配） */
  tokens: number
  enabled: boolean
  /** false = 结构性块（作品设定 / 本章细纲），不允许删除 */
  removable: boolean
  order: number
}

/** 一次编排结果 */
export interface ContextBundle {
  projectId: string
  chapterId: string
  chapterTitle: string
  blocks: ContextBlock[]
  /** 已启用块的 token 合计 */
  totalTokens: number
  /** 预算上限（面板显示占比用） */
  budgetTokens: number
  /** 因超预算被自动关闭的块标题 */
  trimmed: string[]
}

export interface BuildContextOptions {
  /** 摘要链深度：往前取几章的细纲，默认 4 */
  summaryDepth?: number
  /** 上一章结尾原文的字符数，默认 800 */
  prevTailChars?: number
  /** 检索召回片段数，默认 3 */
  retrievalTopK?: number
  /** 上下文预算（token），默认 24000 */
  budgetTokens?: number
  /** 最多纳入几个出场实体，默认 12 */
  maxEntities?: number
  /** 单张设定卡正文截断字符数，默认 400 */
  entityChars?: number
}

/* ---- 长篇作品：编辑器内 AI 动作（P1-3） ---- */

/** 选区驱动的 AI 改写动作 */
export type AiEditAction =
  | 'continue' // 续写：在选中段之后往下接
  | 'polish' // 润色：通顺、去语病
  | 'expand' // 扩写：加细节与感官
  | 'condense' // 缩写：去冗余、保骨架
  | 'restyle' // 改风格：更文学、更有画面感
  | 'deai' // 去 AI 味：更自然、带作者语气

/** 一次 AI 编辑请求的输入 */
export interface AiEditInput {
  action: AiEditAction
  /** 选中的正文（续写时为"续写锚点"） */
  selectedText: string
  /** 选中段之前的正文（取末尾若干字，给模型保留连贯语境） */
  beforeText?: string
  /** 选中段之后的正文 */
  afterText?: string
  /** 由上下文面板注入的背景（设定/摘要链/实体等），附在请求里 */
  contextPrompt?: string
}

/** AI 编辑的返回 */
export interface AiEditResult {
  ok: boolean
  /** 改写/续写结果文本 */
  text?: string
  error?: string
}

/* ---- 长篇作品：一致性审计（P2-1，规则先行） ---- */

export type ConsistencyIssueKind =
  | 'alias-normalization' // 正文用了别名，建议统一为正式名（可一键修正）
  | 'unregistered-name' // 高频出现的专名但设定库里没有
  | 'duplicate-entity' // 两个实体同名 / 同别名

export interface ConsistencyIssue {
  id: string
  kind: ConsistencyIssueKind
  severity: 'info' | 'warn' | 'error'
  message: string
  /** 命中的章节（定位用） */
  chapterId: string
  chapterTitle: string
  /** 原文中命中的字面量 */
  matched?: string
  /** 建议修正为（别名 → 正式名） */
  suggestion?: string
  /** 是否可一键自动修正 */
  autoFixable: boolean
  /** 自动修正关联到的实体（别名归一化的正式名实体） */
  entityId?: string
}

export interface ConsistencyReport {
  projectId: string
  issues: ConsistencyIssue[]
  scannedChapters: number
}

/* ---- 长篇作品：伏笔 / 线索追踪（P2-2） ---- */

/** 伏笔状态：已埋下 / 已回收 / 已放弃 */
export type ForeshadowStatus = 'planted' | 'payed-off' | 'abandoned'

/** 伏笔 / 线索：在 A 章埋下，计划在后续某章回收 */
export interface Foreshadow {
  id: string
  projectId: string
  /** 伏笔内容：埋下时的原文片段，或作者自己的备注 */
  content: string
  /** 埋在哪一章 */
  plantedChapterId: string
  plantedChapterTitle: string
  /** 在哪一章回收（状态为 payed-off 时填） */
  payoffChapterId?: string
  payoffChapterTitle?: string
  status: ForeshadowStatus
  /** 作者备注（可选） */
  note?: string
  createdAt: number
  updatedAt: number
}

/* ---- 长篇作品：灵感工作台 / 写作 Skill 包（P2-3） ---- */

/** 灵感类型：点子 / 情节 / 人物 / 场景 / 对话 / 世界观 / 杂记 */
export type InspirationKind = 'idea' | 'plot' | 'character' | 'scene' | 'dialogue' | 'world' | 'other'

/** 灵感卡片（按项目存放，写作时的灵感碎片与备忘） */
export interface InspirationNote {
  id: string
  projectId: string
  kind: InspirationKind
  /** 灵感正文：一句话点子、一段情节设想、一句台词等 */
  content: string
  /** 作者备注（选填） */
  note?: string
  createdAt: number
  updatedAt: number
}

/**
 * 写作 Skill：可复用的 prompt 模板。
 * 模板用占位符：{{context}} = 当前章上下文（设定/前文/设定库），{{input}} = 作者额外输入。
 * builtin=true 为内置 Skill（可编辑覆盖，默认不可删除）。
 */
export interface WritingSkill {
  id: string
  name: string
  description: string
  template: string
  builtin: boolean
  createdAt: number
  updatedAt: number
}

/** 运行一次 Skill 的结果 */
export interface SkillRunResult {
  ok: boolean
  text?: string
  error?: string
}

/** 写作 Skill 导出包（备份 / 迁移） */
export interface SkillExportBundle {
  version: 1
  exportedAt: number
  skills: WritingSkill[]
}

/** 导入 Skill 包的结果 */
export interface SkillImportResult {
  ok: boolean
  count: number
  error?: string
}

/* ============================================================
 * 信息流（feed）—— 全网热点 × 智能体 统一抽象
 * 同时被主进程（src/main/feed）、preload 双写、渲染层引用，故置于 shared。
 * Phase A：仅新增类型，无行为变更。
 * ============================================================ */

/** 统一条目：全网热点事件 与 智能体结果 都映射到此结构 */
export interface FeedItem {
  /** 稳定 id（热点走 simhash hex；智能体走 title hash） */
  id: string
  title: string
  url?: string
  /** 展示热度 / 权重（热点=热度值；智能体=点数/权重，可为 0） */
  hot: number
  /** 条目级来源：可能是多平台共识（热点）或单来源（智能体） */
  sources: FeedItemSource[]
  /** 来源类别：'hot' = 热点平台；'agent' = 智能体任务 */
  sourceKind: 'hot' | 'agent'
  /** 数据归属的 FeedSource id（如 weibo / hn-briefing） */
  sourceId: string
  /** 分类（复用 categorize，智能体条目默认 '科技'） */
  category: string
  /** 额外元信息（如 HN 的「120 分 · torvalds」） */
  meta?: string
  firstSeen: number
}

export interface FeedItemSource {
  platform: string // 平台/任务 id（weibo / hn-briefing / release-radar）
  name: string // 展示名（微博 / Hacker News 简报 / Release Radar）
  title: string
  url: string
  hot: number
}

/** 数据源元信息（管理面板用） */
export interface FeedSourceMeta {
  id: string
  name: string
  kind: 'hot' | 'agent'
  description?: string
  /** 该源产出的条目分类倾向（用于默认归类） */
  defaultCategory?: string
  /** 是否已启用（参与合并 feed / 通知） */
  enabled: boolean
  /** 周期毫秒（智能体任务用；热点平台为 0=实时聚合） */
  intervalMs: number
  lastRunAt: number | null
  lastStatus: 'idle' | 'ok' | 'error'
  lastSummary?: string
  /** 单源最近一次产出的条目数 */
  lastItemCount: number
  /** 是否为内置源（内置源不可删除） */
  builtIn?: boolean
}

/** 自定义 feed 源定义（用于 addSource） */
export interface CustomFeedSourceDef {
  id: string
  name: string
  kind: 'hot' | 'agent'
  description?: string
  defaultCategory?: string
  enabled: boolean
  intervalMs: number
  /** 自定义源的数据地址（JSON feed） */
  url: string
}

export interface FeedSourceStatus {
  id: string
  status: 'ok' | 'error'
  count: number
  error?: string
}

/** 合并后的信息流结果（替代 HotFetchResult 给渲染层用） */
export interface FeedResult {
  items: FeedItem[]
  sources: FeedSourceStatus[]
  updatedAt: number
}

/** 数据源配置（启用 / 周期） */
export interface FeedSourceConfig {
  enabled: boolean
  intervalMs: number
}

/** 统一通知设置（合并 hotNotifier + 智能体通知） */
export type FeedNotifySettings = {
  enabled: boolean
  intervalMinutes: number
  topCount: number
  /** 是否对智能体运行结果也弹通知（默认 true） */
  notifyAgents: boolean
}

/** 数据源运行历史记录（feed 层自己的历史，区别于 AgentRunRecord） */
export interface FeedRunRecord {
  id: string
  sourceId: string
  at: number
  ok: boolean
  summary: string
  itemCount: number
  /** 本次运行的产出条目（未落库时为 undefined） */
  items?: FeedItem[]
  error?: string
}
