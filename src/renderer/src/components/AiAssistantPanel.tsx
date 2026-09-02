import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Alert, Card, Collapse, Empty, Input, List, Select, Space, Switch, Tabs, Tag, Typography, message } from 'antd'
import { RobotOutlined, SettingOutlined, DeleteOutlined, UploadOutlined, DownloadOutlined, SearchOutlined } from '@ant-design/icons'
import ComposerInput, { BUILTIN_SKILLS } from './ComposerInput'
import type { AiChatMessage, AskResult } from '@shared/types'

interface ChatItem {
  role: 'user' | 'assistant'
  content: string
  error?: boolean
}

/**
 * AI 助手面板：通用对话 + 本地文件问答。
 * 从 pages/Ai.tsx 抽出，供 AutoWorkbench（自动工作台）作为内置 Tab 复用，
 * 实现「AI 助手」与「自动工作台」的融合。
 */
export default function AiAssistantPanel() {
  const [messages, setMessages] = useState<ChatItem[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [skills, setSkills] = useState<string[]>([])
  const [secondaryModel, setSecondaryModel] = useState<string>('')
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [memoryEnabled, setMemoryEnabled] = useState(false)
  const memoryLoaded = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef('')

  const checkConfig = useCallback(async () => {
    try {
      const cfg = await window.api.ai.getConfig()
      setConfigured(Boolean(cfg.endpoint))
      setSelectedModel((cur) => cur || cfg.model || '')
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    checkConfig()
  }, [checkConfig])

  // 加载记忆（若开启则恢复历史）
  useEffect(() => {
    window.api.aiMemory
      .load()
      .then((mem) => {
        setMemoryEnabled(mem.enabled)
        if (mem.enabled && mem.messages.length > 0) {
          setMessages(mem.messages as ChatItem[])
        }
        memoryLoaded.current = true
      })
      .catch(() => {
        memoryLoaded.current = true
      })
  }, [])

  useEffect(() => {
    const offChunk = window.api.ai.onChunk((p) => {
      if (p.sessionId !== sessionRef.current) return
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        if (last && last.role === 'assistant') {
          const next = [...prev]
          next[next.length - 1] = { ...last, content: last.content + p.chunk }
          return next
        }
        return [...prev, { role: 'assistant', content: p.chunk }]
      })
    })
    const offDone = window.api.ai.onDone((p) => {
      if (p.sessionId !== sessionRef.current) return
      setStreaming(false)
      sessionRef.current = ''
      if (!p.ok) {
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last && last.role === 'assistant') {
            const next = [...prev]
            next[next.length - 1] = { ...last, error: true }
            return next
          }
          return prev
        })
      }
    })
    return () => {
      offChunk()
      offDone()
    }
  }, [])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  // 记忆开启时自动保存对话（防抖）
  const memoryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    if (!memoryLoaded.current || !memoryEnabled) return
    clearTimeout(memoryTimer.current)
    memoryTimer.current = setTimeout(() => {
      window.api.aiMemory.save({ enabled: true, messages: messages as AiChatMessage[] }).catch(() => undefined)
    }, 600)
  }, [messages, memoryEnabled])

  const handleSend = async (): Promise<void> => {
    const text = input.trim()
    if (!text || streaming) return
    setInput('')
    const skillHints = skills
      .map((k) => BUILTIN_SKILLS.find((s) => s.key === k)?.hint)
      .filter(Boolean)
      .join('\n')
    const sysHint = skillHints ? `[附加约束]\n${skillHints}` : ''
    const userMsg: ChatItem = { role: 'user', content: text }
    setMessages((prev) => [...prev, userMsg])

    const baseHistory: AiChatMessage[] = messages.map((m) => ({ role: m.role, content: m.content }))
    const history: AiChatMessage[] = sysHint
      ? [...baseHistory, { role: 'system' as 'system', content: sysHint }, { role: 'user', content: text }]
      : [...baseHistory, { role: 'user', content: text }]
    const sessionId = crypto.randomUUID()
    sessionRef.current = sessionId
    setStreaming(true)
    try {
      const ok = await window.api.ai.chat(sessionId, history, selectedModel || undefined)
      if (!ok) {
        setStreaming(false)
        sessionRef.current = ''
        message.warning('AI 未配置，请到「设置」页配置模型')
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: '（未配置模型，请到设置页配置）', error: true }
        ])
      }
      // 次模型：补充对照（可选）
      if (secondaryModel && secondaryModel !== selectedModel) {
        const sid2 = crypto.randomUUID()
        try {
          await window.api.ai.chat(sid2, history, secondaryModel)
        } catch {
          /* ignore */
        }
      }
    } catch {
      setStreaming(false)
      sessionRef.current = ''
      message.error('请求失败')
    }
  }

  const handleMemoryExport = async (): Promise<void> => {
    try {
      const json = await window.api.aiMemory.export()
      const saved = await window.api.exportText('ai-memory.json', json)
      if (saved) message.success('记忆已导出：' + saved)
    } catch {
      message.error('导出失败')
    }
  }

  const handleMemoryImport = async (): Promise<void> => {
    try {
      const file = await window.api.pickTextFile()
      if (!file) return
      const mem = await window.api.aiMemory.import(file.content)
      setMemoryEnabled(mem.enabled)
      setMessages(mem.messages as ChatItem[])
      message.success('记忆已导入（' + mem.messages.length + ' 条消息）')
    } catch (err) {
      message.error('导入失败：' + (err as Error).message)
    }
  }

  const handleStop = async (): Promise<void> => {
    if (sessionRef.current) await window.api.ai.stop(sessionRef.current)
    setStreaming(false)
    sessionRef.current = ''
  }

  return (
    <div className="ai-page-inner">
      <Tabs
        defaultActiveKey="chat"
        items={[
          {
            key: 'chat',
            label: '通用对话',
            children: (
              <>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                  <Button
                    icon={<SettingOutlined />}
                    onClick={() => {
                      const el = [...document.querySelectorAll('.ant-menu-item')].find((e) => e.textContent?.includes('设置'))
                      ;(el as HTMLElement)?.click()
                    }}
                  >
                    模型设置
                  </Button>
                  <Button
                    icon={<DeleteOutlined />}
                    disabled={messages.length === 0 || streaming}
                    onClick={() => {
                      setMessages([])
                      if (memoryEnabled) {
                        window.api.aiMemory.clear().catch(() => undefined)
                      }
                      message.success('已开启新对话')
                    }}
                  >
                    新对话
                  </Button>
                  <Switch
                    checked={memoryEnabled}
                    onChange={(v) => {
                      setMemoryEnabled(v)
                      if (v) {
                        window.api.aiMemory.save({ enabled: true, messages: messages as AiChatMessage[] }).catch(() => undefined)
                        message.success('已开启记忆：对话将自动记录')
                      } else {
                        // 关闭状态也必须持久化 enabled:false，否则下次加载读到的仍是上次的 enabled:true，开关"关不住"
                        window.api.aiMemory.save({ enabled: false, messages: messages as AiChatMessage[] }).catch(() => undefined)
                        message.success('已关闭记忆')
                      }
                    }}
                    checkedChildren="记忆开"
                    unCheckedChildren="记忆关"
                  />
                  <Button icon={<DownloadOutlined />} onClick={() => void handleMemoryExport()} title="导出记忆">
                    记忆导出
                  </Button>
                  <Button icon={<UploadOutlined />} onClick={() => void handleMemoryImport()} title="导入记忆">
                    记忆导入
                  </Button>
                </div>

                <div className="ai-chat" ref={scrollRef}>
                  {messages.length === 0 ? (
                    <Empty
                      style={{ marginTop: 80 }}
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description={
                        configured
                          ? '开始和 AI 对话吧'
                          : '尚未配置模型，请到「设置」页配置 OpenAI 兼容 API（Ollama / OpenAI / 任意网关）'
                      }
                    />
                  ) : (
                    messages.map((m, i) => (
                      <div key={i} className={'ai-msg ' + m.role}>
                        <div className="ai-msg-avatar">{m.role === 'user' ? '我' : <RobotOutlined />}</div>
                        <div className={'ai-msg-bubble' + (m.error ? ' error' : '')}>{m.content}</div>
                      </div>
                    ))
                  )}
                </div>

                <ComposerInput
                  intro="和我聊聊任何事：文档总结、代码编写、数据分析、写作灵感…"
                  value={input}
                  onChange={setInput}
                  onSend={() => void handleSend()}
                  onStop={() => void handleStop()}
                  streaming={streaming}
                  model={selectedModel}
                  onModelChange={setSelectedModel}
                  secondaryModel={secondaryModel}
                  onSecondaryModelChange={setSecondaryModel}
                  modelOptions={['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4', 'llama3.1', 'qwen2.5', 'deepseek-chat', 'gemini-1.5-pro']}
                  skills={skills}
                  onSkillsChange={setSkills}
                  loadMcpTools={() => window.api.mcp.listTools().catch(() => [])}
                  disabled={!configured}
                  promptSource="ai"
                />
              </>
            )
          },
          {
            key: 'local',
            label: '本地文件问答',
            children: <LocalFileQa />
          }
        ]}
      />
    </div>
  )
}

/* ---------- 本地文件问答（与本地文件对话 + 上下文优化 + MCP 工具调用） ---------- */
function LocalFileQa() {
  const [question, setQuestion] = useState('')
  const [maxTokens, setMaxTokens] = useState(3000)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<AskResult | null>(null)

  const ask = async (): Promise<void> => {
    const q = question.trim()
    if (!q) {
      message.warning('请输入问题')
      return
    }
    setLoading(true)
    try {
      const r = await window.api.searchIndex.ask({ question: q, maxTokens })
      setResult(r)
      if (!r.ok && r.answerMode !== 'empty') {
        message.warning('已降级为仅检索模式（LLM 未配置或不可用）')
      }
    } catch (err) {
      message.error('问答失败：' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 8 }}>
      <Alert
        type="info"
        showIcon
        message="基于已建立索引的本地文件回答问题；可调用已连接的 MCP 外部工具；上下文按 token 预算自动压缩。"
      />
      <Space wrap>
        <Input
          aria-label="向本地文件提问"
          style={{ width: 460 }}
          placeholder="向本地文件提问，如：索引里如何做上下文压缩？"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onPressEnter={() => void ask()}
        />
        <Input
          aria-label="上下文 token 数"
          style={{ width: 130 }}
          type="number"
          addonBefore="上下文"
          value={String(maxTokens)}
          onChange={(e) => setMaxTokens(Number(e.target.value) || 3000)}
        />
        <Button type="primary" icon={<SearchOutlined />} loading={loading} onClick={ask}>
          提问
        </Button>
      </Space>

      {result && (
        <Card size="small">
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>{result.answer}</Typography.Paragraph>
          <Space wrap style={{ marginBottom: 8 }}>
            <Tag color={result.answerMode === 'generated' ? 'blue' : result.answerMode === 'empty' ? 'default' : 'orange'}>
              {result.answerMode === 'generated' ? '已生成' : result.answerMode === 'retrieval-only' ? '仅检索模式' : '无命中'}
            </Tag>
            <Tag>使用块 {result.usedChunks}</Tag>
            {result.contextTokens != null && <Tag color="cyan">上下文 {result.contextTokens} token</Tag>}
            {result.truncated && <Tag color="red">上下文已截断（Token 优化）</Tag>}
          </Space>

          {result.mcpToolCalls && result.mcpToolCalls.length > 0 && (
            <Collapse
              size="small"
              style={{ marginBottom: 8 }}
              items={[
                {
                  key: 'tools',
                  label: `本次调用的外部工具（MCP）： ${result.mcpToolCalls.length}`,
                  children: (
                    <List
                      size="small"
                      dataSource={result.mcpToolCalls}
                      renderItem={(t) => (
                        <List.Item>
                          <Tag color={t.isError ? 'red' : 'green'}>{t.serverId}::{t.name}</Tag>
                          <Typography.Text code style={{ fontSize: 12 }}>
                            {String(t.result).slice(0, 200)}
                          </Typography.Text>
                        </List.Item>
                      )}
                    />
                  )
                }
              ]}
            />
          )}

          {result.citations.length > 0 && (
            <Collapse
              size="small"
              defaultActiveKey={['c']}
              items={[
                {
                  key: 'c',
                  label: `引用来源（${result.citations.length}）`,
                  children: (
                    <List
                      size="small"
                      dataSource={result.citations}
                      renderItem={(c) => (
                        <List.Item>
                          <Typography.Text strong style={{ width: 28 }}>
                            [{c.index}]
                          </Typography.Text>
                          <Typography.Text code style={{ fontSize: 12 }} ellipsis={{ tooltip: c.filePath }}>
                            {c.filePath}
                          </Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {c.snippet.slice(0, 80)}
                          </Typography.Text>
                        </List.Item>
                      )}
                    />
                  )
                }
              ]}
            />
          )}
        </Card>
      )}
    </div>
  )
}
