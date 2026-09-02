import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Empty,
  Input,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message
} from 'antd'
import {
  BookOutlined,
  ClearOutlined,
  CompressOutlined,
  EditOutlined,
  FileAddOutlined,
  HistoryOutlined,
  PlusOutlined,
  ReloadOutlined,
  UndoOutlined
} from '@ant-design/icons'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { AiChatMessage, McpToolInfo } from '@shared/types'
import type { ChatMsg, CharacterMeta, WorldInfo, SamplingParams, AuthorNote, RegexScript, QuickReply } from './types'
import ComposerInput from '../ComposerInput'
import { buildTools, buildSystemWithSkills } from './assistantCore'
import SnapshotDrawer from '../SnapshotDrawer'
import BookExportDialog from '../BookExportDialog'

interface Props {
  /** null = 写作助手（无角色）；非 null = 已选角色卡（作为对话上下文，而非切换引擎） */
  char: CharacterMeta | null
  world: WorldInfo | null
  sampling: SamplingParams
  authorNote: AuthorNote | null
  regex: RegexScript[]
  quickReplies: QuickReply[]
  /** 默认模型（初始化主模型） */
  model: string
  chatId: string
  onChatIdChange: (id: string) => void
  /**
   * 长篇上下文（可选）：传入后系统提示会叠加 novel:build-context 编译的
   * 「设定 / 细纲 / 实体 / 召回」参考材料，与角色 / 世界书上下文共存。
   */
  novelContext?: { projectId: string; chapterId: string | null }
  /** 提供时（章节已加载）显示「插入本章」，把最后一条 AI 回复写进编辑器正文 */
  onInsertToChapter?: (text: string) => void
  /** 持久化命名空间（默认 'default'）；长篇可传 `novel:<projectId>` 隔离助手会话 */
  storeKey?: string
}

const MD_MODEL_OPTIONS = ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4', 'claude-opus-4', 'llama3.1', 'qwen2.5', 'deepseek-chat', 'gemini-1.5-pro', 'gpt-4.1']
const MAX_VISIBLE_LINES = 50

/** 估算文本可视行数（按 80 字符折一行 + 换行符） */
function estimateLines(text: string, cols = 80): number {
  if (!text) return 0
  const explicit = text.split('\n').length - 1
  let wrap = 0
  for (const line of text.split('\n')) wrap += Math.ceil((line.length || 1) / cols)
  return explicit + wrap
}

/** 估算 token（中文 1.5 字符/token、英文 4 字符/token） */
function estimateTokens(text: string): number {
  if (!text) return 0
  const cn = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const en = (text.match(/[a-zA-Z0-9 ]/g) ?? []).length
  return Math.ceil(cn / 1.5 + en / 4)
}

/** ChatMsg → AiChatMessage（系统摘要/用户/AI） */
function toAiMessage(m: ChatMsg): AiChatMessage {
  if (m.is_user) return { role: 'user', content: m.mes }
  if (m.extra?.role === 'system' || m.name === 'system') return { role: 'system', content: m.mes }
  return { role: 'assistant', content: m.mes }
}

/** 序列化会话为 Markdown */
function toMarkdown(title: string, messages: ChatMsg[]): string {
  const date = new Date().toLocaleString('zh-CN')
  const lines: string[] = [`# ${title}`, '', `> 生成时间：${date}`, `> 消息数：${messages.length}`, '']
  for (const m of messages) {
    const isSys = m.extra?.role === 'system' || m.name === 'system'
    const tag = m.is_user ? '🧑 我' : isSys ? '⚙ 摘要' : '🤖 AI'
    lines.push(`## ${tag}`, '', m.mes, '')
  }
  return lines.join('\n')
}

/* ============================================
 * 统一对话引擎（写作对话 + 角色上下文 融合）
 * - 引擎统一为 ai.chat：支持技能约束、MCP 工具调用、上下文压缩、双模型并行
 * - 角色卡 / 世界书 / 作者注释 / 预设 经 sillytavern:build-context 编译为 system 注入，
 *   与写作对话共用同一会话，可随时切换角色上下文而不丢失历史
 * - 会话统一持久化 chatsSave('default', chatId)，流式按 sessionId 精确匹配
 * ============================================ */
export default function WorkshopChat(props: Props) {
  const { char, world, sampling, authorNote, quickReplies, model, chatId, onChatIdChange, novelContext, onInsertToChapter, storeKey: storeKeyProp } = props
  // 融合模式下 char 仅作为上下文，不再切换引擎
  const charName = char?.card.name ?? 'AI 助手'
  const storeKey = storeKeyProp ?? 'default' // 写作/角色共用 'default'；长篇助手可传 'novel:<projectId>'

  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [chatList, setChatList] = useState<Array<{ id: string; label: string }>>([])
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  // 写作对话状态
  const [title, setTitle] = useState('未命名写作')
  const [primary, setPrimary] = useState('')
  const [secondary, setSecondary] = useState('')
  const [skills, setSkills] = useState<string[]>(['md', 'concise'])
  const [autoSave, setAutoSave] = useState(true)
  const [autoSaveTick, setAutoSaveTick] = useState(0)
  const [dirty, setDirty] = useState(false)
  // MCP 工具（受控上提到此组件，供 ai.chat 构造 tools）
  const [mcpTools, setMcpTools] = useState<McpToolInfo[]>([])
  const [enabledMcp, setEnabledMcp] = useState<string[]>([])
  // 草稿版本历史 / 导出成书
  const [historyOpen, setHistoryOpen] = useState(false)
  const [bookOpen, setBookOpen] = useState(false)
  // 输入区高度可拖拽调整
  const [inputHeight, setInputHeight] = useState(() => {
    try {
      const v = Number(localStorage.getItem('wb-chat-input-height'))
      return Number.isNaN(v) ? 200 : Math.max(120, Math.min(400, v))
    } catch {
      return 200
    }
  })
  const hResizeRef = useRef<{ startY: number; startHeight: number } | null>(null)

  const sessionRef = useRef('')
  const sessionRef2 = useRef('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /* 默认模型（父级传值 + 兜底自读配置） */
  useEffect(() => {
    setPrimary((cur) => cur || model)
  }, [model])
  useEffect(() => {
    window.api.ai
      .getConfig()
      .then((cfg) => setPrimary((cur) => cur || cfg.model || 'gpt-4o'))
      .catch(() => setPrimary((cur) => cur || 'gpt-4o'))
  }, [])

  /* 加载已安装的 MCP 工具列表 */
  useEffect(() => {
    void window.api.mcp
      .listTools()
      .then((l) => setMcpTools((l as McpToolInfo[]) ?? []))
      .catch(() => undefined)
  }, [])

  /* ---------- 持久化 ---------- */
  const persist = useCallback(
    (msgs: ChatMsg[]) => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        void window.api.sillytavern.chatsSave(storeKey, chatId, msgs)
      }, 400)
    },
    [chatId]
  )

  const refreshChatList = useCallback(async () => {
    try {
      const list = (await window.api.sillytavern.chatsList(storeKey)) as Array<{ id: string; messageCount: number; lastMessage: string }>
      setChatList(list.map((c) => ({ id: c.id, label: `${c.lastMessage || '空会话'}（${c.messageCount} 条）` })))
    } catch {
      setChatList([])
    }
  }, [])

  /* ---------- 加载/切换会话 ---------- */
  useEffect(() => {
    if (!chatId) return
    void window.api.sillytavern.chatsGet(storeKey, chatId).then((msgs) => {
      const list = (msgs as ChatMsg[]) ?? []
      setMessages(list)
      if (list.length === 0 && char?.card.first_mes) {
        const first: ChatMsg = {
          name: char.card.name,
          is_user: false,
          is_name: true,
          send_date: new Date().toISOString(),
          mes: char.card.first_mes
        }
        setMessages([first])
        void window.api.sillytavern.chatsSave(storeKey, chatId, [first])
      }
      refreshChatList()
    })
    // 仅 chatId 变化才重载；切换角色上下文不重置历史
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId])

  /* ---------- 自动滚动 ---------- */
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, streaming])

  /* ---------- 自动保存草稿（30s 静默写 MD，写作助手通用） ---------- */
  useEffect(() => {
    if (!autoSave || messages.length === 0) return
    const t = setInterval(() => {
      void autoSaveDraft(true)
    }, 30000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSave, messages])

  const tokenStats = useMemo(() => {
    const total = messages.reduce((n, m) => n + estimateTokens(m.mes), 0)
    return { messages: messages.length, tokens: total }
  }, [messages])

  /* 最后一条 AI 回复正文（用于「插入本章」——章节已加载时由父组件提供 onInsertToChapter） */
  const lastAiText = useMemo(() => {
    const m = [...messages].reverse().find((x) => !x.is_user && x.extra?.role !== 'system' && x.mes.trim())
    return m?.mes ?? ''
  }, [messages])

  const insertToChapter = useCallback(() => {
    if (lastAiText && onInsertToChapter) onInsertToChapter(lastAiText)
  }, [lastAiText, onInsertToChapter])

  /* ---------- 输入区高度拖拽调整 ---------- */
  const startHResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    hResizeRef.current = { startY: e.clientY, startHeight: inputHeight }
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: MouseEvent) => {
      const r = hResizeRef.current
      if (!r) return
      const delta = r.startY - ev.clientY
      const next = Math.min(400, Math.max(120, r.startHeight + delta))
      setInputHeight(next)
    }
    const onUp = () => {
      hResizeRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      try {
        localStorage.setItem('wb-chat-input-height', String(inputHeight))
      } catch {
        /* ignore */
      }
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [inputHeight])

  /* ---------- 停止 ---------- */
  const stop = useCallback(async (): Promise<void> => {
    const ids = [sessionRef.current, sessionRef2.current].filter(Boolean)
    for (const id of ids) {
      await window.api.sillytavern.stop(id).catch(() => undefined)
      await window.api.ai.stop(id).catch(() => undefined)
    }
    sessionRef.current = ''
    sessionRef2.current = ''
    setStreaming(false)
  }, [])

  /**
   * 卸载（切标签/关页面）时若仍有生成在进行，主动中断主进程流。
   */
  useEffect(
    () => () => {
      const ids = [sessionRef.current, sessionRef2.current].filter(Boolean)
      for (const id of ids) {
        void window.api.sillytavern.stop(id).catch(() => undefined)
        void window.api.ai.stop(id).catch(() => undefined)
      }
    },
    []
  )

  /* ---------- 流式接收（按 sessionId 精确匹配，双模型并行各自分道） ---------- */
  useEffect(() => {
    const offChunk = window.api.ai.onChunk((p) => {
      setMessages((prev) => {
        const idx = prev.findIndex((m) => !m.is_user && m.extra?.sessionId === p.sessionId)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = { ...next[idx], mes: next[idx].mes + p.chunk }
          return next
        }
        for (let i = prev.length - 1; i >= 0; i--) {
          if (!prev[i].is_user && prev[i].extra?.streaming) {
            const next = [...prev]
            next[i] = { ...next[i], mes: next[i].mes + p.chunk }
            return next
          }
        }
        return [...prev, { name: charName, is_user: false, is_name: true, send_date: new Date().toISOString(), mes: p.chunk, extra: { streaming: true, sessionId: p.sessionId } }]
      })
    })
    const offDone = window.api.ai.onDone((p) => {
      setMessages((prev) => {
        const idx = prev.findIndex((m) => !m.is_user && m.extra?.sessionId === p.sessionId)
        if (idx < 0) return prev
        const next = [...prev]
        const m = { ...next[idx], extra: { ...(next[idx].extra ?? {}), streaming: false, ...(p.ok ? {} : { error: true }) } }
        m.swipes = m.swipes ?? []
        if (!m.swipes.includes(m.mes)) m.swipes.push(m.mes)
        m.swipe_id = m.swipes.length - 1
        next[idx] = m
        persist(next)
        return next
      })
    })
    return () => {
      offChunk()
      offDone()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId])

  /**
   * 统一的一轮对话：构造系统上下文 → 调用 ai.chat。
   * baseMessages 为「本轮回合之前」的历史（已过滤流式占位）。
   */
  const runTurn = useCallback(
    async (userContent: string, baseMessages: ChatMsg[]) => {
      const history = baseMessages.filter((m) => !m.extra?.streaming)
      const userMsg: ChatMsg = { name: '用户', is_user: true, is_name: true, send_date: new Date().toISOString(), mes: userContent }

      // 系统上下文（统一叠加，长短篇共用同一套引擎）：
      // 1) 角色 / 世界书 / 作者注释 → sillytavern:build-context
      // 2) 长篇上下文（设定/细纲/实体/召回）→ novel:build-context + novel:render-context
      let systemContent: string | undefined
      const hasRoleCtx = !!char || !!world || !!(authorNote && authorNote.enabled)
      if (hasRoleCtx) {
        try {
          const conversationText = history.map((m) => m.mes).join('\n') + '\n' + userContent
          const ctx = await window.api.sillytavern.buildContext({
            card: char?.card ?? null,
            world: world ?? null,
            conversationText,
            authorNote: authorNote ?? null
          })
          if (ctx) systemContent = ctx
        } catch {
          /* 忽略：退化为纯写作 systemPrompt */
        }
      }
      if (novelContext) {
        try {
          const bundle = await window.api.novel.buildContext(novelContext.projectId, novelContext.chapterId ?? '', {})
          if (bundle) {
            const rendered = await window.api.novel.renderContext(bundle.blocks)
            if (rendered?.text) {
              systemContent = [systemContent, rendered.text].filter(Boolean).join('\n\n')
            }
          }
        } catch {
          /* 忽略：退化为无长篇上下文 */
        }
      }
      // 技能约束追加到 system（长短篇共用同一套技能约束）
      systemContent = buildSystemWithSkills(systemContent, skills)

      const aiHistory: AiChatMessage[] = []
      if (systemContent) aiHistory.push({ role: 'system', content: systemContent })
      aiHistory.push(...history.map(toAiMessage), { role: 'user', content: userContent })

      // 工具：仅主模型启用（双模型并行时避免工具调用竞态）
      const tools = buildTools(enabledMcp, mcpTools)
      const sid = crypto.randomUUID()
      sessionRef.current = sid
      const placeholder = (n: string): ChatMsg => ({
        name: n,
        is_user: false,
        is_name: true,
        send_date: new Date().toISOString(),
        mes: '',
        extra: { streaming: true, sessionId: sid }
      })
      const placeholders: ChatMsg[] = [placeholder(charName)]
      const jobs: Promise<unknown>[] = [
        window.api.ai
          .chat(sid, aiHistory, primary, tools.length ? tools : undefined, sampling as unknown as Record<string, number | string | boolean>)
          .catch(() => undefined)
      ]
      if (secondary && secondary !== primary) {
        const sid2 = crypto.randomUUID()
        sessionRef2.current = sid2
        placeholders.push({ ...placeholder('AI 助手'), extra: { streaming: true, sessionId: sid2 } })
        jobs.push(window.api.ai.chat(sid2, aiHistory, secondary).catch(() => undefined))
      }
      setMessages([...history, userMsg, ...placeholders])
      persist([...history, userMsg])
      setStreaming(true)
      await Promise.all(jobs)
      sessionRef.current = ''
      sessionRef2.current = ''
      setStreaming(false)
    },
    [char, world, authorNote, skills, primary, secondary, charName, sampling, persist, novelContext]
  )

  /* ---------- 发送 ---------- */
  const send = useCallback(
    async (text?: string) => {
      const content = (text ?? input).trim()
      if (!content || streaming) return
      setInput('')
      setDirty(true)
      const base = messages.filter((m) => !m.extra?.streaming)
      await runTurn(content, base)
    },
    [input, streaming, messages, runTurn]
  )

  /* ---------- 重新生成（重发最后一条用户消息，写作/角色通用） ---------- */
  const regenerate = useCallback(async () => {
    if (streaming) return
    const revIdx = [...messages].reverse().findIndex((m) => m.is_user)
    if (revIdx < 0) return
    const realIdx = messages.length - 1 - revIdx
    const userContent = messages[realIdx].mes
    const base = messages.slice(0, realIdx).filter((m) => !m.extra?.streaming)
    await runTurn(userContent, base)
  }, [messages, streaming, runTurn])

  /* ---------- 编辑消息 ---------- */
  const commitEdit = useCallback(
    (idx: number) => {
      setMessages((prev) => {
        const next = [...prev]
        next[idx] = { ...next[idx], mes: editText }
        persist(next)
        return next
      })
      setEditingIdx(null)
    },
    [editText, persist]
  )

  /* ---------- 新会话 / 清空 / 撤销 ---------- */
  const newChat = useCallback(async () => {
    const id = (await window.api.sillytavern.chatsNewId()) as string
    setMessages([])
    setDirty(false)
    onChatIdChange(id)
    void window.api.sillytavern.chatsActiveSet(storeKey, id)
    refreshChatList()
  }, [onChatIdChange, refreshChatList])

  const switchChat = useCallback(
    (id: string) => {
      setMessages([])
      onChatIdChange(id)
      void window.api.sillytavern.chatsActiveSet(storeKey, id)
    },
    [onChatIdChange]
  )

  const undoLast = useCallback(() => {
    setMessages((prev) => {
      if (prev.length === 0) return prev
      const next = prev.slice(0, -1)
      persist(next)
      return next
    })
  }, [persist])

  /* ---------- 压缩上下文（把早期对话总结为摘要） ---------- */
  const compressContext = useCallback(async () => {
    if (messages.length < 4) {
      message.warning('当前对话过短，无需压缩')
      return
    }
    const summaryPrompt: AiChatMessage[] = [
      { role: 'system', content: '请将以下对话压缩为 200 字内的精炼摘要，保留用户意图、关键约束、最终结论与未解决问题。要求客观、信息密度高、可直接续写。' },
      ...messages.slice(0, -2).map(toAiMessage),
      { role: 'user', content: '请生成摘要。' }
    ]
    try {
      const result = await window.api.ai.complete(summaryPrompt)
      const summary = result.text.trim()
      if (!summary) {
        message.error('摘要生成失败')
        return
      }
      const summaryMsg: ChatMsg = {
        name: 'system',
        is_user: false,
        is_name: true,
        send_date: new Date().toISOString(),
        mes: `[历史摘要]\n${summary}`,
        extra: { role: 'system' }
      }
      const newMsgs: ChatMsg[] = [summaryMsg, ...messages.slice(-2)]
      setMessages(newMsgs)
      persist(newMsgs)
      message.success(`已压缩 ${messages.length} → 1 条摘要`)
    } catch (err) {
      message.error('压缩失败：' + (err as Error).message)
    }
  }, [messages, persist])

  /* ---------- 保存 / 草稿 ---------- */
  const docTitle = char?.card.name ?? title

  const saveManual = useCallback(async () => {
    if (messages.length === 0) {
      message.warning('暂无内容可保存')
      return
    }
    const md = toMarkdown(docTitle, messages)
    try {
      const safe = docTitle.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || '写作'
      const saved = await window.api.exportText(`${safe}-${new Date().toISOString().slice(0, 10)}.md`, md)
      if (saved) {
        message.success('已保存：' + saved)
        setDirty(false)
      }
    } catch (err) {
      message.error('保存失败：' + (err as Error).message)
    }
  }, [messages, docTitle])

  const autoSaveDraft = useCallback(
    async (silent = false) => {
      if (messages.length === 0) return
      const md = toMarkdown(docTitle, messages)
      try {
        const saved = await window.api.writing.saveDraft(docTitle, md)
        if (saved && !silent) message.success('草稿已保存：' + saved)
        setAutoSaveTick(Date.now())
        setDirty(false)
      } catch {
        /* ignore silent failure */
      }
    },
    [messages, docTitle]
  )

  /**
   * 草稿 ID：必须与主进程 writing:save-draft 的落盘命名规则一致，
   * 否则版本历史会查到另一份（空）快照目录。
   */
  const draftId = useMemo(
    () => (docTitle || '未命名写作').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || '写作',
    [docTitle]
  )

  // 仅在需要时（手动打点 / 回滚前的当前内容）才序列化，避免每来一条消息都整篇重算
  const currentMarkdown = useMemo(
    () => (historyOpen ? toMarkdown(docTitle, messages) : ''),
    [historyOpen, docTitle, messages]
  )

  /**
   * 回滚草稿：把历史正文覆盖回草稿文件（主进程会先给当前内容留 pre-restore 快照）。
   */
  const handleRestoreDraft = useCallback(
    async (restored: string) => {
      try {
        await window.api.writing.saveDraft(docTitle, restored)
        setAutoSaveTick(Date.now())
      } catch {
        message.error('回滚草稿写入失败')
      }
    },
    [docTitle]
  )

  /* ---------- 渲染辅助 ---------- */
  const renderPreview = (text: string): string => {
    try {
      return DOMPurify.sanitize(marked.parse(text) as string)
    } catch {
      return ''
    }
  }

  const toggleCollapse = (idx: number): void => {
    setMessages((prev) => prev.map((m, i) => (i === idx ? { ...m, extra: { ...(m.extra ?? {}), collapsed: !m.extra?.collapsed } } : m)))
  }

  const displayName = (m: ChatMsg): string => {
    if (m.is_user) return '我'
    if (m.extra?.role === 'system' || m.name === 'system') return '上下文摘要'
    return m.name || charName
  }

  const avatarText = (m: ChatMsg): string => {
    if (m.is_user) return '我'
    if (m.extra?.role === 'system' || m.name === 'system') return '⚙'
    return charName.slice(0, 1)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 工具条 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', flexWrap: 'wrap' }}>
        <Input
          aria-label="作品标题"
          variant="borderless"
          style={{ maxWidth: 180, fontWeight: 600, fontSize: 14 }}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value || '未命名写作')
            setDirty(true)
          }}
          placeholder="作品标题"
        />
        <Select
          aria-label="切换历史会话"
          size="small"
          style={{ minWidth: 160, maxWidth: 240 }}
          placeholder="切换历史会话"
          value={chatId}
          options={chatList}
          onChange={switchChat}
          notFoundContent="暂无历史会话"
        />
        <Button size="small" icon={<PlusOutlined />} onClick={() => void newChat()}>
          新会话
        </Button>
        <Popconfirm title="清空当前会话内容？" onConfirm={() => { setMessages([]); persist([]); setDirty(false) }}>
          <Button size="small" icon={<ClearOutlined />} danger>
            清空
          </Button>
        </Popconfirm>
        <Tooltip title="撤销最后一条">
          <Button size="small" icon={<UndoOutlined />} disabled={messages.length === 0} onClick={undoLast} />
        </Tooltip>
        <Tooltip title="压缩上下文：把早期对话总结为一段摘要">
          <Button size="small" icon={<CompressOutlined />} disabled={messages.length < 4} onClick={() => void compressContext()}>
            压缩
          </Button>
        </Tooltip>
        {onInsertToChapter && (
          <Tooltip title="把最后一条 AI 回复写进当前章节正文（插入到光标处）">
            <Button size="small" type="primary" icon={<FileAddOutlined />} disabled={!lastAiText || streaming} onClick={insertToChapter}>
              插入本章
            </Button>
          </Tooltip>
        )}
        <div style={{ flex: 1 }} />
        {char ? (
          <Tag color="blue" style={{ margin: 0 }}>{char.card.name}</Tag>
        ) : (
          <Tag color="processing" style={{ margin: 0 }}>写作助手</Tag>
        )}
        {char && world && <Tag style={{ margin: 0 }}>世界书：{world.name}</Tag>}
        <Tag style={{ margin: 0 }}>上下文 {tokenStats.messages} 条 / 约 {tokenStats.tokens} token</Tag>
        {streaming && <Tag color="processing" style={{ margin: 0 }}>生成中</Tag>}
        {dirty && <Tag color="orange" style={{ margin: 0 }}>未保存</Tag>}
        {autoSaveTick > 0 && <Tag color="green" style={{ margin: 0 }}>草稿已保存</Tag>}
        <Tooltip title="自动保存（30s）">
          <Switch size="small" checked={autoSave} onChange={setAutoSave} checkedChildren="自动保存" unCheckedChildren="手动" />
        </Tooltip>
        <Button size="small" disabled={messages.length === 0} onClick={() => void saveManual()}>
          保存 MD
        </Button>
        <Tooltip title="草稿历史：查看与回滚这篇写作的历次自动/手动保存">
          <Button size="small" icon={<HistoryOutlined />} onClick={() => setHistoryOpen(true)}>
            历史
          </Button>
        </Tooltip>
        <Tooltip title="导出成书：把写作草稿与笔记拼成一本书">
          <Button
            size="small"
            icon={<BookOutlined />}
            onClick={() => {
              void autoSaveDraft(true).finally(() => setBookOpen(true))
            }}
          >
            成书
          </Button>
        </Tooltip>
      </div>

      {/* 消息区 */}
      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 16px', background: 'var(--bg-canvas, #fafafa)' }}>
        {messages.length === 0 ? (
          <Empty
            style={{ marginTop: 60 }}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              char
                ? `与 ${char.card.name} 对话 —— 世界书 / 预设 / 作者注释已作为上下文生效，亦可挂载 MCP 工具与技能约束。`
                : '统一的 AI 写作助手 —— 可在左侧选择角色卡注入人设、挂载 MCP 工具与技能约束；选中章节后，回复可一键「插入本章」。长对话自动折叠、可一键保存为 Markdown。'
            }
          />
        ) : (
          messages.map((m, i) => {
            const isSys = m.extra?.role === 'system' || m.name === 'system'
            const isUser = m.is_user
            const lines = estimateLines(m.mes)
            const overflow = lines > MAX_VISIBLE_LINES
            const collapsed = overflow && m.extra?.collapsed !== false
            const visibleText = collapsed ? m.mes.split('\n').slice(0, MAX_VISIBLE_LINES).join('\n') + '\n…（已折叠，点击展开）' : m.mes
            const markdownMode = !isUser && !isSys
            return (
              <div key={i} style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'flex-start' }}>
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: isUser ? '#1677ff' : isSys ? '#faad14' : '#722ed1',
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 12,
                    flexShrink: 0
                  }}
                >
                  {avatarText(m)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <Typography.Text strong style={{ fontSize: 13 }}>
                      {displayName(m)}
                    </Typography.Text>
                    {overflow && (
                      <Button size="small" type="link" style={{ padding: 0, height: 'auto' }} onClick={() => toggleCollapse(i)}>
                        {collapsed ? `展开（${lines - MAX_VISIBLE_LINES} 行）` : '收起'}
                      </Button>
                    )}
                    {m.extra?.error && <Tag color="red" style={{ margin: 0 }}>错误</Tag>}
                    {m.extra?.streaming && <Tag color="processing" style={{ margin: 0 }}>生成中</Tag>}
                    {!isUser && !isSys && !m.extra?.streaming && (
                      <Button size="small" type="text" icon={<ReloadOutlined />} style={{ fontSize: 11 }} onClick={() => void regenerate()}>
                        重生成
                      </Button>
                    )}
                    {!m.extra?.streaming && (
                      <Button size="small" type="text" icon={<EditOutlined />} style={{ fontSize: 11 }} onClick={() => { setEditingIdx(i); setEditText(m.mes) }}>
                        编辑
                      </Button>
                    )}
                  </div>
                  {editingIdx === i ? (
                    <Space.Compact style={{ width: '100%' }}>
                      <Input.TextArea aria-label="编辑消息内容" autoSize={{ minRows: 1, maxRows: 6 }} value={editText} onChange={(e) => setEditText(e.target.value)} />
                      <Button type="primary" onClick={() => commitEdit(i)}>保存</Button>
                      <Button onClick={() => setEditingIdx(null)}>取消</Button>
                    </Space.Compact>
                  ) : markdownMode && !collapsed ? (
                    <div
                      className="markdown-preview"
                      style={{ fontSize: 14, lineHeight: 1.7, padding: '8px 12px', borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--lm-border)', boxShadow: '0 1px 2px rgba(0,0,0,.04)' }}
                      dangerouslySetInnerHTML={{ __html: renderPreview(visibleText) }}
                    />
                  ) : (
                    <div
                      className="ai-msg-bubble"
                      style={{
                        whiteSpace: 'pre-wrap',
                        fontSize: 14,
                        lineHeight: 1.7,
                        padding: '8px 12px',
                        borderRadius: 10,
                        background: isUser ? 'var(--accent-soft)' : 'var(--bg-elevated)',
                        border: '1px solid var(--lm-border)',
                        boxShadow: '0 1px 2px rgba(0,0,0,.04)'
                      }}
                    >
                      {visibleText || (m.extra?.streaming ? <Spin size="small" /> : '')}
                    </div>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* 水平拖拽条：上下拖动调整输入区高度 */}
      <div
        title="上下拖动调整输入区高度"
        onMouseDown={startHResize}
        style={{
          height: 6,
          flexShrink: 0,
          cursor: 'row-resize',
          background: 'transparent',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <div style={{ width: '60%', height: 1, background: 'var(--border-color, rgba(128,128,128,.25))' }} />
      </div>

      {/* 输入区 */}
      <div style={{ height: inputHeight, padding: '8px 16px 16px', background: 'var(--bg-canvas, #fafafa)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {quickReplies.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {quickReplies.map((q) => (
              <Button key={q.id} size="small" onClick={() => void send(q.message)}>
                {q.label}
              </Button>
            ))}
          </div>
        )}
        <div style={{ flex: 1, minHeight: 0 }}>
          <ComposerInput
            intro={
              char
                ? `与 ${char.card.name} 对话 —— 角色卡 / 世界书 / 预设 / 作者注释已作为上下文生效；技能约束、MCP 工具、上下文压缩均可使用。`
                : '统一的 AI 写作助手 —— 可选左侧角色卡注入人设、右侧世界书 / 设定面板作为上下文；选中章节后可把回复「插入本章」。技能约束、MCP 工具、上下文压缩均可用。'
            }
            value={input}
            onChange={setInput}
            onSend={() => void send()}
            onStop={() => void stop()}
            streaming={streaming}
            model={primary}
            onModelChange={setPrimary}
            secondaryModel={secondary}
            onSecondaryModelChange={setSecondary}
            modelOptions={MD_MODEL_OPTIONS}
            skills={skills}
            onSkillsChange={setSkills}
            mcpTools={mcpTools}
            enabledMcp={enabledMcp}
            onEnabledMcpChange={setEnabledMcp}
            placeholder={
              char
                ? `与 ${char.card.name} 对话…（Enter 发送，Shift+Enter 换行）`
                : '输入消息，Enter 发送，Shift+Enter 换行'
            }
            promptSource="writing"
          />
        </div>
      </div>

      <SnapshotDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        kind="draft"
        targetId={draftId}
        currentContent={currentMarkdown}
        onRestore={(c) => void handleRestoreDraft(c)}
      />
      <BookExportDialog
        open={bookOpen}
        onClose={() => setBookOpen(false)}
        defaultSelected={[{ kind: 'draft', id: draftId }]}
      />
    </div>
  )
}
