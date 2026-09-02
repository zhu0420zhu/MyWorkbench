import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tabs,
  Tooltip,
  Typography,
  Segmented,
  message
} from 'antd'
import {
  AuditOutlined,
  DeleteOutlined,
  ExportOutlined,
  PlusOutlined,
  ReadOutlined,
  MessageOutlined,
  RobotOutlined
} from '@ant-design/icons'
import type { Chapter, ChapterStatus, NovelProject, NovelProjectMeta } from '@shared/types'
import ChapterTree, { ProjectProgress } from '../novel/ChapterTree'
import ChapterEditor, { ChapterEditorHandle } from '../novel/ChapterEditor'
import OutlinePanel from '../novel/OutlinePanel'
import ContextPanel from '../novel/ContextPanel'
import ConsistencyDrawer from '../novel/ConsistencyDrawer'
import ForeshadowPanel from '../novel/ForeshadowPanel'
import InspirationPanel from '../novel/InspirationPanel'
import BookExportDialog from '../BookExportDialog'
import WorkshopChat from './WorkshopChat'
import WorkshopSidePanel from './WorkshopSidePanel'
import CharacterLibrary from './CharacterLibrary'
import CharacterEditorModal from './CharacterEditorModal'
import { DEFAULT_SAMPLING } from './types'
import type {
  AuthorNote,
  CharacterMeta,
  QuickReply,
  RegexScript,
  RolePreset,
  SamplingParams,
  WorldInfo
} from './types'

interface WritingWorkspaceProps {
  /** 外部跳转指定章节（暂用于独立窗口，id 形如 "<projectId>/<chapterId>"） */
  openChapterId?: string
}

/**
 * 统一写作工作区（短篇 + 长篇合一）：
 * - 左栏 Tab：角色库（短篇人设）/ 章节树（长篇分卷章节）
 * - 中栏 Tab：对话（统一的 AI 写作助手，复用 ai.chat + 技能 + MCP + 压缩，可注入角色上下文与长篇上下文；章节已加载时支持「插入本章」）/ 正文（按章分文件编辑）
 * - 右栏 Tab：设定（世界书 / 预设 / 作者注释 / 正则 / 快捷回复）/ 长篇工具（大纲设定 / 上下文编排 / 伏笔 / 灵感）
 *
 * 长 / 短篇共用同一套 AI 引擎（WorkshopChat 已去 mode 二分），且无重复实现：
 *   - 长篇优势（分卷章节树、按章分文件、大纲、设定库、伏笔、灵感、上下文编排、成书导出、版本历史）全部保留；
 *   - 短篇能力（角色卡、世界书、草稿自动保存、成书导出、MCP/技能/压缩）原样保留。
 * 中栏「对话 / 正文」双面板常驻挂载（仅切换 display），保证「插入本章」在任意 Tab 下都能写入已加载的编辑器。
 */
export default function WritingWorkspace({ openChapterId }: WritingWorkspaceProps) {
  /* ---------------- 长篇状态 ---------------- */
  const [projects, setProjects] = useState<NovelProjectMeta[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [project, setProject] = useState<NovelProject | null>(null)
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null)
  const [chapter, setChapter] = useState<Chapter | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingChapter, setLoadingChapter] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [bookOpen, setBookOpen] = useState(false)
  const [chapterDirty, setChapterDirty] = useState(false)
  const [injectedContext, setInjectedContext] = useState<string | null>(null)
  const [auditOpen, setAuditOpen] = useState(false)
  const [fsReload, setFsReload] = useState(0)
  const [inspReload, setInspReload] = useState(0)
  const [volumePrompt, setVolumePrompt] = useState<{ open: boolean; name: string }>({ open: false, name: '' })
  const [volumeDelete, setVolumeDelete] = useState<{ volumeId: string; affected: number } | null>(null)
  const [narrow, setNarrow] = useState(typeof window !== 'undefined' ? window.innerWidth < 960 : false)
  const [newTitle, setNewTitle] = useState('')
  const [newGenre, setNewGenre] = useState('')
  const [newSynopsis, setNewSynopsis] = useState('')
  const [newTarget, setNewTarget] = useState('')
  const chapterEditorRef = useRef<ChapterEditorHandle | null>(null)

  /* ---------------- 短篇状态 ---------------- */
  const [selectedCharId, setSelectedCharId] = useState('')
  const [char, setChar] = useState<CharacterMeta | null>(null)
  const [editTarget, setEditTarget] = useState<CharacterMeta | null>(null)
  const [chatId, setChatId] = useState('')
  const [model, setModel] = useState('')
  const [world, setWorld] = useState<WorldInfo | null>(null)
  const [preset, setPreset] = useState<RolePreset | null>(null)
  const [note, setNote] = useState<AuthorNote>({ enabled: false, note: '', position: 'top', depth: 0, role: 'system' })
  const [regex, setRegex] = useState<RegexScript[]>([])
  const [quick, setQuick] = useState<QuickReply[]>([])
  const [worlds, setWorlds] = useState<Array<{ id: string; name: string }>>([])
  const [presets, setPresets] = useState<Array<{ id: string; name: string }>>([])
  const [worldId, setWorldIdState] = useState<string | null>(null)
  const [presetId, setPresetIdState] = useState<string | null>(null)

  /* ---------------- 布局 Tab ---------------- */
  const [leftTab, setLeftTab] = useState<'chars' | 'chapters'>('chars')
  const [centerTab, setCenterTab] = useState<'chat' | 'editor'>('chat')
  const [rightTab, setRightTab] = useState<'settings' | 'novel'>('settings')

  /* ---------------- 可拖拽面板宽度 ---------------- */
  const readSize = (key: string, def: number) => {
    try {
      const v = Number(localStorage.getItem(`wb-writing-${key}`))
      return Number.isNaN(v) ? def : v
    } catch {
      return def
    }
  }
  const [leftWidth, setLeftWidth] = useState(() => readSize('leftWidth', 260))
  const [rightWidth, setRightWidth] = useState(() => readSize('rightWidth', 340))
  const resizingRef = useRef<{ side: 'left' | 'right'; startX: number; startWidth: number } | null>(null)

  const saveSize = (key: string, value: number) => {
    try {
      localStorage.setItem(`wb-writing-${key}`, String(Math.round(value)))
    } catch {
      /* ignore */
    }
  }

  const startResize = useCallback((side: 'left' | 'right', e: React.MouseEvent) => {
    e.preventDefault()
    resizingRef.current = { side, startX: e.clientX, startWidth: side === 'left' ? leftWidth : rightWidth }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev: MouseEvent) => {
      const r = resizingRef.current
      if (!r) return
      const delta = ev.clientX - r.startX
      if (r.side === 'left') {
        const next = Math.min(420, Math.max(200, r.startWidth + delta))
        setLeftWidth(next)
      } else {
        const next = Math.min(520, Math.max(220, r.startWidth - delta))
        setRightWidth(next)
      }
    }
    const onUp = () => {
      const r = resizingRef.current
      if (r) {
        saveSize(r.side === 'left' ? 'leftWidth' : 'rightWidth', r.side === 'left' ? leftWidth : rightWidth)
      }
      resizingRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [leftWidth, rightWidth])

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 960)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /* 初始化：写作助手会话 + 短篇设定（世界书/预设/作者注释/正则/快捷） */
  useEffect(() => {
    void window.api.ai.getConfig().then((cfg) => setModel(cfg.model || ''))
    void (async () => {
      const active = (await window.api.sillytavern.chatsActiveGet()) as { charId: string; chatId: string } | null
      if (active?.chatId) setChatId(active.chatId)
      else setChatId((await window.api.sillytavern.chatsNewId()) as string)
    })()
    void (async () => {
      try {
        setWorlds((await window.api.sillytavern.worldsList()) as Array<{ id: string; name: string }>)
        setPresets((await window.api.sillytavern.presetsList()) as Array<{ id: string; name: string }>)
        const wid = (await window.api.sillytavern.worldsDefaultGet()) as string | null
        const pid = (await window.api.sillytavern.presetsDefaultGet()) as string | null
        setWorldIdState(wid)
        setPresetIdState(pid)
        setWorld(wid ? ((await window.api.sillytavern.worldsGet(wid)) as WorldInfo) : null)
        setPreset(pid ? ((await window.api.sillytavern.presetsGet(pid)) as RolePreset) : null)
        setNote((await window.api.sillytavern.noteGet()) as AuthorNote)
        setRegex((await window.api.sillytavern.regexGet()) as RegexScript[])
        setQuick((await window.api.sillytavern.quickGet()) as QuickReply[])
      } catch {
        /* ignore */
      }
    })()
  }, [])

  const loadProjects = useCallback(async () => {
    try {
      const list = await window.api.novel.listProjects()
      setProjects(list)
      return list
    } catch {
      message.error('加载作品列表失败')
      return []
    }
  }, [])

  useEffect(() => {
    void (async () => {
      const list = await loadProjects()
      if (list.length > 0) setProjectId((prev) => prev ?? list[0].id)
      setLoading(false)
    })()
  }, [loadProjects])

  const loadProject = useCallback(async (id: string) => {
    try {
      const p = await window.api.novel.getProject(id)
      setProject(p)
      return p
    } catch {
      message.error('加载作品失败')
      return null
    }
  }, [])

  useEffect(() => {
    if (!projectId) return
    void loadProject(projectId)
  }, [projectId, loadProject])

  /* 角色选择（融合：角色仅作对话上下文，切换不重置会话历史） */
  const handleSelectChar = useCallback(async (id: string) => {
    setSelectedCharId(id)
    if (!id) {
      setChar(null)
      return
    }
    const meta = (await window.api.sillytavern.charsGet(id)) as CharacterMeta | null
    setChar(meta)
  }, [])

  /* 章节选择（同时切到正文 Tab 让作者看到） */
  const selectChapter = useCallback(
    async (chapterId: string) => {
      if (!projectId) return
      setActiveChapterId(chapterId)
      setCenterTab('editor')
      setLoadingChapter(true)
      try {
        const c = await window.api.novel.getChapter(projectId, chapterId)
        setChapter(c)
      } catch {
        message.error('读取章节失败')
      } finally {
        setLoadingChapter(false)
      }
    },
    [projectId]
  )

  useEffect(() => {
    if (!openChapterId || !openChapterId.includes('/')) return
    const [pid, cid] = openChapterId.split('/')
    setProjectId(pid)
    void selectChapter(cid)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openChapterId])

  /* ---------------- 保存 ---------------- */
  const saveChapter = useCallback(
    async (chapterId: string, patch: { title?: string; content?: string; status?: ChapterStatus }, silent: boolean): Promise<void> => {
      if (!projectId) return
      const updated = await window.api.novel.updateChapter(projectId, chapterId, {
        ...patch,
        ...(silent && patch.content !== undefined ? { snapshotMinIntervalMs: 180_000 } : {})
      })
      if (updated) {
        setChapter((prev) => (prev && prev.id === chapterId ? { ...prev, ...updated, content: patch.content ?? prev.content } : prev))
        setProject((prev) => (prev ? { ...prev, chapters: prev.chapters.map((c) => (c.id === updated.id ? updated : c)) } : prev))
      } else if (!silent) {
        throw new Error('保存失败')
      }
    },
    [projectId]
  )

  const saveSummary = useCallback(
    async (summary: string) => {
      if (!projectId || !activeChapterId) return
      const updated = await window.api.novel.updateChapter(projectId, activeChapterId, { summary })
      if (updated) {
        setChapter((prev) => (prev ? { ...prev, summary } : prev))
        setProject((prev) => (prev ? { ...prev, chapters: prev.chapters.map((c) => (c.id === updated.id ? updated : c)) } : prev))
      }
    },
    [projectId, activeChapterId]
  )

  const updateProjectMeta = useCallback(
    async (patch: { title?: string; genre?: string; synopsis?: string; targetWords?: number }) => {
      if (!projectId) return
      await window.api.novel.updateProject(projectId, patch)
      setProject((prev) => (prev ? { ...prev, meta: { ...prev.meta, ...patch } } : prev))
      void loadProjects()
    },
    [projectId, loadProjects]
  )

  /* ---------------- 结构操作 ---------------- */
  const refresh = useCallback(async () => {
    if (!projectId) return
    const p = await loadProject(projectId)
    void loadProjects()
    return p
  }, [projectId, loadProject, loadProjects])

  const handleCreateProject = useCallback(async () => {
    const title = newTitle.trim()
    if (!title) {
      message.warning('请填写书名')
      return
    }
    try {
      const p = await window.api.novel.createProject({
        title,
        genre: newGenre.trim() || undefined,
        synopsis: newSynopsis.trim() || undefined,
        targetWords: Number(newTarget) > 0 ? Number(newTarget) : undefined
      })
      setCreateOpen(false)
      setNewTitle('')
      setNewGenre('')
      setNewSynopsis('')
      setNewTarget('')
      setProjectId(p.meta.id)
      setActiveChapterId(null)
      setChapter(null)
      await loadProjects()
      message.success('作品已创建')
    } catch {
      message.error('创建作品失败')
    }
  }, [newTitle, newGenre, newSynopsis, newTarget, loadProjects])

  const handleCreateVolume = useCallback(async (name: string) => {
    if (!project) return
    try {
      await window.api.novel.createVolume(project.meta.id, name)
      await refresh()
    } catch {
      message.error('创建分卷失败')
    }
  }, [project, refresh])

  const handleCreateChapter = useCallback(
    async (volumeId: string) => {
      if (!projectId) return
      try {
        const c = await window.api.novel.createChapter({ projectId, volumeId })
        if (!c) return
        await refresh()
        await selectChapter(c.id)
      } catch {
        message.error('创建章节失败')
      }
    },
    [projectId, refresh, selectChapter]
  )

  const handleRemoveChapter = useCallback(
    async (chapterId: string) => {
      if (!projectId) return
      try {
        await window.api.novel.removeChapter(projectId, chapterId)
        if (activeChapterId === chapterId) {
          setActiveChapterId(null)
          setChapter(null)
        }
        await refresh()
      } catch {
        message.error('删除章节失败')
      }
    },
    [projectId, activeChapterId, refresh]
  )

  const handleRemoveVolume = useCallback(
    (volumeId: string) => {
      if (!projectId || !project) return
      const affected = project.chapters.filter((c) => c.volumeId === volumeId).length
      if (affected === 0) {
        Modal.confirm({
          title: '删除这个分卷？',
          okText: '删除',
          okButtonProps: { danger: true },
          cancelText: '取消',
          onOk: async () => {
            await window.api.novel.removeVolume(projectId, volumeId, 'delete-chapters')
            await refresh()
            message.success('分卷已删除')
          }
        })
        return
      }
      setVolumeDelete({ volumeId, affected })
    },
    [projectId, project]
  )

  const doRemoveVolume = useCallback(
    async (mode: 'move-to-first' | 'delete-chapters') => {
      if (!projectId || !volumeDelete) return
      try {
        await window.api.novel.removeVolume(projectId, volumeDelete.volumeId, mode)
        await refresh()
        message.success(mode === 'move-to-first' ? '分卷已删除，章节已移入第一卷' : '分卷与章节已删除')
      } catch {
        message.error('删除分卷失败')
      } finally {
        setVolumeDelete(null)
      }
    },
    [projectId, volumeDelete, refresh]
  )

  const handleMoveChapter = useCallback(
    async (chapterId: string, toVolumeId: string, toIndex: number) => {
      if (!projectId) return
      try {
        await window.api.novel.reorderChapter(projectId, chapterId, toVolumeId, toIndex)
        await refresh()
      } catch {
        message.error('移动章节失败')
      }
    },
    [projectId, refresh]
  )

  const plantForeshadow = useCallback(
    async (text: string) => {
      if (!projectId || !activeChapterId || !chapter) return
      const f = await window.api.novel.createForeshadow({
        projectId,
        content: text,
        plantedChapterId: activeChapterId,
        plantedChapterTitle: chapter.title || '（未命名章节）',
        status: 'planted'
      })
      if (f) {
        setFsReload((r) => r + 1)
        message.success('已埋下伏笔')
      }
    },
    [projectId, activeChapterId, chapter]
  )

  /* ---------------- 插入本章（AI 回复写进编辑器，并切到正文） ---------------- */
  const insertToChapter = useCallback(
    (text: string) => {
      chapterEditorRef.current?.insertText(text)
      setCenterTab('editor')
    },
    []
  )

  const sampling = useMemo<SamplingParams>(() => ({ ...DEFAULT_SAMPLING, ...(preset?.sampling ?? {}) }), [preset])

  const activeVolume = useMemo(() => project?.volumes.find((v) => v.id === chapter?.volumeId) ?? null, [project, chapter])

  const exportPresets = useMemo(() => {
    if (!project) return undefined
    return project.chapters.map((c) => ({ kind: 'chapter' as const, id: `${project.meta.id}/${c.id}` }))
  }, [project])

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Spin />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 顶部：作品切换 + 操作 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border-color, rgba(128,128,128,.15))', flexWrap: 'wrap' }}>
        <ReadOutlined style={{ opacity: 0.7 }} />
        <Select
          size="small"
          style={{ minWidth: 200 }}
          value={projectId ?? undefined}
          onChange={(v) => {
            setProjectId(v)
            setActiveChapterId(null)
            setChapter(null)
          }}
          options={projects.map((p) => ({ label: p.title, value: p.id }))}
          placeholder="选择作品（可选，纯写作无需作品）"
          aria-label="选择作品"
          allowClear
          onClear={() => {
            setProjectId(null)
            setProject(null)
            setChapter(null)
          }}
        />
        <Tooltip title="新建作品">
          <Button size="small" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)} />
        </Tooltip>
        {project && (
          <Popconfirm
            title="删除这部作品？"
            description="所有分卷与章节正文会一并删除，且无法恢复。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={async () => {
              if (!projectId) return
              await window.api.novel.removeProject(projectId)
              setProjectId(null)
              setProject(null)
              setChapter(null)
              const list = await loadProjects()
              setProjectId(list[0]?.id ?? null)
              message.success('作品已删除')
            }}
          >
            <Button size="small" danger aria-label="删除作品" icon={<DeleteOutlined />} />
          </Popconfirm>
        )}
        <div style={{ flex: 1 }} />
        <Tooltip title="跑一致性规则：别名归一化、实体重名等">
          <Button size="small" icon={<AuditOutlined />} disabled={!project || project.chapters.length === 0} onClick={() => setAuditOpen(true)}>
            一致性审计
          </Button>
        </Tooltip>
        <Tooltip title="把这部作品的章节导出成书">
          <Button size="small" icon={<ExportOutlined />} disabled={!project || project.chapters.length === 0} onClick={() => setBookOpen(true)}>
            导出成书
          </Button>
        </Tooltip>
      </div>

      {/* 三栏（窄屏纵向堆叠；宽屏可拖拽调整左右栏宽度） */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: narrow ? 'column' : 'row', position: 'relative' }}>
        {/* 左：Tab[角色库 | 章节] */}
        <div style={{ width: narrow ? '100%' : leftWidth, flexShrink: 0, maxHeight: narrow ? 240 : undefined, borderRight: narrow ? 'none' : '1px solid var(--border-color, rgba(128,128,128,.15))', borderBottom: narrow ? '1px solid var(--border-color, rgba(128,128,128,.15))' : 'none', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <Tabs
            size="small"
            className="writing-left-tabs"
            style={{ height: '100%', minHeight: 0 }}
            activeKey={leftTab}
            onChange={(k) => setLeftTab(k as 'chars' | 'chapters')}
            items={[
              {
                key: 'chars',
                label: '角色库',
                children: (
                  <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                    <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-color, rgba(0,0,0,.06))', display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <Button size="small" block type={!selectedCharId ? 'primary' : 'default'} icon={<MessageOutlined />} onClick={() => void handleSelectChar('')}>
                        写作助手（无角色）
                      </Button>
                      <Typography.Text strong style={{ fontSize: 13 }}>
                        角色库
                      </Typography.Text>
                    </div>
                    <div style={{ flex: 1, minHeight: 0 }}>
                      <CharacterLibrary selectedId={selectedCharId} onSelect={(id) => void handleSelectChar(id)} onEdit={setEditTarget} />
                    </div>
                  </div>
                )
              },
              {
                key: 'chapters',
                label: '章节',
                children: project ? (
                  <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                    <div style={{ flex: 1, minHeight: 0 }}>
                      <ChapterTree
                        volumes={project.volumes}
                        chapters={project.chapters}
                        activeId={activeChapterId}
                        onSelect={(id) => void selectChapter(id)}
                        onCreateChapter={(v) => void handleCreateChapter(v)}
                        onCreateVolume={() => setVolumePrompt({ open: true, name: `第 ${(project?.volumes.length ?? 0) + 1} 卷` })}
                        onRemoveChapter={(id) => void handleRemoveChapter(id)}
                        onRemoveVolume={(id) => void handleRemoveVolume(id)}
                        onMoveChapter={(id, v, i) => void handleMoveChapter(id, v, i)}
                      />
                    </div>
                    <ProjectProgress words={project.chapters.reduce((s, c) => s + c.wordCount, 0)} target={project.meta.targetWords} chapters={project.chapters.length} />
                  </div>
                ) : (
                  <Empty style={{ marginTop: 40 }} image={Empty.PRESENTED_IMAGE_SIMPLE} description="新建作品后，分卷与章节会出现在这里" />
                )
              }
            ]}
          />
        </div>

        {!narrow && (
          <div
            title="左右拖动调整宽度"
            onMouseDown={(e) => startResize('left', e)}
            style={{
              width: 6,
              flexShrink: 0,
              cursor: 'col-resize',
              background: 'transparent',
              position: 'relative',
              zIndex: 2,
              display: 'flex',
              justifyContent: 'center'
            }}
          >
            <div style={{ width: 1, height: '100%', background: 'var(--border-color, rgba(128,128,128,.25))' }} />
          </div>
        )}

        {/* 中：Tab[对话 | 正文]（双面板常驻挂载，仅切换 display 以保编辑器句柄） */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderBottom: '1px solid var(--border-color, rgba(128,128,128,.15))' }}>
            <Segmented
              size="small"
              value={centerTab}
              onChange={(v) => setCenterTab(v as 'chat' | 'editor')}
              options={[
                { label: '对话', value: 'chat' },
                { label: '正文', value: 'editor' }
              ]}
            />
            <div style={{ flex: 1 }} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {centerTab === 'chat' ? 'AI 写作助手（可注入角色 / 长篇上下文）' : '章节正文编辑'}
            </Typography.Text>
          </div>
          <div style={{ flex: 1, minHeight: 0, display: centerTab === 'chat' ? 'flex' : 'none', flexDirection: 'column' }}>
            <WorkshopChat
              char={char}
              world={world}
              sampling={sampling}
              authorNote={note}
              regex={regex}
              quickReplies={quick}
              model={model}
              chatId={chatId}
              onChatIdChange={setChatId}
              novelContext={project ? { projectId: project.meta.id, chapterId: activeChapterId } : undefined}
              onInsertToChapter={chapter ? insertToChapter : undefined}
              storeKey="default"
            />
          </div>
          <div style={{ flex: 1, minHeight: 0, display: centerTab === 'editor' ? 'flex' : 'none', flexDirection: 'column' }}>
            {loadingChapter ? (
              <div style={{ margin: 'auto' }}>
                <Spin />
              </div>
            ) : (
              <ChapterEditor
                key={projectId ?? 'none'}
                ref={chapterEditorRef}
                chapter={chapter}
                disabled={false}
                onSave={saveChapter}
                onDirtyChange={setChapterDirty}
                contextPrompt={injectedContext}
                onContextConsumed={() => setInjectedContext(null)}
                onPlantForeshadow={plantForeshadow}
              />
            )}
          </div>
        </div>

        {!narrow && (
          <div
            title="左右拖动调整宽度"
            onMouseDown={(e) => startResize('right', e)}
            style={{
              width: 6,
              flexShrink: 0,
              cursor: 'col-resize',
              background: 'transparent',
              position: 'relative',
              zIndex: 2,
              display: 'flex',
              justifyContent: 'center'
            }}
          >
            <div style={{ width: 1, height: '100%', background: 'var(--border-color, rgba(128,128,128,.25))' }} />
          </div>
        )}

        {/* 右：Tab[设定 | 长篇工具] */}
        <div style={{ width: narrow ? '100%' : rightWidth, flexShrink: 0, maxHeight: narrow ? 300 : undefined, borderLeft: narrow ? 'none' : '1px solid var(--border-color, rgba(128,128,128,.15))', borderTop: narrow ? '1px solid var(--border-color, rgba(128,128,128,.15))' : 'none', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <Tabs
            size="small"
            className="writing-right-tabs"
            style={{ height: '100%', minHeight: 0 }}
            activeKey={rightTab}
            onChange={(k) => setRightTab(k as 'settings' | 'novel')}
            items={[
              {
                key: 'settings',
                label: '设定',
                children: (
                  <div style={{ height: '100%', minHeight: 0, overflowY: 'auto' }}>
                    {!char && (
                      <Typography.Text type="secondary" style={{ display: 'block', padding: 12, fontSize: 12 }}>
                        在左侧选择角色卡注入人设，或在下方设置世界书 / 预设 / 作者注释，它们会作为上下文注入对话。
                      </Typography.Text>
                    )}
                    <WorkshopSidePanel
                      world={world}
                      setWorld={setWorld}
                      worlds={worlds}
                      setWorlds={setWorlds}
                      worldId={worldId}
                      setWorldId={async (id) => {
                        setWorldIdState(id)
                        await window.api.sillytavern.worldsDefaultSet(id)
                        setWorld(id ? ((await window.api.sillytavern.worldsGet(id)) as WorldInfo) : null)
                      }}
                      preset={preset}
                      setPreset={(p) => {
                        setPreset(p)
                        if (p) void window.api.sillytavern.presetsSave(p)
                      }}
                      presets={presets}
                      setPresets={setPresets}
                      presetId={presetId}
                      setPresetId={async (id) => {
                        setPresetIdState(id)
                        await window.api.sillytavern.presetsDefaultSet(id)
                        setPreset(id ? ((await window.api.sillytavern.presetsGet(id)) as RolePreset) : null)
                      }}
                      note={note}
                      setNote={(n) => {
                        setNote(n)
                        void window.api.sillytavern.noteSet(n)
                      }}
                      regex={regex}
                      setRegex={(l) => {
                        setRegex(l)
                        void window.api.sillytavern.regexSet(l)
                      }}
                      quick={quick}
                      setQuick={(l) => {
                        setQuick(l)
                        void window.api.sillytavern.quickSet(l)
                      }}
                    />
                  </div>
                )
              },
              {
                key: 'novel',
                label: (
                  <span>
                    <RobotOutlined /> 长篇工具
                  </span>
                ),
                children: project ? (
                  <Tabs
                    size="small"
                    defaultActiveKey="outline"
                    className="novel-side-tabs"
                    style={{ height: '100%', minHeight: 0 }}
                    items={[
                      {
                        key: 'outline',
                        label: '大纲设定',
                        children: (
                          <OutlinePanel
                            meta={project.meta}
                            chapter={chapter}
                            volume={activeVolume}
                            chapters={project.chapters}
                            onSaveSummary={saveSummary}
                            onUpdateProject={(p) => void updateProjectMeta(p)}
                            onExportBook={() => setBookOpen(true)}
                          />
                        )
                      },
                      {
                        key: 'context',
                        label: '上下文',
                        children: (
                          <ContextPanel
                            projectId={project.meta.id}
                            chapterId={activeChapterId}
                            dirty={chapterDirty}
                            onApplyPrompt={(text) => setInjectedContext(text)}
                          />
                        )
                      },
                      {
                        key: 'foreshadow',
                        label: '伏笔',
                        children: <ForeshadowPanel projectId={project.meta.id} currentChapterId={activeChapterId} reloadKey={fsReload} />
                      },
                      {
                        key: 'inspiration',
                        label: '灵感',
                        children: <InspirationPanel projectId={project.meta.id} currentChapterId={activeChapterId} reloadKey={inspReload} />
                      }
                    ]}
                  />
                ) : (
                  <Empty style={{ marginTop: 40 }} image={Empty.PRESENTED_IMAGE_SIMPLE} description="新建作品后，大纲 / 上下文 / 伏笔 / 灵感可用" />
                )
              }
            ]}
          />
        </div>
      </div>

      <NewProjectModal
        open={createOpen}
        title={newTitle}
        genre={newGenre}
        synopsis={newSynopsis}
        target={newTarget}
        onChange={{ setNewTitle, setNewGenre, setNewSynopsis, setNewTarget }}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void handleCreateProject()}
      />

      <Modal
        open={volumePrompt.open}
        title="新建分卷"
        okText="创建"
        cancelText="取消"
        destroyOnHidden
        onCancel={() => setVolumePrompt({ open: false, name: '' })}
        onOk={async () => {
          const name = volumePrompt.name.trim()
          if (!name) {
            message.warning('请填写分卷名称')
            return
          }
          setVolumePrompt({ open: false, name: '' })
          await handleCreateVolume(name)
        }}
      >
        <Input
          value={volumePrompt.name}
          onChange={(e) => setVolumePrompt((prev) => ({ ...prev, name: e.target.value }))}
          placeholder="分卷名称"
          aria-label="分卷名称"
          onPressEnter={async () => {
            const name = volumePrompt.name.trim()
            if (!name) return
            setVolumePrompt({ open: false, name: '' })
            await handleCreateVolume(name)
          }}
        />
      </Modal>

      <Modal
        open={volumeDelete !== null}
        title={`该卷有 ${volumeDelete?.affected ?? 0} 章，如何处理？`}
        destroyOnHidden
        onCancel={() => setVolumeDelete(null)}
        footer={[
          <Button key="cancel" onClick={() => setVolumeDelete(null)}>
            取消
          </Button>,
          <Button key="move" type="primary" onClick={() => void doRemoveVolume('move-to-first')}>
            章节移入第一卷
          </Button>,
          <Popconfirm
            key="del"
            title="确定连同章节一起删除？"
            description={`将永久删除该卷及其中 ${volumeDelete?.affected ?? 0} 章与其版本历史，不可恢复。`}
            okText="确定删除"
            okButtonProps={{ danger: true }}
            cancelText="再想想"
            onConfirm={() => void doRemoveVolume('delete-chapters')}
          >
            <Button danger>连同章节删除</Button>
          </Popconfirm>
        ]}
      >
        <Typography.Text type="secondary">
          请选择处理方式。「章节移入第一卷」保留所有章节；「连同章节删除」不可恢复。
        </Typography.Text>
      </Modal>

      {project && (
        <BookExportDialog key={project.meta.id} open={bookOpen} onClose={() => setBookOpen(false)} defaultSelected={exportPresets} />
      )}

      <ConsistencyDrawer projectId={projectId} open={auditOpen} onClose={() => setAuditOpen(false)} onApplied={() => void refresh()} />

      <CharacterEditorModal meta={editTarget} onClose={() => setEditTarget(null)} />
    </div>
  )
}

/* ---------------- 新建作品弹窗 ---------------- */
interface NewProjectModalProps {
  open: boolean
  title: string
  genre: string
  synopsis: string
  target: string
  onChange: {
    setNewTitle: (v: string) => void
    setNewGenre: (v: string) => void
    setNewSynopsis: (v: string) => void
    setNewTarget: (v: string) => void
  }
  onCancel: () => void
  onOk: () => void
}

function NewProjectModal({ open, title, genre, synopsis, target, onChange, onCancel, onOk }: NewProjectModalProps) {
  return (
    <Modal open={open} title="新建作品" okText="创建" cancelText="取消" onOk={onOk} onCancel={onCancel} destroyOnHidden>
      <Space direction="vertical" size={10} style={{ width: '100%', marginTop: 8 }}>
        <Input value={title} onChange={(e) => onChange.setNewTitle(e.target.value)} placeholder="书名（必填）" aria-label="书名" />
        <Space size={8} style={{ width: '100%' }}>
          <Input value={genre} onChange={(e) => onChange.setNewGenre(e.target.value)} placeholder="题材：玄幻 / 都市 / 科幻…" aria-label="题材" style={{ flex: 1 }} />
          <Input value={target} onChange={(e) => onChange.setNewTarget(e.target.value)} placeholder="目标字数" aria-label="目标字数" style={{ width: 140 }} />
        </Space>
        <Input.TextArea
          value={synopsis}
          onChange={(e) => onChange.setNewSynopsis(e.target.value)}
          placeholder="一句话梗概（选填）：主角是谁、要做什么、最大的阻碍是什么"
          aria-label="一句话梗概"
          autoSize={{ minRows: 3, maxRows: 6 }}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          创建后会自动生成「第一卷」，直接在里面建章节即可。
        </Typography.Text>
      </Space>
    </Modal>
  )
}
