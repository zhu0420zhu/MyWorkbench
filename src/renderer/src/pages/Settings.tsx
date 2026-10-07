import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  Card,
  Checkbox,
  ColorPicker,
  Descriptions,
  Form,
  Input,
  message,
  Modal,
  Popconfirm,
  Radio,
  Segmented,
  Select,
  Slider,
  Space,
  Table,
  Tag,
  Typography
} from 'antd'
import { CopyOutlined, FolderOpenOutlined, FolderAddOutlined, ApiOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import type { AiConfig, AiProfile, AiProfilesState, DashboardOverview, DataInfo, McpServerConfig, McpServerState, McpToolInfo } from '@shared/types'
import { usePrefs, WALLPAPER_PRESETS, type Prefs, type WallpaperZoneKey } from '../prefs'
import { useTheme } from '../theme/theme'
import { pageLabelOf } from '@shared/pageMeta'
import type { PageKey } from '../nav'

/* ---------- 数据看板 ---------- */

/**
 * 启动默认页可选项（顺序即下拉展示顺序）。
 *
 * 中文名不在此硬编码 —— 统一由 @shared/pageMeta 的 PAGE_LABELS 提供。
 * 本文件此前另立过一份 PAGE_LABEL 名表且已发生漂移：
 *   gameui 写成「游戏UI」、agents 写成「智能体」、dashboard 写成「工作台」，
 * 三处都与侧边栏不一致。2026-09-28 审计后收敛为单一来源。
 */
const DEFAULT_PAGE_CHOICES: PageKey[] = [
  'dashboard',
  'knowledge',
  'filetools',
  'toolbox',
  'writing',
  'copywriting',
  'notes',
  'stickies',
  'texttools',
  'docs',
  'agents',
  'database',
  'analytics',
  'boards',
  'hotspots',
  'settings'
]

function fmtNum(n: number): string {
  return n.toLocaleString('zh-CN')
}

function fmtTime(ts?: number): string {
  if (!ts) return '—'
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return '—'
  }
}

function DashBoardBody({ dash }: { dash: DashboardOverview }) {
  const { usage, content } = dash
  const modelRows = Object.entries(usage.models)
    .map(([model, s]) => ({ model, ...s }))
    .sort((a, b) => b.calls - a.calls)
  const pageRows = Object.entries(usage.pages)
    .map(([page, s]) => ({ page, ...s }))
    .sort((a, b) => b.visits - a.visits)
  const totalAiCalls = (usage.aiCalls.chat || 0) + (usage.aiCalls.complete || 0) + (usage.aiCalls.rightClick || 0)
  const totalModelTokens = modelRows.reduce((n, r) => n + (r.approxTokens || 0), 0)

  const contentItems: Array<{ label: string; value: number | string }> = [
    { label: '笔记', value: content.notes },
    { label: '快捷方式', value: content.shortcuts },
    { label: '自动化', value: content.automations },
    { label: '长篇作品', value: content.novelProjects },
    { label: '章节', value: content.novelChapters },
    { label: '数据表', value: content.dataTables },
    { label: '白板', value: content.boards },
    { label: '便利贴', value: content.stickies },
    { label: 'AI 配置', value: content.aiProfiles }
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 概览数字 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
        {[
          { label: 'AI 调用次数', value: fmtNum(totalAiCalls) },
          { label: '模型用量 token（估）', value: fmtNum(totalModelTokens) },
          { label: '对话 / 完成 / 右键', value: `${usage.aiCalls.chat || 0} / ${usage.aiCalls.complete || 0} / ${usage.aiCalls.rightClick || 0}` },
          { label: '页面访问合计', value: fmtNum(pageRows.reduce((n, r) => n + r.visits, 0)) },
          { label: '笔记 + 章节', value: fmtNum(content.notes + content.novelChapters) },
          { label: '统计起始', value: fmtTime(usage.startedAt).slice(0, 10) }
        ].map((c) => (
          <div
            key={c.label}
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              border: '1px solid rgba(128,128,128,.16)',
              background: 'rgba(128,128,128,.04)'
            }}
          >
            <div style={{ fontSize: 12, opacity: 0.65 }}>{c.label}</div>
            <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* 模型用量 */}
      <div>
        <Typography.Text strong style={{ fontSize: 13 }}>
          模型使用情况
        </Typography.Text>
        {modelRows.length === 0 ? (
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '6px 0 0' }}>
            尚无模型调用记录。配置 AI 后，在写作或文档里使用即可累计。
          </Typography.Paragraph>
        ) : (
          <Table
            style={{ marginTop: 8 }}
            size="small"
            rowKey="model"
            pagination={false}
            dataSource={modelRows}
            columns={[
              { title: '模型', dataIndex: 'model', ellipsis: true },
              { title: '调用次数', dataIndex: 'calls', width: 100, render: (n: number) => fmtNum(n) },
              {
                title: '估算 token',
                dataIndex: 'approxTokens',
                width: 110,
                render: (n: number) => fmtNum(n || 0)
              },
              {
                title: '输入字数',
                dataIndex: 'promptChars',
                width: 110,
                render: (n: number) => fmtNum(n || 0)
              },
              {
                title: '最近使用',
                dataIndex: 'lastUsedAt',
                width: 170,
                render: (t: number) => fmtTime(t)
              }
            ]}
          />
        )}
      </div>

      {Object.keys(usage.agents || {}).length > 0 && (
        <div>
          <Typography.Text strong style={{ fontSize: 13 }}>
            智能体用量（按角色）
          </Typography.Text>
          <Table
            style={{ marginTop: 8 }}
            size="small"
            rowKey="name"
            pagination={false}
            dataSource={Object.entries(usage.agents || {}).map(([name, s]) => ({ name, ...s }))}
            columns={[
              { title: '角色', dataIndex: 'name' },
              { title: '执行次数', dataIndex: 'runs', width: 90 },
              { title: '失败', dataIndex: 'failures', width: 70 },
              { title: '估算 token', dataIndex: 'approxTokens', width: 100 },
              { title: '最近执行', dataIndex: 'lastRunAt', width: 160, render: (t: number) => fmtTime(t) }
            ]}
          />
        </div>
      )}

      {/* 模块内容量 */}
      <div>
        <Typography.Text strong style={{ fontSize: 13 }}>
          各模块内容量
        </Typography.Text>
        <div
          style={{
            marginTop: 8,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
            gap: 8
          }}
        >
          {contentItems.map((c) => (
            <div
              key={c.label}
              style={{
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid rgba(128,128,128,.14)',
                textAlign: 'center'
              }}
            >
              <div style={{ fontSize: 16, fontWeight: 600 }}>{c.value}</div>
              <div style={{ fontSize: 12, opacity: 0.65, marginTop: 2 }}>{c.label}</div>
            </div>
          ))}
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
          数据目录：{content.dataDir}
        </Typography.Text>
      </div>

      {/* 菜单访问 */}
      <div>
        <Typography.Text strong style={{ fontSize: 13 }}>
          菜单 / 页面使用次数
        </Typography.Text>
        {pageRows.length === 0 ? (
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '6px 0 0' }}>
            尚无页面访问记录（统计从本次安装后开始累计）。
          </Typography.Paragraph>
        ) : (
          <Table
            style={{ marginTop: 8 }}
            size="small"
            rowKey="page"
            pagination={false}
            dataSource={pageRows}
            columns={[
              {
                title: '页面',
                dataIndex: 'page',
                render: (p: string) => pageLabelOf(p)
              },
              { title: '访问次数', dataIndex: 'visits', width: 110, render: (n: number) => fmtNum(n) },
              {
                title: '最近访问',
                dataIndex: 'lastVisitedAt',
                width: 170,
                render: (t: number) => fmtTime(t)
              }
            ]}
          />
        )}
      </div>
    </div>
  )
}

/* ---------- 设置伸缩卡片：默认收起，点击标题展开 ---------- */
function SettingSection({
  id,
  title,
  subtitle,
  defaultOpen = false,
  children
}: {
  id: string
  title: React.ReactNode
  subtitle?: React.ReactNode
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(() => {
    try {
      const raw = localStorage.getItem(`wb-settings-open-${id}`)
      if (raw === '1') return true
      if (raw === '0') return false
    } catch {
      /* ignore */
    }
    return defaultOpen
  })
  const toggle = (): void => {
    const next = !open
    setOpen(next)
    try {
      localStorage.setItem(`wb-settings-open-${id}`, next ? '1' : '0')
    } catch {
      /* ignore */
    }
  }
  return (
    <section
      className={`setting-section${open ? ' is-open' : ''}`}
      style={{ maxWidth: 760, marginTop: 12 }}
      aria-expanded={open}
    >
      <button type="button" className="setting-section-head" onClick={toggle} aria-expanded={open}>
        <span className="setting-section-chevron" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        <span className="setting-section-title">{title}</span>
        {subtitle ? <span className="setting-section-sub">{subtitle}</span> : null}
      </button>
      {open && <div className="setting-section-body">{children}</div>}
    </section>
  )
}

/* ---------- MCP 集成客户端配置 ---------- */
function McpSection() {
  const [servers, setServers] = useState<McpServerState[]>([])
  const [tools, setTools] = useState<McpToolInfo[]>([])
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([window.api.mcp.listServers(), window.api.mcp.listTools()])
      setServers(s)
      setTools(t)
    } catch (err) {
      message.error('加载 MCP 失败：' + (err as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const add = async (): Promise<void> => {
    if (!name.trim() || !command.trim()) {
      message.warning('请填写名称与启动命令')
      return
    }
    setLoading(true)
    try {
      const cfg: McpServerConfig = {
        id: crypto.randomUUID(),
        name: name.trim(),
        command: command.trim(),
        args: args.trim() ? args.split(/\s+/) : undefined,
        enabled: true
      }
      await window.api.mcp.addServer(cfg)
      message.success('已添加 MCP 服务器，正在连接')
      setName('')
      setCommand('')
      setArgs('')
      void load()
    } catch (err) {
      message.error('添加失败：' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const remove = async (id: string): Promise<void> => {
    try {
      await window.api.mcp.removeServer(id)
      message.success('已移除')
      void load()
    } catch (err) {
      message.error('移除失败：' + (err as Error).message)
    }
  }

  const statusColor: Record<string, string> = {
    connected: 'green',
    connecting: 'blue',
    error: 'red',
    disabled: 'default'
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space wrap>
        <Input aria-label="服务器名" style={{ width: 160 }} placeholder="服务器名" value={name} onChange={(e) => setName(e.target.value)} />
        <Input aria-label="启动命令" style={{ width: 220 }} placeholder="启动命令，如 npx" value={command} onChange={(e) => setCommand(e.target.value)} />
        <Input aria-label="启动参数" style={{ width: 240 }} placeholder="参数（空格分隔，可选）" value={args} onChange={(e) => setArgs(e.target.value)} />
        <Button type="primary" icon={<PlusOutlined />} loading={loading} onClick={add}>
          添加服务器
        </Button>
      </Space>

      <Table
        size="small"
        rowKey="id"
        dataSource={servers}
        pagination={false}
        locale={{ emptyText: '尚未配置 MCP 服务器' }}
        columns={[
          { title: '名称', dataIndex: 'name' },
          { title: '命令', dataIndex: 'command', ellipsis: true },
          {
            title: '状态',
            dataIndex: 'status',
            width: 110,
            render: (s: string, r) => (
              <Space>
                <Tag color={statusColor[s]}>{s}</Tag>
                {r.error && <Typography.Text type="danger" style={{ fontSize: 12 }}>{r.error}</Typography.Text>}
              </Space>
            )
          },
          { title: '工具数', dataIndex: 'toolCount', width: 80 },
          {
            title: '操作',
            width: 90,
            render: (_v, r) => (
              <Button size="small" danger icon={<DeleteOutlined />} onClick={() => void remove(r.id)}>
                移除
              </Button>
            )
          }
        ]}
      />

      <Card size="small" title={`已注册工具（聚合自所有已连接服务器）：${tools.length}`}>
        {tools.length === 0 ? (
          <Typography.Text type="secondary">暂无可用工具（连接服务器后自动加载）</Typography.Text>
        ) : (
          <Table
            size="small"
            rowKey={(t) => t.serverId + '__' + t.name}
            dataSource={tools}
            pagination={{ pageSize: 8 }}
            columns={[
              { title: '服务器', dataIndex: 'serverName', width: 160 },
              {
                title: '工具',
                dataIndex: 'name',
                render: (n: string, t) => <Tag>{t.serverId}::{n}</Tag>
              },
              { title: '说明', dataIndex: 'description', ellipsis: true }
            ]}
          />
        )}
      </Card>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
        MCP 服务器在应用启动时自动连接（配置持久化于 userData）。连接的工具可在「AI 助手 → 本地文件问答」中被问答调用（函数调度）。
      </Typography.Paragraph>
    </Space>
  )
}

export default function Settings() {
  const [info, setInfo] = useState<DataInfo | null>(null)
  const [dataDir, setDataDir] = useState<{ current: string; custom: string | null } | null>(null)
  const [importing, setImporting] = useState(false)
  const [backuping, setBackuping] = useState(false)
  const [testingAi, setTestingAi] = useState(false)
  const [aiTestResult, setAiTestResult] = useState<{ ok: boolean; error?: string; latencyMs?: number } | null>(null)
  const [needsRestart, setNeedsRestart] = useState(false)
  const [aiForm] = Form.useForm<AiConfig & { profileName?: string }>()
  const { prefs, update } = usePrefs()
  const { isDark } = useTheme()
  const [profiles, setProfiles] = useState<AiProfilesState>({ activeId: '', profiles: [] })
  const [routing, setRouting] = useState<{
    primaryId?: string
    primaryIds: string[]
    fallbackId?: string
    fallbackIds: string[]
    mode: 'primary-only' | 'failover' | 'both'
  }>({ primaryIds: [], fallbackIds: [], mode: 'failover' })
  const [editProfileId, setEditProfileId] = useState<string | null>(null)
  const [dash, setDash] = useState<DashboardOverview | null>(null)
  const [dashLoading, setDashLoading] = useState(false)

  const loadDashboard = useCallback(async () => {
    setDashLoading(true)
    try {
      const d = await window.api.usage.dashboard()
      setDash(d)
    } catch {
      setDash(null)
    } finally {
      setDashLoading(false)
    }
  }, [])

  const loadProfiles = useCallback(async () => {
    try {
      const st = await window.api.ai.listProfiles()
      setProfiles(st)
      void window.api.ai.getRouting().then((r) => setRouting(r)).catch(() => undefined)
      const active = st.profiles.find((p) => p.id === st.activeId) ?? st.profiles[0]
      if (active) {
        setEditProfileId(active.id)
        aiForm.setFieldsValue({
          profileName: active.name,
          endpoint: active.endpoint,
          apiKey: active.apiKey,
          model: active.model,
          systemPrompt: active.systemPrompt,
          secondaryModel: active.secondaryModel
        })
      }
    } catch {
      /* ignore */
    }
  }, [aiForm])

  useEffect(() => {
    void loadProfiles()
  }, [loadProfiles])

  useEffect(() => {
    void loadDashboard()
  }, [loadDashboard])

  const handleSavePrefs = async (patch: Partial<Prefs>): Promise<void> => {
    // 切换壁纸模式时，若强度过低会「看起来没生效」，自动抬到可见区间
    const nextPatch = { ...patch }
    if (patch.wallpaperMode && patch.wallpaperMode !== 'theme') {
      const cur = prefs.wallpaperIntensity ?? 0.85
      if (cur < 0.75) nextPatch.wallpaperIntensity = 0.9
    }
    await update(nextPatch)
    message.success('个性化设置已保存')
  }

  const updateZone = async (
    key: WallpaperZoneKey,
    patch: Partial<{ enabled: boolean; mode: string; intensity: number; image: string; color: string; color2: string }>
  ): Promise<void> => {
    const zones = { ...(prefs.wallpaperZones ?? {}) }
    const prev = zones[key] ?? { enabled: true, mode: 'inherit' as const, intensity: -1, image: '', color: '', color2: '' }
    zones[key] = { ...prev, ...patch } as typeof prev
    await handleSavePrefs({ wallpaperZones: zones } as Partial<Prefs>)
  }

  const pickZoneImage = async (key: WallpaperZoneKey): Promise<void> => {
    const r = await window.api.prefs.pickWallpaper()
    if (!r.ok) {
      if (r.error && r.error !== 'cancelled') message.error(r.error)
      return
    }
    await updateZone(key, { mode: 'image', image: r.path ?? '' })
    message.success('本区自定义背景已应用')
  }

  const load = useCallback(async () => {
    try {
      const [d, cfg, dd] = await Promise.all([
        window.api.data.info(),
        window.api.ai.getConfig(),
        window.api.data.getDataDir()
      ])
      setInfo(d)
      setDataDir(dd)
      aiForm.setFieldsValue(cfg)
    } catch {
      message.error('读取数据信息失败')
    }
  }, [aiForm])

  useEffect(() => {
    load()
  }, [load])

  const handleBackup = async (): Promise<void> => {
    setBackuping(true)
    try {
      const target = await window.api.data.backup()
      if (target) message.success(`导出完成：${target}`)
    } catch {
      message.error('导出失败')
    } finally {
      setBackuping(false)
    }
  }

  const handleImport = async (): Promise<void> => {
    Modal.confirm({
      title: '从备份导入数据',
      content: '导入会覆盖当前数据目录中的同名文件（快捷方式、笔记、自动化等）。建议先执行「导出备份」。确定继续吗？',
      okText: '导入',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setImporting(true)
        try {
          const target = await window.api.data.importData()
          if (target) {
            message.success(`导入完成：${target}`)
            load()
          }
        } catch {
          message.error('导入失败')
        } finally {
          setImporting(false)
        }
      }
    })
  }

  const handleSetDataDir = async (): Promise<void> => {
    try {
      const dir = await window.api.data.pickDir('选择新的数据目录')
      if (!dir) return
      await window.api.data.setDataDir(dir)
      setNeedsRestart(true)
      message.success('已设置自定义数据目录，重启后生效')
      load()
    } catch {
      message.error('设置失败')
    }
  }

  const handleResetDataDir = async (): Promise<void> => {
    try {
      await window.api.data.setDataDir(null)
      setNeedsRestart(true)
      message.success('已恢复默认数据目录，重启后生效')
      load()
    } catch {
      message.error('操作失败')
    }
  }

  const AI_PRESETS = [
    { name: 'Ollama（本地）', endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:14b', keyTip: '本地无需 Key；模型名与 ollama list 一致（如 qwen2.5:14b）' },
    { name: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o', keyTip: '填入 sk- 开头的 API Key' },
    { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyTip: '填入 DeepSeek API Key' },
    { name: '通义千问', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', keyTip: '填入 DashScope API Key（sk-）' },
    { name: 'Kimi（月之暗面）', endpoint: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', keyTip: '填入 Moonshot API Key（sk-）' },
    { name: '智谱 GLM', endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', keyTip: '填入智谱 API Key；glm-4-flash 有免费档' },
    { name: '智谱 GLM-4-Plus', endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', keyTip: '填入智谱 API Key（更强，计费）' },
    { name: '小米 MiMo', endpoint: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.5-pro', keyTip: '填入小米 MiMo API Key（platform.xiaomimimo.com）' },
    { name: '百度千帆', endpoint: 'https://qianfan.baidubce.com/v2', model: 'ernie-4.0-turbo-8k', keyTip: '填入百度千帆 API Key' },
    { name: '讯飞星火', endpoint: 'https://spark-api-open.xf-yun.com/v1', model: 'generalv3.5', keyTip: '填入讯飞星火 API Key（注意 appid/uid 配置）' },
    { name: '豆包（火山方舟）', endpoint: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-1-5-pro-32k-250115', keyTip: '填入方舟 API Key；模型名用控制台推理接入点 ID' },
    { name: '阶跃星辰', endpoint: 'https://api.stepfun.com/v1', model: 'step-2-16k', keyTip: '填入阶跃星辰 API Key' },
    { name: 'MiniMax', endpoint: 'https://api.minimax.chat/v1', model: 'abab6.5s-chat', keyTip: '填入 MiniMax API Key' },
    { name: '零一万物', endpoint: 'https://api.lingyiwanwu.com/v1', model: 'yi-lightning', keyTip: '填入零一万物 API Key' },
    { name: '硅基流动 SiliconFlow', endpoint: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', keyTip: '聚合多家国产模型，注册即送额度' },
    { name: '腾讯混元', endpoint: 'https://api.hunyuan.cloud.tencent.com/v1', model: 'hunyuan-turbos-latest', keyTip: '填入腾讯混元 API Key' }
  ]

  const applyPreset = (name: string): void => {
    const preset = AI_PRESETS.find((x) => x.name === name)
    if (!preset) return
    aiForm.setFieldsValue({ endpoint: preset.endpoint, model: preset.model })
    message.info('已自动填入 ' + preset.name + '，' + preset.keyTip)
  }

  const handleSaveAi = async (values: AiConfig & { profileName?: string }): Promise<void> => {
    try {
      if (editProfileId) {
        await window.api.ai.updateProfile(editProfileId, {
          name: values.profileName || profiles.profiles.find((p) => p.id === editProfileId)?.name || '配置',
          endpoint: values.endpoint,
          apiKey: values.apiKey,
          model: values.model,
          systemPrompt: values.systemPrompt,
          secondaryModel: values.secondaryModel
        })
        if (editProfileId === profiles.activeId) {
          await window.api.ai.saveConfig(values)
        }
        message.success('配置已保存')
        await loadProfiles()
        return
      }
      // 本地 Ollama：无需 Key 也可添加
      const st = await window.api.ai.addProfile({
        name: values.profileName || values.model || '新配置',
        endpoint: values.endpoint,
        apiKey: values.apiKey || '',
        model: values.model,
        systemPrompt: values.systemPrompt,
        secondaryModel: values.secondaryModel,
        activate: true
      })
      setProfiles(st)
      message.success('已新增并启用配置')
      await loadProfiles()
    } catch (err) {
      message.error('保存失败：' + ((err as Error).message || '未知错误'))
    }
  }

  const addOllama = async (): Promise<void> => {
    try {
      const st = await window.api.ai.addOllama({
        endpoint: 'http://localhost:11434/v1',
        model: 'qwen2.5:14b',
        name: 'Ollama qwen2.5:14b'
      })
      setProfiles(st)
      message.success('已添加本地 Ollama qwen2.5:14b 并启用')
      await loadProfiles()
    } catch (err) {
      message.error('添加本地模型失败：' + ((err as Error).message || '未知'))
    }
  }

  const copyDir = async (): Promise<void> => {
    if (!info) return
    try {
      await navigator.clipboard.writeText(info.dataDir)
      message.success('已复制数据目录')
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="dashboard-page">
      <div className="page-header">
        <Typography.Title level={4} style={{ margin: 0 }}>
          设置
        </Typography.Title>
      </div>

      <SettingSection
        id="dash"
        title="数据看板"
        subtitle="模型用量 · 模块内容 · 访问统计"
        defaultOpen
      >
        <div style={{ marginBottom: 10 }}>
          <Space>
            <Button size="small" onClick={() => void loadDashboard()} loading={dashLoading}>
              刷新统计
            </Button>
            <Popconfirm
              title="清空使用统计？"
              description="仅清空调用/访问计数，不删除笔记、作品等数据"
              okText="清空"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={async () => {
                await window.api.usage.reset()
                await loadDashboard()
                message.success('使用统计已清空')
              }}
            >
              <Button size="small" danger>
                清空统计
              </Button>
            </Popconfirm>
          </Space>
        </div>
        {dashLoading && !dash ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            统计加载中…
          </Typography.Text>
        ) : dash ? (
          <DashBoardBody dash={dash} />
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            暂无统计数据，点击「刷新统计」
          </Typography.Text>
        )}
      </SettingSection>

      <SettingSection id="data" title="数据与存储" subtitle="目录 · 备份 · 导入导出">
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="数据目录">
            <Space>
              <Typography.Text code style={{ fontSize: 12 }}>
                {info?.dataDir ?? '加载中…'}
              </Typography.Text>
              <Button size="small" type="text" icon={<CopyOutlined />} onClick={copyDir} title="复制路径" />
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="快捷方式">{info?.shortcuts ?? '-'} 个</Descriptions.Item>
          <Descriptions.Item label="笔记">{info?.notes ?? '-'} 篇</Descriptions.Item>
          <Descriptions.Item label="自动化命令">{info?.automations ?? '-'} 条</Descriptions.Item>
          <Descriptions.Item label="AI 配置">{info?.aiConfigured ? '已配置' : '未配置'}</Descriptions.Item>
        </Descriptions>
        <div style={{ marginTop: 16 }}>
          <Typography.Text strong style={{ fontSize: 13 }}>
            自定义数据目录
          </Typography.Text>
          <div style={{ marginTop: 8 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              当前：
              <Typography.Text code style={{ fontSize: 12 }}>
                {dataDir?.current ?? '加载中…'}
              </Typography.Text>
            </Typography.Text>
            {dataDir?.custom && (
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                自定义：
                <Typography.Text code style={{ fontSize: 12 }}>
                  {dataDir.custom}
                </Typography.Text>
              </Typography.Text>
            )}
          </div>
          <Space style={{ marginTop: 8 }}>
            <Button size="small" onClick={handleSetDataDir}>
              选择目录…
            </Button>
            {dataDir?.custom && (
              <Button size="small" onClick={handleResetDataDir}>
                恢复默认
              </Button>
            )}
            {needsRestart && (
              <Button size="small" type="primary" onClick={() => void window.api.windowApi.relaunch()}>
                立即重启生效
              </Button>
            )}
          </Space>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
            自定义目录可把数据放到任意磁盘位置（如 D:\MyData），设置后重启生效。
          </Typography.Paragraph>
        </div>
        <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button icon={<FolderOpenOutlined />} onClick={handleBackup} loading={backuping}>
            导出数据到…
          </Button>
          <Button icon={<FolderAddOutlined />} onClick={handleImport} loading={importing}>
            从目录导入…
          </Button>
        </div>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
          导出会把 shortcuts.json、automations.json、ai-config.json 与 notes/、boards/、tables/ 文件夹复制到你选择的位置；
          导入则从所选目录读取这些文件并复制到当前数据目录（同名文件会覆盖）。
        </Typography.Paragraph>
      </SettingSection>

      <SettingSection id="ai" title="AI 模型" subtitle="本地 + 云端 · 可双路">
        <Space style={{ marginBottom: 10 }} wrap>
          <Button type="primary" icon={<ApiOutlined />} onClick={() => void addOllama()}>
            一键添加 Ollama
          </Button>
          <Select
            mode="multiple"
            size="small"
            style={{ minWidth: 200 }}
            placeholder="主力（可多选，本地+API）"
            value={routing.primaryIds?.length ? routing.primaryIds : routing.primaryId ? [routing.primaryId] : []}
            options={profiles.profiles.map((p) => ({ label: p.name, value: p.id }))}
            onChange={(vals) => {
              const ids = vals as string[]
              void window.api.ai
                .setRouting({ ...routing, primaryIds: ids, primaryId: ids[0] || routing.primaryId })
                .then(() => loadProfiles())
            }}
          />
          <Select
            mode="multiple"
            size="small"
            style={{ minWidth: 200 }}
            allowClear
            placeholder="备用（failover 顺序）"
            value={routing.fallbackIds?.length ? routing.fallbackIds : routing.fallbackId ? [routing.fallbackId] : []}
            options={profiles.profiles.map((p) => ({ label: p.name, value: p.id }))}
            onChange={(vals) => {
              const ids = vals as string[]
              void window.api.ai
                .setRouting({ ...routing, fallbackIds: ids, fallbackId: ids[0] || undefined })
                .then(() => loadProfiles())
            }}
          />
          <Select
            size="small"
            style={{ width: 110 }}
            value={routing.mode}
            options={[
              { label: '主优先', value: 'primary-only' },
              { label: '失败切换', value: 'failover' },
              { label: '多路并行', value: 'both' }
            ]}
            onChange={(v) => void window.api.ai.setRouting({ ...routing, mode: v }).then(() => loadProfiles())}
          />
        </Space>
        <div style={{ marginBottom: 12 }}>
          <Typography.Text strong style={{ fontSize: 13 }}>
            已保存的配置
          </Typography.Text>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 8px' }}>
            点击加载到下方编辑；「启用」后写作 / AI 右键 / 问答都使用该套。Key 仅加密存在本机。
          </Typography.Paragraph>
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {profiles.profiles.length === 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                暂无配置，请在下方填写并保存
              </Typography.Text>
            )}
            {profiles.profiles.map((p) => {
              const isActive = p.id === profiles.activeId
              return (
                <div
                  key={p.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    flexWrap: 'wrap',
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: isActive ? '1px solid var(--accent, #28607D)' : '1px solid rgba(128,128,128,.18)',
                    background: isActive ? 'var(--accent-soft, rgba(22,119,255,.06))' : 'rgba(128,128,128,.04)'
                  }}
                >
                  <Tag color={isActive ? 'blue' : 'default'} style={{ margin: 0 }}>
                    {isActive ? '当前' : '备用'}
                  </Tag>
                  <Typography.Text strong style={{ fontSize: 13 }}>
                    {p.name}
                  </Typography.Text>
                  <Typography.Text
                    type="secondary"
                    style={{ fontSize: 12, maxWidth: 220 }}
                    ellipsis={{ tooltip: `${p.model} · ${p.endpoint}` }}
                  >
                    {p.model || '未填模型'} · {p.endpoint || '未填地址'}
                  </Typography.Text>
                  <div style={{ flex: 1 }} />
                  <Button
                    size="small"
                    onClick={() => {
                      setEditProfileId(p.id)
                      aiForm.setFieldsValue({
                        profileName: p.name,
                        endpoint: p.endpoint,
                        apiKey: p.apiKey,
                        model: p.model,
                        systemPrompt: p.systemPrompt,
                        secondaryModel: p.secondaryModel
                      })
                    }}
                  >
                    编辑
                  </Button>
                  {!isActive && (
                    <Button
                      size="small"
                      type="primary"
                      onClick={async () => {
                        const st = await window.api.ai.setActiveProfile(p.id)
                        setProfiles(st)
                        message.success(`已启用「${p.name}」`)
                      }}
                    >
                      启用
                    </Button>
                  )}
                  <Popconfirm
                    title="删除这套配置？"
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    onConfirm={async () => {
                      const st = await window.api.ai.removeProfile(p.id)
                      setProfiles(st)
                      if (editProfileId === p.id) {
                        setEditProfileId(st.activeId || null)
                        const nx = st.profiles.find((x) => x.id === st.activeId)
                        if (nx) {
                          aiForm.setFieldsValue({
                            profileName: nx.name,
                            endpoint: nx.endpoint,
                            apiKey: nx.apiKey,
                            model: nx.model,
                            systemPrompt: nx.systemPrompt,
                            secondaryModel: nx.secondaryModel
                          })
                        }
                      }
                      message.success('已删除')
                    }}
                  >
                    <Button size="small" danger>
                      删除
                    </Button>
                  </Popconfirm>
                </div>
              )
            })}
          </Space>
        </div>

        <Form form={aiForm} layout="vertical" onFinish={handleSaveAi} style={{ maxWidth: 560 }}>
          <Form.Item label="配置名称" name="profileName">
            <Input placeholder="如：智谱 GLM / Ollama 本地 / 小米 MiMo" />
          </Form.Item>
          <Form.Item label="快速选择服务">
            <Select
              placeholder="选择服务自动填入地址与模型"
              onChange={(v) => applyPreset(v)}
              options={AI_PRESETS.map((x) => ({ label: x.name, value: x.name }))}
            />
          </Form.Item>
          <Form.Item
            name="endpoint"
            label="API 地址"
            extra="OpenAI 兼容端点，选择上方服务可自动填入"
            rules={[{ required: true, message: '请输入 API 地址' }]}
          >
            <Input placeholder="https://api.openai.com/v1" />
          </Form.Item>
          <Form.Item name="apiKey" label="API Key">
            <Input.Password placeholder="本地 Ollama 可留空" />
          </Form.Item>
          <Form.Item name="model" label="模型" extra="可点右侧「拉取模型列表」自动选择，避免拼写错误（如 qwen2.5:14b）">
            <Input
              placeholder="例如 qwen2.5:14b / gpt-4o"
              addonAfter={
                <Typography.Link
                  style={{ fontSize: 12 }}
                  onClick={async () => {
                    const ep = (aiForm.getFieldValue('endpoint') as string) || ''
                    const key = (aiForm.getFieldValue('apiKey') as string) || ''
                    const r = await window.api.ai.listModels(ep, key)
                    if (!r.ok || !r.models.length) {
                      message.error(r.error || '未获取到模型列表')
                      return
                    }
                    Modal.info({
                      title: '可用模型（点击填入）',
                      width: 420,
                      content: (
                        <div style={{ maxHeight: 320, overflow: 'auto' }}>
                          {r.models.map((m) => (
                            <Button
                              key={m}
                              type="link"
                              block
                              style={{ textAlign: 'left' }}
                              onClick={() => {
                                aiForm.setFieldsValue({ model: m })
                                message.success(`已填入 ${m}`)
                              }}
                            >
                              {m}
                            </Button>
                          ))}
                        </div>
                      )
                    })
                  }}
                >
                  拉取模型列表
                </Typography.Link>
              }
            />
          </Form.Item>
          <Form.Item name="systemPrompt" label="系统提示词">
            <Input.TextArea
              placeholder="你是一个乐于助人的助手。"
              autoSize={{ minRows: 2, maxRows: 4 }}
            />
          </Form.Item>
          <Button type="primary" htmlType="submit">
            {editProfileId ? '保存当前配置' : '新增并启用'}
          </Button>
          <Button
            style={{ marginLeft: 8 }}
            onClick={() => {
              setEditProfileId(null)
              aiForm.resetFields()
              aiForm.setFieldsValue({
                profileName: '',
                endpoint: '',
                apiKey: '',
                model: '',
                systemPrompt: '你是一个乐于助人的助手。'
              })
            }}
          >
            新建空白配置
          </Button>
          <Button
            style={{ marginLeft: 8 }}
            icon={<ApiOutlined />}
            loading={testingAi}
            onClick={async () => {
              const values = aiForm.getFieldsValue() as AiConfig
              setTestingAi(true)
              setAiTestResult(null)
              try {
                const r = await window.api.ai.testProfile(values)
                setAiTestResult(r)
                if (r.ok) message.success(`连接成功（${r.latencyMs ?? '-'}ms）`)
                else message.error('连接失败：' + r.error)
              } catch (err) {
                message.error('测试失败：' + (err as Error).message)
              } finally {
                setTestingAi(false)
              }
            }}
          >
            保存并测试连接
          </Button>
          {aiTestResult && !aiTestResult.ok && (
            <Typography.Text type="danger" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
              连接失败：{aiTestResult.error}
            </Typography.Text>
          )}
        </Form>
      </SettingSection>

      <SettingSection id="theme" title="个性化" subtitle="主题色 · 壁纸 · 动效">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <Typography.Text strong style={{ fontSize: 13 }}>
              主题色
            </Typography.Text>
            <div style={{ marginTop: 8 }} role="radiogroup" aria-label="主题主色">
              <Radio.Group
                value={prefs.colorPrimary}
                onChange={(e) => handleSavePrefs({ colorPrimary: e.target.value })}
              >
                {['#28607D', '#46D4E6', '#1677ff', '#13c2c2', '#52c41a', '#faad14', '#fa541c', '#eb2f96', '#722ed1'].map((c1) => (
                  <Radio.Button
                    key={c1}
                    value={c1}
                    aria-label={`主题主色 ${c1}`}
                    style={{
                      width: 32,
                      height: 32,
                      padding: 0,
                      background: c1,
                      border: 'none',
                      marginRight: 8,
                      borderRadius: 6,
                      boxShadow: prefs.colorPrimary === c1 ? 'inset 0 0 0 2px #fff, inset 0 0 0 4px currentColor, 0 0 0 1px rgba(0,0,0,.15)' : undefined
                    }}
                  />
                ))}
              </Radio.Group>
            </div>
          </div>
          <div>
            <Typography.Text strong style={{ fontSize: 13 }}>
              启动默认页面
            </Typography.Text>
            <div style={{ marginTop: 8 }}>
              <Select
                aria-label="启动默认页面"
                style={{ width: 220 }}
                value={prefs.defaultPage}
                onChange={(v) => handleSavePrefs({ defaultPage: v })}
                options={DEFAULT_PAGE_CHOICES.map((k) => ({ label: pageLabelOf(k), value: k }))}
              />
            </div>
          </div>
          <div>
            <Typography.Text strong style={{ fontSize: 13 }}>
              氛境壁纸
            </Typography.Text>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 8 }}>
              参考 Linear / Arc 等现代桌面应用的环境层设计：纯 CSS 渐变，无外链资源；侧栏玻璃化后可透出。
            </Typography.Paragraph>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {WALLPAPER_PRESETS.map((w) => {
                const active = (prefs.wallpaperMode || 'theme') === w.id
                return (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => void handleSavePrefs({ wallpaperMode: w.id })}
                    aria-pressed={active}
                    style={{
                      width: 92,
                      cursor: 'pointer',
                      padding: 0,
                      border: active ? '2px solid var(--accent, #28607D)' : '1px solid rgba(128,128,128,.25)',
                      borderRadius: 10,
                      overflow: 'hidden',
                      background: 'transparent',
                      boxShadow: active ? '0 0 0 2px color-mix(in srgb, var(--accent,#28607D) 25%, transparent)' : undefined
                    }}
                  >
                    <div style={{ height: 52, background: w.preview }} />
                    <div style={{ padding: '6px 4px', fontSize: 12, textAlign: 'center' }}>{w.label}</div>
                  </button>
                )
              })}
              <button
                type="button"
                onClick={() => void handleSavePrefs({ wallpaperMode: 'custom' })}
                aria-pressed={(prefs.wallpaperMode || 'theme') === 'custom'}
                style={{
                  width: 92,
                  cursor: 'pointer',
                  padding: 0,
                  border:
                    (prefs.wallpaperMode || 'theme') === 'custom'
                      ? '2px solid var(--accent, #28607D)'
                      : '1px solid rgba(128,128,128,.25)',
                  borderRadius: 10,
                  overflow: 'hidden',
                  background: 'transparent'
                }}
              >
                <div
                  style={{
                    height: 52,
                    background: `linear-gradient(140deg, ${prefs.wallpaperColor || '#28607D'}, ${prefs.wallpaperColor2 || '#46D4E6'})`
                  }}
                />
                <div style={{ padding: '6px 4px', fontSize: 12, textAlign: 'center' }}>自定义</div>
              </button>
              <button
                type="button"
                onClick={() => void handleSavePrefs({ wallpaperMode: 'image' })}
                aria-pressed={(prefs.wallpaperMode || 'theme') === 'image'}
                style={{
                  width: 92,
                  cursor: 'pointer',
                  padding: 0,
                  border:
                    (prefs.wallpaperMode || 'theme') === 'image'
                      ? '2px solid var(--accent, #28607D)'
                      : '1px solid rgba(128,128,128,.25)',
                  borderRadius: 10,
                  overflow: 'hidden',
                  background: 'transparent'
                }}
              >
                <div
                  style={{
                    height: 52,
                    background:
                      prefs.wallpaperImage && (prefs.wallpaperMode || 'theme') === 'image'
                        ? 'linear-gradient(135deg,#4a5568,#2d3748)'
                        : 'linear-gradient(135deg,#cbd5e1,#94a3b8)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 11,
                    color: '#fff'
                  }}
                >
                  {prefs.wallpaperImage ? '已选图' : '选图'}
                </div>
                <div style={{ padding: '6px 4px', fontSize: 12, textAlign: 'center' }}>背景图</div>
              </button>
            </div>

            {(prefs.wallpaperMode || 'theme') === 'image' && (
              <div style={{ marginTop: 12, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                <Button
                  size="small"
                  type="primary"
                  onClick={async () => {
                    const r = await window.api.prefs.pickWallpaper()
                    if (!r.ok) {
                      if (r.error && r.error !== 'cancelled') message.error(r.error)
                      return
                    }
                    await handleSavePrefs({ wallpaperMode: 'image', wallpaperImage: r.path })
                    message.success('壁纸已应用')
                  }}
                >
                  选择图片…
                </Button>
                <Segmented
                  size="small"
                  value={prefs.wallpaperImageFit || 'cover'}
                  onChange={(v) => void handleSavePrefs({ wallpaperImageFit: v as 'cover' | 'contain' })}
                  options={[
                    { label: '铺满', value: 'cover' },
                    { label: '完整显示', value: 'contain' }
                  ]}
                />
                {prefs.wallpaperImage ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis={{ tooltip: prefs.wallpaperImage }}>
                    已保存至应用数据目录
                  </Typography.Text>
                ) : (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    请先选择一张本地图片（png/jpg/webp…）
                  </Typography.Text>
                )}
              </div>
            )}

            {(prefs.wallpaperMode || 'theme') === 'custom' && (
              <div style={{ marginTop: 12, display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>主色</Typography.Text>
                  <div style={{ marginTop: 4 }}>
                    <ColorPicker
                      aria-label="壁纸主色"
                      value={prefs.wallpaperColor || '#28607D'}
                      allowClear={false}
                      onChange={(_, hex) => handleSavePrefs({ wallpaperColor: hex })}
                    />
                  </div>
                </div>
                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>辅色</Typography.Text>
                  <div style={{ marginTop: 4 }}>
                    <ColorPicker
                      aria-label="壁纸辅色"
                      value={prefs.wallpaperColor2 || '#46D4E6'}
                      allowClear={false}
                      onChange={(_, hex) => handleSavePrefs({ wallpaperColor2: hex })}
                    />
                  </div>
                </div>
              </div>
            )}

            <div style={{ marginTop: 8 }}>
              <Typography.Text strong style={{ fontSize: 13 }}>
                应用区域（可单独开关 / 单独模式）
              </Typography.Text>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 8 }}>
                标题栏、侧栏、内容区可分别设置：预设壁纸、本区自定义背景图、本区自定义双色，并单独调强度。
              </Typography.Paragraph>
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                {([
                  { key: 'titlebar' as const, label: '标题栏 / 菜单栏' },
                  { key: 'sider' as const, label: '侧边栏' },
                  { key: 'content' as const, label: '内容区（主背景）' }
                ]).map((row) => {
                  const z = prefs.wallpaperZones?.[row.key] ?? {
                    enabled: true,
                    mode: 'inherit',
                    intensity: -1,
                    image: '',
                    color: '',
                    color2: ''
                  }
                  const zoneMode = (z.mode || 'inherit') as string
                  return (
                    <div
                      key={row.key}
                      style={{
                        padding: '10px 12px',
                        borderRadius: 10,
                        border: '1px solid rgba(128,128,128,.18)',
                        background: 'rgba(128,128,128,.04)'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                        <Checkbox
                          checked={z.enabled !== false}
                          onChange={(e) => void updateZone(row.key, { enabled: e.target.checked })}
                          style={{ minWidth: 140 }}
                        >
                          <strong style={{ fontSize: 13 }}>{row.label}</strong>
                        </Checkbox>
                        <Select
                          size="small"
                          style={{ width: 150 }}
                          value={zoneMode}
                          onChange={(v) => void updateZone(row.key, { mode: v })}
                          options={[
                            { label: '跟随全局', value: 'inherit' },
                            ...WALLPAPER_PRESETS.filter((p) => p.id !== 'theme').map((p) => ({ label: p.label, value: p.id })),
                            { label: '本区自定义色', value: 'custom' },
                            { label: '本区背景图', value: 'image' }
                          ]}
                          disabled={z.enabled === false}
                        />
                        <div style={{ minWidth: 160, flex: 1, maxWidth: 220 }}>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            强度 {z.intensity < 0 ? '全局' : Math.round(z.intensity * 100) + '%'}
                          </Typography.Text>
                          <Slider
                            min={-1}
                            max={1}
                            step={0.05}
                            value={z.intensity}
                            disabled={z.enabled === false}
                            onChange={(v) => void updateZone(row.key, { intensity: v as number })}
                            tooltip={{ formatter: (val) => ((val as number) < 0 ? '跟随全局' : Math.round((val as number) * 100) + '%') }}
                          />
                        </div>
                      </div>

                      {/* 本区自定义背景：常驻，三个区域都可单独加图 / 设色 */}
                      <div
                        style={{
                          marginTop: 8,
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 12,
                          alignItems: 'center',
                          paddingTop: 8,
                          borderTop: '1px dashed rgba(128,128,128,.2)'
                        }}
                      >
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          自定义背景：
                        </Typography.Text>
                        <Button
                          size="small"
                          icon={<FolderOpenOutlined />}
                          disabled={z.enabled === false}
                          onClick={() => void pickZoneImage(row.key)}
                        >
                          {z.image ? '更换本区图片' : '上传本区图片'}
                        </Button>
                        {zoneMode === 'image' && z.image ? (
                          <Tag color="blue" style={{ margin: 0 }}>
                            已用本区图
                          </Tag>
                        ) : z.image ? (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            已存图片，切换模式为「本区背景图」后生效
                          </Typography.Text>
                        ) : null}
                        <ColorPicker
                          aria-label={`${row.label}自定义主色`}
                          value={z.color || prefs.wallpaperColor || '#28607D'}
                          allowClear={false}
                          disabled={z.enabled === false}
                          onChange={(_, hex) => void updateZone(row.key, { color: hex, mode: zoneMode === 'image' ? 'custom' : zoneMode === 'inherit' ? 'custom' : zoneMode })}
                        />
                        <ColorPicker
                          aria-label={`${row.label}自定义辅色`}
                          value={z.color2 || prefs.wallpaperColor2 || '#46D4E6'}
                          allowClear={false}
                          disabled={z.enabled === false}
                          onChange={(_, hex) => void updateZone(row.key, { color2: hex, mode: zoneMode === 'image' ? 'custom' : zoneMode === 'inherit' ? 'custom' : zoneMode })}
                        />
                        <Button
                          size="small"
                          type="link"
                          disabled={z.enabled === false}
                          onClick={() => void updateZone(row.key, { mode: 'custom' })}
                        >
                          用自定义色
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </Space>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                三个区域互不影响：例如标题栏用图 A、侧栏用极光、内容区用森野。上传会复制到应用数据目录，原文件可移动。
              </Typography.Paragraph>
            </div>

            <div style={{ marginTop: 14, maxWidth: 320 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                壁纸强度：{Math.round((prefs.wallpaperIntensity ?? 0.85) * 100)}%
              </Typography.Text>
              <Slider
                aria-label="壁纸强度"
                min={0.2}
                max={1}
                step={0.05}
                value={prefs.wallpaperIntensity ?? 0.85}
                onChange={(v) => void handleSavePrefs({ wallpaperIntensity: v as number })}
              />
            </div>

            <div style={{ marginTop: 8 }}>
              <Typography.Text strong style={{ fontSize: 13 }}>
                动效
              </Typography.Text>
              <div style={{ marginTop: 8 }}>
                <Segmented
                  value={prefs.motionLevel || 'full'}
                  onChange={(v) => void handleSavePrefs({ motionLevel: v as 'full' | 'subtle' | 'none' })}
                  options={[
                    { label: '完整', value: 'full' },
                    { label: '克制', value: 'subtle' },
                    { label: '关闭', value: 'none' }
                  ]}
                />
              </div>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                完整：页面淡入 + 菜单悬停 + 壁纸光斑漂移。克制：更短过渡。关闭：遵循系统「减少动态」偏好。
              </Typography.Paragraph>
            </div>
          </div>
          <div>
            <Typography.Text strong style={{ fontSize: 13 }}>
              界面表面（菜单 / 对话框）
            </Typography.Text>
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'flex-start', gap: 24, flexWrap: 'wrap' }}>
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  表面背景色
                </Typography.Text>
                <div style={{ marginTop: 4 }}>
                  <ColorPicker
                    aria-label="表面背景色"
                    value={prefs.surfaceBg}
                    allowClear={false}
                    onChange={(_, hex) => handleSavePrefs({ surfaceBg: hex })}
                  />
                </div>
              </div>
              <div style={{ minWidth: 240 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  表面不透明度：{Math.round((prefs.surfaceOpacity ?? 1) * 100)}%
                </Typography.Text>
                <div style={{ marginTop: 4 }}>
                  <Slider
                    aria-label="表面不透明度"
                    min={0.3}
                    max={1}
                    step={0.05}
                    value={prefs.surfaceOpacity ?? 1}
                    onChange={(v) => handleSavePrefs({ surfaceOpacity: v as number })}
                  />
                </div>
              </div>
              <Button
                size="small"
                onClick={() =>
                  handleSavePrefs({
                    surfaceBg: isDark ? '#20242F' : '#FDFBF5',
                    surfaceOpacity: 0.92,
                    wallpaperMode: 'theme',
                    wallpaperIntensity: 0.85,
                    motionLevel: 'full',
                    wallpaperImage: prefs.wallpaperImage,
                    wallpaperImageFit: 'cover'
                  })
                }
              >
                恢复默认
              </Button>
            </div>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
              壁纸模式下建议表面不透明度 0.85–0.95，侧栏玻璃效果更明显；调低可透出更多环境层。
            </Typography.Paragraph>
          </div>
        </div>
      </SettingSection>

      <SettingSection id="mcp" title="MCP 集成" subtitle="外部工具接入">
        <McpSection />
      </SettingSection>

      <SettingSection id="hotkeys" title="快捷键">
        <Table
          size="small"
          rowKey="key"
          pagination={false}
          dataSource={[
            { key: 'Ctrl+K', desc: '打开全局搜索 / 命令面板（页面跳转 + 操作触发）' },
            { key: 'Ctrl+N', desc: '新建笔记' },
            { key: 'Ctrl+/', desc: '发起 AI 问答（跳转到 AI 助手）' },
            { key: 'Alt+1 … 9', desc: '跳转到对应页面（按导航顺序）' },
            { key: 'Ctrl+S', desc: '保存当前笔记（笔记页内）' }
          ]}
          columns={[
            {
              title: '快捷键',
              dataIndex: 'key',
              width: 160,
              render: (k: string) => <Typography.Text code>{k}</Typography.Text>
            },
            { title: '作用', dataIndex: 'desc' }
          ]}
        />
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
          在输入框中编辑时，Ctrl+N / Ctrl+/ 不会抢占输入；从其它区域按下即可触发对应操作。
        </Typography.Paragraph>
      </SettingSection>

      <SettingSection id="storage" title="存储格式" subtitle="文件化数据布局">
        <Typography.Paragraph style={{ fontSize: 13 }}>
          所有数据均为纯文本文件，可用任意编辑器查看/修改，也可纳入 Git 管理（文件化、离线优先、数据自主）：
        </Typography.Paragraph>
        <ul className="settings-format-list">
          <li>
            <code>shortcuts.json</code> — 工作台快捷方式
          </li>
          <li>
            <code>notes/index.json</code> + <code>notes/&lt;id&gt;.md</code> — 笔记元数据与 Markdown 正文
          </li>
          <li>
            <code>tables/lingmo.db</code> — 数据库表（SQLite，字段 + 行级存储）
          </li>
          <li>
            <code>boards/</code> — 白板元数据与画布快照
          </li>
          <li>
            <code>automations.json</code> — 自动化命令
          </li>
          <li>
            <code>ai-config.json</code> — AI 模型配置
          </li>
        </ul>
      </SettingSection>
    </div>
  )
}
