import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  Card,
  ColorPicker,
  Descriptions,
  Form,
  Input,
  message,
  Modal,
  Radio,
  Select,
  Slider,
  Space,
  Table,
  Tag,
  Typography
} from 'antd'
import { CopyOutlined, FolderOpenOutlined, FolderAddOutlined, ApiOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import type { AiConfig, DataInfo, McpServerConfig, McpServerState, McpToolInfo } from '@shared/types'
import { usePrefs, type Prefs } from '../prefs'

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
  const [aiForm] = Form.useForm<AiConfig>()
  const { prefs, update } = usePrefs()

  const handleSavePrefs = async (patch: Partial<Prefs>): Promise<void> => {
    await update(patch)
    message.success('个性化设置已保存')
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
    { name: 'Ollama（本地）', endpoint: 'http://127.0.0.1:11434/v1', model: 'llama3.1', keyTip: '本地服务无需 Key，可留空' },
    { name: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o', keyTip: '填入 sk- 开头的 API Key' },
    { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyTip: '填入 DeepSeek API Key' },
    { name: '通义千问', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', keyTip: '填入 DashScope API Key（sk-）' },
    { name: 'Kimi（月之暗面）', endpoint: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', keyTip: '填入 Moonshot API Key（sk-）' }
  ]

  const applyPreset = (name: string): void => {
    const preset = AI_PRESETS.find((x) => x.name === name)
    if (!preset) return
    aiForm.setFieldsValue({ endpoint: preset.endpoint, model: preset.model })
    message.info('已自动填入 ' + preset.name + '，' + preset.keyTip)
  }

  const handleSaveAi = async (values: AiConfig): Promise<void> => {
    try {
      await window.api.ai.saveConfig(values)
      message.success('AI 模型配置已保存')
    } catch {
      message.error('保存失败')
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

      <Card title="数据与存储" style={{ maxWidth: 760 }}>
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
      </Card>

      <Card title="AI 模型" style={{ maxWidth: 760, marginTop: 16 }}>
        <Form form={aiForm} layout="vertical" onFinish={handleSaveAi} style={{ maxWidth: 560 }}>
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
          <Form.Item name="model" label="模型">
            <Input placeholder="例如 gpt-4o / llama3.1" />
          </Form.Item>
          <Form.Item name="systemPrompt" label="系统提示词">
            <Input.TextArea
              placeholder="你是一个乐于助人的助手。"
              autoSize={{ minRows: 2, maxRows: 4 }}
            />
          </Form.Item>
          <Button type="primary" htmlType="submit">
            保存配置
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
                await window.api.ai.saveConfig(values)
                const r = await window.api.ai.testConnection()
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
      </Card>

      <Card title="个性化" style={{ maxWidth: 760, marginTop: 16 }}>
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
                options={[
                  { label: '工作台', value: 'dashboard' },
                  { label: '本地知识库', value: 'knowledge' },
                  { label: '文件工具', value: 'filetools' },
                  { label: '写作', value: 'writing' },
                  { label: '文案', value: 'copywriting' },
                  { label: '笔记', value: 'notes' },
                  { label: '便利贴', value: 'stickies' },
                  { label: '文本工具', value: 'texttools' },
                  { label: '游戏UI设计', value: 'gameui' },
                  { label: '数据整理', value: 'database' },
                  { label: '数据分析', value: 'analytics' },
                  { label: '白板', value: 'boards' },
                  { label: '情报中心', value: 'hotspots' },
                  { label: '设置', value: 'settings' }
                ]}
              />
            </div>
          </div>
          <div>
            <Typography.Text strong style={{ fontSize: 13 }}>
              界面背景与透明度（仅浅色主题）
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
                    min={0}
                    max={1}
                    step={0.05}
                    value={prefs.surfaceOpacity ?? 1}
                    onChange={(v) => handleSavePrefs({ surfaceOpacity: v as number })}
                  />
                </div>
              </div>
              <Button
                size="small"
                onClick={() => handleSavePrefs({ surfaceBg: '#FDFBF5', surfaceOpacity: 1 })}
              >
                恢复默认
              </Button>
            </div>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
              背景色为 HEX（默认 #FDFBF5），不透明度取值范围 0–1（0=全透明，1=不透明，默认 1）。
              仅作用于浅色主题，实时生效于菜单、对话框等浮层；变更立即保存并在当前窗口应用。
            </Typography.Paragraph>
          </div>
        </div>
      </Card>

      <Card title="MCP 集成" style={{ maxWidth: 760, marginTop: 16 }}>
        <McpSection />
      </Card>

      <Card title="快捷键" style={{ maxWidth: 760, marginTop: 16 }}>
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
      </Card>

      <Card title="存储格式" style={{ maxWidth: 760, marginTop: 16 }}>
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
      </Card>
    </div>
  )
}
