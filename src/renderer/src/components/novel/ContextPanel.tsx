/**
 * 上下文面板（右栏「上下文」标签页）
 *
 * 把 ContextBundle 摊开给作者看：每一块是什么、占多少 token、要不要用。
 *
 * **为什么非得"可见"**：黑盒上下文是长篇 AI 写作最大的信任黑洞——
 * 模型写崩了，作者不知道是它失忆了、还是它看了不该看的东西。
 * 摊开之后，作者能直接把某块关掉重试，定位问题从"玄学调 prompt"变成"开关几次"。
 *
 * **为什么块可以手动改文本**：摘要链偶尔会带上一句已经作废的剧情，
 * 与其回章节里改细纲再等它刷新，不如当场删掉那一行。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Empty,
  Input,
  InputNumber,
  Progress,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message
} from 'antd'
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CopyOutlined,
  DeleteOutlined,
  RedoOutlined,
  SettingOutlined
} from '@ant-design/icons'
import type { BuildContextOptions, ContextBlock, ContextBundle } from '@shared/types'

interface ContextPanelProps {
  projectId: string
  chapterId: string | null
  /** 编辑区有未保存改动时为 true：提示作者编排基于已保存的正文 */
  dirty?: boolean
  /** 把提示词交给调用方（如编辑器内 AI 动作） */
  onApplyPrompt?: (text: string) => void
}

const KIND_LABEL: Record<string, string> = {
  synopsis: '作品设定',
  outline: '本章细纲',
  'prev-tail': '上一章结尾',
  entities: '出场实体',
  'summary-chain': '摘要链',
  retrieval: '旧章回忆',
  note: '备忘'
}

export default function ContextPanel({
  projectId,
  chapterId,
  dirty,
  onApplyPrompt
}: ContextPanelProps) {
  const [bundle, setBundle] = useState<ContextBundle | null>(null)
  const [loading, setLoading] = useState(false)
  const [options, setOptions] = useState<BuildContextOptions>({
    summaryDepth: 4,
    prevTailChars: 800,
    retrievalTopK: 3,
    budgetTokens: 24000
  })
  const [noteInput, setNoteInput] = useState('')
  const [reindexing, setReindexing] = useState(false)

  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const build = useCallback(async () => {
    if (!chapterId) return
    setLoading(true)
    try {
      const b = await window.api.novel.buildContext(projectId, chapterId, options)
      if (aliveRef.current) setBundle(b)
    } catch {
      if (aliveRef.current) message.error('上下文编排失败')
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [projectId, chapterId, options])

  // 切章节自动编排一次：作者切过来就是要看的，不该再点一次按钮
  useEffect(() => {
    if (!chapterId) {
      setBundle(null)
      return
    }
    void build()
    // options 变化由「重新编排」按钮触发，这里只跟随章节
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, chapterId])

  /** 本地改动后回主进程重算 token（保证面板数字与真正发出去的一致） */
  const sync = useCallback(async (blocks: ContextBlock[]) => {
    const r = await window.api.novel.renderContext(blocks)
    if (!aliveRef.current) return
    setBundle((prev) =>
      prev
        ? { ...prev, blocks: r.blocks, totalTokens: r.totalTokens }
        : {
            projectId,
            chapterId: chapterId ?? '',
            chapterTitle: '',
            blocks: r.blocks,
            totalTokens: r.totalTokens,
            budgetTokens: 24000,
            trimmed: []
          }
    )
    return r
  }, [projectId, chapterId])

  const setBlocks = useCallback(
    (updater: (prev: ContextBlock[]) => ContextBlock[]) => {
      setBundle((prev) => {
        if (!prev) return prev
        const next = updater(prev.blocks)
        void sync(next).catch(() => undefined)
        return { ...prev, blocks: next }
      })
    },
    [sync]
  )

  const toggle = useCallback(
    (id: string, on: boolean) => {
      setBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, enabled: on } : b)))
    },
    [setBlocks]
  )

  const move = useCallback(
    (index: number, dir: -1 | 1) => {
      setBlocks((prev) => {
        const next = [...prev]
        const j = index + dir
        if (j < 0 || j >= next.length) return prev
        const tmp = next[index]
        next[index] = next[j]
        next[j] = tmp
        return next
      })
    },
    [setBlocks]
  )

  const removeBlock = useCallback(
    (id: string) => {
      setBlocks((prev) => prev.filter((b) => b.id !== id))
    },
    [setBlocks]
  )

  const editText = useCallback(
    (id: string, text: string) => {
      setBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, text } : b)))
    },
    [setBlocks]
  )

  const addNote = useCallback(async () => {
    const t = noteInput.trim()
    if (!t) return
    await window.api.novel.addPinnedNote(projectId, t)
    setNoteInput('')
    await build()
  }, [projectId, noteInput, build])

  const reindex = useCallback(async () => {
    setReindexing(true)
    try {
      const r = await window.api.novel.reindexProject(projectId)
      message.success(`已入库 ${r.indexed} 章${r.failed ? `，失败 ${r.failed} 章` : ''}`)
      if (r.indexed > 0) await build()
    } catch {
      message.error('重建索引失败')
    } finally {
      if (aliveRef.current) setReindexing(false)
    }
  }, [projectId, build])

  const copyAll = useCallback(async () => {
    const r = await window.api.novel.renderContext(bundle?.blocks ?? [])
    if (!r.text.trim()) {
      message.warning('没有已启用的上下文块')
      return
    }
    await navigator.clipboard.writeText(r.text)
    message.success('已复制上下文')
  }, [bundle])

  const percent = useMemo(() => {
    if (!bundle || bundle.budgetTokens <= 0) return 0
    return Math.min(100, Math.round((bundle.totalTokens / bundle.budgetTokens) * 100))
  }, [bundle])

  if (!chapterId) {
    return (
      <div style={{ padding: 16 }}>
        <Empty description="未选择章节" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Space size={4} style={{ width: '100%' }}>
          <Button size="small" icon={<RedoOutlined />} loading={loading} onClick={() => void build()}>
            重新编排
          </Button>
          <Button size="small" icon={<CopyOutlined />} onClick={() => void copyAll()}>
            复制
          </Button>
          {onApplyPrompt && (
            <Button
              size="small"
              type="primary"
              onClick={async () => {
                const r = await window.api.novel.renderContext(bundle?.blocks ?? [])
                if (!r.text.trim()) {
                  message.warning('没有已启用的上下文块')
                  return
                }
                onApplyPrompt(r.text)
              }}
            >
              送入 AI
            </Button>
          )}
        </Space>

        <Tooltip title={`${bundle?.totalTokens ?? 0} / ${bundle?.budgetTokens ?? 0} token（估算）`}>
          <Progress
            percent={percent}
            size="small"
            status={percent > 100 ? 'exception' : percent > 85 ? 'normal' : 'success'}
            format={() => `${bundle?.totalTokens ?? 0}`}
          />
        </Tooltip>

        {dirty && (
          <Alert
            type="info"
            showIcon
            banner
            message={<span style={{ fontSize: 11 }}>编排基于已保存的正文，当前改动尚未入库</span>}
          />
        )}
        {bundle?.trimmed.length ? (
          <Alert
            type="warning"
            showIcon
            banner
            message={
              <span style={{ fontSize: 11 }}>
                超预算已自动关闭：{bundle.trimmed.join('、')}
              </span>
            }
          />
        ) : null}
      </div>

      <Collapse
        ghost
        size="small"
        style={{ padding: '0 8px' }}
        items={[
          {
            key: 'opts',
            label: (
              <Typography.Text style={{ fontSize: 11 }}>
                <SettingOutlined /> 编排参数
              </Typography.Text>
            ),
            children: (
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <OptRow label="摘要链深度" hint="往前取几章的细纲">
                  <InputNumber
                    aria-label="摘要链深度"
                    size="small"
                    min={1}
                    max={12}
                    value={options.summaryDepth}
                    onChange={(v) => setOptions((p) => ({ ...p, summaryDepth: v ?? 4 }))}
                    style={{ width: 90 }}
                  />
                </OptRow>
                <OptRow label="上一章结尾" hint="取多少字符原文">
                  <InputNumber
                    aria-label="上一章结尾字符数"
                    size="small"
                    min={0}
                    max={4000}
                    step={200}
                    value={options.prevTailChars}
                    onChange={(v) => setOptions((p) => ({ ...p, prevTailChars: v ?? 800 }))}
                    style={{ width: 90 }}
                  />
                </OptRow>
                <OptRow label="旧章回忆" hint="检索召回几个片段">
                  <InputNumber
                    aria-label="旧章回忆召回片段数"
                    size="small"
                    min={0}
                    max={8}
                    value={options.retrievalTopK}
                    onChange={(v) => setOptions((p) => ({ ...p, retrievalTopK: v ?? 3 }))}
                    style={{ width: 90 }}
                  />
                </OptRow>
                <OptRow label="token 预算">
                  <InputNumber
                    aria-label="token 预算"
                    size="small"
                    min={2000}
                    max={200000}
                    step={2000}
                    value={options.budgetTokens}
                    onChange={(v) => setOptions((p) => ({ ...p, budgetTokens: v ?? 24000 }))}
                    style={{ width: 110 }}
                  />
                </OptRow>
                <Button
                  size="small"
                  block
                  loading={reindexing}
                  onClick={() => void reindex()}
                >
                  重建检索索引（旧章节召回需要）
                </Button>
              </Space>
            )
          }
        ]}
      />

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 8px 8px' }}>
        {loading && !bundle ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin size="small" />
          </div>
        ) : !bundle || bundle.blocks.length === 0 ? (
          <Empty description="暂无上下文" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {bundle.blocks.map((b, i) => (
              <div
                key={b.id}
                style={{
                  border: '1px solid var(--border-color, rgba(128,128,128,.2))',
                  borderRadius: 6,
                  padding: 6,
                  opacity: b.enabled ? 1 : 0.55
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Checkbox
                    checked={b.enabled}
                    onChange={(e) => toggle(b.id, e.target.checked)}
                  />
                  <Tag style={{ fontSize: 10, lineHeight: '16px', marginInlineEnd: 0 }}>
                    {KIND_LABEL[b.kind] ?? b.kind}
                  </Tag>
                  <Typography.Text
                    ellipsis={{ tooltip: b.title }}
                    style={{ fontSize: 11, flex: 1, minWidth: 0 }}
                  >
                    {b.title}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 10, flexShrink: 0 }}>
                    {b.tokens}
                  </Typography.Text>
                  <Button
                    size="small"
                    type="text"
                    aria-label="上移"
                    icon={<ArrowUpOutlined />}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  />
                  <Button
                    size="small"
                    type="text"
                    aria-label="下移"
                    icon={<ArrowDownOutlined />}
                    disabled={i === bundle.blocks.length - 1}
                    onClick={() => move(i, 1)}
                  />
                  {b.removable && (
                    <Button
                      size="small"
                      type="text"
                      danger
                      aria-label="删除上下文块"
                      icon={<DeleteOutlined />}
                      onClick={() => removeBlock(b.id)}
                    />
                  )}
                </div>
                {b.text ? (
                  <Input.TextArea
                    size="small"
                    aria-label="上下文块内容"
                    value={b.text}
                    onChange={(e) => editText(b.id, e.target.value)}
                    autoSize={{ minRows: 2, maxRows: 8 }}
                    style={{ marginTop: 4, fontSize: 11 }}
                  />
                ) : (
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    （空）
                  </Typography.Text>
                )}
              </div>
            ))}
          </Space>
        )}
      </div>

      <div style={{ padding: '6px 8px', borderTop: '1px solid var(--border-color, rgba(128,128,128,.15))' }}>
        <Space size={4} style={{ width: '100%' }}>
          <Input
            size="small"
            aria-label="备忘内容"
            value={noteInput}
            onChange={(e) => setNoteInput(e.target.value)}
            onPressEnter={() => void addNote()}
            placeholder="钉一条备忘，如「别再让他用火莲」"
          />
          <Button size="small" onClick={() => void addNote()}>
            添加
          </Button>
        </Space>
      </div>
    </div>
  )
}

function OptRow({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Typography.Text style={{ fontSize: 11 }}>{label}</Typography.Text>
        {hint && (
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 10 }}>
              {hint}
            </Typography.Text>
          </div>
        )}
      </div>
      {children}
    </div>
  )
}
