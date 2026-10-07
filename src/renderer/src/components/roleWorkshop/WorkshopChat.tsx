import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Dropdown,
  Empty,
  Input,
  Modal,
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
  UndoOutlined,
  NumberOutlined
} from '@ant-design/icons'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { AiChatMessage, KbRefPick, McpToolInfo, WritingSkill } from '@shared/types'
import type { ChatMsg, CharacterMeta, WorldInfo, SamplingParams, AuthorNote, RegexScript, QuickReply } from './types'
import ComposerInput from '../ComposerInput'
import KbTriggerPicker from '../kb/KbTriggerPicker'
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
  // 写作技能库（角色专属技能的数据源；随角色选中自动注入）
  const [libSkills, setLibSkills] = useState<WritingSkill[]>([])
  const [autoSave, setAutoSave] = useState(true)
  const [autoSaveTick, setAutoSaveTick] = useState(0)
  const [dirty, setDirty] = useState(false)
  // MCP 工具（受控上提到此组件，供 ai.chat 构造 tools）
  const [mcpTools, setMcpTools] = useState<McpToolInfo[]>([])
  const [enabledMcp, setEnabledMcp] = useState<string[]>([])
  // 草稿版本历史 / 导出成书
  const [historyOpen, setHistoryOpen] = useState(false)
  const [bookOpen, setBookOpen] = useState(false)
  // # 知识库引用（范式 B：选择器挂载 → 发送时注入 system）
  const [kbRefs, setKbRefs] = useState<KbRefPick[]>([])
  const [kbPickerOpen, setKbPickerOpen] = useState(false)
  const hashArmedRef = useRef(false)
  // 输入区高度：默认自适应；手动拖拽后锁定像素高度（可再拖回）
  const [inputHeight, setInputHeight] = useState<number | 'auto'>(() => {
    try {
      const raw = localStorage.getItem('wb-chat-input-height')
      if (!raw || raw === 'auto') return 'auto'
      const v = Number(raw)
      return Number.isNaN(v) ? 'auto' : Math.max(120, Math.min(Math.round(window.innerHeight * 0.45), v))
    } catch {
      return 'auto'
    }
  })
  const hResizeRef = useRef<{ startY: number; startHeight: number } | null>(null)

  const sessionRef = useRef('')
  const sessionRef2 = useRef('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputDockRef = useRef<HTMLDivElement | null>(null)
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
    [chatId, storeKey]
  )

  const refreshChatList = useCallback(async () => {
    try {
      const list = (await window.api.sillytavern.chatsList(storeKey)) as Array<{ id: string; messageCount: number; lastMessage: string }>
      setChatList(list.map((c) => ({ id: c.id, label: `${c.lastMessage || '空会话'}（${c.messageCount} 条）` })))
    } catch {
      setChatList([])
    }
  }, [storeKey])

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
    // chatId 或 storeKey（按作品隔离）任一变化都重载；切换角色上下文不重置历史
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, storeKey])

  /* ---------- 角色专属技能：库技能加载 + 按当前角色解析 ---------- */
  useEffect(() => {
    void window.api.novel
      .listSkills()
      .then((l) => setLibSkills((l as WritingSkill[]) ?? []))
      .catch(() => undefined)
  }, [])

  const charSkillIds = useMemo(() => {
    const ext = char?.card.extensions as Record<string, unknown> | undefined
    const ids = ext?.lingmoSkills
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
  }, [char])

  const charLibSkills = useMemo(
    () => (charSkillIds.length ? libSkills.filter((s) => charSkillIds.includes(s.id)) : []),
    [libSkills, charSkillIds]
  )

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

  /* ---------- 输入区高度：自适应 + 手动拖拽锁定 ---------- */
  const startHResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const dock = inputDockRef.current
      const startH = typeof inputHeight === 'number' ? inputHeight : (dock?.offsetHeight ?? 200)
      hResizeRef.current = { startY: e.clientY, startHeight: startH }
      // 从 auto 切到固定高度时，先把当前实测高度写入，避免跳变
      setInputHeight(startH)
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
      let latest = startH
      const onMove = (ev: MouseEvent) => {
        const r = hResizeRef.current
        if (!r) return
        const delta = r.startY - ev.clientY
        const maxH = Math.max(200, Math.round(window.innerHeight * 0.45))
        latest = Math.min(maxH, Math.max(120, r.startHeight + delta))
        setInputHeight(latest)
      }
      const onUp = () => {
        hResizeRef.current = null
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        try {
          localStorage.setItem('wb-chat-input-height', String(latest))
        } catch {
          /* ignore */
        }
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [inputHeight]
  )

  /** 恢复自适应高度 */
  const resetInputHeight = useCallback(() => {
    setInputHeight('auto')
    try {
      localStorage.setItem('wb-chat-input-height', 'auto')
    } catch {
      /* ignore */
    }
  }, [])

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
      // 技能约束追加到 system（长短篇共用同一套技能约束；第三参 = 角色专属技能，选中角色时自动生效）
      systemContent = buildSystemWithSkills(systemContent, skills, charLibSkills)

      // 知识库引用注入（# 选择器挂载的资产）
      if (kbRefs.length) {
        try {
          const blocks = await window.api.knowledgeBase.resolveInject(kbRefs, userContent)
          const inject = blocks.length ? await window.api.knowledgeBase.renderInject(blocks) : ''
          if (inject) systemContent = [systemContent, inject].filter(Boolean).join('\n\n')
          // 记录会话级引用（L3）
          for (const p of kbRefs) {
            void window.api.knowledgeBase
              .addReference({
                id: crypto.randomUUID(),
                kbId: storeKey,
                assetId: p.id,
                assetType: p.kind,
                scope: 'session',
                channel: p.channel === 'schema' ? 'load-as-table' : p.channel === 'rag' ? 'rag' : 'full-text',
                referencePosition: `chat:${chatId}`,
                createdAt: Date.now()
              })
              .catch(() => undefined)
          }
        } catch {
          /* 注入失败不阻断对话 */
        }
      }

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
    [char, world, authorNote, skills, primary, secondary, charName, sampling, persist, novelContext, kbRefs, storeKey, chatId, charLibSkills]
  )

  /* ---------- 发送 ---------- */
  const handleInputChange = useCallback((v: string) => {
    setInput(v)
    // 范式 B：行首/空白后的 # 唤起选择器（仅触发一次，选完由按钮再次打开）
    const m = /(^|\s)#(\s|$)/.exec(v)
    if (m && !hashArmedRef.current) {
      hashArmedRef.current = true
      setKbPickerOpen(true)
      // 把触发用的 # 从输入中去掉，避免当正文发出
      setInput(v.replace(/(^|\s)#(\s|$)/, '$1$2'))
    }
    if (!/#/.test(v)) hashArmedRef.current = false
  }, [])

  const send = useCallback(
    async (text?: string) => {
      const content = (text ?? input).trim()
      if (!content || streaming) return
      // D1：聊天下任务 @任务 @角色 说明…
      const hubCreate = (window as unknown as { __hubCreateFromChat?: (s: string) => Promise<boolean> }).__hubCreateFromChat
      if (hubCreate && /^(@任务|@task|\/task|创建任务[:：])/i.test(content)) {
        const handled = await hubCreate(content).catch(() => false)
        if (handled) {
          setInput('')
          return
        }
      }
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
    <div className="workshop-chat" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 工具条：主操作常驻，次操作收进「更多」 */}
      <div className="workshop-chat-toolbar">
        <Input
          aria-label="作品标题"
          variant="borderless"
          className="workshop-chat-title"
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
          className="workshop-chat-session"
          placeholder="历史会话"
          value={chatId}
          options={chatList}
          onChange={switchChat}
          notFoundContent="暂无历史会话"
          showSearch
          optionFilterProp="label"
        />
        <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => void newChat()}>
          新会话
        </Button>
        {onInsertToChapter && (
          <Tooltip title="把最后一条 AI 回复写进当前章节正文">
            <Button
              size="small"
              type="primary"
              icon={<FileAddOutlined />}
              disabled={!lastAiText || streaming}
              onClick={insertToChapter}
            >
              插入本章
            </Button>
          </Tooltip>
        )}
        <div style={{ flex: 1 }} />
        <span className="workshop-chat-meta">
          {char ? char.card.name : '写作助手'}
          {' · '}
          {tokenStats.messages} 条 / ~{tokenStats.tokens} tok
          {streaming ? ' · 生成中' : ''}
          {dirty ? ' · 未保存' : ''}
        </span>
        <Tooltip title="自动保存（每 30 秒）">
          <Switch size="small" checked={autoSave} onChange={setAutoSave} checkedChildren="自动" unCheckedChildren="手动" />
        </Tooltip>
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              { key: 'undo', icon: <UndoOutlined />, label: '撤销最后一条', disabled: messages.length === 0 },
              { key: 'compress', icon: <CompressOutlined />, label: '压缩上下文', disabled: messages.length < 4 },
              { type: 'divider' },
              { key: 'save', label: '保存 Markdown', disabled: messages.length === 0 },
              { key: 'history', icon: <HistoryOutlined />, label: '草稿历史' },
              { key: 'book', icon: <BookOutlined />, label: '导出成书' },
              { type: 'divider' },
              { key: 'clear', icon: <ClearOutlined />, label: '清空会话', danger: true }
            ],
            onClick: ({ key }) => {
              if (key === 'undo') undoLast()
              if (key === 'compress') void compressContext()
              if (key === 'save') void saveManual()
              if (key === 'history') setHistoryOpen(true)
              if (key === 'book') void autoSaveDraft(true).finally(() => setBookOpen(true))
              if (key === 'clear') {
                Modal.confirm({
                  title: '清空当前会话内容？',
                  okText: '清空',
                  okButtonProps: { danger: true },
                  cancelText: '取消',
                  onOk: () => {
                    setMessages([])
                    persist([])
                    setDirty(false)
                  }
                })
              }
            }
          }}
        >
          <Button size="small" type="text" aria-label="更多操作">
            更多
          </Button>
        </Dropdown>
      </div>

      {/* 消息区：居中阅读栏，弱化壁纸干扰 */}
      <div ref={scrollRef} className="workshop-chat-stream">
        <div className="workshop-chat-stream-inner">
        {messages.length === 0 ? (
          <Empty
            style={{ marginTop: 48 }}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              char
                ? `与 ${char.card.name} 对话。右侧可配置世界书 / 预设 / 作者注释。`
                : '选择左侧角色注入人设，或直接开始写作。输入 # 可挂载本地知识库。'
            }
          />
        ) : (
          messages.map((m, i) => {
            const isSys = m.extra?.role === 'system' || m.name === 'system'
            const isUser = m.is_user
            const lines = estimateLines(m.mes)
            const overflow = lines > MAX_VISIBLE_LINES
            const collapsed = overflow && m.extra?.collapsed !== false
            const visibleText = collapsed ? m.mes.split('\n').slice(0, MAX_VISIBLE_LINES).join('\n') + '\n…（已折叠）' : m.mes
            const markdownMode = !isUser && !isSys
            return (
              <div key={i} className="workshop-msg">
                <div
                  className="workshop-msg-avatar"
                  style={{
                    background: isUser ? 'var(--accent, #1677ff)' : isSys ? '#faad14' : '#722ed1'
                  }}
                >
                  {avatarText(m)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="workshop-msg-head">
                    <Typography.Text strong style={{ fontSize: 13 }}>
                      {displayName(m)}
                    </Typography.Text>
                    {overflow && (
                      <Button size="small" type="link" style={{ padding: 0, height: 'auto', fontSize: 12 }} onClick={() => toggleCollapse(i)}>
                        {collapsed ? `展开 ${lines - MAX_VISIBLE_LINES} 行` : '收起'}
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
                      className="markdown-preview workshop-msg-body workshop-msg-body-md"
                      dangerouslySetInnerHTML={{ __html: renderPreview(visibleText) }}
                    />
                  ) : (
                    <div
                      className="workshop-msg-body"
                      style={{
                        background: isUser ? 'var(--accent-soft, rgba(22,119,255,.1))' : 'var(--bg-elevated, #fff)'
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
      </div>

      {/* 上下拖拽：自适应 ↔ 手动锁定高度 */}
      <div
        className="workshop-input-resize"
        title={inputHeight === 'auto' ? '拖动可固定输入区高度；双击恢复自适应' : '拖动调整输入区高度；双击恢复自适应'}
        onMouseDown={startHResize}
        onDoubleClick={resetInputHeight}
      >
        <div className="workshop-input-resize-bar" />
      </div>

      {/* 输入区：与消息流同宽对齐，高度自适应或按拖拽锁定 */}
      <div
        ref={inputDockRef}
        className="workshop-input-dock"
        style={
          inputHeight === 'auto'
            ? { height: 'auto', minHeight: 148, maxHeight: '42%' }
            : { height: inputHeight, minHeight: 120 }
        }
      >
        <div className="workshop-input-dock-inner">
          {quickReplies.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8, flexShrink: 0 }}>
              {quickReplies.map((q) => (
                <Button key={q.id} size="small" onClick={() => void send(q.message)}>
                  {q.label}
                </Button>
              ))}
            </div>
          )}
          {kbRefs.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8, flexShrink: 0, alignItems: 'center' }}>
              {kbRefs.map((r) => (
                <Tag
                  key={`${r.kind}:${r.id}`}
                  closable
                  color={r.kind === 'data' ? 'gold' : r.kind === 'worldbook' ? 'purple' : 'blue'}
                  onClose={() => setKbRefs((prev) => prev.filter((x) => !(x.kind === r.kind && x.id === r.id)))}
                  style={{ margin: 0 }}
                >
                  {r.name}
                  <span style={{ opacity: 0.65, marginLeft: 4 }}>
                    {r.channel === 'rag' ? '检索' : r.channel === 'schema' ? '表结构' : '全文'}
                  </span>
                </Tag>
              ))}
              <Button size="small" type="link" style={{ padding: 0, height: 'auto' }} onClick={() => setKbPickerOpen(true)}>
                管理引用
              </Button>
            </div>
          )}
          {charLibSkills.length > 0 && (
            <div style={{ marginBottom: 6, display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                角色专属技能（自动生效）：
              </Typography.Text>
              {charLibSkills.map((s) => (
                <Tooltip key={s.id} title={(s.template || s.description || '').slice(0, 200)}>
                  <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                    {s.name}
                  </Tag>
                </Tooltip>
              ))}
            </div>
          )}
          <div className="workshop-composer-slot">
            <ComposerInput
              compact
              intro={
                char
                  ? `与 ${char.card.name} 对话 · # 挂载知识库`
                  : 'AI 写作助手 · 输入 # 挂载知识库 · 选中章节后可插入本章'
              }
              value={input}
              onChange={handleInputChange}
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
              extraActions={
                <Tooltip title="引用本地知识库（或输入 #）">
                  <Button
                    size="small"
                    icon={<NumberOutlined />}
                    onClick={() => setKbPickerOpen(true)}
                    type={kbRefs.length ? 'primary' : 'default'}
                  >
                    知识库{kbRefs.length ? ` ${kbRefs.length}` : ''}
                  </Button>
                </Tooltip>
              }
              placeholder={
                char
                  ? `与 ${char.card.name} 对话…（Enter 发送；# 挂载知识库）`
                  : '输入消息…（Enter 发送；# 挂载知识库）'
              }
              promptSource="writing"
            />
          </div>
        </div>
      </div>

      <KbTriggerPicker
        open={kbPickerOpen}
        onClose={() => {
          setKbPickerOpen(false)
          hashArmedRef.current = false
        }}
        value={kbRefs}
        onChange={setKbRefs}
      />

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
