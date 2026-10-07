import type {
  Shortcut,
  ShortcutInput,
  Note,
  NoteMeta,
  Automation,
  AutomationInput,
  AutomationOutputChunk,
  AutomationDoneEvent,
  SearchResult,
  AiConfig,
  AiProfile,
  AiProfilesState,
  AiRouting,
  AgentHubSnapshot,
  AgentMemory,
  AgentRoleBrief,
  AutopilotBrief,
  CodeSymbol,
  DutySlot,
  EvoApp,
  ExperienceCard,
  GoalBrief,
  ImChannel,
  AiChatMessage,
  DashboardOverview,
  IssueBrief,
  IssueComment,
  PlanBrief,
  ResourceCatalog,
  RunBrief,
  SandboxRun,
  SquadBrief,
  UsageStatsState,
  WorkspaceBrief,
  WorkspaceDir,
  AiTool,
  AiChunkEvent,
  AiDoneEvent,
  PromptLogItem,
  DataInfo,
  DataTable,
  FieldValue,
  TableMeta,
  TableImportInput,
  TableImportResult,
  AggregateRequest,
  AggregateResult,
  BoardMeta,
  OcrImageInfo,
  StickyNote,
  StickyNoteInput,
  PublishJobInfo,
  PublishStats,
  AiAssistResult,
  PublishPlatformInfo,
  PublishCreateInput,
  HotNotifierStatus,
  GzhConfigInfo,
  FeedItem,
  FeedResult,
  FeedSourceMeta,
  FeedSourceConfig,
  FeedNotifySettings,
  FeedRunRecord,
  OrganizeAction,
  OrganizeOptions,
  OrganizePlanPreview,
  ExecuteResult,
  ConversionResult,
  ConvertInput,
  ConvertConverterInfo,
  ConvertTempStatus,
  ConvertCleanupResult,
  SearchHit,
  IngestResult,
  IndexStats,
  AskRequest,
  AskResult,
  QaHistoryEntry,
  ClassificationMemoryEntry,
  QaPrefs,
  KnowledgeBuildInput,
  KnowledgeBuildOptions,
  KnowledgeBuildResult,
  McpServerConfig,
  McpServerState,
  McpToolInfo,
  McpCallInput,
  McpCallResult,
  NoteTag,
  CategoryRule,
  NoteIndexTable,
  IndexHit,
  NoteExportBundle,
  NoteImportResult,
  SnapshotKind,
  SnapshotMeta,
  BookSourceItem,
  BookExportInput,
  BookExportResult,
  BookCoverOptions,
  BookCoverResult,
  ChapterStatus,
  NovelProject,
  NovelProjectMeta,
  Volume,
  Chapter,
  ChapterMeta,
  Entity,
  EntityKind,
  EntityMeta,
  EntityMention,
  EntityRelation,
  EntityState,
  ContextBundle,
  ContextBlock,
  BuildContextOptions,
  AiEditInput,
  AiEditResult,
  ConsistencyIssue,
  ConsistencyReport,
  Foreshadow,
  ForeshadowStatus,
  InspirationKind,
  InspirationNote,
  SkillExportBundle,
  SkillImportResult,
  SkillRunResult,
  WritingSkill,
  NovelWorkflow,
  ProjectWorkflowState,
  DocOpenResult,
  SurgicalExtractResult,
  SurgicalApplyResult,
  SurgicalEdit,
  DataAssetRecord,
  DataAssetColumn,
  ReferenceRecord,
  ReferenceScope,
  KbCandidate,
  KbInjectBlock,
  KbRefPick
} from '../shared/types'

/* ---- 工具集类型（由 ck 08_工具集 移植） ---- */
export interface FileInfo {
  path: string
  relative_path: string
  name: string
  stem: string
  extension: string
  size: number
  category: string
  created: number
  modified: number
  accessed: number
}
export interface FileDetail {
  path: string
  name: string
  stem: string
  extension: string
  size: number
  category: string
  created: number
  modified: number
  accessed: number
  is_file: boolean
  is_dir: boolean
}
export interface ScanOptions {
  recursive?: boolean
  includeExtensions?: string[]
  excludeExtensions?: string[]
  excludeDirs?: string[]
  minSize?: number
  maxSize?: number
}
export interface DiskInfoDict {
  path: string
  total: number
  used: number
  free: number
  percent_used: number
  total_formatted: string
  used_formatted: string
  free_formatted: string
}
export interface CategoryStat {
  category: string
  count: number
  size: number
  size_formatted: string
  percent: number
}
export interface ExtensionStat {
  extension: string
  count: number
  size: number
  size_formatted: string
  percent: number
}
export interface LargeFile {
  path: string
  name: string
  size: number
  size_formatted: string
  modified: number
}
export interface DirectoryAnalysis {
  directory: string
  total_size: number
  total_size_formatted: string
  category_stats: CategoryStat[]
  extension_stats: ExtensionStat[]
  large_files: LargeFile[]
  large_file_count: number
}
export interface DuplicateResultGroup {
  files: string[]
  similarity: number
  size: number
  hash: string | null
  keep: string | null
  delete: string[]
  savings: number
}
export interface DuplicateScanResult {
  directory: string
  total_groups: number
  total_duplicates: number
  total_savings: number
  strategy: string
  groups: DuplicateResultGroup[]
}
export interface FolderCompareDiffLine {
  type: 'same' | 'added' | 'removed'
  line: string
  leftNo?: number
  rightNo?: number
}
export interface FolderCompareFile {
  relativePath: string
  leftPath?: string
  rightPath?: string
  leftSize?: number
  rightSize?: number
  leftModified?: number
  rightModified?: number
  leftHash?: string
  rightHash?: string
  status: 'identical' | 'different' | 'only-left' | 'only-right'
  diff?: FolderCompareDiffLine[]
}
export interface FolderCompareResult {
  left: string
  right: string
  onlyInLeft: FolderCompareFile[]
  onlyInRight: FolderCompareFile[]
  different: FolderCompareFile[]
  identical: FolderCompareFile[]
  summary: {
    totalLeft: number
    totalRight: number
    identical: number
    different: number
    onlyLeft: number
    onlyRight: number
  }
}
export interface WatchedDirInfo {
  name: string
  path: string
  enabled: boolean
}
export interface FileEvent {
  event_type: 'created' | 'modified' | 'deleted' | 'renamed' | 'moved_from' | 'moved_to'
  path: string
  old_path?: string
  timestamp: number
}
/** 窗口缩放方向：四边 + 四角 */
export type WindowResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
/** 关闭行为：ask=每次询问 / minimize=最小化到后台 / quit=直接退出 */
export type WindowCloseBehavior = 'ask' | 'minimize' | 'quit'

export interface Api {
  platform: string
  versions: {
    electron: string
    chrome: string
    node: string
  }
  windowApi: {
    minimize: () => Promise<void>
    toggleMaximize: () => Promise<boolean>
    close: () => Promise<void>
    onMaximizedChange: (cb: (maximized: boolean) => void) => () => void
    relaunch: () => Promise<boolean>
    isMaximized: () => Promise<boolean>
    bounds: () => Promise<{ x: number; y: number; width: number; height: number } | null>
    resizeBegin: (edge: WindowResizeEdge) => void
    resizeMove: () => void
    resizeEnd: () => void
    onConfirmClose: (cb: () => void) => () => void
    replyClose: (action: 'minimize' | 'quit' | 'cancel', remember: boolean) => void
    getCloseBehavior: () => Promise<WindowCloseBehavior>
    setCloseBehavior: (b: WindowCloseBehavior) => Promise<WindowCloseBehavior>
    /** 把指定页面以独立无边框窗口打开（已打开则聚焦） */
    openPageWindow: (page: string, id?: string) => Promise<boolean>
    closePageWindow: (page: string, id?: string) => Promise<boolean>
    /** 已打开的独立窗口 key 列表，格式 `page:id` */
    listPageWindows: () => Promise<string[]>
    hasPageWindow: (page: string, id?: string) => Promise<boolean>
    onPageWindowsChanged: (cb: (keys: string[]) => void) => () => void
    /** 独立窗口内跳转到某页 → 交给主窗口打开并聚焦 */
    navigateInMain: (page: string, id?: string) => Promise<boolean>
    /** 主窗口监听来自独立窗口的跳转请求 */
    onMainNavigate: (cb: (t: { page: string; id?: string }) => void) => () => void
  }
  shortcuts: {
    list: () => Promise<Shortcut[]>
    add: (input: ShortcutInput) => Promise<Shortcut[]>
    update: (payload: Shortcut) => Promise<Shortcut[]>
    remove: (id: string) => Promise<Shortcut[]>
  }
  notes: {
    list: () => Promise<NoteMeta[]>
    get: (id: string) => Promise<Note | null>
    create: (title: string) => Promise<NoteMeta[]>
    update: (id: string, content: string) => Promise<NoteMeta[]>
    remove: (id: string) => Promise<NoteMeta[]>
    updateMeta: (
      id: string,
      meta: { tags?: string[]; category?: string; categorizedBy?: 'auto' | 'manual' }
    ) => Promise<NoteMeta[]>
    createBatch: (inputs: Array<{ title: string; content: string }>) => Promise<NoteMeta[]>
    repairEncoding: (id: string) => Promise<Note | null>
    repairAllEncodings: () => Promise<{ scanned: number; repaired: number }>
  }
  snapshots: {
    /** 列出快照（新的在前） */
    list: (kind: SnapshotKind, id: string) => Promise<SnapshotMeta[]>
    /** 手动打点：内容无变化时返回 null */
    create: (kind: SnapshotKind, id: string, content: string, label?: string) => Promise<SnapshotMeta | null>
    get: (kind: SnapshotKind, id: string, snapId: string) => Promise<string | null>
    /** 回滚：先把当前内容存为 pre-restore 快照，再返回目标快照正文 */
    restore: (kind: SnapshotKind, id: string, snapId: string, currentContent: string) => Promise<string | null>
    remove: (kind: SnapshotKind, id: string, snapId: string) => Promise<boolean>
  }
  book: {
    /** 可导出来源：笔记 + 写作草稿 */
    sources: () => Promise<BookSourceItem[]>
    /** Pandoc 是否可用（EPUB/DOCX/PDF/HTML 需要它） */
    pandocAvailable: () => Promise<boolean>
    export: (input: BookExportInput) => Promise<BookExportResult>
    /** 从磁盘挑一张封面图（返回绝对路径 + 预览 dataUrl） */
    pickCover: () => Promise<BookCoverResult>
    /** 用内置模板生成封面 PNG（离屏渲染截图，离线可用） */
    generateCover: (opts: BookCoverOptions) => Promise<BookCoverResult>
  }
  // 长篇作品：作品 / 分卷 / 章节
  novel: {
    listProjects: () => Promise<NovelProjectMeta[]>
    createProject: (input: {
      title: string
      genre?: string
      synopsis?: string
      targetWords?: number
      workflowId?: string
    }) => Promise<NovelProject>
    getProject: (projectId: string) => Promise<NovelProject | null>
    updateProject: (
      projectId: string,
      patch: { title?: string; genre?: string; synopsis?: string; targetWords?: number }
    ) => Promise<NovelProjectMeta | null>
    removeProject: (projectId: string) => Promise<boolean>

    listWorkflows: () => Promise<NovelWorkflow[]>
    getWorkflow: (projectId: string) => Promise<ProjectWorkflowState | null>
    workflowStepDone: (projectId: string, stepId: string, done: boolean) => Promise<ProjectWorkflowState | null>
    switchWorkflow: (projectId: string, workflowId: string) => Promise<ProjectWorkflowState | null>
    seedWorkflowSkills: () => Promise<number>

    createVolume: (projectId: string, title: string, summary?: string) => Promise<Volume[]>
    updateVolume: (
      projectId: string,
      volumeId: string,
      patch: { title?: string; summary?: string }
    ) => Promise<Volume[]>
    removeVolume: (
      projectId: string,
      volumeId: string,
      mode: 'delete-chapters' | 'move-to-first'
    ) => Promise<Volume[]>

    createChapter: (input: {
      projectId: string
      volumeId: string
      title?: string
      summary?: string
      wordGoal?: number
    }) => Promise<ChapterMeta | null>
    getChapter: (projectId: string, chapterId: string) => Promise<Chapter | null>
    /** content 传了才写正文；不传只改元数据 */
    updateChapter: (
      projectId: string,
      chapterId: string,
      patch: {
        title?: string
        summary?: string
        status?: ChapterStatus
        wordGoal?: number
        content?: string
        /** 自动保存节流：距上一个快照不足此毫秒数则跳过（手动保存不传） */
        snapshotMinIntervalMs?: number
      }
    ) => Promise<ChapterMeta | null>
    removeChapter: (projectId: string, chapterId: string) => Promise<ChapterMeta[]>
    /** 卷内或跨卷移动；toIndex 为目标卷内的插入位置 */
    reorderChapter: (
      projectId: string,
      chapterId: string,
      toVolumeId: string,
      toIndex: number
    ) => Promise<ChapterMeta[]>

    collectChapters: (
      projectId: string
    ) => Promise<Array<{ title: string; content: string; volumeTitle: string }>>

    /* ---- 设定库：实体卡 / 关系 / 动态状态 ---- */
    listEntities: (projectId: string) => Promise<EntityMeta[]>
    getEntity: (projectId: string, entityId: string) => Promise<Entity | null>
    createEntity: (input: {
      projectId: string
      kind: EntityKind
      name: string
      aliases?: string[]
      tagline?: string
      content?: string
      pinned?: boolean
      firstChapterId?: string
    }) => Promise<EntityMeta | null>
    updateEntity: (
      projectId: string,
      entityId: string,
      patch: {
        kind?: EntityKind
        name?: string
        aliases?: string[]
        tagline?: string
        content?: string
        pinned?: boolean
        index?: number
        firstChapterId?: string
      }
    ) => Promise<EntityMeta | null>
    removeEntity: (projectId: string, entityId: string) => Promise<EntityMeta[]>
    reorderEntities: (projectId: string, orderedIds: string[]) => Promise<EntityMeta[]>

    listRelations: (projectId: string) => Promise<EntityRelation[]>
    /** 同 from→to+label 视为同一条，重复调用为更新而非新增 */
    upsertRelation: (input: {
      projectId: string
      id?: string
      fromId: string
      toId: string
      label: string
      bidirectional?: boolean
    }) => Promise<EntityRelation | null>
    removeRelation: (projectId: string, relationId: string) => Promise<EntityRelation[]>

    listStates: (projectId: string, entityId?: string) => Promise<EntityState[]>
    setState: (input: {
      projectId: string
      entityId: string
      chapterId: string
      text: string
      id?: string
    }) => Promise<EntityState | null>
    removeState: (projectId: string, stateId: string) => Promise<EntityState[]>

    /** 正文实体识别（别名感知）：返回按出现次数降序的出场实体 */
    detectMentions: (projectId: string, text: string) => Promise<EntityMention[]>

    /* ---- 上下文编排器 ---- */
    buildContext: (
      projectId: string,
      chapterId: string,
      opts?: BuildContextOptions
    ) => Promise<ContextBundle | null>
    listPinnedNotes: (projectId: string) => Promise<string[]>
    addPinnedNote: (projectId: string, text: string) => Promise<string[]>
    removePinnedNote: (projectId: string, index: number) => Promise<string[]>
    /** 全量重建检索索引：本功能上线前就存在的旧章节需要跑一次才能被召回 */
    reindexProject: (projectId: string) => Promise<{ indexed: number; failed: number }>
    /** 重算 token 并拼成提示词；面板手工改过块之后调用 */
    renderContext: (
      blocks: ContextBlock[]
    ) => Promise<{ blocks: ContextBlock[]; totalTokens: number; text: string }>
    /** 编辑器内 AI 动作：选区改写 / 续写 */
    aiEdit: (input: AiEditInput) => Promise<AiEditResult>
    /** 一致性审计：跑规则，返回问题列表 */
    auditProject: (projectId: string) => Promise<ConsistencyReport>
    /** 应用一条自动修正（当前仅别名归一化） */
    applyConsistencyFix: (projectId: string, issue: ConsistencyIssue) => Promise<boolean>

    /* ---- 伏笔 / 线索追踪（P2-2） ---- */
    listForeshadows: (projectId: string) => Promise<Foreshadow[]>
    createForeshadow: (input: {
      projectId: string
      content: string
      plantedChapterId: string
      plantedChapterTitle: string
      payoffChapterId?: string
      payoffChapterTitle?: string
      status?: ForeshadowStatus
      note?: string
    }) => Promise<Foreshadow | null>
    updateForeshadow: (
      projectId: string,
      id: string,
      patch: {
        content?: string
        note?: string
        plantedChapterId?: string
        plantedChapterTitle?: string
        payoffChapterId?: string
        payoffChapterTitle?: string
      }
    ) => Promise<Foreshadow | null>
    setForeshadowStatus: (
      projectId: string,
      id: string,
      status: ForeshadowStatus,
      payoffChapterId?: string,
      payoffChapterTitle?: string
    ) => Promise<Foreshadow | null>
    removeForeshadow: (projectId: string, id: string) => Promise<Foreshadow[]>
    /** 当前章写作时提醒：已埋下超过 threshold 章仍未回收的伏笔 */
    listOverdue: (
      projectId: string,
      currentChapterId: string,
      threshold: number
    ) => Promise<Foreshadow[]>

    /* ---- 灵感工作台：灵感池（按项目，P2-3） ---- */
    listInspirations: (projectId: string) => Promise<InspirationNote[]>
    createInspiration: (input: {
      projectId: string
      kind: InspirationKind
      content: string
      note?: string
    }) => Promise<InspirationNote | null>
    updateInspiration: (
      projectId: string,
      id: string,
      patch: { kind?: InspirationKind; content?: string; note?: string }
    ) => Promise<InspirationNote | null>
    removeInspiration: (projectId: string, id: string) => Promise<InspirationNote[]>

    /* ---- 灵感工作台：写作 Skill 包（全局，P2-3） ---- */
    listSkills: () => Promise<WritingSkill[]>
    createSkill: (input: {
      name: string
      description?: string
      template: string
    }) => Promise<WritingSkill | null>
    updateSkill: (
      id: string,
      patch: { name?: string; description?: string; template?: string }
    ) => Promise<WritingSkill | null>
    removeSkill: (id: string) => Promise<WritingSkill[]>
    /** 运行 Skill：用当前章上下文 + 作者输入填模板，调 AI 返回文本 */
    runSkill: (input: {
      projectId: string
      skillId: string
      chapterId?: string
      userInput?: string
    }) => Promise<SkillRunResult>
    /** 导出全部 Skill（含内置）为备份包 */
    exportSkills: () => Promise<SkillExportBundle>
    /** 导入 Skill 包（整体覆盖式还原） */
    importSkills: (bundle: SkillExportBundle) => Promise<SkillImportResult>
  }
  notesFeature: {
    tags: {
      list: () => Promise<NoteTag[]>
      add: (name: string) => Promise<NoteTag[]>
      rename: (oldName: string, newName: string) => Promise<NoteTag[]>
      remove: (name: string) => Promise<NoteTag[]>
    }
    rules: {
      list: () => Promise<CategoryRule[]>
      add: (input: { name: string; keywords: string[]; category: string }) => Promise<CategoryRule[]>
      update: (id: string, input: { name: string; keywords: string[]; category: string }) => Promise<CategoryRule[]>
      remove: (id: string) => Promise<CategoryRule[]>
      apply: () => Promise<{ updated: number; classified: number }>
    }
    indexes: {
      list: () => Promise<NoteIndexTable[]>
      add: (input: { name: string; keywords?: string[]; tags?: string[]; dateFrom?: number; dateTo?: number }) => Promise<NoteIndexTable[]>
      update: (id: string, input: { name: string; keywords?: string[]; tags?: string[]; dateFrom?: number; dateTo?: number }) => Promise<NoteIndexTable[]>
      remove: (id: string) => Promise<NoteIndexTable[]>
      build: (id: string) => Promise<IndexHit[]>
    }
    exportJson: () => Promise<NoteExportBundle>
    exportMarkdown: () => Promise<string>
    import: (bundle: NoteExportBundle) => Promise<NoteImportResult>
  }
  automations: {
    list: () => Promise<Automation[]>
    add: (input: AutomationInput) => Promise<Automation[]>
    update: (payload: Automation) => Promise<Automation[]>
    remove: (id: string) => Promise<Automation[]>
    run: (id: string) => Promise<boolean>
    stop: (id: string) => Promise<boolean>
    running: () => Promise<string[]>
    onOutput: (cb: (payload: AutomationOutputChunk) => void) => () => void
    onDone: (cb: (payload: AutomationDoneEvent) => void) => () => void
  }
  tables: {
    list: () => Promise<TableMeta[]>
    get: (id: string) => Promise<DataTable | null>
    create: (name: string) => Promise<TableMeta[]>
    update: (table: DataTable) => Promise<TableMeta[]>
    updateCell: (tableId: string, rowId: string, fieldId: string, value: FieldValue) => Promise<TableMeta[]>
    remove: (id: string) => Promise<TableMeta[]>
    import: (input: TableImportInput) => Promise<TableImportResult>
    aggregate: (req: AggregateRequest) => Promise<AggregateResult>
  }
  boards: {
    list: () => Promise<BoardMeta[]>
    create: (title: string) => Promise<BoardMeta[]>
    remove: (id: string) => Promise<BoardMeta[]>
    get: (id: string) => Promise<unknown | null>
    save: (id: string, snapshot: unknown) => Promise<BoardMeta[]>
    rename: (id: string, title: string) => Promise<BoardMeta[]>
  }
  stickies: {
    list: () => Promise<StickyNote[]>
    get: (id: string) => Promise<StickyNote | null>
    create: (input: StickyNoteInput) => Promise<StickyNote[]>
    update: (payload: StickyNote) => Promise<StickyNote[]>
    remove: (id: string) => Promise<StickyNote[]>
    stick: (id: string) => Promise<boolean>
    unstick: (id: string) => Promise<boolean>
    /** 调整悬浮窗尺寸（展开大尺寸 / 恢复折叠） */
    setSize: (id: string, width: number, height: number) => Promise<boolean>
    onStickyUpdate: (cb: (note: StickyNote) => void) => () => void
    /** 悬浮面板窗当前形态（折叠图标 / 展开内容） */
    panelMode: () => Promise<'collapsed' | 'expanded'>
    /** 切换悬浮面板窗形态 */
    panelSetMode: (mode: 'collapsed' | 'expanded') => Promise<boolean>
    /** 主进程形态变更广播（切换动画时同步 UI） */
    onPanelMode: (cb: (mode: 'collapsed' | 'expanded') => void) => () => void
  }
  ocr: {
    model: (name: string) => Promise<Uint8Array | null>
    wasm: (name: string) => Promise<Uint8Array | null>
    dict: () => Promise<string>
    tableDict: () => Promise<string>
    pickImage: () => Promise<OcrImageInfo | null>
    pickImages: () => Promise<OcrImageInfo[]>
  }
  pickBufferFile: () => Promise<{ name: string; data: Uint8Array } | null>
  pickBufferFiles: () => Promise<Array<{ name: string; data: Uint8Array; size: number }>>
  exportBuffer: (defaultName: string, data: Uint8Array) => Promise<string | null>
  exportText: (defaultName: string, content: string) => Promise<string | null>
  writing: {
    saveDraft: (title: string, content: string) => Promise<string | null>
  }
  prefs: {
    get: () => Promise<Record<string, unknown>>
    set: (prefs: Record<string, unknown>) => Promise<Record<string, unknown>>
    pickWallpaper: () => Promise<{ ok: boolean; path?: string; error?: string }>
    wallpaperUrl: (path: string) => Promise<string>
  }
  translate: {
    run: (text: string, source: string, target: string) => Promise<{ ok: boolean; value?: string; error?: string }>
    langs: () => Promise<Array<{ code: string; label: string }>>
  }
  /* ---- feed：全网热点 × 智能体 统一情报流（渲染层新入口） ---- */
  feed: {
    result: () => Promise<FeedResult>
    listSources: () => Promise<FeedSourceMeta[]>
    runSource: (id: string) => Promise<FeedItem[]>
    setSourceConfig: (id: string, c: FeedSourceConfig) => Promise<void>
    addSource: (def: CustomFeedSourceDef) => Promise<FeedSourceMeta>
    removeSource: (id: string) => Promise<void>
    history: (id: string) => Promise<FeedRunRecord[]>
    notifyGet: () => Promise<FeedNotifySettings>
    notifySet: (s: FeedNotifySettings) => Promise<FeedNotifySettings>
    notifyCheck: () => Promise<{ notified: number; total: number }>
    notifyStatus: () => Promise<HotNotifierStatus>
  }
  pickTextFile: () => Promise<{ name: string; content: string } | null>
  docs: {
    pick: () => Promise<DocOpenResult>
    openPath: (path: string) => Promise<DocOpenResult>
    save: (path: string, content: string) => Promise<{ ok: boolean; error?: string }>
    saveAs: (content: string, defaultName?: string) => Promise<{ ok: boolean; path?: string; error?: string }>
    saveAsFormat: (
      payload: { source: 'text' | 'html'; content: string; defaultName?: string; format?: string }
    ) => Promise<{ ok: boolean; path?: string; error?: string }>
    saveHtmlAs: (html: string, defaultName?: string) => Promise<{ ok: boolean; path?: string; error?: string }>
    saveDocxAs: (html: string, defaultName?: string) => Promise<{ ok: boolean; path?: string; error?: string }>
    saveOffice: (path: string, html: string) => Promise<{ ok: boolean; error?: string; note?: string }>
    print: () => Promise<{ ok: boolean; error?: string }>
    surgicalExtract: (path: string) => Promise<SurgicalExtractResult>
    surgicalApply: (path: string, edits: SurgicalEdit[]) => Promise<SurgicalApplyResult>
  }
  searchAll: (query: string) => Promise<SearchResult[]>
  aiMemory: {
    load: () => Promise<{ enabled: boolean; messages: AiChatMessage[] }>
    save: (memory: { enabled: boolean; messages: AiChatMessage[] }) => Promise<{ enabled: boolean; messages: AiChatMessage[] }>
    clear: () => Promise<{ enabled: boolean; messages: AiChatMessage[] }>
    export: () => Promise<string>
    import: (json: string) => Promise<{ enabled: boolean; messages: AiChatMessage[] }>
  }
  promptLog: {
    add: (input: { text: string; source: 'ai' | 'writing'; model?: string }) => Promise<PromptLogItem | null>
    list: () => Promise<PromptLogItem[]>
    delete: (id: string) => Promise<PromptLogItem[]>
    clear: () => Promise<PromptLogItem[]>
  }
  ai: {
    getConfig: () => Promise<AiConfig>
    saveConfig: (cfg: AiConfig) => Promise<AiConfig>
    testConnection: () => Promise<{ ok: boolean; error?: string; latencyMs?: number }>
    listProfiles: () => Promise<AiProfilesState>
    addProfile: (input: {
      name: string
      endpoint?: string
      apiKey?: string
      model?: string
      systemPrompt?: string
      secondaryModel?: string
      activate?: boolean
    }) => Promise<AiProfilesState>
    updateProfile: (
      id: string,
      patch: Partial<{
        name: string
        endpoint: string
        apiKey: string
        model: string
        systemPrompt: string
        secondaryModel: string
      }>
    ) => Promise<AiProfilesState>
    removeProfile: (id: string) => Promise<AiProfilesState>
    setActiveProfile: (id: string) => Promise<AiProfilesState>
    testProfile: (cfg: AiConfig) => Promise<{ ok: boolean; error?: string; latencyMs?: number }>
    listModels: (endpoint: string, apiKey?: string) => Promise<{ ok: boolean; models: string[]; error?: string }>
    addOllama: (opts?: { endpoint?: string; model?: string; name?: string }) => Promise<AiProfilesState>
    getRouting: () => Promise<AiRouting>
    setRouting: (r: Partial<AiRouting>) => Promise<AiRouting>
    chat: (sessionId: string, messages: AiChatMessage[], model?: string, tools?: AiTool[], sampling?: Record<string, number | string | boolean>) => Promise<boolean>
    complete: (messages: AiChatMessage[], model?: string) => Promise<{ ok: boolean; text: string; error?: string }>
    stop: (sessionId: string) => Promise<boolean>
    onChunk: (cb: (payload: AiChunkEvent) => void) => () => void
    onDone: (cb: (payload: AiDoneEvent) => void) => () => void
  }
  data: {
    info: () => Promise<DataInfo>
    backup: () => Promise<string | null>
    importData: () => Promise<string | null>
    getDataDir: () => Promise<{ current: string; custom: string | null }>
    setDataDir: (dir: string | null) => Promise<{ custom: string | null }>
    pickDir: (title?: string) => Promise<string | null>
  }
  publish: {
    listPlatforms: () => Promise<PublishPlatformInfo[]>
    login: (platformId: string) => Promise<boolean>
    checkLogin: (platformId: string) => Promise<boolean>
    checkAllLogin: () => Promise<Record<string, boolean>>
    create: (input: PublishCreateInput) => Promise<PublishJobInfo[]>
    stats: () => Promise<PublishStats>
    aiSummarize: (input: { title: string; content: string }) => Promise<AiAssistResult>
    aiRewrite: (input: { title: string; content: string; platformId: string }) => Promise<AiAssistResult>
    gzhGet: () => Promise<GzhConfigInfo>
    gzhSave: (input: { appId: string; secret: string }) => Promise<boolean>
    gzhClear: () => Promise<boolean>
    listJobs: () => Promise<PublishJobInfo[]>
    retry: (id: string) => Promise<PublishJobInfo[]>
  }
  tools: {
    scanDirectory: (dir: string, opts?: ScanOptions) => Promise<FileInfo[]>
    fileInfo: (p: string) => Promise<FileDetail | null>
    formatSize: (bytes: number) => Promise<string>
    deleteFile: (p: string, sendToTrash?: boolean) => Promise<boolean>
    getDiskInfo: (p: string) => Promise<DiskInfoDict>
    getAllDisks: () => Promise<DiskInfoDict[]>
    analyzeDirectory: (dir: string, recursive?: boolean, minSizeLarge?: number) => Promise<DirectoryAnalysis>
    findLargeFiles: (dir: string, minSize?: number, limit?: number) => Promise<LargeFile[]>
    findDuplicates: (dir: string, opts?: ScanOptions & { strategy?: string }) => Promise<DuplicateScanResult>
    compareFolders: (left: string, right: string, opts?: { hash?: boolean; diffText?: boolean; maxDiffLines?: number }) => Promise<FolderCompareResult>
    watcher: {
      add: (dir: string, name?: string) => Promise<boolean>
      remove: (dir: string) => Promise<boolean>
      start: () => Promise<boolean>
      stop: () => Promise<boolean>
      pause: () => Promise<boolean>
      resume: () => Promise<boolean>
      list: () => Promise<WatchedDirInfo[]>
      onEvent: (cb: (event: FileEvent) => void) => () => void
    }
  }
  organize: {
    getTargetBase: () => Promise<string>
    setTargetBase: (dir: string) => Promise<string>
    aiClassify: (filePaths: string[], useAi?: boolean) => Promise<Record<string, string>>
    recordCorrection: (filePath: string, category: string) => Promise<void>
    memoryList: () => Promise<ClassificationMemoryEntry[]>
    memoryClear: () => Promise<void>
    generatePlan: (filePaths: string[], opts?: OrganizeOptions) => Promise<OrganizePlanPreview>
    executePlan: (actions: OrganizeAction[]) => Promise<ExecuteResult>
  }
  convert: {
    convert: (input: ConvertInput) => Promise<ConversionResult>
    supported: () => Promise<Record<string, string[]>>
    converters: () => Promise<ConvertConverterInfo[]>
    findConverter: (src: string, tgt: string) => Promise<string | undefined>
    submit: (input: ConvertInput) => Promise<unknown>
    submitBatch: (inputs: ConvertInput[]) => Promise<unknown[]>
    getTask: (id: string) => Promise<unknown>
    listTasks: (state?: string) => Promise<unknown[]>
    cancel: (id: string) => Promise<boolean>
    progress: () => Promise<{
      total: number
      pending: number
      running: number
      completed: number
      failed: number
      progressPercent: number
    }>
    retry: (id: string, force?: boolean) => Promise<unknown>
    tempStatus: () => Promise<ConvertTempStatus>
    cleanupTemp: (expireHours?: number) => Promise<ConvertCleanupResult>
  }
  media: {
    ffmpegAvailable: () => Promise<boolean>
    pickImages: () => Promise<Array<{ path: string; name: string; size: number }>>
    pickImage: () => Promise<Array<{ path: string; name: string; size: number }>>
    pickVideos: () => Promise<Array<{ path: string; name: string; size: number }>>
    pickVideo: () => Promise<Array<{ path: string; name: string; size: number }>>
    pickAudios: () => Promise<Array<{ path: string; name: string; size: number }>>
    pickAudio: () => Promise<Array<{ path: string; name: string; size: number }>>
    pickMedia: () => Promise<Array<{ path: string; name: string; size: number }>>
    savePath: (defaultName: string, exts: string[]) => Promise<string | null>
    readFile: (filePath: string) => Promise<Uint8Array | null>
    writeFile: (filePath: string, data: Uint8Array) => Promise<boolean>
    probe: (filePath: string) => Promise<{
      ok: boolean
      error?: string
      durationSec: number
      width: number
      height: number
      fps: number
      hasAudio: boolean
      hasVideo: boolean
      sizeBytes: number
      formatName: string
      videoCodec: string
      audioCodec: string
    }>
    convert: (input: {
      sourcePath: string
      targetFormat: string
      outputPath?: string
      quality?: 'low' | 'medium' | 'high'
      kind?: 'video' | 'audio' | 'gif'
    }) => Promise<{ ok: boolean; error?: string; outputPath?: string; sizeBytes?: number; durationMs?: number }>
    extractFrame: (input: {
      sourcePath: string
      timeSec: number
      outputPath?: string
      format?: 'png' | 'jpg' | 'webp'
      width?: number
    }) => Promise<{ ok: boolean; error?: string; outputPath?: string; sizeBytes?: number }>
    videoToGif: (input: {
      sourcePath: string
      startSec: number
      endSec: number
      outputPath?: string
      fps?: number
      width?: number
    }) => Promise<{ ok: boolean; error?: string; outputPath?: string; sizeBytes?: number }>
    extractAudio: (input: {
      sourcePath: string
      outputPath?: string
      targetFormat?: string
      quality?: 'low' | 'medium' | 'high'
    }) => Promise<{ ok: boolean; error?: string; outputPath?: string; sizeBytes?: number }>
    trim: (input: {
      sourcePath: string
      startSec: number
      endSec: number
      outputPath?: string
      reencode?: boolean
    }) => Promise<{ ok: boolean; error?: string; outputPath?: string; sizeBytes?: number }>
    imageConvert: (input: {
      sourcePath: string
      targetFormat: string
      outputPath?: string
      quality?: 'low' | 'medium' | 'high'
    }) => Promise<{ ok: boolean; error?: string; outputPath?: string; sizeBytes?: number }>
  }
  hardware: {
    clipboardList: () => Promise<
      Array<{
        id: string
        kind: 'text' | 'image' | 'files'
        text?: string
        preview?: string
        filePaths?: string[]
        imageDataUrl?: string
        size: number
        createdAt: number
      }>
    >
    clipboardClear: () => Promise<boolean>
    clipboardRemove: (id: string) => Promise<boolean>
    clipboardCopy: (id: string) => Promise<boolean>
    onClipboardEvent: (cb: (entry: unknown) => void) => () => void
    system: (force?: boolean) => Promise<{ ok: boolean; error?: string; data?: Record<string, unknown>; fetchedAt: number }>
    cpuMemory: (force?: boolean) => Promise<{ ok: boolean; error?: string; data?: Record<string, unknown>; fetchedAt: number }>
    graphics: (force?: boolean) => Promise<{ ok: boolean; error?: string; data?: Record<string, unknown>; fetchedAt: number }>
    board: (force?: boolean) => Promise<{ ok: boolean; error?: string; data?: Record<string, unknown>; fetchedAt: number }>
    disk: (force?: boolean) => Promise<{ ok: boolean; error?: string; data?: Record<string, unknown>; fetchedAt: number }>
    network: (force?: boolean) => Promise<{ ok: boolean; error?: string; data?: Record<string, unknown>; fetchedAt: number }>
    power: (force?: boolean) => Promise<{ ok: boolean; error?: string; data?: Record<string, unknown>; fetchedAt: number }>
    summary: () => Promise<Record<string, { ok: boolean; error?: string; data?: Record<string, unknown>; fetchedAt: number }>>
  }
  ppt: {
    available: () => Promise<boolean>
    toPdf: (sourcePath: string) => Promise<{ ok: boolean; bytes?: Uint8Array; error?: string }>
  }
  pdf: {
    sofficeAvailable: () => Promise<boolean>
    pickPdfs: () => Promise<Array<{ path: string; name: string; size: number }>>
    pickExcel: () => Promise<Array<{ path: string; name: string; size: number }>>
    read: (filePath: string) => Promise<Uint8Array | null>
    write: (filePath: string, data: Uint8Array) => Promise<boolean>
    savePath: (defaultName: string, exts: string[]) => Promise<string | null>
    pickDir: (title?: string) => Promise<string | null>
    exists: (paths: string[]) => Promise<boolean[]>
    excelToPdf: (input: {
      sourcePath: string
      outputPath?: string
      pageOrientation?: 'auto' | 'portrait' | 'landscape'
    }) => Promise<{ ok: boolean; error?: string; outputPath?: string; sizeBytes?: number }>
  }
  searchIndex: {
    ingest: (filePath: string) => Promise<IngestResult>
    ingestDir: (dir: string, recursive?: boolean, extFilter?: string[]) => Promise<IngestResult[]>
    query: (q: string, topK?: number) => Promise<SearchHit[]>
    delete: (filePath: string) => Promise<{ deletedCount: number }>
    rebuild: () => Promise<void>
    stats: () => Promise<IndexStats>
    tokenize: (text: string) => Promise<string[]>
    ask: (req: AskRequest) => Promise<AskResult>
    qaHistory: () => Promise<QaHistoryEntry[]>
    qaHistoryClear: () => Promise<boolean>
    qaPrefsGet: () => Promise<QaPrefs>
    qaPrefsSet: (prefs: QaPrefs) => Promise<QaPrefs>
  }
  knowledgeBase: {
    build: (inputs: KnowledgeBuildInput[], opts?: KnowledgeBuildOptions) => Promise<KnowledgeBuildResult>
    listDataAssets: (kbId?: string) => Promise<DataAssetRecord[]>
    getDataAsset: (assetId: string) => Promise<DataAssetRecord | null>
    assetColumns: (assetId: string) => Promise<DataAssetColumn[]>
    addReference: (rec: ReferenceRecord) => Promise<void>
    listReferences: (scope?: ReferenceScope, refPos?: string) => Promise<ReferenceRecord[]>
    listCandidates: (q?: string) => Promise<KbCandidate[]>
    resolveInject: (picks: KbRefPick[], query?: string) => Promise<KbInjectBlock[]>
    renderInject: (blocks: KbInjectBlock[]) => Promise<string>
  }
  kbData: {
    aggregate: (req: AggregateRequest) => Promise<AggregateResult>
    getTable: (id: string) => Promise<DataTable | null>
    listTables: () => Promise<TableMeta[]>
  }
  mcp: {
    listServers: () => Promise<McpServerState[]>
    addServer: (config: McpServerConfig) => Promise<McpServerState>
    removeServer: (id: string) => Promise<boolean>
    listTools: () => Promise<McpToolInfo[]>
    callTool: (input: McpCallInput) => Promise<McpCallResult>
  }
  openExternal: (url: string) => Promise<boolean>
  runCommand: (command: string) => Promise<number | null>
  sillytavern: {
    status: () => Promise<{ ok: boolean; dataRoot: string; characterCount: number; worldCount: number; chatCount: number }>
    charsList: () => Promise<unknown[]>
    charsGet: (id: string) => Promise<unknown>
    charsSave: (id: string, card: unknown) => Promise<unknown>
    charsAvatar: (id: string, bytes: Uint8Array) => Promise<boolean>
    charsExport: (id: string) => Promise<{ bytes: Uint8Array; isPng: boolean }>
    charsImport: (bytes: Uint8Array) => Promise<unknown>
    charsDelete: (id: string) => Promise<boolean>
    charsDefaultGet: () => Promise<string | null>
    charsDefaultSet: (id: string | null) => Promise<void>
    worldsList: () => Promise<unknown[]>
    worldsGet: (id: string) => Promise<unknown>
    worldsSave: (id: string, world: unknown) => Promise<void>
    worldsDelete: (id: string) => Promise<boolean>
    worldsDefaultGet: () => Promise<string | null>
    worldsDefaultSet: (id: string | null) => Promise<void>
    chatsList: (charId: string) => Promise<unknown[]>
    chatsGet: (charId: string, chatId: string) => Promise<unknown>
    chatsSave: (charId: string, chatId: string, msgs: unknown[]) => Promise<void>
    chatsDelete: (charId: string, chatId: string) => Promise<boolean>
    chatsNewId: () => Promise<string>
    chatsActiveGet: () => Promise<{ charId: string; chatId: string } | null>
    chatsActiveSet: (charId: string, chatId: string) => Promise<void>
    presetsList: () => Promise<unknown[]>
    presetsGet: (id: string) => Promise<unknown>
    presetsSave: (p: unknown) => Promise<void>
    presetsDelete: (id: string) => Promise<boolean>
    presetsDefaultGet: () => Promise<string | null>
    presetsDefaultSet: (id: string | null) => Promise<void>
    noteGet: () => Promise<unknown>
    noteSet: (note: unknown) => Promise<void>
    regexGet: () => Promise<unknown[]>
    regexSet: (list: unknown[]) => Promise<void>
    quickGet: () => Promise<unknown[]>
    quickSet: (list: unknown[]) => Promise<void>
    chat: (
      sessionId: string,
      payload: {
        card: unknown
        world: unknown
        history: unknown[]
        userText: string
        params: Record<string, unknown>
        authorNote: unknown
        regex: unknown[]
        model?: string
      }
    ) => Promise<boolean>
    // 编译角色上下文为 system 文本（写作融合模式注入 ai.chat）
    buildContext: (opts: { card: unknown; world: unknown; conversationText: string; authorNote: unknown }) => Promise<string>
    stop: (sessionId: string) => Promise<boolean>
  }
  usage: {
    pageVisit: (page: string) => Promise<void>
    dashboard: () => Promise<DashboardOverview>
    reset: () => Promise<UsageStatsState>
  }
  hub: {
    snapshot: () => Promise<AgentHubSnapshot>
    runtimes: () => Promise<Array<{ id: string; label: string; available: boolean; path?: string }>>
    renameWorkspace: (name: string) => Promise<WorkspaceBrief>
    listAgents: () => Promise<AgentRoleBrief[]>
    upsertAgent: (input: Partial<AgentRoleBrief> & { name: string }) => Promise<AgentRoleBrief>
    removeAgent: (id: string) => Promise<void>
    bindSkills: (agentId: string, skillIds: string[]) => Promise<AgentRoleBrief | null>
    listSquads: () => Promise<SquadBrief[]>
    upsertSquad: (input: Partial<SquadBrief> & { name: string }) => Promise<SquadBrief>
    listIssues: () => Promise<IssueBrief[]>
    createIssue: (input: {
      title: string
      body?: string
      assigneeId?: string
      squadId?: string
      repoPath?: string
      labels?: string[]
    }) => Promise<IssueBrief>
    updateIssue: (id: string, patch: Partial<IssueBrief>) => Promise<IssueBrief | null>
    commentIssue: (issueId: string, author: string, kind: 'human' | 'agent', body: string) => Promise<IssueComment | null>
    removeIssue: (id: string) => Promise<void>
    runIssue: (id: string, force?: boolean) => Promise<{ ok: boolean; runId?: string; error?: string }>
    reviewIssue: (id: string, approve: boolean, note?: string) => Promise<void>
    listRuns: (issueId?: string) => Promise<RunBrief[]>
    inboxRead: (id: string, read?: boolean) => Promise<void>
    inboxClear: () => Promise<void>
    listAutopilots: () => Promise<AutopilotBrief[]>
    upsertAutopilot: (input: Partial<AutopilotBrief> & { name: string }) => Promise<AutopilotBrief>
    removeAutopilot: (id: string) => Promise<void>
    generatePlan: (opts: { title: string; detail?: string; issueId?: string; goalId?: string }) => Promise<{ ok: boolean; planId?: string; error?: string }>
    executePlan: (planId: string) => Promise<{ ok: boolean; error?: string }>
    upsertPlan: (input: Partial<PlanBrief> & { title: string }) => Promise<PlanBrief>
    upsertGoal: (input: Partial<GoalBrief> & { title: string }) => Promise<GoalBrief>
    advanceGoal: (goalId: string) => Promise<{ ok: boolean; error?: string }>
    setDuty: (slots: DutySlot[]) => Promise<DutySlot[]>
    upsertApp: (input: Partial<EvoApp> & { name: string }) => Promise<EvoApp>
    runApp: (appId: string) => Promise<{ ok: boolean; error?: string; output?: string }>
    upsertWorkspaceDir: (input: { name: string; path: string }) => Promise<WorkspaceDir>
    addExperience: (input: Omit<ExperienceCard, 'id' | 'createdAt'>) => Promise<ExperienceCard>
    addMemory: (input: Omit<AgentMemory, 'id' | 'createdAt'>) => Promise<AgentMemory>
    upsertImChannel: (input: Partial<ImChannel> & { name: string; webhookUrl: string }) => Promise<ImChannel>
    sendIm: (channelId: string, title: string, body: string) => Promise<{ ok: boolean; error?: string }>
    testIm: (channel: ImChannel) => Promise<{ ok: boolean; error?: string }>
    marketCatalog: (remoteUrl?: string) => Promise<ResourceCatalog>
    marketInstall: (id: string) => Promise<{ ok: boolean; error?: string; count?: number }>
    codeIndexBuild: (rootDir: string) => Promise<CodeSymbol[]>
    codeIndexQuery: (q: string) => Promise<CodeSymbol[]>
    sandboxRun: (cwd: string, command: string, timeoutMs?: number) => Promise<SandboxRun>
  }
}

declare global {
  interface Window {
    api: Api
  }
}
