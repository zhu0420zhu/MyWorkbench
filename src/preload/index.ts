import { contextBridge, ipcRenderer } from 'electron'
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
  AiChatMessage,
  AgentHubSnapshot,
  DashboardOverview,
  UsageStatsState,
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
  CustomFeedSourceDef,
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

/** 窗口缩放方向：四边 + 四角（与 main/windowManager 的 ResizeEdge 保持字面量一致） */
export type WindowResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
/** 关闭行为：ask=每次询问 / minimize=最小化到后台 / quit=直接退出 */
export type WindowCloseBehavior = 'ask' | 'minimize' | 'quit'

const api = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? ''
  },
  windowApi: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('window:toggle-maximize'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
    onMaximizedChange: (cb: (maximized: boolean) => void): (() => void) => {
      const handler = (_e: unknown, m: boolean) => cb(m)
      ipcRenderer.on('window:maximized', handler)
      return () => ipcRenderer.removeListener('window:maximized', handler)
    },
    relaunch: (): Promise<boolean> => ipcRenderer.invoke('app:relaunch'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
    bounds: (): Promise<{ x: number; y: number; width: number; height: number } | null> =>
      ipcRenderer.invoke('window:bounds'),
    // 无边框窗口的八向缩放：begin 记住起点，move 高频发送（发后不管），end 结束
    resizeBegin: (edge: WindowResizeEdge): void => ipcRenderer.send('window:resize-begin', edge),
    resizeMove: (): void => ipcRenderer.send('window:resize-move'),
    resizeEnd: (): void => ipcRenderer.send('window:resize-end'),
    // 关闭确认：主进程推送 window:confirm-close，渲染层答复后由主进程执行
    onConfirmClose: (cb: () => void): (() => void) => {
      const handler = (): void => cb()
      ipcRenderer.on('window:confirm-close', handler)
      return () => ipcRenderer.removeListener('window:confirm-close', handler)
    },
    replyClose: (action: 'minimize' | 'quit' | 'cancel', remember: boolean): void =>
      ipcRenderer.send('window:close-reply', { action, remember }),
    getCloseBehavior: (): Promise<'ask' | 'minimize' | 'quit'> =>
      ipcRenderer.invoke('window:get-close-behavior'),
    setCloseBehavior: (b: 'ask' | 'minimize' | 'quit'): Promise<'ask' | 'minimize' | 'quit'> =>
      ipcRenderer.invoke('window:set-close-behavior', b),
    // 页面独立窗口：把写作 / 笔记等页面分离成独立无边框窗口（各自独立缩放与记忆）
    openPageWindow: (page: string, id?: string): Promise<boolean> =>
      ipcRenderer.invoke('window:open-page', page, id),
    closePageWindow: (page: string, id?: string): Promise<boolean> =>
      ipcRenderer.invoke('window:close-page', page, id),
    listPageWindows: (): Promise<string[]> => ipcRenderer.invoke('window:page-windows'),
    hasPageWindow: (page: string, id?: string): Promise<boolean> =>
      ipcRenderer.invoke('window:has-page', page, id),
    onPageWindowsChanged: (cb: (keys: string[]) => void): (() => void) => {
      const handler = (_e: unknown, keys: string[]): void => cb(keys)
      ipcRenderer.on('page-windows:changed', handler)
      return () => ipcRenderer.removeListener('page-windows:changed', handler)
    },
    // 独立窗口内的跨页跳转：交给主窗口处理，避免子窗口内容漂移
    navigateInMain: (page: string, id?: string): Promise<boolean> =>
      ipcRenderer.invoke('window:navigate-main', page, id),
    onMainNavigate: (cb: (t: { page: string; id?: string }) => void): (() => void) => {
      const handler = (_e: unknown, t: { page: string; id?: string }): void => cb(t)
      ipcRenderer.on('main:navigate', handler)
      return () => ipcRenderer.removeListener('main:navigate', handler)
    }
  },
  shortcuts: {
    list: (): Promise<Shortcut[]> => ipcRenderer.invoke('shortcuts:list'),
    add: (input: ShortcutInput): Promise<Shortcut[]> => ipcRenderer.invoke('shortcuts:add', input),
    update: (payload: Shortcut): Promise<Shortcut[]> =>
      ipcRenderer.invoke('shortcuts:update', payload),
    remove: (id: string): Promise<Shortcut[]> => ipcRenderer.invoke('shortcuts:remove', id)
  },
  notes: {
    list: (): Promise<NoteMeta[]> => ipcRenderer.invoke('notes:list'),
    get: (id: string): Promise<Note | null> => ipcRenderer.invoke('notes:get', id),
    create: (title: string): Promise<NoteMeta[]> => ipcRenderer.invoke('notes:create', title),
    update: (id: string, content: string): Promise<NoteMeta[]> =>
      ipcRenderer.invoke('notes:update', id, content),
    remove: (id: string): Promise<NoteMeta[]> => ipcRenderer.invoke('notes:remove', id),
    updateMeta: (
      id: string,
      meta: { tags?: string[]; category?: string; categorizedBy?: 'auto' | 'manual' }
    ): Promise<NoteMeta[]> => ipcRenderer.invoke('notes:update-meta', id, meta),
    createBatch: (inputs: Array<{ title: string; content: string }>): Promise<NoteMeta[]> =>
      ipcRenderer.invoke('notes:create-batch', inputs),
    repairEncoding: (id: string): Promise<Note | null> => ipcRenderer.invoke('notes:repair-encoding', id),
    repairAllEncodings: (): Promise<{ scanned: number; repaired: number }> =>
      ipcRenderer.invoke('notes:repair-all-encodings')
  },
  // 版本快照与回滚：每次保存留点，可回看 / 对比 / 恢复
  snapshots: {
    list: (kind: SnapshotKind, id: string): Promise<SnapshotMeta[]> =>
      ipcRenderer.invoke('snapshots:list', kind, id),
    create: (kind: SnapshotKind, id: string, content: string, label?: string): Promise<SnapshotMeta | null> =>
      ipcRenderer.invoke('snapshots:create', kind, id, content, label),
    get: (kind: SnapshotKind, id: string, snapId: string): Promise<string | null> =>
      ipcRenderer.invoke('snapshots:get', kind, id, snapId),
    restore: (
      kind: SnapshotKind,
      id: string,
      snapId: string,
      currentContent: string
    ): Promise<string | null> =>
      ipcRenderer.invoke('snapshots:restore', kind, id, snapId, currentContent),
    remove: (kind: SnapshotKind, id: string, snapId: string): Promise<boolean> =>
      ipcRenderer.invoke('snapshots:remove', kind, id, snapId)
  },
  // 导出成书：笔记 / 写作草稿按序拼装 → EPUB / DOCX / PDF / HTML / MD / TXT
  book: {
    sources: (): Promise<BookSourceItem[]> => ipcRenderer.invoke('book:sources'),
    pandocAvailable: (): Promise<boolean> => ipcRenderer.invoke('book:pandoc-available'),
    export: (input: BookExportInput): Promise<BookExportResult> =>
      ipcRenderer.invoke('book:export', input),
    pickCover: (): Promise<BookCoverResult> => ipcRenderer.invoke('book:pick-cover'),
    generateCover: (opts: BookCoverOptions): Promise<BookCoverResult> =>
      ipcRenderer.invoke('book:generate-cover', opts)
  },
  // 长篇作品：作品 / 分卷 / 章节
  novel: {
    listProjects: (): Promise<NovelProjectMeta[]> => ipcRenderer.invoke('novel:list-projects'),
    createProject: (input: {
      title: string
      genre?: string
      synopsis?: string
      targetWords?: number
      workflowId?: string
    }): Promise<NovelProject> => ipcRenderer.invoke('novel:create-project', input),
    getProject: (projectId: string): Promise<NovelProject | null> =>
      ipcRenderer.invoke('novel:get-project', projectId),
    updateProject: (
      projectId: string,
      patch: { title?: string; genre?: string; synopsis?: string; targetWords?: number }
    ): Promise<NovelProjectMeta | null> =>
      ipcRenderer.invoke('novel:update-project', projectId, patch),
    removeProject: (projectId: string): Promise<boolean> =>
      ipcRenderer.invoke('novel:remove-project', projectId),

    /* ---- 写作工作流（新建自动挂载） ---- */
    listWorkflows: (): Promise<NovelWorkflow[]> => ipcRenderer.invoke('novel:list-workflows'),
    getWorkflow: (projectId: string): Promise<ProjectWorkflowState | null> =>
      ipcRenderer.invoke('novel:get-workflow', projectId),
    workflowStepDone: (projectId: string, stepId: string, done: boolean): Promise<ProjectWorkflowState | null> =>
      ipcRenderer.invoke('novel:workflow-step-done', projectId, stepId, done),
    switchWorkflow: (projectId: string, workflowId: string): Promise<ProjectWorkflowState | null> =>
      ipcRenderer.invoke('novel:switch-workflow', projectId, workflowId),
    seedWorkflowSkills: (): Promise<number> => ipcRenderer.invoke('novel:seed-workflow-skills'),

    createVolume: (projectId: string, title: string, summary?: string): Promise<Volume[]> =>
      ipcRenderer.invoke('novel:create-volume', projectId, title, summary),
    updateVolume: (
      projectId: string,
      volumeId: string,
      patch: { title?: string; summary?: string }
    ): Promise<Volume[]> => ipcRenderer.invoke('novel:update-volume', projectId, volumeId, patch),
    removeVolume: (
      projectId: string,
      volumeId: string,
      mode: 'delete-chapters' | 'move-to-first'
    ): Promise<Volume[]> => ipcRenderer.invoke('novel:remove-volume', projectId, volumeId, mode),

    createChapter: (input: {
      projectId: string
      volumeId: string
      title?: string
      summary?: string
      wordGoal?: number
    }): Promise<ChapterMeta | null> => ipcRenderer.invoke('novel:create-chapter', input),
    getChapter: (projectId: string, chapterId: string): Promise<Chapter | null> =>
      ipcRenderer.invoke('novel:get-chapter', projectId, chapterId),
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
    ): Promise<ChapterMeta | null> =>
      ipcRenderer.invoke('novel:update-chapter', projectId, chapterId, patch),
    removeChapter: (projectId: string, chapterId: string): Promise<ChapterMeta[]> =>
      ipcRenderer.invoke('novel:remove-chapter', projectId, chapterId),
    /** 卷内或跨卷移动；toIndex 为目标卷内的插入位置 */
    reorderChapter: (
      projectId: string,
      chapterId: string,
      toVolumeId: string,
      toIndex: number
    ): Promise<ChapterMeta[]> =>
      ipcRenderer.invoke('novel:reorder-chapter', projectId, chapterId, toVolumeId, toIndex),

    collectChapters: (
      projectId: string
    ): Promise<Array<{ title: string; content: string; volumeTitle: string }>> =>
      ipcRenderer.invoke('novel:collect-chapters', projectId),

    /* ---- 设定库：实体卡 / 关系 / 动态状态 ---- */
    listEntities: (projectId: string): Promise<EntityMeta[]> =>
      ipcRenderer.invoke('novel:list-entities', projectId),
    getEntity: (projectId: string, entityId: string): Promise<Entity | null> =>
      ipcRenderer.invoke('novel:get-entity', projectId, entityId),
    createEntity: (input: {
      projectId: string
      kind: EntityKind
      name: string
      aliases?: string[]
      tagline?: string
      content?: string
      pinned?: boolean
      firstChapterId?: string
    }): Promise<EntityMeta | null> => ipcRenderer.invoke('novel:create-entity', input),
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
    ): Promise<EntityMeta | null> =>
      ipcRenderer.invoke('novel:update-entity', projectId, entityId, patch),
    removeEntity: (projectId: string, entityId: string): Promise<EntityMeta[]> =>
      ipcRenderer.invoke('novel:remove-entity', projectId, entityId),
    reorderEntities: (projectId: string, orderedIds: string[]): Promise<EntityMeta[]> =>
      ipcRenderer.invoke('novel:reorder-entities', projectId, orderedIds),

    listRelations: (projectId: string): Promise<EntityRelation[]> =>
      ipcRenderer.invoke('novel:list-relations', projectId),
    /** 同 from→to+label 视为同一条，重复调用为更新而非新增 */
    upsertRelation: (input: {
      projectId: string
      id?: string
      fromId: string
      toId: string
      label: string
      bidirectional?: boolean
    }): Promise<EntityRelation | null> => ipcRenderer.invoke('novel:upsert-relation', input),
    removeRelation: (projectId: string, relationId: string): Promise<EntityRelation[]> =>
      ipcRenderer.invoke('novel:remove-relation', projectId, relationId),

    listStates: (projectId: string, entityId?: string): Promise<EntityState[]> =>
      ipcRenderer.invoke('novel:list-states', projectId, entityId),
    setState: (input: {
      projectId: string
      entityId: string
      chapterId: string
      text: string
      id?: string
    }): Promise<EntityState | null> => ipcRenderer.invoke('novel:set-state', input),
    removeState: (projectId: string, stateId: string): Promise<EntityState[]> =>
      ipcRenderer.invoke('novel:remove-state', projectId, stateId),

    /** 正文实体识别（别名感知）：返回按出现次数降序的出场实体 */
    detectMentions: (projectId: string, text: string): Promise<EntityMention[]> =>
      ipcRenderer.invoke('novel:detect-mentions', projectId, text),

    /* ---- 上下文编排器 ---- */
    buildContext: (
      projectId: string,
      chapterId: string,
      opts?: BuildContextOptions
    ): Promise<ContextBundle | null> =>
      ipcRenderer.invoke('novel:build-context', projectId, chapterId, opts),
    listPinnedNotes: (projectId: string): Promise<string[]> =>
      ipcRenderer.invoke('novel:list-pinned-notes', projectId),
    addPinnedNote: (projectId: string, text: string): Promise<string[]> =>
      ipcRenderer.invoke('novel:add-pinned-note', projectId, text),
    removePinnedNote: (projectId: string, index: number): Promise<string[]> =>
      ipcRenderer.invoke('novel:remove-pinned-note', projectId, index),
    /** 全量重建检索索引：本功能上线前就存在的旧章节需要跑一次才能被召回 */
    reindexProject: (projectId: string): Promise<{ indexed: number; failed: number }> =>
      ipcRenderer.invoke('novel:reindex-project', projectId)
    ,
    /** 重算 token 并拼成提示词；面板手工改过块之后调用 */
    renderContext: (
      blocks: ContextBlock[]
    ): Promise<{ blocks: ContextBlock[]; totalTokens: number; text: string }> =>
      ipcRenderer.invoke('novel:render-context', blocks)
    ,
    /** 编辑器内 AI 动作：选区改写 / 续写 */
    aiEdit: (input: AiEditInput): Promise<AiEditResult> =>
      ipcRenderer.invoke('novel:ai-edit', input)
    ,
    /** 一致性审计：跑规则，返回问题列表 */
    auditProject: (projectId: string): Promise<ConsistencyReport> =>
      ipcRenderer.invoke('novel:audit-project', projectId)
    ,
    /** 应用一条自动修正（当前仅别名归一化） */
    applyConsistencyFix: (
      projectId: string,
      issue: ConsistencyIssue
    ): Promise<boolean> => ipcRenderer.invoke('novel:apply-fix', projectId, issue)
    ,
    /* ---- 伏笔 / 线索追踪（P2-2） ---- */
    listForeshadows: (projectId: string): Promise<Foreshadow[]> =>
      ipcRenderer.invoke('novel:list-foreshadows', projectId),
    createForeshadow: (input: {
      projectId: string
      content: string
      plantedChapterId: string
      plantedChapterTitle: string
      payoffChapterId?: string
      payoffChapterTitle?: string
      status?: ForeshadowStatus
      note?: string
    }): Promise<Foreshadow | null> => ipcRenderer.invoke('novel:create-foreshadow', input),
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
    ): Promise<Foreshadow | null> =>
      ipcRenderer.invoke('novel:update-foreshadow', projectId, id, patch),
    setForeshadowStatus: (
      projectId: string,
      id: string,
      status: ForeshadowStatus,
      payoffChapterId?: string,
      payoffChapterTitle?: string
    ): Promise<Foreshadow | null> =>
      ipcRenderer.invoke('novel:set-foreshadow-status', projectId, id, status, payoffChapterId, payoffChapterTitle),
    removeForeshadow: (projectId: string, id: string): Promise<Foreshadow[]> =>
      ipcRenderer.invoke('novel:remove-foreshadow', projectId, id),
    /** 当前章写作时提醒：已埋下超过 threshold 章仍未回收的伏笔 */
    listOverdue: (
      projectId: string,
      currentChapterId: string,
      threshold: number
    ): Promise<Foreshadow[]> =>
      ipcRenderer.invoke('novel:list-overdue', projectId, currentChapterId, threshold)
    ,
    /* ---- 灵感工作台：灵感池（按项目，P2-3） ---- */
    listInspirations: (projectId: string): Promise<InspirationNote[]> =>
      ipcRenderer.invoke('novel:list-inspirations', projectId),
    createInspiration: (input: {
      projectId: string
      kind: InspirationKind
      content: string
      note?: string
    }): Promise<InspirationNote | null> => ipcRenderer.invoke('novel:create-inspiration', input),
    updateInspiration: (
      projectId: string,
      id: string,
      patch: { kind?: InspirationKind; content?: string; note?: string }
    ): Promise<InspirationNote | null> =>
      ipcRenderer.invoke('novel:update-inspiration', projectId, id, patch),
    removeInspiration: (projectId: string, id: string): Promise<InspirationNote[]> =>
      ipcRenderer.invoke('novel:remove-inspiration', projectId, id)
    ,
    /* ---- 灵感工作台：写作 Skill 包（全局，P2-3） ---- */
    listSkills: (): Promise<WritingSkill[]> => ipcRenderer.invoke('novel:list-skills'),
    createSkill: (input: {
      name: string
      description?: string
      template: string
    }): Promise<WritingSkill | null> => ipcRenderer.invoke('novel:create-skill', input),
    updateSkill: (
      id: string,
      patch: { name?: string; description?: string; template?: string }
    ): Promise<WritingSkill | null> => ipcRenderer.invoke('novel:update-skill', id, patch),
    removeSkill: (id: string): Promise<WritingSkill[]> => ipcRenderer.invoke('novel:remove-skill', id),
    runSkill: (input: {
      projectId: string
      skillId: string
      chapterId?: string
      userInput?: string
    }): Promise<SkillRunResult> => ipcRenderer.invoke('novel:run-skill', input),
    exportSkills: (): Promise<SkillExportBundle> => ipcRenderer.invoke('novel:export-skills'),
    importSkills: (bundle: SkillExportBundle): Promise<SkillImportResult> =>
      ipcRenderer.invoke('novel:import-skills', bundle)
  },
  notesFeature: {
    tags: {
      list: (): Promise<NoteTag[]> => ipcRenderer.invoke('notes-feature:tags-list'),
      add: (name: string): Promise<NoteTag[]> => ipcRenderer.invoke('notes-feature:tags-add', name),
      rename: (oldName: string, newName: string): Promise<NoteTag[]> =>
        ipcRenderer.invoke('notes-feature:tags-rename', oldName, newName),
      remove: (name: string): Promise<NoteTag[]> => ipcRenderer.invoke('notes-feature:tags-remove', name)
    },
    rules: {
      list: (): Promise<CategoryRule[]> => ipcRenderer.invoke('notes-feature:rules-list'),
      add: (input: { name: string; keywords: string[]; category: string }): Promise<CategoryRule[]> =>
        ipcRenderer.invoke('notes-feature:rules-add', input),
      update: (id: string, input: { name: string; keywords: string[]; category: string }): Promise<CategoryRule[]> =>
        ipcRenderer.invoke('notes-feature:rules-update', id, input),
      remove: (id: string): Promise<CategoryRule[]> => ipcRenderer.invoke('notes-feature:rules-remove', id),
      apply: (): Promise<{ updated: number; classified: number }> =>
        ipcRenderer.invoke('notes-feature:rules-apply')
    },
    indexes: {
      list: (): Promise<NoteIndexTable[]> => ipcRenderer.invoke('notes-feature:indexes-list'),
      add: (input: { name: string; keywords?: string[]; tags?: string[]; dateFrom?: number; dateTo?: number }): Promise<NoteIndexTable[]> =>
        ipcRenderer.invoke('notes-feature:indexes-add', input),
      update: (
        id: string,
        input: { name: string; keywords?: string[]; tags?: string[]; dateFrom?: number; dateTo?: number }
      ): Promise<NoteIndexTable[]> => ipcRenderer.invoke('notes-feature:indexes-update', id, input),
      remove: (id: string): Promise<NoteIndexTable[]> => ipcRenderer.invoke('notes-feature:indexes-remove', id),
      build: (id: string): Promise<IndexHit[]> => ipcRenderer.invoke('notes-feature:indexes-build', id)
    },
    exportJson: (): Promise<NoteExportBundle> => ipcRenderer.invoke('notes-feature:export-json'),
    exportMarkdown: (): Promise<string> => ipcRenderer.invoke('notes-feature:export-markdown'),
    import: (bundle: NoteExportBundle): Promise<NoteImportResult> =>
      ipcRenderer.invoke('notes-feature:import', bundle)
  },
  automations: {
    list: (): Promise<Automation[]> => ipcRenderer.invoke('automations:list'),
    add: (input: AutomationInput): Promise<Automation[]> =>
      ipcRenderer.invoke('automations:add', input),
    update: (payload: Automation): Promise<Automation[]> =>
      ipcRenderer.invoke('automations:update', payload),
    remove: (id: string): Promise<Automation[]> => ipcRenderer.invoke('automations:remove', id),
    run: (id: string): Promise<boolean> => ipcRenderer.invoke('automations:run', id),
    stop: (id: string): Promise<boolean> => ipcRenderer.invoke('automations:stop', id),
    running: (): Promise<string[]> => ipcRenderer.invoke('automations:running'),
    onOutput: (cb: (payload: AutomationOutputChunk) => void): (() => void) => {
      const handler = (_e: unknown, payload: AutomationOutputChunk) => cb(payload)
      ipcRenderer.on('automations:output', handler)
      return () => ipcRenderer.removeListener('automations:output', handler)
    },
    onDone: (cb: (payload: AutomationDoneEvent) => void): (() => void) => {
      const handler = (_e: unknown, payload: AutomationDoneEvent) => cb(payload)
      ipcRenderer.on('automations:done', handler)
      return () => ipcRenderer.removeListener('automations:done', handler)
    }
  },
  tables: {
    list: (): Promise<TableMeta[]> => ipcRenderer.invoke('tables:list'),
    get: (id: string): Promise<DataTable | null> => ipcRenderer.invoke('tables:get', id),
    create: (name: string): Promise<TableMeta[]> => ipcRenderer.invoke('tables:create', name),
    update: (table: DataTable): Promise<TableMeta[]> => ipcRenderer.invoke('tables:update', table),
    updateCell: (tableId: string, rowId: string, fieldId: string, value: FieldValue): Promise<TableMeta[]> =>
      ipcRenderer.invoke('tables:updateCell', tableId, rowId, fieldId, value),
    remove: (id: string): Promise<TableMeta[]> => ipcRenderer.invoke('tables:remove', id),
    import: (input: TableImportInput): Promise<TableImportResult> => ipcRenderer.invoke('tables:import', input),
    aggregate: (req: AggregateRequest): Promise<AggregateResult> => ipcRenderer.invoke('tables:aggregate', req)
  },
  boards: {
    list: (): Promise<BoardMeta[]> => ipcRenderer.invoke('boards:list'),
    create: (title: string): Promise<BoardMeta[]> => ipcRenderer.invoke('boards:create', title),
    remove: (id: string): Promise<BoardMeta[]> => ipcRenderer.invoke('boards:remove', id),
    get: (id: string): Promise<unknown | null> => ipcRenderer.invoke('boards:get', id),
    save: (id: string, snapshot: unknown): Promise<BoardMeta[]> =>
      ipcRenderer.invoke('boards:save', id, snapshot),
    rename: (id: string, title: string): Promise<BoardMeta[]> =>
      ipcRenderer.invoke('boards:rename', id, title)
  },
  stickies: {
    list: (): Promise<StickyNote[]> => ipcRenderer.invoke('stickies:list'),
    get: (id: string): Promise<StickyNote | null> => ipcRenderer.invoke('stickies:get', id),
    create: (input: StickyNoteInput): Promise<StickyNote[]> =>
      ipcRenderer.invoke('stickies:create', input),
    update: (payload: StickyNote): Promise<StickyNote[]> =>
      ipcRenderer.invoke('stickies:update', payload),
    remove: (id: string): Promise<StickyNote[]> => ipcRenderer.invoke('stickies:remove', id),
    stick: (id: string): Promise<boolean> => ipcRenderer.invoke('stickies:stick', id),
    unstick: (id: string): Promise<boolean> => ipcRenderer.invoke('stickies:unstick', id),
    /** 调整悬浮窗尺寸（展开大尺寸 / 恢复折叠） */
    setSize: (id: string, width: number, height: number): Promise<boolean> =>
      ipcRenderer.invoke('stickies:set-size', id, width, height),
    onStickyUpdate: (cb: (note: StickyNote) => void): (() => void) => {
      const handler = (_e: unknown, note: StickyNote) => cb(note)
      ipcRenderer.on('sticky:update', handler)
      return () => ipcRenderer.removeListener('sticky:update', handler)
    },
    /** 悬浮面板窗当前形态（折叠图标 / 展开内容） */
    panelMode: (): Promise<'collapsed' | 'expanded'> => ipcRenderer.invoke('stickies:panel-mode'),
    /** 切换悬浮面板窗形态 */
    panelSetMode: (mode: 'collapsed' | 'expanded'): Promise<boolean> =>
      ipcRenderer.invoke('stickies:panel-set-mode', mode),
    /** 主进程形态变更广播（切换动画时同步 UI） */
    onPanelMode: (cb: (mode: 'collapsed' | 'expanded') => void): (() => void) => {
      const handler = (_e: unknown, m: 'collapsed' | 'expanded') => cb(m)
      ipcRenderer.on('stickies:panel-mode', handler)
      return () => ipcRenderer.removeListener('stickies:panel-mode', handler)
    }
  },
  ocr: {
    model: (name: string): Promise<Uint8Array | null> => ipcRenderer.invoke('ocr:model', name),
    wasm: (name: string): Promise<Uint8Array | null> => ipcRenderer.invoke('ocr:wasm', name),
    dict: (): Promise<string> => ipcRenderer.invoke('ocr:dict'),
    tableDict: (): Promise<string> => ipcRenderer.invoke('ocr:table-dict'),
    pickImage: (): Promise<OcrImageInfo | null> => ipcRenderer.invoke('ocr:pick-image'),
    pickImages: (): Promise<OcrImageInfo[]> => ipcRenderer.invoke('ocr:pick-images')
  },
  pickBufferFile: (): Promise<{ name: string; data: Uint8Array } | null> =>
    ipcRenderer.invoke('file:pick-buffer'),
  pickBufferFiles: (): Promise<Array<{ name: string; data: Uint8Array; size: number }>> =>
    ipcRenderer.invoke('file:pick-buffers'),
  exportBuffer: (defaultName: string, data: Uint8Array): Promise<string | null> =>
    ipcRenderer.invoke('export:save-buffer', { defaultName, data }),
  exportText: (defaultName: string, content: string): Promise<string | null> =>
    ipcRenderer.invoke('export:save-text', { defaultName, content }),
  writing: {
    saveDraft: (title: string, content: string): Promise<string | null> =>
      ipcRenderer.invoke('writing:save-draft', { title, content })
  },
  prefs: {
    get: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('prefs:get'),
    set: (prefs: Record<string, unknown>): Promise<Record<string, unknown>> => ipcRenderer.invoke('prefs:set', prefs),
    pickWallpaper: (): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('prefs:pick-wallpaper'),
    wallpaperUrl: (path: string): Promise<string> => ipcRenderer.invoke('prefs:wallpaper-url', path)
  },
  translate: {
    run: (text: string, source: string, target: string): Promise<{ ok: boolean; value?: string; error?: string }> =>
      ipcRenderer.invoke('translate:run', text, source, target),
    langs: (): Promise<Array<{ code: string; label: string }>> => ipcRenderer.invoke('translate:langs')
  },
  /* ---- feed：全网热点 × 智能体 统一情报流（渲染层新入口） ---- */
  feed: {
    result: (): Promise<FeedResult> => ipcRenderer.invoke('feed:result'),
    listSources: (): Promise<FeedSourceMeta[]> => ipcRenderer.invoke('feed:list-sources'),
    runSource: (id: string): Promise<FeedItem[]> => ipcRenderer.invoke('feed:run-source', id),
    setSourceConfig: (id: string, c: FeedSourceConfig): Promise<void> =>
      ipcRenderer.invoke('feed:set-source-config', id, c),
    addSource: (def: CustomFeedSourceDef): Promise<FeedSourceMeta> =>
      ipcRenderer.invoke('feed:add-source', def),
    removeSource: (id: string): Promise<void> => ipcRenderer.invoke('feed:remove-source', id),
    history: (id: string): Promise<FeedRunRecord[]> => ipcRenderer.invoke('feed:history', id),
    notifyGet: (): Promise<FeedNotifySettings> => ipcRenderer.invoke('feed:notify-get'),
    notifySet: (s: FeedNotifySettings): Promise<FeedNotifySettings> =>
      ipcRenderer.invoke('feed:notify-set', s),
    notifyCheck: (): Promise<{ notified: number; total: number }> =>
      ipcRenderer.invoke('feed:notify-check'),
    notifyStatus: (): Promise<HotNotifierStatus> => ipcRenderer.invoke('feed:notify-status')
  },
  pickTextFile: (): Promise<{ name: string; content: string } | null> =>
    ipcRenderer.invoke('file:pick-text'),
  docs: {
    pick: (): Promise<DocOpenResult> => ipcRenderer.invoke('docs:pick'),
    openPath: (path: string): Promise<DocOpenResult> => ipcRenderer.invoke('docs:open-path', path),
    save: (path: string, content: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('docs:save', path, content),
    saveAs: (content: string, defaultName?: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('docs:save-as', content, defaultName),
    saveAsFormat: (
      payload: { source: 'text' | 'html'; content: string; defaultName?: string; format?: string }
    ): Promise<{ ok: boolean; path?: string; error?: string }> => ipcRenderer.invoke('docs:save-as-format', payload),
    saveHtmlAs: (html: string, defaultName?: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('docs:save-html-as', html, defaultName),
    saveDocxAs: (html: string, defaultName?: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('docs:save-docx-as', html, defaultName),
    saveOffice: (path: string, html: string): Promise<{ ok: boolean; error?: string; note?: string }> =>
      ipcRenderer.invoke('docs:save-office', path, html),
    print: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('docs:print'),
    surgicalExtract: (path: string): Promise<SurgicalExtractResult> =>
      ipcRenderer.invoke('docs:surgical-extract', path),
    surgicalApply: (path: string, edits: SurgicalEdit[]): Promise<SurgicalApplyResult> =>
      ipcRenderer.invoke('docs:surgical-apply', path, edits)
  },
  ppt: {
    available: (): Promise<boolean> => ipcRenderer.invoke('ppt:available'),
    toPdf: (sourcePath: string): Promise<{ ok: boolean; bytes?: Uint8Array; error?: string }> =>
      ipcRenderer.invoke('ppt:to-pdf', sourcePath)
  },
  searchAll: (query: string): Promise<SearchResult[]> => ipcRenderer.invoke('search:all', query),
  aiMemory: {
    load: (): Promise<{ enabled: boolean; messages: AiChatMessage[] }> => ipcRenderer.invoke('ai:memory-load'),
    save: (memory: { enabled: boolean; messages: AiChatMessage[] }): Promise<{ enabled: boolean; messages: AiChatMessage[] }> =>
      ipcRenderer.invoke('ai:memory-save', memory),
    clear: (): Promise<{ enabled: boolean; messages: AiChatMessage[] }> => ipcRenderer.invoke('ai:memory-clear'),
    export: (): Promise<string> => ipcRenderer.invoke('ai:memory-export'),
    import: (json: string): Promise<{ enabled: boolean; messages: AiChatMessage[] }> => ipcRenderer.invoke('ai:memory-import', json)
  },
  promptLog: {
    add: (input: { text: string; source: 'ai' | 'writing'; model?: string }): Promise<PromptLogItem | null> =>
      ipcRenderer.invoke('prompt-log:add', input),
    list: (): Promise<PromptLogItem[]> => ipcRenderer.invoke('prompt-log:list'),
    delete: (id: string): Promise<PromptLogItem[]> => ipcRenderer.invoke('prompt-log:delete', id),
    clear: (): Promise<PromptLogItem[]> => ipcRenderer.invoke('prompt-log:clear')
  },
  ai: {
    getConfig: (): Promise<AiConfig> => ipcRenderer.invoke('ai:get-config'),
    saveConfig: (cfg: AiConfig): Promise<AiConfig> => ipcRenderer.invoke('ai:save-config', cfg),
    testConnection: (): Promise<{ ok: boolean; error?: string; latencyMs?: number }> =>
      ipcRenderer.invoke('ai:test-connection'),
    listProfiles: (): Promise<import('../shared/types').AiProfilesState> => ipcRenderer.invoke('ai:list-profiles'),
    addProfile: (input: {
      name: string
      endpoint?: string
      apiKey?: string
      model?: string
      systemPrompt?: string
      secondaryModel?: string
      activate?: boolean
    }): Promise<import('../shared/types').AiProfilesState> => ipcRenderer.invoke('ai:add-profile', input),
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
    ): Promise<import('../shared/types').AiProfilesState> => ipcRenderer.invoke('ai:update-profile', id, patch),
    removeProfile: (id: string): Promise<import('../shared/types').AiProfilesState> =>
      ipcRenderer.invoke('ai:remove-profile', id),
    setActiveProfile: (id: string): Promise<import('../shared/types').AiProfilesState> =>
      ipcRenderer.invoke('ai:set-active-profile', id),
    testProfile: (cfg: AiConfig): Promise<{ ok: boolean; error?: string; latencyMs?: number }> =>
      ipcRenderer.invoke('ai:test-profile', cfg),
    listModels: (endpoint: string, apiKey?: string): Promise<{ ok: boolean; models: string[]; error?: string }> =>
      ipcRenderer.invoke('ai:list-models', endpoint, apiKey),
    addOllama: (opts?: { endpoint?: string; model?: string; name?: string }) =>
      ipcRenderer.invoke('ai:add-ollama', opts),
    getRouting: () => ipcRenderer.invoke('ai:get-routing'),
    setRouting: (r: { primaryId?: string; fallbackId?: string; mode?: string }) =>
      ipcRenderer.invoke('ai:set-routing', r),
    chat: (
      sessionId: string,
      messages: AiChatMessage[],
      model?: string,
      tools?: AiTool[],
      sampling?: Record<string, number | string | boolean>
    ): Promise<boolean> => ipcRenderer.invoke('ai:chat', sessionId, messages, model, tools, sampling),
    complete: (messages: AiChatMessage[], model?: string): Promise<{ ok: boolean; text: string; error?: string }> =>
      ipcRenderer.invoke('ai:complete', messages, model),
    stop: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('ai:stop', sessionId),
    onChunk: (cb: (payload: AiChunkEvent) => void): (() => void) => {
      const handler = (_e: unknown, payload: AiChunkEvent) => cb(payload)
      ipcRenderer.on('ai:chunk', handler)
      return () => ipcRenderer.removeListener('ai:chunk', handler)
    },
    onDone: (cb: (payload: AiDoneEvent) => void): (() => void) => {
      const handler = (_e: unknown, payload: AiDoneEvent) => cb(payload)
      ipcRenderer.on('ai:done', handler)
      return () => ipcRenderer.removeListener('ai:done', handler)
    }
  },
  usage: {
    pageVisit: (page: string): Promise<void> => ipcRenderer.invoke('usage:page-visit', page),
    dashboard: (): Promise<DashboardOverview> => ipcRenderer.invoke('usage:dashboard'),
    reset: (): Promise<UsageStatsState> => ipcRenderer.invoke('usage:reset')
  },
  hub: {
    snapshot: (): Promise<import('../shared/types').AgentHubSnapshot> => ipcRenderer.invoke('hub:snapshot'),
    runtimes: () => ipcRenderer.invoke('hub:runtimes'),
    renameWorkspace: (name: string) => ipcRenderer.invoke('hub:rename-workspace', name),
    listAgents: () => ipcRenderer.invoke('hub:list-agents'),
    upsertAgent: (input: Record<string, unknown>) => ipcRenderer.invoke('hub:upsert-agent', input),
    removeAgent: (id: string) => ipcRenderer.invoke('hub:remove-agent', id),
    bindSkills: (agentId: string, skillIds: string[]) => ipcRenderer.invoke('hub:bind-skills', agentId, skillIds),
    listSquads: () => ipcRenderer.invoke('hub:list-squads'),
    upsertSquad: (input: Record<string, unknown>) => ipcRenderer.invoke('hub:upsert-squad', input),
    listIssues: () => ipcRenderer.invoke('hub:list-issues'),
    createIssue: (input: Record<string, unknown>) => ipcRenderer.invoke('hub:create-issue', input),
    updateIssue: (id: string, patch: Record<string, unknown>) => ipcRenderer.invoke('hub:update-issue', id, patch),
    commentIssue: (issueId: string, author: string, kind: string, body: string) =>
      ipcRenderer.invoke('hub:comment-issue', issueId, author, kind, body),
    removeIssue: (id: string) => ipcRenderer.invoke('hub:remove-issue', id),
    runIssue: (id: string, force?: boolean) => ipcRenderer.invoke('hub:run-issue', id, force),
    reviewIssue: (id: string, approve: boolean, note?: string) => ipcRenderer.invoke('hub:review-issue', id, approve, note),
    listRuns: (issueId?: string) => ipcRenderer.invoke('hub:list-runs', issueId),
    inboxRead: (id: string, read?: boolean) => ipcRenderer.invoke('hub:inbox-read', id, read),
    inboxClear: () => ipcRenderer.invoke('hub:inbox-clear'),
    listAutopilots: () => ipcRenderer.invoke('hub:list-autopilots'),
    upsertAutopilot: (input: Record<string, unknown>) => ipcRenderer.invoke('hub:upsert-autopilot', input),
    removeAutopilot: (id: string) => ipcRenderer.invoke('hub:remove-autopilot', id),
    generatePlan: (opts: { title: string; detail?: string; issueId?: string; goalId?: string }) =>
      ipcRenderer.invoke('hub:generate-plan', opts),
    executePlan: (planId: string) => ipcRenderer.invoke('hub:execute-plan', planId),
    upsertPlan: (input: Record<string, unknown>) => ipcRenderer.invoke('hub:upsert-plan', input),
    upsertGoal: (input: Record<string, unknown>) => ipcRenderer.invoke('hub:upsert-goal', input),
    advanceGoal: (goalId: string) => ipcRenderer.invoke('hub:advance-goal', goalId),
    setDuty: (slots: unknown[]) => ipcRenderer.invoke('hub:set-duty', slots),
    upsertApp: (input: Record<string, unknown>) => ipcRenderer.invoke('hub:upsert-app', input),
    runApp: (appId: string) => ipcRenderer.invoke('hub:run-app', appId),
    upsertWorkspaceDir: (input: Record<string, unknown>) => ipcRenderer.invoke('hub:upsert-workspace-dir', input),
    addExperience: (input: Record<string, unknown>) => ipcRenderer.invoke('hub:add-experience', input),
    addMemory: (input: Record<string, unknown>) => ipcRenderer.invoke('hub:add-memory', input),
    upsertImChannel: (input: Record<string, unknown>) => ipcRenderer.invoke('hub:upsert-im', input),
    sendIm: (channelId: string, title: string, body: string) => ipcRenderer.invoke('hub:send-im', channelId, title, body),
    testIm: (channel: Record<string, unknown>) => ipcRenderer.invoke('hub:test-im', channel),
    marketCatalog: (remoteUrl?: string) => ipcRenderer.invoke('hub:market-catalog', remoteUrl),
    marketInstall: (id: string) => ipcRenderer.invoke('hub:market-install', id),
    codeIndexBuild: (rootDir: string) => ipcRenderer.invoke('hub:code-index-build', rootDir),
    codeIndexQuery: (q: string) => ipcRenderer.invoke('hub:code-index-query', q),
    sandboxRun: (cwd: string, command: string, timeoutMs?: number) => ipcRenderer.invoke('hub:sandbox-run', cwd, command, timeoutMs)
  },
  data: {
    info: (): Promise<DataInfo> => ipcRenderer.invoke('data:info'),
    backup: (): Promise<string | null> => ipcRenderer.invoke('data:backup'),
    importData: (): Promise<string | null> => ipcRenderer.invoke('data:import'),
    getDataDir: (): Promise<{ current: string; custom: string | null }> => ipcRenderer.invoke('data:get-datadir'),
    setDataDir: (dir: string | null): Promise<{ custom: string | null }> => ipcRenderer.invoke('data:set-datadir', dir),
    pickDir: (title?: string): Promise<string | null> => ipcRenderer.invoke('data:pick-dir', title)
  },
  publish: {
    listPlatforms: (): Promise<PublishPlatformInfo[]> => ipcRenderer.invoke('publish:list-platforms'),
    login: (platformId: string): Promise<boolean> => ipcRenderer.invoke('publish:login', platformId),
    checkLogin: (platformId: string): Promise<boolean> => ipcRenderer.invoke('publish:check-login', platformId),
    checkAllLogin: (): Promise<Record<string, boolean>> => ipcRenderer.invoke('publish:check-all-login'),
    create: (input: PublishCreateInput): Promise<PublishJobInfo[]> => ipcRenderer.invoke('publish:create', input),
    stats: (): Promise<PublishStats> => ipcRenderer.invoke('publish:stats'),
    aiSummarize: (input: { title: string; content: string }): Promise<AiAssistResult> => ipcRenderer.invoke('publish:ai-summarize', input),
    aiRewrite: (input: { title: string; content: string; platformId: string }): Promise<AiAssistResult> => ipcRenderer.invoke('publish:ai-rewrite', input),
    gzhGet: (): Promise<GzhConfigInfo> => ipcRenderer.invoke('publish:gzh-config'),
    gzhSave: (input: { appId: string; secret: string }): Promise<boolean> => ipcRenderer.invoke('publish:gzh-save', input),
    gzhClear: (): Promise<boolean> => ipcRenderer.invoke('publish:gzh-clear'),
    listJobs: (): Promise<PublishJobInfo[]> => ipcRenderer.invoke('publish:list-jobs'),
    retry: (id: string): Promise<PublishJobInfo[]> => ipcRenderer.invoke('publish:retry', id)
  },
  tools: {
    scanDirectory: (dir: string, opts?: unknown): Promise<unknown[]> =>
      ipcRenderer.invoke('tools:scan-directory', dir, opts),
    fileInfo: (p: string): Promise<unknown | null> => ipcRenderer.invoke('tools:file-info', p),
    formatSize: (bytes: number): Promise<string> => ipcRenderer.invoke('tools:format-size', bytes),
    deleteFile: (p: string, sendToTrash?: boolean): Promise<boolean> => ipcRenderer.invoke('tools:delete-file', p, sendToTrash),
    getDiskInfo: (p: string): Promise<unknown> => ipcRenderer.invoke('tools:get-disk-info', p),
    getAllDisks: (): Promise<unknown[]> => ipcRenderer.invoke('tools:get-all-disks'),
    analyzeDirectory: (dir: string, recursive?: boolean, minSizeLarge?: number): Promise<unknown> =>
      ipcRenderer.invoke('tools:analyze-directory', dir, recursive, minSizeLarge),
    findLargeFiles: (dir: string, minSize?: number, limit?: number): Promise<unknown[]> =>
      ipcRenderer.invoke('tools:find-large-files', dir, minSize, limit),
    findDuplicates: (dir: string, opts?: unknown): Promise<unknown> =>
      ipcRenderer.invoke('tools:find-duplicates', dir, opts),
    compareFolders: (left: string, right: string, opts?: unknown): Promise<unknown> =>
      ipcRenderer.invoke('tools:compare-folders', left, right, opts),
    watcher: {
      add: (dir: string, name?: string): Promise<boolean> => ipcRenderer.invoke('tools:watcher-add', dir, name),
      remove: (dir: string): Promise<boolean> => ipcRenderer.invoke('tools:watcher-remove', dir),
      start: (): Promise<boolean> => ipcRenderer.invoke('tools:watcher-start'),
      stop: (): Promise<boolean> => ipcRenderer.invoke('tools:watcher-stop'),
      pause: (): Promise<boolean> => ipcRenderer.invoke('tools:watcher-pause'),
      resume: (): Promise<boolean> => ipcRenderer.invoke('tools:watcher-resume'),
      list: (): Promise<unknown[]> => ipcRenderer.invoke('tools:watcher-list'),
      onEvent: (cb: (event: unknown) => void): (() => void) => {
        const handler = (_e: unknown, event: unknown) => cb(event)
        ipcRenderer.on('tools:watcher-event', handler)
        return () => ipcRenderer.removeListener('tools:watcher-event', handler)
      }
    }
  },
  organize: {
    getTargetBase: (): Promise<string> => ipcRenderer.invoke('organize:get-target-base'),
    setTargetBase: (dir: string): Promise<string> => ipcRenderer.invoke('organize:set-target-base', dir),
    aiClassify: (filePaths: string[], useAi?: boolean): Promise<Record<string, string>> =>
      ipcRenderer.invoke('organize:ai-classify', filePaths, useAi),
    recordCorrection: (filePath: string, category: string): Promise<void> =>
      ipcRenderer.invoke('organize:record-correction', filePath, category),
    memoryList: (): Promise<ClassificationMemoryEntry[]> => ipcRenderer.invoke('organize:memory-list'),
    memoryClear: (): Promise<void> => ipcRenderer.invoke('organize:memory-clear'),
    generatePlan: (filePaths: string[], opts?: OrganizeOptions): Promise<OrganizePlanPreview> =>
      ipcRenderer.invoke('organize:generate-plan', filePaths, opts),
    executePlan: (actions: OrganizeAction[]): Promise<ExecuteResult> =>
      ipcRenderer.invoke('organize:execute-plan', actions)
  },
  convert: {
    convert: (input: ConvertInput): Promise<ConversionResult> => ipcRenderer.invoke('convert:convert', input),
    supported: (): Promise<Record<string, string[]>> => ipcRenderer.invoke('convert:supported'),
    converters: (): Promise<ConvertConverterInfo[]> => ipcRenderer.invoke('convert:converters'),
    findConverter: (src: string, tgt: string): Promise<string | undefined> =>
      ipcRenderer.invoke('convert:find-converter', src, tgt),
    submit: (input: ConvertInput): Promise<unknown> => ipcRenderer.invoke('convert:submit', input),
    submitBatch: (inputs: ConvertInput[]): Promise<unknown[]> => ipcRenderer.invoke('convert:submit-batch', inputs),
    getTask: (id: string): Promise<unknown> => ipcRenderer.invoke('convert:get-task', id),
    listTasks: (state?: string): Promise<unknown[]> => ipcRenderer.invoke('convert:list-tasks', state),
    cancel: (id: string): Promise<boolean> => ipcRenderer.invoke('convert:cancel', id),
    progress: (): Promise<{
      total: number
      pending: number
      running: number
      completed: number
      failed: number
      progressPercent: number
    }> => ipcRenderer.invoke('convert:progress'),
    retry: (id: string, force?: boolean): Promise<unknown> => ipcRenderer.invoke('convert:retry', id, force),
    tempStatus: (): Promise<ConvertTempStatus> => ipcRenderer.invoke('convert:temp-status'),
    cleanupTemp: (expireHours?: number): Promise<ConvertCleanupResult> =>
      ipcRenderer.invoke('convert:cleanup-temp', expireHours)
  },
  media: {
    ffmpegAvailable: (): Promise<boolean> => ipcRenderer.invoke('media:ffmpeg-available'),
    pickImages: (): Promise<Array<{ path: string; name: string; size: number }>> =>
      ipcRenderer.invoke('media:pick-images'),
    pickImage: (): Promise<Array<{ path: string; name: string; size: number }>> =>
      ipcRenderer.invoke('media:pick-image'),
    pickVideos: (): Promise<Array<{ path: string; name: string; size: number }>> =>
      ipcRenderer.invoke('media:pick-videos'),
    pickVideo: (): Promise<Array<{ path: string; name: string; size: number }>> =>
      ipcRenderer.invoke('media:pick-video'),
    pickAudios: (): Promise<Array<{ path: string; name: string; size: number }>> =>
      ipcRenderer.invoke('media:pick-audios'),
    pickAudio: (): Promise<Array<{ path: string; name: string; size: number }>> =>
      ipcRenderer.invoke('media:pick-audio'),
    pickMedia: (): Promise<Array<{ path: string; name: string; size: number }>> =>
      ipcRenderer.invoke('media:pick-media'),
    savePath: (defaultName: string, exts: string[]): Promise<string | null> =>
      ipcRenderer.invoke('media:save-path', defaultName, exts),
    readFile: (filePath: string): Promise<Uint8Array | null> => ipcRenderer.invoke('media:read-file', filePath),
    writeFile: (filePath: string, data: Uint8Array): Promise<boolean> =>
      ipcRenderer.invoke('media:write-file', filePath, data),
    probe: (filePath: string): Promise<{
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
    }> => ipcRenderer.invoke('media:probe', filePath),
    convert: (input: {
      sourcePath: string
      targetFormat: string
      outputPath?: string
      quality?: 'low' | 'medium' | 'high'
      kind?: 'video' | 'audio' | 'gif'
    }): Promise<{ ok: boolean; error?: string; outputPath?: string; sizeBytes?: number; durationMs?: number }> =>
      ipcRenderer.invoke('media:convert', input),
    extractFrame: (input: {
      sourcePath: string
      timeSec: number
      outputPath?: string
      format?: 'png' | 'jpg' | 'webp'
      width?: number
    }): Promise<{ ok: boolean; error?: string; outputPath?: string; sizeBytes?: number }> =>
      ipcRenderer.invoke('media:extract-frame', input),
    videoToGif: (input: {
      sourcePath: string
      startSec: number
      endSec: number
      outputPath?: string
      fps?: number
      width?: number
    }): Promise<{ ok: boolean; error?: string; outputPath?: string; sizeBytes?: number }> =>
      ipcRenderer.invoke('media:video-to-gif', input),
    extractAudio: (input: {
      sourcePath: string
      outputPath?: string
      targetFormat?: string
      quality?: 'low' | 'medium' | 'high'
    }): Promise<{ ok: boolean; error?: string; outputPath?: string; sizeBytes?: number }> =>
      ipcRenderer.invoke('media:extract-audio', input),
    trim: (input: {
      sourcePath: string
      startSec: number
      endSec: number
      outputPath?: string
      reencode?: boolean
    }): Promise<{ ok: boolean; error?: string; outputPath?: string; sizeBytes?: number }> =>
      ipcRenderer.invoke('media:trim', input),
    imageConvert: (input: {
      sourcePath: string
      targetFormat: string
      outputPath?: string
      quality?: 'low' | 'medium' | 'high'
    }): Promise<{ ok: boolean; error?: string; outputPath?: string; sizeBytes?: number }> =>
      ipcRenderer.invoke('media:image-convert', input)
  },
  hardware: {
    clipboardList: (): Promise<
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
    > => ipcRenderer.invoke('hardware:clipboard-list'),
    clipboardClear: (): Promise<boolean> => ipcRenderer.invoke('hardware:clipboard-clear'),
    clipboardRemove: (id: string): Promise<boolean> => ipcRenderer.invoke('hardware:clipboard-remove', id),
    clipboardCopy: (id: string): Promise<boolean> => ipcRenderer.invoke('hardware:clipboard-copy', id),
    onClipboardEvent: (cb: (entry: unknown) => void): (() => void) => {
      const handler = (_e: unknown, entry: unknown): void => cb(entry)
      ipcRenderer.on('hardware:clipboard-event', handler)
      return () => ipcRenderer.removeListener('hardware:clipboard-event', handler)
    },
    system: (force = false): Promise<unknown> => ipcRenderer.invoke('hardware:system', force),
    cpuMemory: (force = false): Promise<unknown> => ipcRenderer.invoke('hardware:cpu-memory', force),
    graphics: (force = false): Promise<unknown> => ipcRenderer.invoke('hardware:graphics', force),
    board: (force = false): Promise<unknown> => ipcRenderer.invoke('hardware:board', force),
    disk: (force = false): Promise<unknown> => ipcRenderer.invoke('hardware:disk', force),
    network: (force = false): Promise<unknown> => ipcRenderer.invoke('hardware:network', force),
    power: (force = false): Promise<unknown> => ipcRenderer.invoke('hardware:power', force),
    summary: (): Promise<unknown> => ipcRenderer.invoke('hardware:summary')
  },
  pdf: {
    sofficeAvailable: (): Promise<boolean> => ipcRenderer.invoke('pdf:soffice-available'),
    pickPdfs: (): Promise<Array<{ path: string; name: string; size: number }>> =>
      ipcRenderer.invoke('pdf:pick-pdfs'),
    pickExcel: (): Promise<Array<{ path: string; name: string; size: number }>> =>
      ipcRenderer.invoke('pdf:pick-excel'),
    read: (filePath: string): Promise<Uint8Array | null> => ipcRenderer.invoke('pdf:read', filePath),
    write: (filePath: string, data: Uint8Array): Promise<boolean> => ipcRenderer.invoke('pdf:write', filePath, data),
    savePath: (defaultName: string, exts: string[]): Promise<string | null> =>
      ipcRenderer.invoke('pdf:save-path', defaultName, exts),
    pickDir: (title?: string): Promise<string | null> => ipcRenderer.invoke('pdf:pick-dir', title),
    exists: (paths: string[]): Promise<boolean[]> => ipcRenderer.invoke('pdf:exists', paths),
    excelToPdf: (input: {
      sourcePath: string
      outputPath?: string
      pageOrientation?: 'auto' | 'portrait' | 'landscape'
    }): Promise<{ ok: boolean; error?: string; outputPath?: string; sizeBytes?: number }> =>
      ipcRenderer.invoke('pdf:excel-to-pdf', input)
  },
  searchIndex: {
    ingest: (filePath: string): Promise<IngestResult> => ipcRenderer.invoke('searchIndex:ingest', filePath),
    ingestDir: (dir: string, recursive?: boolean, extFilter?: string[]): Promise<IngestResult[]> =>
      ipcRenderer.invoke('searchIndex:ingest-dir', dir, recursive, extFilter),
    query: (q: string, topK?: number): Promise<SearchHit[]> => ipcRenderer.invoke('searchIndex:query', q, topK),
    delete: (filePath: string): Promise<{ deletedCount: number }> => ipcRenderer.invoke('searchIndex:delete', filePath),
    rebuild: (): Promise<void> => ipcRenderer.invoke('searchIndex:rebuild'),
    stats: (): Promise<IndexStats> => ipcRenderer.invoke('searchIndex:stats'),
    tokenize: (text: string): Promise<string[]> => ipcRenderer.invoke('searchIndex:tokenize', text),
    ask: (req: AskRequest): Promise<AskResult> => ipcRenderer.invoke('searchIndex:ask', req),
    qaHistory: (): Promise<QaHistoryEntry[]> => ipcRenderer.invoke('searchIndex:qa-history'),
    qaHistoryClear: (): Promise<boolean> => ipcRenderer.invoke('searchIndex:qa-history-clear'),
    qaPrefsGet: (): Promise<QaPrefs> => ipcRenderer.invoke('searchIndex:qa-prefs-get'),
    qaPrefsSet: (prefs: QaPrefs): Promise<QaPrefs> => ipcRenderer.invoke('searchIndex:qa-prefs-set', prefs)
  },
  knowledgeBase: {
    build: (inputs: KnowledgeBuildInput[], opts?: KnowledgeBuildOptions): Promise<KnowledgeBuildResult> =>
      ipcRenderer.invoke('knowledgeBase:build', inputs, opts),
    listDataAssets: (kbId?: string): Promise<DataAssetRecord[]> => ipcRenderer.invoke('knowledgeBase:listDataAssets', kbId),
    getDataAsset: (assetId: string): Promise<DataAssetRecord | null> => ipcRenderer.invoke('knowledgeBase:getDataAsset', assetId),
    assetColumns: (assetId: string): Promise<DataAssetColumn[]> => ipcRenderer.invoke('knowledgeBase:assetColumns', assetId),
    addReference: (rec: ReferenceRecord): Promise<void> => ipcRenderer.invoke('knowledgeBase:addReference', rec),
    listReferences: (scope?: ReferenceScope, refPos?: string): Promise<ReferenceRecord[]> =>
      ipcRenderer.invoke('knowledgeBase:listReferences', scope, refPos),
    listCandidates: (q?: string): Promise<KbCandidate[]> => ipcRenderer.invoke('knowledgeBase:listCandidates', q),
    resolveInject: (picks: KbRefPick[], query?: string): Promise<KbInjectBlock[]> =>
      ipcRenderer.invoke('knowledgeBase:resolveInject', picks, query),
    renderInject: (blocks: KbInjectBlock[]): Promise<string> => ipcRenderer.invoke('knowledgeBase:renderInject', blocks)
  },
  kbData: {
    aggregate: (req: AggregateRequest): Promise<AggregateResult> => ipcRenderer.invoke('kbData:aggregate', req),
    getTable: (id: string): Promise<DataTable | null> => ipcRenderer.invoke('kbData:getTable', id),
    listTables: (): Promise<TableMeta[]> => ipcRenderer.invoke('kbData:listTables')
  },
  mcp: {
    listServers: (): Promise<McpServerState[]> => ipcRenderer.invoke('mcp:list-servers'),
    addServer: (config: McpServerConfig): Promise<McpServerState> => ipcRenderer.invoke('mcp:add-server', config),
    removeServer: (id: string): Promise<boolean> => ipcRenderer.invoke('mcp:remove-server', id),
    listTools: (): Promise<McpToolInfo[]> => ipcRenderer.invoke('mcp:list-tools'),
    callTool: (input: McpCallInput): Promise<McpCallResult> => ipcRenderer.invoke('mcp:call-tool', input)
  },
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('open:external', url),
  runCommand: (command: string): Promise<number | null> => ipcRenderer.invoke('command:run', command),
  sillytavern: {
    status: (): Promise<{ ok: boolean; dataRoot: string; characterCount: number; worldCount: number; chatCount: number }> =>
      ipcRenderer.invoke('sillytavern:status'),
    // 角色卡
    charsList: () => ipcRenderer.invoke('sillytavern:chars-list'),
    charsGet: (id: string) => ipcRenderer.invoke('sillytavern:chars-get', id),
    charsSave: (id: string, card: unknown) => ipcRenderer.invoke('sillytavern:chars-save', id, card),
    charsAvatar: (id: string, bytes: Uint8Array) => ipcRenderer.invoke('sillytavern:chars-avatar', id, bytes),
    charsExport: (id: string) => ipcRenderer.invoke('sillytavern:chars-export', id),
    charsImport: (bytes: Uint8Array) => ipcRenderer.invoke('sillytavern:chars-import', bytes),
    charsDelete: (id: string) => ipcRenderer.invoke('sillytavern:chars-delete', id),
    charsDefaultGet: () => ipcRenderer.invoke('sillytavern:chars-default-get'),
    charsDefaultSet: (id: string | null) => ipcRenderer.invoke('sillytavern:chars-default-set', id),
    // 世界书
    worldsList: () => ipcRenderer.invoke('sillytavern:worlds-list'),
    worldsGet: (id: string) => ipcRenderer.invoke('sillytavern:worlds-get', id),
    worldsSave: (id: string, world: unknown) => ipcRenderer.invoke('sillytavern:worlds-save', id, world),
    worldsDelete: (id: string) => ipcRenderer.invoke('sillytavern:worlds-delete', id),
    worldsDefaultGet: () => ipcRenderer.invoke('sillytavern:worlds-default-get'),
    worldsDefaultSet: (id: string | null) => ipcRenderer.invoke('sillytavern:worlds-default-set', id),
    // 聊天记录
    chatsList: (charId: string) => ipcRenderer.invoke('sillytavern:chats-list', charId),
    chatsGet: (charId: string, chatId: string) => ipcRenderer.invoke('sillytavern:chats-get', charId, chatId),
    chatsSave: (charId: string, chatId: string, msgs: unknown[]) => ipcRenderer.invoke('sillytavern:chats-save', charId, chatId, msgs),
    chatsDelete: (charId: string, chatId: string) => ipcRenderer.invoke('sillytavern:chats-delete', charId, chatId),
    chatsNewId: () => ipcRenderer.invoke('sillytavern:chats-new-id'),
    chatsActiveGet: () => ipcRenderer.invoke('sillytavern:chats-active-get'),
    chatsActiveSet: (charId: string, chatId: string) => ipcRenderer.invoke('sillytavern:chats-active-set', charId, chatId),
    // 预设
    presetsList: () => ipcRenderer.invoke('sillytavern:presets-list'),
    presetsGet: (id: string) => ipcRenderer.invoke('sillytavern:presets-get', id),
    presetsSave: (p: unknown) => ipcRenderer.invoke('sillytavern:presets-save', p),
    presetsDelete: (id: string) => ipcRenderer.invoke('sillytavern:presets-delete', id),
    presetsDefaultGet: () => ipcRenderer.invoke('sillytavern:presets-default-get'),
    presetsDefaultSet: (id: string | null) => ipcRenderer.invoke('sillytavern:presets-default-set', id),
    // 作者注释 / 正则 / 快速回复
    noteGet: () => ipcRenderer.invoke('sillytavern:note-get'),
    noteSet: (note: unknown) => ipcRenderer.invoke('sillytavern:note-set', note),
    regexGet: () => ipcRenderer.invoke('sillytavern:regex-get'),
    regexSet: (list: unknown[]) => ipcRenderer.invoke('sillytavern:regex-set', list),
    quickGet: () => ipcRenderer.invoke('sillytavern:quick-get'),
    quickSet: (list: unknown[]) => ipcRenderer.invoke('sillytavern:quick-set', list),
    // 对话引擎（流式复用 ai:chunk / ai:done 事件）
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
    ) => ipcRenderer.invoke('sillytavern:chat', sessionId, payload),
    // 编译角色上下文为 system 文本（写作融合模式注入 ai.chat）
    buildContext: (opts: { card: unknown; world: unknown; conversationText: string; authorNote: unknown }): Promise<string> =>
      ipcRenderer.invoke('sillytavern:build-context', opts),
    stop: (sessionId: string) => ipcRenderer.invoke('sillytavern:stop', sessionId)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore define in index.d.ts
  window.api = api
}
