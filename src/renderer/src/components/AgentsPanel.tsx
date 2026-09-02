import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  Card,
  Collapse,
  Empty,
  Input,
  List,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message
} from 'antd'
import {
  ApartmentOutlined,
  LinkOutlined,
  PlayCircleOutlined,
  ReloadOutlined
} from '@ant-design/icons'
import type { AgentJobInfo, AgentResultItem, AgentRunRecord, AgentsConfig } from '@shared/types'

/**
 * 智能体面板的渲染组件（不含页面标题/路由逻辑）。
 * 从 pages/Agents.tsx 抽出，供 Hotspots（多媒体）作为内置 Tab 复用，
 * 实现「智能体」与「多媒体」的融合。
 */
export default function AgentsPanel() {
  const [jobs, setJobs] = useState<AgentJobInfo[]>([])
  const [history, setHistory] = useState<Record<string, AgentRunRecord[]>>({})
  const [repos, setRepos] = useState<string>('')
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    try {
      const [list, cfg] = await Promise.all([
        window.api.agents.list(),
        window.api.agents.config({})
      ])
      setJobs(list)
      setRepos((cfg.releaseRepos ?? []).join('\n'))
    } catch (err) {
      message.error('加载智能体失败：' + (err as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const runNow = async (id: string): Promise<void> => {
    setRunningIds((prev) => new Set(prev).add(id))
    try {
      const r = await window.api.agents.runNow(id)
      if (r.ok) message.success(r.summary || '运行成功')
      else message.warning(r.error || '运行失败')
      await load()
      await loadHistory(id)
    } catch (err) {
      message.error('运行失败：' + (err as Error).message)
    } finally {
      setRunningIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const toggle = async (job: AgentJobInfo, enabled: boolean): Promise<void> => {
    try {
      await window.api.agents.jobConfig(job.id, { enabled })
      setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, enabled } : j)))
      message.success(enabled ? '已启用' : '已停用')
    } catch (err) {
      message.error('设置失败：' + (err as Error).message)
    }
  }

  const saveRepos = async (): Promise<void> => {
    const list = repos
      .split(/\n|;/)
      .map((r) => r.trim())
      .filter(Boolean)
    try {
      await window.api.agents.config({ releaseRepos: list })
      message.success('Release Radar 仓库已更新')
    } catch (err) {
      message.error('保存失败：' + (err as Error).message)
    }
  }

  const loadHistory = useCallback(async (id: string): Promise<void> => {
    try {
      const h = await window.api.agents.history(id)
      setHistory((prev) => ({ ...prev, [id]: h }))
    } catch {
      /* ignore */
    }
  }, [])

  // 挂载后预加载各 job 运行历史（Collapse 展开即可见）
  useEffect(() => {
    jobs.forEach((j) => void loadHistory(j.id))
  }, [jobs, loadHistory])

  return (
    <div>
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 12 }}>
        常驻智能体：每日自动抓取 Hacker News 简报 与 GitHub 发布动态（Release Radar），到点系统通知
      </Typography.Text>

      <Card
        title="Release Radar 关注仓库"
        size="small"
        extra={
          <Button size="small" type="primary" icon={<ReloadOutlined />} onClick={saveRepos}>
            保存
          </Button>
        }
        style={{ marginBottom: 16 }}
      >
        <Input.TextArea
          aria-label="GitHub 仓库列表"
          rows={3}
          placeholder="每行一个 owner/repo，如 microsoft/vscode"
          value={repos}
          onChange={(e) => setRepos(e.target.value)}
        />
      </Card>

      {jobs.length === 0 ? (
        <Empty description="暂无常驻智能体" />
      ) : (
        <Table
          rowKey="id"
          dataSource={jobs}
          pagination={false}
          columns={[
            {
              title: '名称',
              dataIndex: 'name',
              render: (v: string, j) => (
                <Space>
                  <Typography.Text strong>{v}</Typography.Text>
                  <Tag>{(j.intervalMs / 3600000).toFixed(0)}h</Tag>
                </Space>
              )
            },
            { title: '说明', dataIndex: 'description', ellipsis: true },
            {
              title: '状态',
              dataIndex: 'lastStatus',
              width: 90,
              render: (s: string) => {
                const map: Record<string, string> = { idle: 'default', ok: 'green', error: 'red' }
                return <Tag color={map[s] ?? 'default'}>{s}</Tag>
              }
            },
            {
              title: '上次运行',
              dataIndex: 'lastRunAt',
              width: 160,
              render: (t: number | null) => (t ? new Date(t).toLocaleString() : '从未')
            },
            {
              title: '上次摘要',
              dataIndex: 'lastSummary',
              ellipsis: true,
              render: (v?: string) => <Typography.Text type="secondary">{v ?? '-'}</Typography.Text>
            },
            {
              title: '启用',
              dataIndex: 'enabled',
              width: 80,
              render: (v: boolean, j) => (
                <Switch size="small" checked={v} onChange={(e) => void toggle(j, e)} />
              )
            },
            {
              title: '操作',
              width: 120,
              render: (_v, j) => (
                <Button
                  size="small"
                  type="primary"
                  icon={<PlayCircleOutlined />}
                  loading={runningIds.has(j.id)}
                  onClick={() => void runNow(j.id)}
                >
                  立即运行
                </Button>
              )
            }
          ]}
        />
      )}

      <Collapse
        style={{ marginTop: 16 }}
        items={jobs.map((j) => ({
          key: j.id,
          label: `运行历史 · ${j.name}`,
          children: (
            <List
              size="small"
              dataSource={history[j.id] ?? []}
              locale={{ emptyText: '暂无运行记录' }}
              renderItem={(h: AgentRunRecord) => (
                <List.Item>
                  <div style={{ width: '100%' }}>
                    <Space wrap>
                      <Tag color={h.ok ? 'green' : 'red'}>{h.ok ? '成功' : '失败'}</Tag>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {new Date(h.at).toLocaleString()}
                      </Typography.Text>
                      <Typography.Text>{h.summary}</Typography.Text>
                    </Space>
                    {h.items && h.items.length > 0 && (
                      <List
                        size="small"
                        style={{
                          marginTop: 6,
                          background: 'var(--bg-subtle, rgba(0,0,0,.03))',
                          borderRadius: 8
                        }}
                        dataSource={h.items}
                        renderItem={(it: AgentResultItem) => (
                          <List.Item
                            style={{ paddingInline: 10 }}
                            actions={
                              it.url
                                ? [
                                    <Button
                                      key="open"
                                      type="link"
                                      size="small"
                                      icon={<LinkOutlined />}
                                      onClick={() => void window.api.openExternal(it.url as string)}
                                    >
                                      打开
                                    </Button>
                                  ]
                                : []
                            }
                          >
                            <Space size={6} wrap>
                              {it.meta && (
                                <Tag color="blue" style={{ margin: 0 }}>
                                  {it.meta}
                                </Tag>
                              )}
                              <Typography.Text
                                style={{
                                  fontSize: 13,
                                  cursor: it.url ? 'pointer' : 'default',
                                  color: it.url ? 'var(--link-color, #1677ff)' : undefined
                                }}
                                onClick={() => it.url && void window.api.openExternal(it.url)}
                              >
                                {it.title}
                              </Typography.Text>
                            </Space>
                          </List.Item>
                        )}
                      />
                    )}
                  </div>
                </List.Item>
              )}
            />
          )
        }))}
      />
    </div>
  )
}
