import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Checkbox, Drawer, Empty, List, Popconfirm, Popover, Select, Tag, Tooltip, Typography } from 'antd'
import {
  ArrowDownOutlined,
  AudioOutlined,
  ClearOutlined,
  DeleteOutlined,
  HistoryOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  SendOutlined,
  StopOutlined
} from '@ant-design/icons'
import type { McpToolInfo, PromptLogItem } from '@shared/types'

interface Props {
  /** 顶部欢迎/介绍语 */
  intro?: React.ReactNode
  /** 输入值 */
  value: string
  onChange: (v: string) => void
  /** 发送：Enter 触发；可阻止默认 */
  onSend: () => void
  /** 停止生成（流式中显示） */
  onStop?: () => void
  /** 是否正在生成 */
  streaming?: boolean
  /** 当前模型 */
  model: string
  onModelChange: (m: string) => void
  /** 次模型（双模型主次；空 = 不启用） */
  secondaryModel?: string
  onSecondaryModelChange?: (m: string) => void
  /** 模型列表 */
  modelOptions?: string[]
  /** 已选技能 key */
  skills: string[]
  onSkillsChange: (s: string[]) => void
  /** 加载 MCP 工具列表（可能为空数组表示未安装） */
  loadMcpTools?: () => Promise<McpToolInfo[]>
  /** MCP 工具列表（由父级加载后传入；为空则内部自行加载） */
  mcpTools?: McpToolInfo[]
  /** 已选 MCP 工具 id（受控；不传则内部维护） */
  enabledMcp?: string[]
  /** 受控 setEnabledMcp */
  onEnabledMcpChange?: (v: string[]) => void
  /** 是否禁用 */
  disabled?: boolean
  /** placeholder */
  placeholder?: string
  /** 隐藏技能/工具/MCP/次模型等扩展控件（角色扮演等简化场景） */
  hideExtras?: boolean
  /** 提示词记录来源：传入后自动将每次发送沉淀到本地提示词库，并展示「记录」入口 */
  promptSource?: 'ai' | 'writing'
  /** 底栏额外操作（如「引用知识库」按钮），渲染在模型选择左侧 */
  extraActions?: React.ReactNode
  /** 紧凑模式：隐藏长 intro，输入框铺满父容器高度（写作页用） */
  compact?: boolean
}

/** 内置技能：写作对话常用预设（注入 system hint） */
export const BUILTIN_SKILLS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'md', label: 'Markdown 排版', hint: '请使用 Markdown 格式（标题/列表/代码块/表格）输出，便于后续排版。' },
  { key: 'formal', label: '正式语气', hint: '请使用正式、严谨的语气，避免口语化表达。' },
  { key: 'concise', label: '简洁表达', hint: '请尽量精简表述，去除冗余，每句话都有信息量。' },
  { key: 'academic', label: '学术化', hint: '请使用学术写作规范：客观、克制、术语准确，必要时给出引用建议。' },
  { key: 'summarize', label: '摘要压缩', hint: '请在每轮回复末尾给出 1-2 句精炼摘要，便于快速回顾。' }
]

/* ============================================
 * 通用对话输入框（参考附件 1 样式）
 * - 圆角容器 + 介绍语 + + 按钮（已选技能 chip + MCP 工具选择）
 * - 完全访问徽章 + 模型选择 + 副模型 + 麦克风 + 发送
 * ============================================ */
export default function ComposerInput({
  intro,
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  model,
  onModelChange,
  secondaryModel,
  onSecondaryModelChange,
  modelOptions = [],
  skills,
  onSkillsChange,
  loadMcpTools,
  mcpTools: mcpToolsProp,
  enabledMcp: enabledMcpProp,
  onEnabledMcpChange,
  disabled,
  placeholder = '输入消息，Enter 发送，Shift+Enter 换行',
  hideExtras = false,
  promptSource,
  extraActions,
  compact = false
}: Props) {
  const [popOpen, setPopOpen] = useState(false)
  const [loadedTools, setLoadedTools] = useState<McpToolInfo[]>([])
  const [enabledMcpInt, setEnabledMcpInt] = useState<string[]>([])
  const [loadingMcp, setLoadingMcp] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [history, setHistory] = useState<PromptLogItem[]>([])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  // 父级受控优先，否则内部维护
  const tools = mcpToolsProp ?? loadedTools
  const enabledMcp = enabledMcpProp ?? enabledMcpInt
  const setEnabledMcp = onEnabledMcpChange ?? setEnabledMcpInt

  const allModels = useMemo(() => {
    const s = new Set([model, secondaryModel ?? '', ...modelOptions].filter(Boolean))
    return [...s]
  }, [model, secondaryModel, modelOptions])

  useEffect(() => {
    // 父级已传入工具列表 → 直接使用，不再自行加载
    if (mcpToolsProp) {
      setLoadedTools(mcpToolsProp)
      return
    }
    if (!popOpen || !loadMcpTools) return
    let cancelled = false
    setLoadingMcp(true)
    loadMcpTools()
      .then((list) => {
        if (!cancelled) setLoadedTools(list)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoadingMcp(false)
      })
    return () => {
      cancelled = true
    }
  }, [popOpen, loadMcpTools, mcpToolsProp])

  const toggleSkill = (k: string): void => {
    onSkillsChange(skills.includes(k) ? skills.filter((s) => s !== k) : [...skills, k])
  }
  const toggleMcp = (id: string): void => {
    const next = enabledMcp.includes(id) ? enabledMcp.filter((x) => x !== id) : [...enabledMcp, id]
    setEnabledMcp(next)
  }

  /** 发送前自动沉淀提示词到本地库（fire-and-forget），再交给父级真正发送 */
  const doSend = useCallback((): void => {
    const text = value.trim()
    if (!text || streaming || disabled) return
    if (promptSource) {
      window.api.promptLog
        .add({ text, source: promptSource, model: model || undefined })
        .catch(() => undefined)
    }
    onSend()
  }, [value, streaming, disabled, promptSource, model, onSend])

  /* ---- 提示词记录抽屉 ---- */
  const loadHistory = useCallback(async (): Promise<void> => {
    try {
      setLoadingHistory(true)
      const items = await window.api.promptLog.list()
      setHistory(items)
    } catch {
      setHistory([])
    } finally {
      setLoadingHistory(false)
    }
  }, [])

  const openHistory = useCallback((): void => {
    setDrawerOpen(true)
    void loadHistory()
  }, [loadHistory])

  const insertPrompt = useCallback(
    (it: PromptLogItem): void => {
      const next = value.trim() ? `${value}\n\n${it.text}` : it.text
      onChange(next)
    },
    [value, onChange]
  )

  const removePrompt = useCallback(
    async (id: string): Promise<void> => {
      await window.api.promptLog.delete(id).catch(() => undefined)
      await loadHistory()
    },
    [loadHistory]
  )

  const clearHistory = useCallback(async (): Promise<void> => {
    await window.api.promptLog.clear().catch(() => undefined)
    setHistory([])
  }, [])

  const fullAccess = true

  return (
    <div
      className={`composer-input${compact ? ' composer-input-compact' : ''}`}
      style={{
        background: 'var(--bg-elevated, #fff)',
        border: '1px solid var(--border-color, rgba(0,0,0,.08))',
        borderRadius: 14,
        padding: compact ? '10px 12px 8px' : '14px 16px 10px',
        boxShadow: '0 1px 3px rgba(0,0,0,.05)',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        minHeight: 0,
        boxSizing: 'border-box',
        overflow: 'hidden'
      }}
    >
      {intro && !compact && (
        <div style={{ marginBottom: 8, flexShrink: 0 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: 1.5 }}>
            {intro}
          </Typography.Text>
        </div>
      )}

      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled || streaming}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            if (!streaming) doSend()
          }
        }}
        style={{
          width: '100%',
          flex: 1,
          minHeight: compact ? 64 : 48,
          resize: 'none',
          border: 'none',
          outline: 'none',
          background: 'transparent',
          fontSize: 14,
          lineHeight: 1.65,
          color: 'inherit',
          padding: '4px 0 8px',
          overflow: 'auto'
        }}
      />

      {/* 已选技能/工具徽章行（可隐藏） */}
      {(skills.length > 0 || enabledMcp.length > 0) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
          {skills.map((k) => {
            const sk = BUILTIN_SKILLS.find((s) => s.key === k)
            return (
              <Tag
                key={`s-${k}`}
                color="processing"
                closable
                onClose={() => toggleSkill(k)}
                style={{ margin: 0 }}
              >
                {sk?.label ?? k}
              </Tag>
            )
          })}
          {enabledMcp.map((id) => {
            const t = tools.find((x) => `${x.serverId}::${x.name}` === id)
            return (
              <Tag
                key={`m-${id}`}
                color="purple"
                closable
                onClose={() => toggleMcp(id)}
                style={{ margin: 0 }}
              >
                🔌 {t?.name ?? id}
              </Tag>
            )
          })}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {!hideExtras && (
          <Popover
            open={popOpen}
            onOpenChange={setPopOpen}
            trigger="click"
            placement="bottomLeft"
            content={
              <div style={{ width: 320 }}>
                <Typography.Text strong style={{ fontSize: 12 }}>
                  内置技能
                </Typography.Text>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '6px 0 12px' }}>
                  {BUILTIN_SKILLS.map((s) => (
                    <Tag.CheckableTag key={s.key} checked={skills.includes(s.key)} onChange={() => toggleSkill(s.key)}>
                      {s.label}
                    </Tag.CheckableTag>
                  ))}
                </div>
                <Typography.Text strong style={{ fontSize: 12 }}>
                  已安装 MCP 工具
                </Typography.Text>
                <div style={{ marginTop: 6 }}>
                  {loadingMcp ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      加载中…
                    </Typography.Text>
                  ) : tools.length === 0 ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      暂无已安装工具（设置 → MCP 集成 中添加）
                    </Typography.Text>
                  ) : (
                    tools.map((t) => {
                      const id = `${t.serverId}::${t.name}`
                      return (
                        <Checkbox
                          key={id}
                          checked={enabledMcp.includes(id)}
                          onChange={() => toggleMcp(id)}
                          style={{ display: 'block', marginBottom: 2 }}
                        >
                          <span style={{ fontSize: 12 }}>{t.name}</span>
                          <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>
                            {t.serverId}
                          </Typography.Text>
                        </Checkbox>
                      )
                    })
                  )}
                </div>
              </div>
            }
          >
            <Button type="text" icon={<PlusOutlined />} title="技能/工具" />
          </Popover>
        )}

        <Tooltip title="已授予应用完整访问权限（读取/写入/外部工具）">
          <Tag
            icon={<SafetyCertificateOutlined style={{ color: '#52c41a' }} />}
            color="success"
            style={{ margin: 0, fontSize: 12 }}
          >
            完全访问
          </Tag>
        </Tooltip>

        {promptSource && (
          <Tooltip title="提示词记录">
            <Button type="text" icon={<HistoryOutlined />} onClick={openHistory} />
          </Tooltip>
        )}

        {!hideExtras && onSecondaryModelChange && (
          <Select
            aria-label="次模型"
            size="small"
            style={{ width: 130 }}
            value={secondaryModel || undefined}
            onChange={(v) => onSecondaryModelChange(v)}
            placeholder="次模型（可选）"
            allowClear
            options={allModels.map((m) => ({ label: m, value: m }))}
          />
        )}

        <div style={{ flex: 1 }} />

        {extraActions}

        <Select
          aria-label="主模型"
          size="small"
          style={{ width: 150 }}
          value={model || undefined}
          onChange={onModelChange}
          placeholder="主模型"
          options={allModels.map((m) => ({ label: m, value: m }))}
        />
        <Tooltip title="语音输入（即将开放）">
          <Button type="text" icon={<AudioOutlined />} disabled />
        </Tooltip>
        {streaming ? (
          <Button danger icon={<StopOutlined />} onClick={onStop}>
            停止
          </Button>
        ) : (
          <Button
            type="primary"
            shape="circle"
            icon={<SendOutlined />}
            disabled={disabled || !value.trim()}
            onClick={doSend}
            title="发送 (Enter)"
          />
        )}
      </div>

      <Drawer
        title="提示词记录"
        placement="right"
        width={360}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        styles={{ body: { padding: 8 } }}
        extra={
          <Popconfirm
            title="确认清空全部提示词记录？"
            okText="清空"
            cancelText="取消"
            onConfirm={clearHistory}
          >
            <Button size="small" danger icon={<ClearOutlined />}>
              清空
            </Button>
          </Popconfirm>
        }
      >
        {history.length === 0 ? (
          <Empty description={loadingHistory ? '加载中…' : '暂无记录（发送消息后自动沉淀）'} />
        ) : (
          <List
            dataSource={history}
            renderItem={(it) => (
              <List.Item
                actions={[
                  <Tooltip key="insert" title="插入输入框">
                    <Button type="link" size="small" icon={<ArrowDownOutlined />} onClick={() => insertPrompt(it)} />
                  </Tooltip>,
                  <Popconfirm
                    key="del"
                    title="删除该记录？"
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() => void removePrompt(it.id)}
                  >
                    <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                ]}
              >
                <div style={{ width: '100%' }}>
                  <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 120, overflow: 'auto' }}>
                    {it.text}
                  </div>
                  <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Tag color={it.source === 'ai' ? 'blue' : 'green'} style={{ margin: 0 }}>
                      {it.source === 'ai' ? 'AI 对话' : '写作'}
                    </Tag>
                    {it.model && (
                      <Tag style={{ margin: 0, fontSize: 11 }}>
                        {it.model}
                      </Tag>
                    )}
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {new Date(it.at).toLocaleString()}
                    </Typography.Text>
                  </div>
                </div>
              </List.Item>
            )}
          />
        )}
      </Drawer>
    </div>
  )
}