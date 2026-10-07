/**
 * 智能体任务中心（对标 Multica）
 * 看板指派 · 角色/小队/技能 · 执行日志 · 审核门 · 收件箱 · Autopilot · 运行时
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Empty,
  Input,
  List,
  message,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import {
  CheckOutlined,
  CloseOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  RocketOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import type {
  AgentHubSnapshot,
  AgentRoleBrief,
  IssueBrief,
  RunBrief,
  WritingSkill
} from '@shared/types'
import { formatError } from '../utils/formatError'

/** EvoFlow 扩展面板：Plan / Goal / Apps / 资产 / 代码 / IM / 沙箱 */
function EvoPanels({
  snap,
  onReload,
  mode
}: {
  snap: AgentHubSnapshot
  onReload: () => void
  mode: 'plan' | 'goal' | 'apps' | 'assets' | 'code' | 'im' | 'market' | 'sandbox'
}) {
  const [q, setQ] = useState('')
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [path, setPath] = useState('')
  const [cmd, setCmd] = useState('echo hello')
  const [webhook, setWebhook] = useState('')
  const [imKind, setImKind] = useState<'webhook' | 'feishu' | 'dingtalk' | 'wecom' | 'telegram'>('webhook')
  const [imExtra, setImExtra] = useState('')
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof window.api.hub.marketCatalog>> | null>(null)
  const [busy, setBusy] = useState(false)

  if (mode === 'plan') {
    return (
      <div>
        <Space direction="vertical" size={8} style={{ width: '100%', maxWidth: 640, marginBottom: 12 }}>
          <Input placeholder="计划目标（Plan 模式）" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Input.TextArea placeholder="补充说明" value={detail} onChange={(e) => setDetail(e.target.value)} autoSize={{ minRows: 2 }} />
          <Button
            type="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true)
              const r = await window.api.hub.generatePlan({ title: title || '未命名计划', detail })
              setBusy(false)
              if (r.ok) message.success('已生成计划，可修订后执行')
              else message.error(r.error || '失败')
              onReload()
            }}
          >
            生成计划
          </Button>
        </Space>
        <List
          dataSource={snap.plans}
          locale={{ emptyText: '暂无计划' }}
          renderItem={(p) => (
            <List.Item
              actions={[
                <Button
                  key="go"
                  size="small"
                  type="primary"
                  disabled={p.status === 'executing'}
                  onClick={async () => {
                    await window.api.hub.upsertPlan({ ...p, status: 'approved' })
                    const r = await window.api.hub.executePlan(p.id)
                    message[r.ok ? 'success' : 'warning'](r.ok ? '计划执行完成' : r.error || '部分失败')
                    onReload()
                  }}
                >
                  执行计划
                </Button>,
                <Button
                  key="ap"
                  size="small"
                  onClick={async () => {
                    await window.api.hub.upsertPlan({ ...p, status: 'approved' })
                    message.success('已批准计划')
                    onReload()
                  }}
                >
                  批准
                </Button>
              ]}
            >
              <List.Item.Meta
                title={`${p.title} [${p.status}]`}
                description={
                  <div>
                    {p.steps.map((s, i) => (
                      <div key={s.id}>
                        <Checkbox
                          checked={s.done}
                          onChange={async () => {
                            s.done = !s.done
                            await window.api.hub.upsertPlan({ ...p, steps: [...p.steps] })
                            onReload()
                          }}
                        >
                          {i + 1}. {s.title}
                        </Checkbox>
                        <div style={{ fontSize: 12, opacity: 0.6, marginLeft: 22 }}>{s.detail}</div>
                      </div>
                    ))}
                  </div>
                }
              />
            </List.Item>
          )}
        />
      </div>
    )
  }

  if (mode === 'goal') {
    return (
      <div>
        <Space direction="vertical" size={8} style={{ width: '100%', maxWidth: 640, marginBottom: 12 }}>
          <Input placeholder="长目标 Goal 标题" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Input.TextArea placeholder="目标说明 / 工作目录可稍后设" value={detail} onChange={(e) => setDetail(e.target.value)} autoSize={{ minRows: 2 }} />
          <Space>
            <Button
              type="primary"
              onClick={async () => {
                await window.api.hub.upsertGoal({
                  title: title || '未命名目标',
                  description: detail,
                  stages: [
                    { id: 's1', title: '阶段一：调研', done: false },
                    { id: 's2', title: '阶段二：产出', done: false },
                    { id: 's3', title: '阶段三：总结', done: false }
                  ]
                })
                onReload()
              }}
            >
              新建 Goal
            </Button>
          </Space>
        </Space>
        <List
          dataSource={snap.goals}
          locale={{ emptyText: '暂无 Goal' }}
          renderItem={(g) => (
            <List.Item
              actions={[
                <Button
                  key="run"
                  size="small"
                  type="primary"
                  onClick={async () => {
                    const r = await window.api.hub.advanceGoal(g.id)
                    message[r.ok ? 'success' : 'warning'](r.ok ? '阶段已推进' : r.error || '失败')
                    onReload()
                  }}
                >
                  推进阶段
                </Button>,
                <Button
                  key="pause"
                  size="small"
                  onClick={async () => {
                    await window.api.hub.upsertGoal({ ...g, status: g.status === 'paused' ? 'running' : 'paused' })
                    onReload()
                  }}
                >
                  {g.status === 'paused' ? '继续' : '挂起'}
                </Button>
              ]}
            >
              <List.Item.Meta
                title={`${g.title} [${g.status}]`}
                description={
                  <div>
                    {g.description}
                    <Progress
                      percent={Math.round((g.stages.filter((s) => s.done).length / Math.max(1, g.stages.length)) * 100)}
                      size="small"
                    />
                    {g.stages.map((s) => (
                      <Tag key={s.id} color={s.done ? 'success' : 'default'}>
                        {s.title}
                      </Tag>
                    ))}
                  </div>
                }
              />
            </List.Item>
          )}
        />
      </div>
    )
  }

  if (mode === 'apps') {
    return (
      <div>
        <Space direction="vertical" size={8} style={{ width: '100%', maxWidth: 640, marginBottom: 12 }}>
          <Input placeholder="应用名称（多节点工作流）" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Input.TextArea placeholder="应用描述 / 默认节点提示词" value={detail} onChange={(e) => setDetail(e.target.value)} autoSize={{ minRows: 2 }} />
          <Button
            type="primary"
            onClick={async () => {
              await window.api.hub.upsertApp({
                name: title || '新应用',
                description: detail,
                nodes: [
                  { id: 'n1', title: '准备', prompt: detail || title, requireApproval: true },
                  { id: 'n2', title: '执行', prompt: (detail || title) + '。请输出完整结果。' },
                  { id: 'n3', title: '复核', prompt: '检查上一步结果并指出问题', requireApproval: true }
                ],
                intervalMinutes: 0,
                enabled: true
              })
              onReload()
            }}
          >
            新建应用
          </Button>
        </Space>
        <List
          dataSource={snap.apps}
          locale={{ emptyText: '暂无应用' }}
          renderItem={(a) => (
            <List.Item
              actions={[
                <Button
                  key="run"
                  size="small"
                  type="primary"
                  onClick={async () => {
                    const r = await window.api.hub.runApp(a.id)
                    message[r.ok ? 'success' : 'warning'](r.ok ? '应用已跑完' : r.error || '失败')
                    onReload()
                  }}
                >
                  运行
                </Button>
              ]}
            >
              <List.Item.Meta
                title={
                  <Space>
                    {a.name}
                    <Tag>{a.nodes.length} 节点</Tag>
                    {a.imChannelId && <Tag color="blue">IM 派发</Tag>}
                  </Space>
                }
                description={`${a.description} · ${a.nodes.map((n) => n.title).join(' → ')}`}
              />
            </List.Item>
          )}
        />
      </div>
    )
  }

  if (mode === 'assets') {
    return (
      <div>
        <Alert type="info" showIcon style={{ marginBottom: 8 }} message="资产中心：经验 / 反思 / 画像 / 记忆（执行任务后自动沉淀）" />
        <List
          dataSource={[...snap.experiences.map((e) => ({ t: '经验', id: e.id, title: e.title, body: e.body })),
            ...snap.memories.map((m) => ({ t: m.kind === 'reflection' ? '反思' : m.kind === 'profile' ? '画像' : '记忆', id: m.id, title: m.agentId, body: m.body }))]}
          locale={{ emptyText: '暂无资产' }}
          renderItem={(x) => (
            <List.Item>
              <List.Item.Meta title={<Space><Tag>{x.t}</Tag>{x.title}</Space>} description={x.body} />
            </List.Item>
          )}
        />
      </div>
    )
  }

  if (mode === 'code') {
    return (
      <div>
        <Space style={{ marginBottom: 8 }} wrap>
          <Input placeholder="工作目录（构建符号索引）" value={path} onChange={(e) => setPath(e.target.value)} style={{ width: 280 }} />
          <Button
            type="primary"
            loading={busy}
            onClick={async () => {
              if (!path.trim()) return message.warning('请填写目录')
              setBusy(true)
              const list = await window.api.hub.codeIndexBuild(path.trim())
              setBusy(false)
              message.success(`已索引 ${list.length} 个符号`)
              onReload()
            }}
          >
            构建索引
          </Button>
          <Input placeholder="搜索符号 / 文件" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 180 }} />
          <Button
            onClick={async () => {
              const list = await window.api.hub.codeIndexQuery(q)
              message.info(`命中 ${list.length} 条（见列表刷新后可再搜）`)
              onReload()
            }}
          >
            查询
          </Button>
        </Space>
        <Table
          size="small"
          rowKey={(r) => `${r.file}:${r.line}:${r.name}`}
          dataSource={(snap as unknown as { codeIndex?: Array<{ name: string; kind: string; file: string; line: number; refCount?: number }> }).codeIndex || []}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: '符号', dataIndex: 'name' },
            { title: '类型', dataIndex: 'kind', width: 90 },
            { title: '文件', dataIndex: 'file', ellipsis: true },
            { title: '行', dataIndex: 'line', width: 60 },
            { title: '引用', dataIndex: 'refCount', width: 70 }
          ]}
        />
      </div>
    )
  }

  if (mode === 'im') {
    return (
      <div>
        <Space direction="vertical" size={8} style={{ width: '100%', maxWidth: 640, marginBottom: 12 }}>
          <Select
            value={imKind}
            style={{ width: 200 }}
            onChange={(v) => setImKind(v)}
            options={[
              { label: '钉钉机器人', value: 'dingtalk' },
              { label: '飞书', value: 'feishu' },
              { label: '企业微信', value: 'wecom' },
              { label: 'Telegram Bot', value: 'telegram' },
              { label: '通用 Webhook', value: 'webhook' }
            ]}
          />
          <Input placeholder="渠道名" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Input
            placeholder={imKind === 'telegram' ? 'https://api.telegram.org（token 填下方）' : imKind === 'feishu' ? 'Webhook 或空（用应用凭证）' : '机器人 Webhook URL'}
            value={webhook}
            onChange={(e) => setWebhook(e.target.value)}
          />
          <Input
            placeholder={
              imKind === 'telegram'
                ? '格式：botToken|chatId'
                : imKind === 'feishu'
                  ? '格式：appId|appSecret|chatId（可只填 webhook）'
                  : imKind === 'wecom'
                    ? '可选：corpid|agentId|corpsecret'
                    : '可选扩展字段'
            }
            value={imExtra}
            onChange={(e) => setImExtra(e.target.value)}
          />
          <Space>
            <Button
              type="primary"
              onClick={async () => {
                const parts = imExtra.split('|').map((s) => s.trim())
                await window.api.hub.upsertImChannel({
                  name: title || `${imKind}渠道`,
                  kind: imKind,
                  webhookUrl: webhook,
                  enabled: true,
                  appId: imKind === 'feishu' ? parts[0] : undefined,
                  appSecret: imKind === 'feishu' ? parts[1] : undefined,
                  chatId: imKind === 'telegram' ? parts[1] : imKind === 'feishu' ? parts[2] : undefined,
                  botToken: imKind === 'telegram' ? parts[0] : undefined,
                  corpSecret: imKind === 'wecom' ? parts[2] : undefined,
                  agentId: imKind === 'wecom' ? parts[1] : undefined
                })
                message.success('渠道已保存')
                onReload()
              }}
            >
              保存渠道
            </Button>
            <Button
              onClick={async () => {
                const parts = imExtra.split('|').map((s) => s.trim())
                const r = await window.api.hub.testIm({
                  name: title || '测试',
                  kind: imKind,
                  webhookUrl: webhook,
                  enabled: true,
                  appId: imKind === 'feishu' ? parts[0] : undefined,
                  appSecret: imKind === 'feishu' ? parts[1] : undefined,
                  chatId: imKind === 'telegram' ? parts[1] : imKind === 'feishu' ? parts[2] : undefined,
                  botToken: imKind === 'telegram' ? parts[0] : undefined
                } as never).catch(() => ({ ok: false, error: '接口不可用' }))
                message[r.ok ? 'success' : 'error'](r.ok ? '测试发送成功' : r.error || '失败')
              }}
            >
              协议测试
            </Button>
          </Space>
        </Space>
        <List
          dataSource={snap.imChannels}
          locale={{ emptyText: '暂无 IM 渠道' }}
          renderItem={(c) => (
            <List.Item
              actions={[
                <Button
                  key="t"
                  size="small"
                  onClick={async () => {
                    const r = await window.api.hub.sendIm(c.id, '测试消息', '来自灵墨工作台')
                    message[r.ok ? 'success' : 'error'](r.ok ? '已发送' : r.error || '失败')
                  }}
                >
                  测试
                </Button>
              ]}
            >
              <List.Item.Meta
                title={
                  <Space>
                    {c.name}
                    <Tag>{c.kind}</Tag>
                  </Space>
                }
                description={c.webhookUrl || c.chatId || '—'}
              />
            </List.Item>
          )}
        />
      </div>
    )
  }

  if (mode === 'market') {
    return (
      <div>
        <Space style={{ marginBottom: 8 }} wrap>
          <Input placeholder="远程目录 JSON URL（可选）" value={webhook} onChange={(e) => setWebhook(e.target.value)} style={{ width: 320 }} />
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true)
              const cat = await window.api.hub.marketCatalog(webhook || undefined)
              setCatalog(cat)
              setBusy(false)
              message.success(`目录 ${cat.packs.length} 项`)
            }}
          >
            刷新目录
          </Button>
          <Button
            onClick={async () => {
              const cat = await window.api.hub.marketCatalog()
              setCatalog(cat)
            }}
          >
            内置目录
          </Button>
        </Space>
        <List
          dataSource={catalog?.packs ?? []}
          locale={{ emptyText: '点「内置目录 / 刷新目录」加载资源包' }}
          renderItem={(p) => (
            <List.Item
              actions={[
                <Button
                  key="in"
                  size="small"
                  type={p.installed ? 'default' : 'primary'}
                  disabled={p.installed}
                  onClick={async () => {
                    const r = await window.api.hub.marketInstall(p.id)
                    message[r.ok ? 'success' : 'error'](r.ok ? `已安装${r.count ? `（${r.count} 项）` : ''}` : r.error || '失败')
                    const cat = await window.api.hub.marketCatalog()
                    setCatalog(cat)
                  }}
                >
                  {p.installed ? '已安装' : '安装'}
                </Button>
              ]}
            >
              <List.Item.Meta
                title={
                  <Space>
                    {p.name}
                    <Tag>{p.kind}</Tag>
                    <Tag>v{p.version}</Tag>
                    {p.tags.map((t) => (
                      <Tag key={t}>{t}</Tag>
                    ))}
                  </Space>
                }
                description={`${p.description} · ${p.author}`}
              />
            </List.Item>
          )}
        />
      </div>
    )
  }

  // sandbox
  return (
    <div>
      <Space style={{ marginBottom: 8 }} wrap>
        <Input placeholder="工作目录" value={path} onChange={(e) => setPath(e.target.value)} style={{ width: 220 }} />
        <Input placeholder="命令（沙箱目录内执行）" value={cmd} onChange={(e) => setCmd(e.target.value)} style={{ width: 280 }} />
        <Button
          type="primary"
          loading={busy}
          onClick={async () => {
            setBusy(true)
            const r = await window.api.hub.sandboxRun(path || 'sandbox', cmd)
            setBusy(false)
            message.info(`${r.status}`)
            onReload()
          }}
        >
          执行
        </Button>
      </Space>
      <List
        dataSource={snap.sandboxRuns}
        locale={{ emptyText: '暂无沙箱记录' }}
        renderItem={(s) => (
          <List.Item>
            <List.Item.Meta
              title={
                <Space>
                  <Tag color={s.status === 'ok' ? 'success' : s.status === 'failed' || s.status === 'timeout' ? 'error' : 'processing'}>
                    {s.status}
                  </Tag>
                  {s.command}
                </Space>
              }
              description={<span style={{ fontFamily: 'monospace', fontSize: 12 }}>{(s.stdout || s.stderr || '').slice(0, 200)}</span>}
            />
          </List.Item>
        )}
      />
    </div>
  )
}

type Tab =
  | 'board'
  | 'agents'
  | 'plan'
  | 'goal'
  | 'apps'
  | 'assets'
  | 'code'
  | 'im'
  | 'market'
  | 'sandbox'
  | 'skills'
  | 'inbox'
  | 'runs'
  | 'autopilot'
  | 'runtime'

const STATUS: Record<string, { label: string; color: string }> = {
  backlog: { label: '待办', color: 'default' },
  ready: { label: '就绪', color: 'blue' },
  running: { label: '执行中', color: 'processing' },
  review: { label: '待审核', color: 'orange' },
  done: { label: '完成', color: 'success' },
  failed: { label: '失败', color: 'error' }
}

const COLS: Array<{ key: IssueBrief['status']; title: string }> = [
  { key: 'backlog', title: '待办' },
  { key: 'ready', title: '就绪' },
  { key: 'running', title: '执行中' },
  { key: 'review', title: '待审核' },
  { key: 'done', title: '完成' },
  { key: 'failed', title: '失败' }
]

export default function AgentHub() {
  const [tab, setTab] = useState<Tab>('board')
  const [snap, setSnap] = useState<AgentHubSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [skills, setSkills] = useState<WritingSkill[]>([])
  const [busyId, setBusyId] = useState('')

  // 新建任务
  const [ntOpen, setNtOpen] = useState(false)
  const [ntTitle, setNtTitle] = useState('')
  const [ntBody, setNtBody] = useState('')
  const [ntAssignee, setNtAssignee] = useState('')
  const [ntRepo, setNtRepo] = useState('')
  // 角色
  const [agOpen, setAgOpen] = useState(false)
  const [agEdit, setAgEdit] = useState<Partial<AgentRoleBrief> & { name: string }>({ name: '' })
  const [agSaving, setAgSaving] = useState(false)
  const [bindSaving, setBindSaving] = useState(false)
  // Autopilot
  const [apOpen, setApOpen] = useState(false)
  const [apName, setApName] = useState('每日任务报告')
  const [apMin, setApMin] = useState('60')
  const [apPrompt, setApPrompt] = useState('汇总当前任务看板进展，输出要点报告：完成、进行中、阻塞、建议下一步。')
  // 执行详情
  const [runDetail, setRunDetail] = useState<RunBrief | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [s, sk] = await Promise.all([window.api.hub.snapshot(), window.api.novel.listSkills().catch(() => [])])
      setSnap(s)
      setSkills(sk as WritingSkill[])
    } catch (err) {
      message.error('加载失败：' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
    const t = setInterval(() => void reload(), 8000)
    return () => clearInterval(t)
  }, [reload])

  const issuesByStatus = useMemo(() => {
    const m: Record<string, IssueBrief[]> = { backlog: [], ready: [], running: [], review: [], done: [], failed: [] }
    for (const i of snap?.issues ?? []) (m[i.status] ??= []).push(i)
    return m
  }, [snap])

  const runIssue = async (id: string): Promise<void> => {
    setBusyId(id)
    try {
      const r = await window.api.hub.runIssue(id)
      if (r.ok) message.success('已执行完成，请在「待审核」确认')
      else message.warning(r.error || '执行失败')
    } finally {
      setBusyId('')
      void reload()
    }
  }

  const createTask = async (): Promise<void> => {
    if (!ntTitle.trim()) {
      message.warning('请填写标题')
      return
    }
    await window.api.hub.createIssue({
      title: ntTitle.trim(),
      body: ntBody,
      assigneeId: ntAssignee || undefined,
      repoPath: ntRepo || undefined
    })
    setNtOpen(false)
    setNtTitle('')
    setNtBody('')
    setNtRepo('')
    message.success('任务已创建')
    void reload()
  }

  /** 聊天下任务：解析 @角色 标题】说明 */
  const createFromChat = useCallback(
    async (raw: string): Promise<boolean> => {
      const t = raw.trim()
      if (!/^@任务|^@task|\/task\b|^创建任务[:：]/i.test(t)) return false
      const body = t.replace(/^(@任务|@task|\/task|创建任务)[:：]?\s*/i, '')
      const m = /^@(\S+)\s+(.+)/.exec(body)
      let assignee: string | undefined
      let title = body
      if (m) {
        const name = m[1]
        const agent = (snap?.agents ?? []).find((a) => a.name.includes(name))
        if (agent) {
          assignee = agent.id
          title = m[2]
        }
      }
      const issue = await window.api.hub.createIssue({
        title: title.slice(0, 80) || '来自对话的任务',
        body: raw,
        assigneeId: assignee
      })
      message.success('已从对话创建任务，可在看板查看')
      void reload()
      if (assignee) void runIssue(issue.id)
      return true
    },
    [snap]
  )

  // 暴露给全局聊天（D1）
  useEffect(() => {
    ;(window as unknown as { __hubCreateFromChat?: typeof createFromChat }).__hubCreateFromChat = createFromChat
    return () => {
      delete (window as unknown as { __hubCreateFromChat?: unknown }).__hubCreateFromChat
    }
  }, [createFromChat])

  const boardStats = useMemo(() => {
    const issues = snap?.issues ?? []
    return {
      total: issues.length,
      running: issues.filter((i) => i.status === 'running').length,
      review: issues.filter((i) => i.status === 'review').length,
      done: issues.filter((i) => i.status === 'done').length
    }
  }, [snap])

  return (
    <div className="dashboard-page" style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="page-header" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          智能体任务
        </Typography.Title>
        <Tag color="processing">{snap?.workspace.name ?? '工作区'}</Tag>
        <Tag>共 {boardStats.total} · 进行 {boardStats.running} · 待审 {boardStats.review}</Tag>
        <div style={{ flex: 1 }} />
        <Space wrap>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setNtOpen(true)}>
            新建任务
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => void reload()} loading={loading}>
            刷新
          </Button>
        </Space>
      </div>
      <div style={{ marginBottom: 8 }}>
        <Segmented
          value={tab}
          onChange={(v) => setTab(v as Tab)}
          options={[
            { label: '看板', value: 'board' },
            { label: 'Plan', value: 'plan' },
            { label: 'Goal', value: 'goal' },
            { label: '角色', value: 'agents' },
            { label: '应用中心', value: 'apps' },
            { label: '资产', value: 'assets' },
            { label: '代码索引', value: 'code' },
            { label: 'IM', value: 'im' },
            { label: '资源市场', value: 'market' },
            { label: '沙箱', value: 'sandbox' },
            { label: '技能', value: 'skills' },
            { label: '收件箱', value: 'inbox' },
            { label: '日志', value: 'runs' },
            { label: 'Autopilot', value: 'autopilot' },
            { label: '运行时', value: 'runtime' }
          ]}
        />
      </div>

      {!snap && loading ? (
        <Spin style={{ margin: 40 }} />
      ) : !snap ? (
        <Empty description="暂无数据" />
      ) : tab === 'plan' ? (
        <EvoPanels snap={snap} onReload={() => void reload()} mode="plan" />
      ) : tab === 'goal' ? (
        <EvoPanels snap={snap} onReload={() => void reload()} mode="goal" />
      ) : tab === 'apps' ? (
        <EvoPanels snap={snap} onReload={() => void reload()} mode="apps" />
      ) : tab === 'assets' ? (
        <EvoPanels snap={snap} onReload={() => void reload()} mode="assets" />
      ) : tab === 'code' ? (
        <EvoPanels snap={snap} onReload={() => void reload()} mode="code" />
      ) : tab === 'im' ? (
        <EvoPanels snap={snap} onReload={() => void reload()} mode="im" />
      ) : tab === 'market' ? (
        <EvoPanels snap={snap} onReload={() => void reload()} mode="market" />
      ) : tab === 'sandbox' ? (
        <EvoPanels snap={snap} onReload={() => void reload()} mode="sandbox" />
      ) : tab === 'board' ? (
        <div style={{ display: 'flex', gap: 10, overflow: 'auto', flex: 1, minHeight: 0, paddingBottom: 8 }}>
          {COLS.map((c) => (
            <div key={c.key} className="hub-col" style={{ minWidth: 200, flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
                {c.title}{' '}
                <Tag style={{ margin: 0 }}>{issuesByStatus[c.key]?.length ?? 0}</Tag>
              </div>
              {(issuesByStatus[c.key] ?? []).map((iss) => (
                <Card key={iss.id} size="small" className="hub-card" style={{ marginBottom: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{iss.title}</div>
                  <div style={{ fontSize: 12, opacity: 0.65, margin: '4px 0' }}>
                    {(iss.body || '').slice(0, 80)}
                    {iss.repoPath ? ' · 绑定仓库' : ''}
                    {iss.blockedBy.length ? ` · 依赖 ${iss.blockedBy.length}` : ''}
                  </div>
                  <Space size={4} wrap>
                    <Tag style={{ margin: 0 }}>
                      {snap.agents.find((a) => a.id === iss.assigneeId)?.name ?? '未指派'}
                    </Tag>
                    {iss.labels.map((l) => (
                      <Tag key={l} style={{ margin: 0 }}>
                        {l}
                      </Tag>
                    ))}
                  </Space>
                  <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {iss.status !== 'running' && (
                      <Button
                        size="small"
                        type="primary"
                        icon={<PlayCircleOutlined />}
                        loading={busyId === iss.id}
                        onClick={() => void runIssue(iss.id)}
                      >
                        执行
                      </Button>
                    )}
                    {iss.status === 'review' && (
                      <>
                        <Button
                          size="small"
                          icon={<CheckOutlined />}
                          onClick={async () => {
                            await window.api.hub.reviewIssue(iss.id, true)
                            message.success('已通过')
                            void reload()
                          }}
                        >
                          通过
                        </Button>
                        <Button
                          size="small"
                          danger
                          icon={<CloseOutlined />}
                          onClick={async () => {
                            await window.api.hub.reviewIssue(iss.id, false, '需要修改')
                            void reload()
                          }}
                        >
                          驳回
                        </Button>
                      </>
                    )}
                    <Popconfirm title="删除任务？" onConfirm={async () => { await window.api.hub.removeIssue(iss.id); void reload() }}>
                      <Button size="small" type="text" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  </div>
                </Card>
              ))}
              {(issuesByStatus[c.key] ?? []).length === 0 && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  空
                </Typography.Text>
              )}
            </div>
          ))}
        </div>
      ) : tab === 'agents' ? (
        <div>
          <Space style={{ marginBottom: 8 }}>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setAgEdit({ name: '', brain: 'ai', description: '', skillIds: [] })
                setAgOpen(true)
              }}
            >
              新建角色
            </Button>
            <Button
              icon={<ThunderboltOutlined />}
              onClick={() => {
                setAgEdit({
                  name: '写作审校',
                  brain: 'ai',
                  description: '负责审校文稿、找逻辑漏洞，输出修改建议',
                  skillIds: []
                })
                setAgOpen(true)
                message.info('已生成示例配置（Build with AI），确认后保存')
              }}
            >
              AI 生成角色
            </Button>
          </Space>
          <List
            dataSource={snap.agents}
            locale={{ emptyText: '暂无角色，先新建' }}
            renderItem={(a) => (
              <List.Item
                actions={[
                  <Button
                    key="edit"
                    size="small"
                    onClick={() => {
                      setAgEdit({ ...a })
                      setAgOpen(true)
                    }}
                  >
                    编辑
                  </Button>,
                  <Popconfirm
                    key="del"
                    title="删除角色？"
                    onConfirm={async () => {
                      await window.api.hub.removeAgent(a.id)
                      void reload()
                    }}
                  >
                    <Button size="small" danger>
                      删除
                    </Button>
                  </Popconfirm>
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space>
                      <RocketOutlined />
                      {a.name}
                      <Tag>{a.brain === 'cli' ? `CLI ${a.cliCommand || ''}` : 'AI 模型'}</Tag>
                      <Tag>{a.skillIds.length} 技能</Tag>
                    </Space>
                  }
                  description={a.description || '（无描述）'}
                />
              </List.Item>
            )}
          />
          <Typography.Text strong style={{ fontSize: 13, display: 'block', marginTop: 12 }}>
            小队 Squads
          </Typography.Text>
          <Space style={{ marginTop: 8 }} wrap>
            <Button
              size="small"
              onClick={async () => {
                if (snap.agents.length === 0) {
                  message.warning('请先创建角色')
                  return
                }
                await window.api.hub.upsertSquad({
                  name: `小队 ${snap.squads.length + 1}`,
                  leaderId: snap.agents[0].id,
                  memberIds: snap.agents.map((x) => x.id)
                })
                void reload()
              }}
            >
              新建小队（全员+队长）
            </Button>
            {snap.squads.map((s) => (
              <Tag key={s.id}>
                {s.name} · 队长{snap.agents.find((a) => a.id === s.leaderId)?.name || '—'} · {s.memberIds.length}人
              </Tag>
            ))}
          </Space>
        </div>
      ) : tab === 'skills' ? (
        <div>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 8 }}
            message={`全部技能（${skills.length} 个）`}
            description="含内置写作 Skill、工作流 Skill 与市场安装包；可多选绑定到各角色，执行任务时注入提示词。"
          />
          <Table
            size="small"
            rowKey="id"
            pagination={{ pageSize: 10 }}
            dataSource={skills}
            columns={[
              {
                title: '技能',
                dataIndex: 'name',
                render: (n: string, s: WritingSkill) => (
                  <Space>
                    <ThunderboltOutlined style={{ color: 'var(--accent, #1677ff)' }} />
                    {n}
                    {s.builtin && <Tag color="blue" style={{ margin: 0 }}>内置</Tag>}
                  </Space>
                )
              },
              { title: '说明', dataIndex: 'description', ellipsis: true },
              {
                title: '绑定到角色',
                width: 260,
                render: (_, s: WritingSkill) => (
                  <Select
                    mode="multiple"
                    size="small"
                    style={{ width: '100%' }}
                    placeholder="选择角色"
                    disabled={bindSaving}
                    value={snap.agents.filter((a) => a.skillIds?.includes(s.id)).map((a) => a.id)}
                    options={snap.agents.map((a) => ({ label: a.name, value: a.id }))}
                    onChange={async (vals) => {
                      const ids = vals as string[]
                      setBindSaving(true)
                      try {
                        for (const a of snap.agents) {
                          const should = ids.includes(a.id)
                          const has = a.skillIds?.includes(s.id)
                          if (should !== has) {
                            const next = should
                              ? [...(a.skillIds || []), s.id]
                              : (a.skillIds || []).filter((x) => x !== s.id)
                            await window.api.hub.bindSkills(a.id, next)
                          }
                        }
                        message.success('技能绑定已更新')
                      } catch (err) {
                        message.error('绑定保存失败：' + formatError(err, '未知错误'))
                      } finally {
                        setBindSaving(false)
                        void reload()
                      }
                    }}
                  />
                )
              }
            ]}
          />
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
            角色侧也可在「角色」页编辑技能；资源市场安装的包会自动进入本列表。
          </Typography.Paragraph>
        </div>
      ) : tab === 'inbox' ? (
        <div>
          <Space style={{ marginBottom: 8 }}>
            <Button onClick={async () => { await window.api.hub.inboxClear(); void reload() }}>清空</Button>
          </Space>
          <List
            dataSource={snap.inbox}
            locale={{ emptyText: '收件箱为空' }}
            renderItem={(it) => (
              <List.Item
                onClick={async () => {
                  await window.api.hub.inboxRead(it.id, true)
                  void reload()
                }}
                style={{ cursor: 'pointer', opacity: it.read ? 0.55 : 1 }}
                actions={
                  it.issueId
                    ? [
                        <Button
                          key="go"
                          size="small"
                          onClick={async () => {
                            await window.api.hub.inboxRead(it.id, true)
                            setTab('board')
                            void reload()
                          }}
                        >
                          查看任务
                        </Button>
                      ]
                    : undefined
                }
              >
                <List.Item.Meta
                  title={
                    <Space>
                      <Tag color={it.kind === 'review' ? 'orange' : it.kind === 'failed' ? 'error' : it.kind === 'blocked' ? 'warning' : 'default'}>
                        {it.kind === 'review' ? '待审核' : it.kind === 'failed' ? '失败' : it.kind === 'blocked' ? '阻塞' : '通知'}
                      </Tag>
                      {it.title}
                    </Space>
                  }
                  description={it.body}
                />
              </List.Item>
            )}
          />
        </div>
      ) : tab === 'runs' ? (
        <Table
          size="small"
          rowKey="id"
          dataSource={snap.runs}
          pagination={{ pageSize: 10 }}
          onRow={(r) => ({ onClick: () => setRunDetail(r), style: { cursor: 'pointer' } })}
          columns={[
            { title: '时间', dataIndex: 'startedAt', width: 150, render: (t: number) => new Date(t).toLocaleString('zh-CN', { hour12: false }) },
            {
              title: '状态',
              dataIndex: 'status',
              width: 90,
              render: (s: RunBrief['status']) => (
                <Tag color={s === 'success' ? 'success' : s === 'failed' ? 'error' : 'processing'}>{s}</Tag>
              )
            },
            { title: '角色', dataIndex: 'agentId', width: 120 },
            { title: '任务', dataIndex: 'issueId', width: 120, ellipsis: true },
            { title: '尝试', dataIndex: 'attempt', width: 70, render: (a: number, r: RunBrief) => `${a}/${r.maxAttempts}` },
            { title: 'tokens(约)', dataIndex: 'approxTokens', width: 90 },
            { title: '耗时', width: 80, render: (_: unknown, r: RunBrief) => (r.durationMs ? Math.round(r.durationMs / 1000) + 's' : '—') }
          ]}
        />
      ) : tab === 'autopilot' ? (
        <div>
          <Space style={{ marginBottom: 8 }}>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setApOpen(true)}>
              新建 Autopilot
            </Button>
          </Space>
          <List
            dataSource={snap.autopilots}
            locale={{ emptyText: '暂无定时流水线' }}
            renderItem={(ap) => (
              <List.Item
                actions={[
                  <Popconfirm key="rm" title="删除？" onConfirm={async () => { await window.api.hub.removeAutopilot(ap.id); void reload() }}>
                    <Button size="small" danger>
                      删除
                    </Button>
                  </Popconfirm>
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space>
                      {ap.name}
                      <Tag>{ap.intervalMinutes} 分钟</Tag>
                      <Tag color={ap.enabled ? 'success' : 'default'}>{ap.enabled ? '启用' : '停用'}</Tag>
                      {ap.lastRunAt && (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          上次 {new Date(ap.lastRunAt).toLocaleString('zh-CN', { hour12: false })}
                        </Typography.Text>
                      )}
                    </Space>
                  }
                  description={ap.prompt}
                />
              </List.Item>
            )}
          />
        </div>
      ) : (
        <div>
          <Alert type="info" showIcon style={{ marginBottom: 8 }} message="本机 Agent CLI 运行时" description="检测到的 CLI 可作为角色「CLI」执行器；未安装时回退到已配置的 AI 模型脑。" />
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={snap.runtimes}
            columns={[
              { title: 'CLI', dataIndex: 'label' },
              { title: '命令', dataIndex: 'id' },
              {
                title: '状态',
                dataIndex: 'available',
                render: (ok: boolean) => (ok ? <Tag color="success">可用</Tag> : <Tag>未安装</Tag>)
              },
              { title: '路径', dataIndex: 'path', ellipsis: true }
            ]}
          />
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
            工作区：{snap.workspace.name}（可在打开任务时绑定 Git 仓库路径作为上下文 —— 新建任务「仓库/文档路径」）
          </Typography.Paragraph>
        </div>
      )}

      {/* 新建任务 */}
      <Modal
        open={ntOpen}
        title="新建任务"
        onCancel={() => setNtOpen(false)}
        onOk={() => void createTask()}
        okText="创建"
        cancelText="取消"
        destroyOnHidden
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Input placeholder="任务标题" value={ntTitle} onChange={(e) => setNtTitle(e.target.value)} />
          <Input.TextArea placeholder="说明 / 要求" value={ntBody} onChange={(e) => setNtBody(e.target.value)} autoSize={{ minRows: 3 }} />
          <Select
            placeholder="指派智能体"
            allowClear
            style={{ width: '100%' }}
            value={ntAssignee || undefined}
            onChange={(v) => setNtAssignee(v || '')}
            options={snap?.agents.map((a) => ({ label: a.name, value: a.id })) ?? []}
          />
          <Input placeholder="绑定 Git 仓库 / 文档路径（可选，作为上下文）" value={ntRepo} onChange={(e) => setNtRepo(e.target.value)} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            也可在任意聊天输入：@任务 @角色名 标题说明 → 自动建卡并执行
          </Typography.Text>
        </Space>
      </Modal>

      {/* 角色编辑 */}
      <Modal
        open={agOpen}
        title={agEdit.id ? '编辑角色' : '新建角色'}
        onCancel={() => setAgOpen(false)}
        confirmLoading={agSaving}
        onOk={async () => {
          setAgSaving(true)
          try {
            await window.api.hub.upsertAgent(agEdit)
            setAgOpen(false)
            message.success('已保存')
            void reload()
          } catch (err) {
            message.error('保存失败：' + formatError(err, '未知错误'))
          } finally {
            setAgSaving(false)
          }
        }}
        okText="保存"
        destroyOnHidden
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Input placeholder="角色名" value={agEdit.name} onChange={(e) => setAgEdit({ ...agEdit, name: e.target.value })} />
          <Input.TextArea
            placeholder="职责 / 系统提示"
            value={agEdit.description}
            onChange={(e) => setAgEdit({ ...agEdit, description: e.target.value })}
            autoSize={{ minRows: 3 }}
          />
          <Select
            mode="multiple"
            allowClear
            placeholder="角色专属技能（执行任务时注入提示词，可多选）"
            style={{ width: '100%' }}
            value={agEdit.skillIds ?? []}
            onChange={(v) => setAgEdit({ ...agEdit, skillIds: v })}
            options={skills.map((s) => ({ label: s.name, value: s.id }))}
          />
          {skills.length === 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              技能库为空：可先到「技能」页签查看或安装写作技能
            </Typography.Text>
          )}
          <Select
            value={agEdit.brain || 'ai'}
            style={{ width: '100%' }}
            onChange={(v) => setAgEdit({ ...agEdit, brain: v as 'ai' | 'cli' })}
            options={[
              { label: 'AI 模型脑（当前启用配置）', value: 'ai' },
              { label: '本机 CLI（Claude/Codex…）', value: 'cli' }
            ]}
          />
          {agEdit.brain === 'cli' && (
            <Input placeholder="CLI 命令 id，如 claude / codex" value={agEdit.cliCommand || ''} onChange={(e) => setAgEdit({ ...agEdit, cliCommand: e.target.value })} />
          )}
        </Space>
      </Modal>

      {/* Autopilot */}
      <Modal
        open={apOpen}
        title="新建 Autopilot（报告类定时任务）"
        onCancel={() => setApOpen(false)}
        onOk={async () => {
          await window.api.hub.upsertAutopilot({
            name: apName,
            intervalMinutes: Number(apMin) || 60,
            kind: 'report',
            prompt: apPrompt,
            label: 'report',
            enabled: true
          })
          setApOpen(false)
          message.success('已创建，将按间隔自动建任务并执行')
          void reload()
        }}
        okText="创建"
        destroyOnHidden
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Input value={apName} onChange={(e) => setApName(e.target.value)} placeholder="名称" />
          <Input value={apMin} onChange={(e) => setApMin(e.target.value)} placeholder="间隔（分钟，≥5）" />
          <Input.TextArea value={apPrompt} onChange={(e) => setApPrompt(e.target.value)} autoSize={{ minRows: 3 }} />
        </Space>
      </Modal>

      {/* 执行日志 */}
      <Modal open={!!runDetail} title="执行日志" footer={null} onCancel={() => setRunDetail(null)} width={680} destroyOnHidden>
        {runDetail && (
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {runDetail.status} · 第 {runDetail.attempt}/{runDetail.maxAttempts} 次 · 约 {runDetail.approxTokens} tokens
            </Typography.Text>
            <pre
              style={{
                maxHeight: 280,
                overflow: 'auto',
                background: 'rgba(0,0,0,.04)',
                padding: 10,
                borderRadius: 8,
                fontSize: 12
              }}
            >
              {runDetail.events.map((e) => `[${new Date(e.t).toLocaleTimeString()}] ${e.level}: ${e.message}`).join('\n') || '（无日志）'}
            </pre>
            {runDetail.output && (
              <Typography.Paragraph style={{ fontSize: 13, whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>
                {runDetail.output}
              </Typography.Paragraph>
            )}
            {runDetail.error && <Alert type="error" showIcon message={runDetail.error} />}
          </div>
        )}
      </Modal>
    </div>
  )
}
