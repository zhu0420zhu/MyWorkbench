import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Button, Empty, Input, Modal, Segmented, Select, Space, Tag, Tooltip, Typography, message } from 'antd'
import { CloseOutlined, FlagOutlined, HistoryOutlined, SaveOutlined, ThunderboltOutlined } from '@ant-design/icons'
import type { AiEditAction, Chapter, ChapterStatus } from '@shared/types'
import SnapshotDrawer from '../SnapshotDrawer'
import { STATUS_META } from './ChapterTree'

const STATUS_OPTIONS = (Object.keys(STATUS_META) as ChapterStatus[]).map((v) => ({
  label: STATUS_META[v].label,
  value: v
}))

interface ChapterEditorProps {
  chapter: Chapter | null
  disabled: boolean
  /**
   * 保存。**chapterId 必须由调用方显式传入**，不能依赖父组件的 "当前章节" 状态：
   * 切换章节时父组件的 activeChapterId 已经先更新了，而本组件的卸载清理钩子还在保存上一章，
   * 若让保存去读"当前章节"，就会把 A 章的正文写进 B 章（静默串章丢数据）。
   * silent=true 表示自动保存（不弹提示、快照走节流）。
   */
  onSave: (
    chapterId: string,
    patch: { title?: string; content?: string; status?: ChapterStatus },
    silent: boolean
  ) => Promise<void>
  /** 脏状态上行：上下文面板要提示"编排基于已保存的正文" */
  onDirtyChange?: (dirty: boolean) => void
  /** 上下文面板注入的背景提示词，AI 动作时附在请求里 */
  contextPrompt?: string | null
  /** 注入的上下文被用掉后回调（用于"仅用一次"后清除） */
  onContextConsumed?: () => void
  /** 从正文选区埋下伏笔：传入选区原文，由父组件带当前章节信息落库 */
  onPlantForeshadow?: (text: string) => void
}

/** 自动保存间隔（毫秒） */
const AUTOSAVE_MS = 30_000

/** 命令式句柄：父组件（长篇助手）用它在光标处插入 AI 回复 */
export interface ChapterEditorHandle {
  insertText: (text: string) => void
}

/**
 * 章节编辑器：标题 + 正文 + 状态 + 自动保存 + 版本历史。
 *
 * 自动保存的坑（与笔记页同一套处理）：
 *   - 用 ref 承载最新的 title/content，定时器回调不能闭包捕获旧值
 *   - 只在 dirty 时落盘，空转不做无谓写入
 *   - 切换章节前强制 flush，否则上一章的修改会丢
 */
const ChapterEditor = forwardRef<ChapterEditorHandle, ChapterEditorProps>(function ChapterEditor(
  {
    chapter,
    disabled,
    onSave,
    onDirtyChange,
    contextPrompt,
    onContextConsumed,
    onPlantForeshadow
  },
  ref
) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [status, setStatus] = useState<ChapterStatus>('outline')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  // 字数统计防抖：大章节（数万字）每次按键都跑全量正则会卡顿，防抖到空闲 300ms 再算
  const [wordCount, setWordCount] = useState(() => countWordsLocal(content))

  // P1-3：选区驱动的 AI 动作状态
  const [sel, setSel] = useState<{ text: string; start: number; end: number; x: number; y: number } | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [diff, setDiff] = useState<{
    action: AiEditAction
    original: string
    generated: string
    start: number
    end: number
  } | null>(null)

  const titleRef = useRef('')
  const contentRef = useRef('')
  const dirtyRef = useRef(false)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  // 当前正在编辑的章节 id：卸载清理时必须用它，不能读父组件的"当前章节"
  const chapterIdRef = useRef('')
  titleRef.current = title
  contentRef.current = content
  dirtyRef.current = dirty
  chapterIdRef.current = chapter?.id ?? ''

  // 脏状态上行给父组件（上下文面板据此提示"编排基于已保存正文"）
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  // 章节切换：载入新内容
  useEffect(() => {
    if (!chapter) return
    setTitle(chapter.title)
    setContent(chapter.content)
    setStatus(chapter.status)
    setDirty(false)
    setWordCount(countWordsLocal(chapter.content))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter?.id])

  // 输入时防抖重算字数，避免大章节每次按键都全量正则重算导致卡顿
  useEffect(() => {
    const t = setTimeout(() => setWordCount(countWordsLocal(content)), 300)
    return () => clearTimeout(t)
  }, [content])

  const flush = useCallback(
    async (silent: boolean) => {
      const id = chapterIdRef.current
      if (!id || !dirtyRef.current) return
      setSaving(true)
      try {
        await onSave(id, { title: titleRef.current, content: contentRef.current }, silent)
        setDirty(false)
      } finally {
        setSaving(false)
      }
    },
    [onSave]
  )

  // 离开当前章节前保存一次（标题/内容任一变化过就落盘）
  useEffect(() => {
    if (!chapter) return
    const idAtMount = chapter.id
    return () => {
      // 用挂载时捕获的 id + ref 里的最新内容：保证"存回的是这一章"
      if (idAtMount && dirtyRef.current) {
        void onSave(idAtMount, { title: titleRef.current, content: contentRef.current }, true).catch(
          () => undefined
        )
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter?.id])

  // 定时自动保存
  useEffect(() => {
    if (!chapter) return
    const timer = setInterval(() => void flush(true), AUTOSAVE_MS)
    return () => clearInterval(timer)
  }, [chapter, flush])

  // Ctrl/Cmd + S 手动保存
  useEffect(() => {
    if (!chapter) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void flush(false).then(() => message.success('已保存'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chapter, flush])

  const handleRestore = useCallback(
    async (restored: string) => {
      setContent(restored)
      setDirty(false)
      try {
        await onSave(chapterIdRef.current, { content: restored }, true)
        message.success('已回滚（回滚前的版本也保留在历史里）')
      } catch {
        message.error('回滚内容写入失败')
      }
    },
    [onSave]
  )

  const changeStatus = useCallback(
    async (next: ChapterStatus) => {
      setStatus(next)
      try {
        await onSave(chapterIdRef.current, { status: next }, true)
      } catch {
        message.error('状态更新失败')
      }
    },
    [onSave]
  )

  /* ------------------------------ P1-3：AI 动作 ------------------------------ */

  const ACTION_LABEL: Record<AiEditAction, string> = {
    continue: '续写',
    polish: '润色',
    expand: '扩写',
    condense: '缩写',
    restyle: '改风格',
    deai: '去 AI 味'
  }

  /** 选区变化：在鼠标/光标处弹出浮层。键盘选择退化为固定位置。 */
  const handleSelect = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget
    const s = ta.selectionStart
    const en = ta.selectionEnd
    if (s === en) {
      setSel(null)
      return
    }
    const rect = ta.getBoundingClientRect()
    let x = rect.left + 14
    let y = rect.top + 14
    const native = e.nativeEvent
    if (native instanceof MouseEvent && (native.clientX || native.clientY)) {
      x = native.clientX
      y = native.clientY - 10
    }
    x = Math.min(Math.max(x, 8), window.innerWidth - 240)
    y = Math.min(Math.max(y, 8), window.innerHeight - 64)
    setSel({ text: ta.value.slice(s, en), start: s, end: en, x, y })
  }, [])

  /** 顶栏"AI 改写"按钮：从 textarea 重新取选区，没有则提示 */
  const onAiButton = useCallback(() => {
    const ta = taRef.current
    if (!ta) return
    const s = ta.selectionStart
    const en = ta.selectionEnd
    if (s === en) {
      message.info('先选中一段文字，或把光标停在要续写的位置')
      return
    }
    setSel({
      text: ta.value.slice(s, en),
      start: s,
      end: en,
      x: window.innerWidth / 2 - 120,
      y: 80
    })
  }, [])

  const runAi = useCallback(
    async (action: AiEditAction) => {
      if (!sel) return
      const value = contentRef.current
      const before = value.slice(0, sel.start).slice(-600)
      const after = value.slice(sel.end).slice(0, 400)
      setSel(null)
      setAiBusy(true)
      try {
        const r = await window.api.novel.aiEdit({
          action,
          selectedText: sel.text,
          beforeText: before,
          afterText: after,
          contextPrompt: contextPrompt ?? undefined
        })
        if (!r.ok) {
          message.error(r.error ?? 'AI 调用失败')
          return
        }
        if (contextPrompt && onContextConsumed) onContextConsumed()
        setDiff({
          action,
          original: sel.text,
          generated: r.text ?? '',
          start: sel.start,
          end: sel.end
        })
      } catch {
        message.error('AI 调用失败')
      } finally {
        setAiBusy(false)
      }
    },
    [sel, contextPrompt, onContextConsumed]
  )

  /** 接受 AI 结果：续写插在选区之后，其余动作替换选区 */
  const applyDiff = useCallback(() => {
    if (!diff) return
    const value = contentRef.current
    let next: string
    if (diff.action === 'continue') {
      const prev = value[diff.end - 1]
      const needBreak = prev !== undefined && !/\s/.test(prev)
      next = value.slice(0, diff.end) + (needBreak ? '\n\n' : '') + diff.generated + value.slice(diff.end)
    } else {
      next = value.slice(0, diff.start) + diff.generated + value.slice(diff.end)
    }
    contentRef.current = next
    setContent(next)
    setDirty(true)
    if (contextPrompt && onContextConsumed) onContextConsumed()
    setDiff(null)
  }, [diff, contextPrompt, onContextConsumed])

  /** 命令式插入：把外部文本（如 AI 助手回复）插到正文光标处；无选区则追加到末尾 */
  const insertText = useCallback((text: string): void => {
    const ta = taRef.current
    const base = contentRef.current
    let start = base.length
    let end = base.length
    if (ta) {
      start = ta.selectionStart ?? base.length
      end = ta.selectionEnd ?? base.length
    }
    const next = base.slice(0, start) + text + base.slice(end)
    contentRef.current = next
    setContent(next)
    setDirty(true)
  }, [])

  useImperativeHandle(
    ref,
    () => ({ insertText }),
    [insertText]
  )

  if (!chapter) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Empty description="从左侧选择一章开始写作，或新建章节" />
      </div>
    )
  }

  // 防抖后的字数（输入时空闲 300ms 才更新，显示可能短暂滞后，可接受）
  const words = wordCount

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid var(--border-color, rgba(128,128,128,.15))',
          flexWrap: 'wrap'
        }}
      >
        <Input
          aria-label="章节标题"
          value={title}
          disabled={disabled}
          onChange={(e) => {
            setTitle(e.target.value)
            setDirty(true)
          }}
          style={{ flex: 1, minWidth: 160, fontWeight: 600 }}
          placeholder="章节标题"
        />
        <Select
          aria-label="章节状态"
          size="small"
          value={status}
          disabled={disabled}
          onChange={changeStatus}
          options={STATUS_OPTIONS}
          style={{ width: 96 }}
        />
        <Space size={6}>
          {dirty && <Tag color="orange" style={{ margin: 0 }}>未保存</Tag>}
          {!dirty && !saving && <Tag color="green" style={{ margin: 0 }}>已保存</Tag>}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {words.toLocaleString()} 字
            {chapter.wordGoal > 0 && ` / 目标 ${chapter.wordGoal.toLocaleString()}`}
          </Typography.Text>
          {contextPrompt && (
            <Tooltip title="上下文面板注入的背景，将随下一次 AI 动作发送，用完即清">
              <Tag
                color="blue"
                style={{ margin: 0, cursor: 'pointer' }}
                closable
                onClose={() => onContextConsumed?.()}
              >
                已注入上下文
              </Tag>
            </Tooltip>
          )}
          <Tooltip title="选中文字后用 AI 改写 / 续写（也可直接在正文上选词弹出浮层）">
            <Button size="small" icon={<ThunderboltOutlined />} onClick={onAiButton} disabled={disabled}>
              AI 改写
            </Button>
          </Tooltip>
          <Tooltip title="版本历史：查看与回滚本章的历次保存">
            <Button
              size="small"
              icon={<HistoryOutlined />}
              onClick={() => void flush(true).finally(() => setHistoryOpen(true))}
            >
              历史
            </Button>
          </Tooltip>
          <Button
            size="small"
            type="primary"
            icon={<SaveOutlined />}
            disabled={disabled || !dirty}
            loading={saving}
            onClick={() => void flush(false).then(() => message.success('已保存'))}
          >
            保存
          </Button>
        </Space>
      </div>

      <textarea
        ref={taRef}
        value={content}
        disabled={disabled}
        onChange={(e) => {
          setContent(e.target.value)
          setDirty(true)
        }}
        onMouseUp={handleSelect}
        onKeyUp={handleSelect}
        placeholder="开始写这一章…（Ctrl+S 保存，每 30 秒自动保存；选中文字即弹出 AI 浮层）"
        style={{
          flex: 1,
          minHeight: 0,
          width: '100%',
          resize: 'none',
          border: 'none',
          outline: 'none',
          padding: '16px 20px',
          fontSize: 15,
          lineHeight: 1.9,
          fontFamily: 'inherit',
          background: 'transparent',
          color: 'inherit'
        }}
      />

      {chapter && (
        <SnapshotDrawer
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          kind="chapter"
          targetId={chapter.id}
          currentContent={content}
          onRestore={(c) => void handleRestore(c)}
        />
      )}

      {/* P1-3：选区浮层（固定定位，跟随鼠标/光标） */}
      {sel && (
        <div
          onMouseDown={(e) => e.preventDefault()}
          style={{
            position: 'fixed',
            left: sel.x,
            top: sel.y,
            zIndex: 1000,
            background: 'var(--bg-elevated, #fff)',
            border: '1px solid var(--border-color, rgba(128,128,128,.25))',
            borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,.18)',
            padding: 4,
            display: 'flex',
            alignItems: 'center',
            gap: 2
          }}
        >
          {(['continue', 'polish', 'expand', 'condense', 'restyle', 'deai'] as AiEditAction[]).map((a) => (
            <Button
              key={a}
              size="small"
              type={a === 'continue' ? 'primary' : 'text'}
              loading={aiBusy && a === 'continue'}
              disabled={aiBusy}
              onClick={() => void runAi(a)}
            >
              {ACTION_LABEL[a]}
            </Button>
          ))}
          {onPlantForeshadow && (
            <Tooltip title="把这段选为正文伏笔，记录到伏笔面板">
              <Button
                size="small"
                type="text"
                icon={<FlagOutlined />}
                disabled={aiBusy}
                onClick={() => {
                  onPlantForeshadow(sel.text)
                  setSel(null)
                }}
              >
                埋伏笔
              </Button>
            </Tooltip>
          )}
          <Button size="small" type="text" aria-label="关闭选区浮层" icon={<CloseOutlined />} onClick={() => setSel(null)} />
        </div>
      )}

      {/* P1-3：AI 结果差异对比（接受 / 拒绝） */}
      <Modal
        open={!!diff}
        title={`AI ${diff ? ACTION_LABEL[diff.action] : ''} · 差异对比`}
        width={760}
        footer={[
          <Button key="reject" onClick={() => setDiff(null)}>
            拒绝
          </Button>,
          <Button key="accept" type="primary" onClick={applyDiff}>
            {diff?.action === 'continue' ? '插入续写' : '接受改写'}
          </Button>
        ]}
        onCancel={() => setDiff(null)}
      >
        {diff && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {diff.action === 'continue' ? '续写锚点（原文）' : '原文'}
              </Typography.Text>
              <div
                style={{
                  maxHeight: 200,
                  overflowY: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  padding: 10,
                  borderRadius: 6,
                  border: '1px solid var(--border-color, rgba(128,128,128,.2))',
                  background: 'var(--bg-subtle, rgba(128,128,128,.06))',
                  fontSize: 13,
                  lineHeight: 1.7
                }}
              >
                {diff.original || '（空）'}
              </div>
            </div>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {diff.action === 'continue' ? 'AI 续写结果（将插入其后）' : 'AI 改写结果（将替换原文）'}
              </Typography.Text>
              <div
                style={{
                  maxHeight: 240,
                  overflowY: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  padding: 10,
                  borderRadius: 6,
                  border: '1px solid var(--border-color, rgba(128,128,128,.2))',
                  background: 'var(--bg-subtle, rgba(128,128,128,.06))',
                  fontSize: 13,
                  lineHeight: 1.7
                }}
              >
                {diff.generated || '（空）'}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
})

export default ChapterEditor

/** 与 main/snapshots.ts 的 countWords 同口径（含中文标点） */
const CJK_RE = /[㐀-䶿一-鿿豈-﫿぀-ヿ　-〿＀-￯]/g
function countWordsLocal(text: string): number {
  if (!text) return 0
  const cjk = (text.match(CJK_RE) ?? []).length
  const rest = text.replace(CJK_RE, ' ').match(/[A-Za-z0-9_'’]+/g)
  return cjk + (rest?.length ?? 0)
}
