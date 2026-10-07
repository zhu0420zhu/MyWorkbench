import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Collapse,
  Empty,
  Input,
  List,
  Progress,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Tabs,
  Typography,
  message
} from 'antd'
import {
  BookOutlined,
  BuildOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  SearchOutlined,
  ClearOutlined
} from '@ant-design/icons'
import type {
  AskResult,
  IndexStats,
  KnowledgeBuildInput,
  KnowledgeBuildResult,
  QaHistoryEntry,
  SearchHit
} from '@shared/types'

/* ---------- 建索引 ---------- */
function IndexSection() {
  const [dir, setDir] = useState('')
  const [recursive, setRecursive] = useState(true)
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<SearchHit[]>([])
  const [stats, setStats] = useState<IndexStats | null>(null)

  const refreshStats = useCallback(async () => {
    try {
      setStats(await window.api.searchIndex.stats())
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void refreshStats()
  }, [refreshStats])

  const pick = async (): Promise<void> => {
    const d = await window.api.data.pickDir('选择要建立索引的目录')
    if (d) setDir(d)
  }

  const ingest = async (): Promise<void> => {
    if (!dir.trim()) {
      message.warning('请先选择目录')
      return
    }
    setLoading(true)
    try {
      const r = await window.api.searchIndex.ingestDir(dir.trim(), recursive)
      const ok = r.filter((x) => x.success).length
      message.success(`已索引 ${ok}/${r.length} 个文件（含图片视觉描述）`)
      void refreshStats()
    } catch (err) {
      message.error('索引失败：' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const rebuild = async (): Promise<void> => {
    setLoading(true)
    try {
      await window.api.searchIndex.rebuild()
      message.success('索引已重建')
      void refreshStats()
    } catch (err) {
      message.error('重建失败：' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space wrap>
        <Input
          style={{ width: 340 }}
          placeholder="目录路径"
          aria-label="目录路径"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
        />
        <Button icon={<FolderOpenOutlined />} onClick={pick}>
          选择目录
        </Button>
        <Switch
          checked={recursive}
          onChange={setRecursive}
          checkedChildren="递归"
          unCheckedChildren="仅当前"
        />
        <Button type="primary" icon={<DatabaseOutlined />} loading={loading} onClick={ingest}>
          建立索引
        </Button>
        <Button icon={<ClearOutlined />} loading={loading} onClick={rebuild}>
          重建索引
        </Button>
      </Space>

      {stats && (
        <Card size="small">
          <Space size="large" wrap>
            <Statistic title="已索引文档" value={stats.docCount} />
            <Statistic title="文本块" value={stats.chunkCount} />
            <Statistic title="Token 估算" value={stats.tokenCount} />
            <Tag color={stats.available ? 'green' : 'red'}>
              {stats.available ? '索引可用' : '索引不可用'}
            </Tag>
          </Space>
        </Card>
      )}

      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
        建立索引即把目录下文本/HTML/代码/图片（自动生成视觉描述）解析为可检索块。图片无需转换即可被问答检索（Vision RAG）。
      </Typography.Paragraph>
    </Space>
  )
}

/* ---------- 检索问答（与本地文件对话，含上下文优化与 MCP 工具调用） ---------- */
function AskSection() {
  const [question, setQuestion] = useState('')
  const [maxTokens, setMaxTokens] = useState<number>(3000)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<AskResult | null>(null)
  const [history, setHistory] = useState<QaHistoryEntry[]>([])

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await window.api.searchIndex.qaHistory())
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

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
      void loadHistory()
    } catch (err) {
      message.error('问答失败：' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const clearHistory = async (): Promise<void> => {
    try {
      await window.api.searchIndex.qaHistoryClear()
      setHistory([])
      message.success('问答历史已清空')
    } catch {
      /* ignore */
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space wrap>
        <Input
          style={{ width: 420 }}
          placeholder="向本地文件提问，如：项目里如何处理索引？"
          aria-label="向本地文件提问"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onPressEnter={() => void ask()}
        />
        <Input
          style={{ width: 130 }}
          type="number"
          addonBefore="上下文"
          aria-label="上下文 token 数"
          value={String(maxTokens)}
          onChange={(e) => setMaxTokens(Number(e.target.value) || 3000)}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          token 预算（上下文优化）
        </Typography.Text>
        <Button type="primary" icon={<SearchOutlined />} loading={loading} onClick={ask}>
          提问
        </Button>
      </Space>

      {result && (
        <Card size="small">
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>{result.answer}</Typography.Paragraph>

          <Space wrap style={{ marginBottom: 8 }}>
            <Tag color={result.answerMode === 'generated' ? 'blue' : result.answerMode === 'empty' ? 'default' : 'orange'}>
              {result.answerMode === 'generated'
                ? '已生成'
                : result.answerMode === 'retrieval-only'
                ? '仅检索模式'
                : '无命中'}
            </Tag>
            <Tag>使用块 {result.usedChunks}</Tag>
            {result.contextTokens != null && <Tag color="cyan">上下文 {result.contextTokens} token</Tag>}
            {result.truncated && <Tag color="red">上下文已截断</Tag>}
          </Space>

          {result.mcpToolCalls && result.mcpToolCalls.length > 0 && (
            <Collapse
              size="small"
              style={{ marginBottom: 8 }}
              items={[
                {
                  key: 'tools',
                  label: `本次调用的外部工具（MCP）：${result.mcpToolCalls.length}`,
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

      <Card
        size="small"
        title="问答历史"
        extra={
          <Button size="small" icon={<DeleteOutlined />} onClick={clearHistory}>
            清空
          </Button>
        }
      >
        {history.length === 0 ? (
          <Empty description="暂无问答记录" />
        ) : (
          <List
            size="small"
            dataSource={history}
            renderItem={(h) => (
              <List.Item>
                <div>
                  <Typography.Text strong>{h.question}</Typography.Text>
                  <br />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {new Date(h.at).toLocaleString()} · {h.citationCount} 引用
                  </Typography.Text>
                  <div style={{ fontSize: 13, marginTop: 2 }}>{h.answer.slice(0, 120)}</div>
                </div>
              </List.Item>
            )}
          />
        )}
      </Card>
    </Space>
  )
}

/* ---------- 知识库构建（convert → index → QA 流水线） ---------- */
function BuildSection() {
  const [paths, setPaths] = useState('')
  const [recursive, setRecursive] = useState(true)
  const [includeImages, setIncludeImages] = useState(true)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<KnowledgeBuildResult | null>(null)

  const build = async (): Promise<void> => {
    const items: KnowledgeBuildInput[] = paths
      .split(/\n|;/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => ({ path: p, kind: p.endsWith('/') || p.endsWith('\\') ? 'dir' : 'file' }))
    if (items.length === 0) {
      message.warning('请输入至少一个文件或目录路径')
      return
    }
    setLoading(true)
    try {
      const r = await window.api.knowledgeBase.build(items, { recursive, includeImages })
      setResult(r)
      message.success(`构建完成：索引 ${r.ingested} · 转换后索引 ${r.ingestedConverted} · 跳过 ${r.skipped} · 失败 ${r.failed}`)
    } catch (err) {
      message.error('构建失败：' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const pct = (n: number): number => (result && result.total ? Math.round((n / result.total) * 100) : 0)

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert
        type="info"
        showIcon
        message="知识库构建 = 自动路由格式转换 + 本地索引 + 图片视觉描述，一次性把文档纳入可检索知识库"
      />
      <Input.TextArea
        rows={4}
        placeholder={'每行一个文件或目录路径（目录以 / 或 \\ 结尾）。例如：\nC:/Docs/report.pdf\nD:/Notes/'}
        aria-label="待索引的文件或目录路径"
        value={paths}
        onChange={(e) => setPaths(e.target.value)}
      />
      <Space>
        <Switch checked={recursive} onChange={setRecursive} checkedChildren="递归" unCheckedChildren="仅当前" />
        <Switch checked={includeImages} onChange={setIncludeImages} checkedChildren="含图片" unCheckedChildren="不含图片" />
        <Button type="primary" icon={<BuildOutlined />} loading={loading} onClick={build}>
          构建知识库
        </Button>
      </Space>

      {result && (
        <Card size="small">
          <Space wrap style={{ marginBottom: 12 }}>
            <Statistic title="总计" value={result.total} />
            <Statistic title="直接索引" value={result.ingested} />
            <Statistic title="转换后索引" value={result.ingestedConverted} />
            <Statistic title="跳过" value={result.skipped} />
            <Statistic title="失败" value={result.failed} />
          </Space>
          <Progress
            percent={pct(result.ingested + result.ingestedConverted)}
            success={{ percent: pct(result.ingested + result.ingestedConverted) }}
            status={result.failed > 0 ? 'exception' : 'normal'}
          />
          <Table
            size="small"
            style={{ marginTop: 8 }}
            rowKey="sourcePath"
            dataSource={result.items}
            pagination={{ pageSize: 8 }}
            columns={[
              { title: '来源', dataIndex: 'sourcePath', ellipsis: true },
              {
                title: '状态',
                dataIndex: 'status',
                width: 140,
                render: (s: string) => {
                  const map: Record<string, string> = {
                    ingested: 'green',
                    'ingested-converted': 'blue',
                    skipped: 'default',
                    error: 'red'
                  }
                  return <Tag color={map[s] ?? 'default'}>{s}</Tag>
                }
              },
              { title: '块数', dataIndex: 'chunkCount', width: 70 },
              {
                title: '说明',
                dataIndex: 'error',
                ellipsis: true,
                render: (e?: string) => (e ? <Typography.Text type="danger">{e}</Typography.Text> : '-')
              }
            ]}
          />
        </Card>
      )}
    </Space>
  )
}

const GUIDE_KEY = 'kb-guide-dismissed-v1'

export default function KnowledgeBase() {
  const [guideOpen, setGuideOpen] = useState(() => localStorage.getItem(GUIDE_KEY) !== '1')
  return (
    <div className="dashboard-page">
      <div className="page-header">
        <Typography.Title level={4} style={{ margin: 0 }}>
          <BookOutlined /> 本地知识库
        </Typography.Title>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          全文检索索引 · Vision RAG（图片描述）· 知识库流水线（移植自 awesome-llm-apps RAG / Chat-with-Files）
        </Typography.Text>
        {!guideOpen && (
          <Button size="small" icon={<BookOutlined />} onClick={() => setGuideOpen(true)}>
            使用引导
          </Button>
        )}
      </div>
      {guideOpen && (
        <Alert
          type="info"
          showIcon
          closable
          style={{ marginBottom: 12 }}
          onClose={() => {
            localStorage.setItem(GUIDE_KEY, '1')
            setGuideOpen(false)
          }}
          message="三步上手本地知识库（全离线，数据不出本机）"
          description={
            <div style={{ fontSize: 13, lineHeight: 1.9 }}>
              <p style={{ margin: '2px 0' }}>
                ① <b>建立索引</b>：选择一个文件夹（可含子目录）建立全文检索索引，支持 Markdown / TXT / PDF / DOCX 等文本类文件。索引完成后即可在「检索问答」中搜索。
              </p>
              <p style={{ margin: '2px 0' }}>
                ② <b>知识库构建</b>（可选，批量进阶）：粘贴文件或目录路径批量纳入知识库——Office / PDF 等格式会自动经本地 LibreOffice / Pandoc 转换后索引；勾选「含图片」还会为图片生成视觉描述（Vision RAG），实现以图搜答。
              </p>
              <p style={{ margin: '2px 0' }}>
                ③ <b>检索问答</b>：用自然语言提问，答案基于已索引内容生成并附带引用来源；历史问答可随时回看。
              </p>
              <p style={{ margin: '2px 0 0' }}>
                🔒 全流程本地处理：文档内容与索引数据只保存在本机，不会上传到任何服务器。
              </p>
            </div>
          }
        />
      )}
      <Tabs
        defaultActiveKey="ask"
        items={[
          { key: 'ask', label: '检索问答', children: <AskSection /> },
          { key: 'index', label: '建立索引', children: <IndexSection /> },
          { key: 'build', label: '知识库构建', children: <BuildSection /> }
        ]}
      />
    </div>
  )
}
