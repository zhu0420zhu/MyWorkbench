/**
 * 选中文本 → 右键浮动 AI 菜单（写作 / 文案 / 笔记 / 文档处理共用）
 * 修复要点：右键时克隆 Range，弹窗后仍能「替换选中」；按钮均有明确反馈
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Input, message, Modal, Space, Spin } from 'antd'
import { ThunderboltOutlined } from '@ant-design/icons'
import type { AiChatMessage } from '@shared/types'

export const AI_SELECT_ACTIONS = [
  { key: 'rewrite', label: '改写' },
  { key: 'expand', label: '扩写' },
  { key: 'condense', label: '缩写' },
  { key: 'polish', label: '润色' },
  { key: 'scene', label: '场景增强' },
  { key: 'deai', label: '去 AI 味' },
  { key: 'tone', label: '改基调' },
  { key: 'ask', label: '追问' },
  { key: 'summary', label: '总结' },
  { key: 'translate', label: '翻译' }
] as const

const HINTS: Record<string, string> = {
  rewrite: '保持原意，换一种说法，更流畅自然',
  expand: '在保持核心的前提下丰富细节与层次',
  condense: '压缩篇幅，保留关键信息',
  polish: '提升文笔与可读性，不改变情节',
  scene: '增强画面感、感官细节与节奏',
  deai: '去掉模板腔，更像人写',
  tone: '调整语气基调（未指定则偏严肃克制）',
  ask: '基于选中内容给出分析与建议，不要求替换原文',
  summary: '用要点概括这段内容',
  translate: '若为中文则译成英文，若为英文则译成中文'
}

const QUICK = ['rewrite', 'expand', 'condense', 'polish', 'translate', 'summary'] as const

export function buildAiSelectPrompt(key: string, text: string, extra?: string): string {
  const item = AI_SELECT_ACTIONS.find((a) => a.key === key)
  return [
    '你是专业中文写作编辑。请严格按照任务输出结果。',
    `任务：${item?.label ?? key}。`,
    `说明：${HINTS[key] ?? '处理文本'}。`,
    extra?.trim() ? `附加要求：${extra.trim()}` : '',
    '输出要求：只输出处理后的正文；若任务是「追问」「总结」，可输出简短分析。不要开场白，不要 markdown 代码块包裹。',
    '',
    '【选中文本开始】',
    text,
    '【选中文本结束】'
  ]
    .filter((s) => s !== '')
    .join('\n')
}

type SelKind = 'editable' | 'textarea'

interface SelCap {
  kind: SelKind
  el: HTMLElement
  start: number
  end: number
  text: string
  range?: Range
}

interface AiSelectMenuProps {
  rootRef: React.RefObject<HTMLElement | null>
  enabled?: boolean
}

function isErrResult(s: string): boolean {
  return !s || s.startsWith('AI 调用失败') || s.startsWith('生成失败')
}

export default function AiSelectMenu({ rootRef, enabled = true }: AiSelectMenuProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; text: string } | null>(null)
  const [more, setMore] = useState(false)
  const [open, setOpen] = useState(false)
  const [action, setAction] = useState<string>('')
  const [extra, setExtra] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState('')
  const [errHint, setErrHint] = useState('')
  const selRef = useRef<SelCap | null>(null)
  const selTextRef = useRef('')

  const captureSelection = useCallback((): SelCap | null => {
    const active = document.activeElement as HTMLElement | null
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
      const ta = active as HTMLTextAreaElement
      const start = ta.selectionStart ?? 0
      const end = ta.selectionEnd ?? 0
      const text = ta.value.slice(start, end)
      if (!text.trim()) return null
      return { text: text.trim(), kind: 'textarea', el: ta, start, end }
    }
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
    const range = sel.getRangeAt(0)
    const text = sel.toString()
    if (!text.trim()) return null
    let node: Node | null = range.commonAncestorContainer
    let editable: HTMLElement | null = null
    while (node && node !== document.body) {
      if (node instanceof HTMLElement && (node.isContentEditable || node.getAttribute('contenteditable') === 'true')) {
        editable = node
        break
      }
      node = node.parentNode
    }
    const el = editable ?? (rootRef.current as HTMLElement | null) ?? document.body
    // 克隆 Range：弹窗打开后浏览器会丢选区
    let cloned: Range | undefined
    try {
      cloned = range.cloneRange()
    } catch {
      cloned = undefined
    }
    return { text: text.trim(), kind: 'editable', el, start: 0, end: 0, range: cloned }
  }, [rootRef])

  useEffect(() => {
    if (!enabled) return
    const root = rootRef.current ?? document.body
    const onCtx = (e: MouseEvent) => {
      const cap = captureSelection()
      if (!cap) {
        setMenu(null)
        setMore(false)
        return
      }
      e.preventDefault()
      e.stopPropagation()
      selRef.current = cap
      selTextRef.current = cap.text
      setMore(false)
      setMenu({ x: e.clientX, y: e.clientY, text: cap.text })
    }
    root.addEventListener('contextmenu', onCtx, true)
    return () => root.removeEventListener('contextmenu', onCtx, true)
  }, [enabled, rootRef, captureSelection])

  const applyResult = useCallback((text: string): boolean => {
    const cap = selRef.current
    const payload = (text ?? '').trim()
    if (!cap || !payload || isErrResult(payload)) {
      message.warning('没有可写入的有效结果')
      return false
    }

    if (cap.kind === 'textarea') {
      const ta = cap.el as HTMLTextAreaElement
      const proto = Object.getPrototypeOf(ta)
      const desc = Object.getOwnPropertyDescriptor(proto, 'value')
      const next = ta.value.slice(0, cap.start) + payload + ta.value.slice(cap.end)
      if (desc?.set) desc.set.call(ta, next)
      else ta.value = next
      ta.focus()
      ta.setSelectionRange(cap.start, cap.start + payload.length)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      message.success('已替换选中内容')
      return true
    }

    const el = cap.el
    el.focus()
    const range = cap.range
    try {
      if (range) {
        const container =
          range.commonAncestorContainer.nodeType === Node.TEXT_NODE
            ? range.commonAncestorContainer.parentNode
            : range.commonAncestorContainer
        if (container && (el === container || el.contains(container))) {
          range.deleteContents()
          const node = document.createTextNode(payload)
          range.insertNode(node)
          const after = document.createRange()
          after.setStartAfter(node)
          after.collapse(true)
          const sel = window.getSelection()
          sel?.removeAllRanges()
          sel?.addRange(after)
          el.dispatchEvent(new Event('input', { bubbles: true }))
          message.success('已替换选中内容')
          return true
        }
      }
      // 回退：在元素内用原文定位替换
      const html = el.innerHTML
      const esc = cap.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (html.includes(cap.text)) {
        el.innerHTML = html.replace(cap.text, payload)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        message.success('已替换选中内容')
        return true
      }
      if (new RegExp(esc).test(html)) {
        el.innerHTML = html.replace(new RegExp(esc), payload)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        message.success('已替换选中内容')
        return true
      }
      document.execCommand('insertText', false, payload)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      message.success('已插入结果')
      return true
    } catch (err) {
      message.error('替换失败：' + ((err as Error).message || '选区已失效，可先复制结果'))
      return false
    }
  }, [])

  const runAction = useCallback(
    async (key: string, extraHint?: string) => {
      const text = selTextRef.current || selRef.current?.text || menu?.text || ''
      if (!text.trim()) {
        message.warning('未捕获到选中文本，请重新选中后再试')
        setErrHint('未捕获到选中文本，请重新选中后再试')
        setOpen(true)
        setMenu(null)
        setLoading(false)
        setResult('')
        return
      }
      if (!key) {
        message.warning('未选择操作类型')
        return
      }
      setAction(key)
      setOpen(true)
      setMenu(null)
      setMore(false)
      setLoading(true)
      setResult('')
      setErrHint('')
      try {
        const msgs: AiChatMessage[] = [{ role: 'user', content: buildAiSelectPrompt(key, text, extraHint) }]
        const r = await window.api.ai.complete(msgs)
        if (!r) {
          setErrHint('AI 接口无响应')
          setResult('')
        } else if (r.ok) {
          const t = (r.text ?? '').trim()
          if (!t) {
            setErrHint('模型返回为空，请检查设置中的模型名，或重试')
            setResult('')
          } else {
            setResult(t)
          }
        } else {
          setErrHint(r.error || 'AI 调用失败')
          setResult('')
        }
      } catch (err) {
        setErrHint((err as Error).message || 'AI 调用异常')
        setResult('')
      } finally {
        setLoading(false)
      }
    },
    [menu]
  )

  useEffect(() => {
    if (!menu) return
    const close = () => {
      setMenu(null)
      setMore(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    // 用 mousedown 延后绑定，避免本次右键/点击立刻把菜单关掉
    const t = window.setTimeout(() => {
      window.addEventListener('mousedown', close)
      window.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  if (!menu && !open) return null

  const canReplace = !!result && !isErrResult(result) && !loading

  return (
    <>
      {menu && (
        <div
          className="ai-select-menu"
          role="menu"
          style={{
            position: 'fixed',
            left: Math.min(Math.max(8, menu.x - 20), Math.max(8, window.innerWidth - 360)),
            top: Math.min(menu.y + 6, window.innerHeight - 220),
            zIndex: 10050,
            background: 'rgba(28, 30, 36, 0.96)',
            color: '#f5f5f5',
            border: '1px solid rgba(255,255,255,.08)',
            borderRadius: 10,
            boxShadow: '0 10px 32px rgba(0,0,0,.28)',
            padding: '6px 8px',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 2,
            maxWidth: 360
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {QUICK.map((k) => {
            const item = AI_SELECT_ACTIONS.find((a) => a.key === k)!
            return (
              <button
                key={k}
                type="button"
                role="menuitem"
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  void runAction(k)
                }}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'inherit',
                  fontSize: 13,
                  padding: '6px 10px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap'
                }}
              >
                {item.label}
              </button>
            )
          })}
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setMore((v) => !v)
            }}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'rgba(255,255,255,.65)',
              fontSize: 12,
              padding: '6px 8px',
              borderRadius: 6,
              cursor: 'pointer'
            }}
          >
            更多 ▾
          </button>
          {more && (
            <div
              style={{
                width: '100%',
                borderTop: '1px solid rgba(255,255,255,.08)',
                marginTop: 4,
                paddingTop: 4,
                display: 'flex',
                flexWrap: 'wrap',
                gap: 2
              }}
            >
              {AI_SELECT_ACTIONS.filter((a) => !(QUICK as readonly string[]).includes(a.key)).map((a) => (
                <button
                  key={a.key}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                  }}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    void runAction(a.key)
                  }}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: 'inherit',
                    fontSize: 12,
                    padding: '5px 8px',
                    borderRadius: 6,
                    cursor: 'pointer'
                  }}
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <Modal
        open={open}
        title={
          <span>
            <ThunderboltOutlined style={{ marginRight: 6 }} />
            AI · {AI_SELECT_ACTIONS.find((a) => a.key === action)?.label ?? '处理'}
          </span>
        }
        onCancel={() => setOpen(false)}
        width={680}
        footer={null}
        destroyOnHidden
        zIndex={10060}
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <div
            style={{
              fontSize: 12,
              opacity: 0.7,
              maxHeight: 72,
              overflow: 'auto',
              lineHeight: 1.5,
              padding: '6px 8px',
              borderRadius: 6,
              background: 'rgba(128,128,128,.08)'
            }}
          >
            原文（{(selTextRef.current || '').length} 字）：
            {(selTextRef.current || '').slice(0, 280)}
            {(selTextRef.current || '').length > 280 ? '…' : ''}
          </div>
          <Input.TextArea
            aria-label="附加要求"
            placeholder="附加要求（选填）：如更口语化、保持人名不变…"
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            autoSize={{ minRows: 2, maxRows: 4 }}
          />
          <Space wrap>
            <Button
              size="small"
              type="primary"
              loading={loading}
              onClick={() => void runAction(action || 'rewrite', extra)}
            >
              生成 / 重新生成
            </Button>
            <Button size="small" disabled={!canReplace} onClick={() => applyResult(result)}>
              替换选中
            </Button>
            <Button
              size="small"
              disabled={!result}
              onClick={() => {
                void navigator.clipboard.writeText(result)
                message.success('已复制')
              }}
            >
              复制
            </Button>
            <Button size="small" onClick={() => setOpen(false)}>
              关闭
            </Button>
          </Space>
          {errHint && <Alert type="warning" showIcon message={errHint} description="请到「设置 → AI 模型」检查 endpoint / API Key / 模型名后重试。" />}
          {loading && (
            <div style={{ padding: 28, textAlign: 'center' }}>
              <Spin tip="正在调用 AI…" />
            </div>
          )}
          {!loading && result && (
            <Input.TextArea
              aria-label="AI 结果"
              value={result}
              onChange={(e) => setResult(e.target.value)}
              autoSize={{ minRows: 8, maxRows: 22 }}
            />
          )}
          {!loading && !result && !errHint && (
            <div style={{ padding: 16, opacity: 0.55, fontSize: 12 }}>点击「生成 / 重新生成」开始处理选中文本。</div>
          )}
        </Space>
      </Modal>
    </>
  )
}
