import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message
} from 'antd'
import { DeleteOutlined, LinkOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { hoursToMs, isValidHttpUrl, msToHours } from './feedUtils'
import type { FeedItem, FeedRunRecord, FeedSourceMeta } from '@shared/types'

/**
 * 数据源管理面板（抽屉）。
 * 合并原「智能体面板」（任务表 + 启用/立即运行/历史）
 * 与原「多媒体页」的热点平台状态条：
 * 16 个热点平台 + 2 个智能体任务统一在一张表里管理。
 * 仅使用 window.api.feed.*。
 */
export interface SourceManagerProps {
  open: boolean
  onClose: () => void
  /** 数据源配置变更后通知外层刷新（可选） */
  onChanged?: () => void
}

const STATUS_COLOR: Record<FeedSourceMeta['lastStatus'], string> = {
  idle: 'default',
  ok: 'green',
  error: 'red'
}

const STATUS_LABEL: Record<FeedSourceMeta['lastStatus'], string> = {
  idle: '未运行',
  ok: '正常',
  error: '失效'
}

export default function SourceManager({ open, onClose, onChanged }: SourceManagerProps) {
  const [sources, setSources] = useState<FeedSourceMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const [history, setHistory] = useState<Record<string, FeedRunRecord[]>>({})
  const [expandedKeys, setExpandedKeys] = useState<string[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [addForm] = Form.useForm()

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setSources(await window.api.feed.listSources())
    } catch (err) {
      message.error(`加载数据源失败：${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const loadHistory = useCallback(async (id: string): Promise<void> => {
    try {
      const h = await window.api.feed.history(id)
      setHistory((prev) => ({ ...prev, [id]: h }))
    } catch {
      /* 历史不可用时忽略 */
    }
  }, [])

  const applyConfig = async (
    src: FeedSourceMeta,
    patch: { enabled?: boolean; intervalMs?: number }
  ): Promise<void> => {
    const next: FeedSourceMeta = {
      ...src,
      enabled: patch.enabled ?? src.enabled,
      intervalMs: patch.intervalMs ?? src.intervalMs
    }
    setSources((prev) => prev.map((s) => (s.id === src.id ? next : s)))
    try {
      await window.api.feed.setSourceConfig(src.id, {
        enabled: next.enabled,
        intervalMs: next.intervalMs
      })
      onChanged?.()
    } catch (err) {
      message.error(`设置失败：${(err as Error).message}`)
      void load()
    }
  }

  const runNow = async (src: FeedSourceMeta): Promise<void> => {
    setRunningIds((prev) => new Set(prev).add(src.id))
    try {
      const items: FeedItem[] = await window.api.feed.runSource(src.id)
      message.success(`「${src.name}」运行完成：产出 ${items.length} 条`)
      await load()
      await loadHistory(src.id)
      onChanged?.()
    } catch (err) {
      message.error(`运行失败：${(err as Error).message}`)
    } finally {
      setRunningIds((prev) => {
        const nextSet = new Set(prev)
        nextSet.delete(src.id)
        return nextSet
      })
    }
  }

  const openLink = (url: string): void => {
    if (isValidHttpUrl(url)) void window.api.openExternal(url)
    else message.error('链接无效，无法打开')
  }

  const handleAdd = async (values: {
    id: string
    name: string
    kind: 'hot' | 'agent'
    url: string
    description?: string
    defaultCategory?: string
    intervalHours?: number
  }): Promise<void> => {
    try {
      await window.api.feed.addSource({
        id: values.id.trim(),
        name: values.name.trim(),
        kind: values.kind,
        description: values.description?.trim(),
        defaultCategory: values.defaultCategory?.trim() || undefined,
        enabled: true,
        intervalMs: values.kind === 'hot' ? 0 : Math.max(1, values.intervalHours ?? 1) * 3600_000,
        url: values.url.trim()
      })
      message.success('数据源已添加')
      addForm.resetFields()
      setAddOpen(false)
      await load()
      onChanged?.()
    } catch (err) {
      message.error(`添加失败：${(err as Error).message}`)
    }
  }

  const handleRemove = (src: FeedSourceMeta): void => {
    Modal.confirm({
      title: '删除数据源',
      content: `确定删除「${src.name}」吗？该数据源的历史记录与周期任务将一并移除。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await window.api.feed.removeSource(src.id)
          message.success('已删除')
          await load()
          onChanged?.()
        } catch (err) {
          message.error(`删除失败：${(err as Error).message}`)
        }
      }
    })
  }

  const okCount = sources.filter((s) => s.lastStatus === 'ok').length
  const hotCount = sources.filter((s) => s.kind === 'hot').length
  const agentCount = sources.filter((s) => s.kind === 'agent').length

  return (
    <Drawer
      title="数据源管理"
      open={open}
      onClose={onClose}
      width={900}
      extra={
        <Space>
          <Button
            size="small"
            icon={<PlusOutlined />}
            onClick={() => setAddOpen(true)}
          >
            添加数据源
          </Button>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => void load()}
          >
            刷新
          </Button>
        </Space>
      }
    >
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 12 }}>
        共 {sources.length} 个数据源（热点平台 {hotCount} · 智能体 {agentCount}），运行正常{' '}
        {okCount} 个。热点平台为实时聚合（周期固定 0）；智能体任务按周期自动运行并弹系统通知。
      </Typography.Text>

      {sources.length === 0 ? (
        <Empty description="暂无数据源" />
      ) : (
        <Table<FeedSourceMeta>
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={sources}
          pagination={false}
          expandable={{
            expandedRowKeys: expandedKeys,
            onExpand: (expanded, record) => {
              setExpandedKeys((prev) =>
                expanded ? [...prev, record.id] : prev.filter((k) => k !== record.id)
              )
              if (expanded && !history[record.id]) void loadHistory(record.id)
            },
            expandedRowRender: (record) => (
              <List
                size="small"
                dataSource={history[record.id] ?? []}
                locale={{ emptyText: '暂无运行记录' }}
                renderItem={(h: FeedRunRecord) => (
                  <List.Item>
                    <div style={{ width: '100%' }}>
                      <Space wrap>
                        <Tag color={h.ok ? 'green' : 'red'}>{h.ok ? '成功' : '失败'}</Tag>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {new Date(h.at).toLocaleString()}
                        </Typography.Text>
                        <Typography.Text>{h.summary}</Typography.Text>
                        {h.error && (
                          <Typography.Text type="danger" style={{ fontSize: 12 }}>
                            {h.error}
                          </Typography.Text>
                        )}
                      </Space>
                      {h.items && h.items.length > 0 && (
                        <List
                          size="small"
                          style={{
                            marginTop: 6,
                            background: 'var(--bg-subtle, rgba(0,0,0,.03))',
                            borderRadius: 8
                          }}
                          dataSource={h.items.slice(0, 10)}
                          renderItem={(it: FeedItem) => (
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
                                        onClick={() => openLink(it.url as string)}
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
                                  onClick={() => it.url && openLink(it.url)}
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
          }}
          columns={[
            {
              title: '启用',
              dataIndex: 'enabled',
              width: 70,
              render: (v: boolean, record) => (
                <Switch
                  size="small"
                  checked={v}
                  onChange={(checked) => void applyConfig(record, { enabled: checked })}
                />
              )
            },
            {
              title: '名称',
              dataIndex: 'name',
              width: 200,
              render: (v: string, record) => (
                <Space size={4}>
                  <Typography.Text strong>{v}</Typography.Text>
                  <Tag
                    color={record.kind === 'agent' ? 'geekblue' : 'volcano'}
                    style={{ fontSize: 11, margin: 0 }}
                  >
                    {record.kind === 'agent' ? '智能体' : '热点'}
                  </Tag>
                </Space>
              )
            },
            { title: '说明', dataIndex: 'description', ellipsis: true },
            {
              title: '周期（小时）',
              dataIndex: 'intervalMs',
              width: 130,
              render: (v: number, record) => (
                <InputNumber
                  size="small"
                  min={0}
                  step={1}
                  style={{ width: 90 }}
                  value={msToHours(v)}
                  // 热点平台为实时聚合（intervalMs 固定 0），置灰不可编辑
                  disabled={record.kind === 'hot'}
                  aria-label={`${record.name} 运行周期（小时）`}
                  onChange={(h) => {
                    if (h === null || record.kind === 'hot') return
                    void applyConfig(record, { intervalMs: hoursToMs(Number(h)) })
                  }}
                />
              )
            },
            {
              title: '状态',
              dataIndex: 'lastStatus',
              width: 95,
              render: (s: FeedSourceMeta['lastStatus'], record) => (
                <Tag color={STATUS_COLOR[s]} title={record.lastSummary}>
                  {STATUS_LABEL[s]}
                  {s === 'ok' ? ` · ${record.lastItemCount}` : ''}
                </Tag>
              )
            },
            {
              title: '上次运行',
              dataIndex: 'lastRunAt',
              width: 165,
              render: (t: number | null) => (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t ? new Date(t).toLocaleString() : '从未'}
                </Typography.Text>
              )
            },
            {
              title: '操作',
              width: 170,
              render: (_v, record) => (
                <Space>
                  <Button
                    size="small"
                    type="primary"
                    icon={<PlayCircleOutlined />}
                    loading={runningIds.has(record.id)}
                    onClick={() => void runNow(record)}
                  >
                    立即运行
                  </Button>
                  {!record.builtIn && (
                    <Button
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      title="删除"
                      onClick={() => handleRemove(record)}
                    >
                      删除
                    </Button>
                  )}
                </Space>
              )
            }
          ]}
        />
      )}

      <Modal
        title="添加数据源"
        open={addOpen}
        onCancel={() => {
          setAddOpen(false)
          addForm.resetFields()
        }}
        onOk={() => addForm.submit()}
        width={520}
      >
        <Form form={addForm} layout="vertical" onFinish={handleAdd}>
          <Form.Item
            name="id"
            label="ID"
            rules={[{ required: true, message: '请输入数据源 ID' }]}
          >
            <Input placeholder="如 my-rss" />
          </Form.Item>
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: '请输入数据源名称' }]}
          >
            <Input placeholder="如 我的 RSS" />
          </Form.Item>
          <Form.Item name="kind" label="类型" initialValue="agent" rules={[{ required: true }]}>
            <Select
              options={[
                { label: '智能体（按周期拉取）', value: 'agent' },
                { label: '热点（实时聚合）', value: 'hot' }
              ]}
            />
          </Form.Item>
          <Form.Item
            name="url"
            label="JSON Feed URL"
            rules={[{ required: true, message: '请输入 JSON feed 地址' }]}
            extra="期望返回 [{ title, url, hot? }] 或 { items: [...] }"
          >
            <Input placeholder="https://example.com/feed.json" />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input.TextArea rows={2} placeholder="可选说明" />
          </Form.Item>
          <Form.Item name="defaultCategory" label="默认分类">
            <Input placeholder="如 科技" />
          </Form.Item>
          <Form.Item
            name="intervalHours"
            label="周期（小时）"
            initialValue={6}
            rules={[{ required: true }]}
          >
            <InputNumber min={1} style={{ width: 120 }} />
          </Form.Item>
        </Form>
      </Modal>
    </Drawer>
  )
}
