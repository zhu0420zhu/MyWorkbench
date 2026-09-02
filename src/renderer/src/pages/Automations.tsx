import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button,
  Empty,
  Form,
  Input,
  List,
  message,
  Modal,
  Skeleton,
  Tag,
  Typography
} from 'antd'
import {
  ClearOutlined,
  DeleteOutlined,
  EditOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  StopOutlined
} from '@ant-design/icons'
import type { Automation, AutomationInput } from '@shared/types'

interface LogLine {
  text: string
  isError?: boolean
  isMeta?: boolean
}

export default function Automations({
  openAutomationId,
  openNew
}: {
  openAutomationId?: string
  openNew?: boolean
}) {
  const [items, setItems] = useState<Automation[]>([])
  const [loading, setLoading] = useState(true)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const [logs, setLogs] = useState<LogLine[]>([])
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Automation | null>(null)
  const [form] = Form.useForm<AutomationInput>()
  const logRef = useRef<HTMLDivElement>(null)

  const active = items.find((a) => a.id === activeId) ?? null

  const load = useCallback(async () => {
    try {
      const list = await window.api.automations.list()
      setItems(list)
      const running = await window.api.automations.running()
      setRunningIds(new Set(running))
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const offOutput = window.api.automations.onOutput((p) => {
      if (p.id !== activeId) return
      setLogs((prev) => [...prev, { text: p.chunk, isError: p.isError }].slice(-2000))
    })
    const offDone = window.api.automations.onDone((p) => {
      setRunningIds((prev) => {
        const next = new Set(prev)
        next.delete(p.id)
        return next
      })
      if (p.id === activeId) {
        setLogs((prev) => [
          ...prev,
          { text: `\n[进程结束] 退出码 ${p.exitCode ?? '未知'}`, isMeta: true }
        ].slice(-2000))
      }
    })
    return () => {
      offOutput()
      offDone()
    }
  }, [activeId])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])

  const openDetail = (id: string): void => {
    setActiveId(id)
    setLogs([])
  }

  // 外部跳转（Ctrl+K 搜索）指定打开某条自动化
  useEffect(() => {
    if (openAutomationId) openDetail(openAutomationId)
  }, [openAutomationId])

  // 外部触发「新建自动化」：打开新建弹窗
  useEffect(() => {
    if (openNew) {
      setEditing(null)
      form.resetFields()
      setModalOpen(true)
    }
  }, [openNew])

  const handleRun = async (): Promise<void> => {
    if (!active) return
    setLogs([])
    const ok = await window.api.automations.run(active.id)
    if (ok) {
      setRunningIds((prev) => new Set(prev).add(active.id))
    } else {
      message.warning('启动失败或已在运行')
    }
  }

  const handleStop = async (): Promise<void> => {
    if (!active) return
    await window.api.automations.stop(active.id)
  }

  const handleSubmit = async (values: AutomationInput): Promise<void> => {
    try {
      if (editing) {
        await window.api.automations.update({ ...editing, ...values })
        message.success('已保存')
      } else {
        await window.api.automations.add(values)
        message.success('已添加')
      }
      setModalOpen(false)
      setEditing(null)
      load()
    } catch {
      message.error('保存失败')
    }
  }

  const handleRemove = async (id: string): Promise<void> => {
    try {
      await window.api.automations.remove(id)
      if (activeId === id) setActiveId(null)
      message.success('已删除')
      load()
    } catch {
      message.error('删除失败')
    }
  }

  return (
    <div className="automations-page">
      <div className="automations-list">
        <div className="notes-list-header">
          <Typography.Text strong>自动化</Typography.Text>
          <Button
            type="text"
            size="small"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null)
              form.resetFields()
              setModalOpen(true)
            }}
            title="新建命令"
          />
        </div>
        <div className="automations-list-body">
          {loading ? (
            <Skeleton active paragraph={{ rows: 6 }} />
          ) : items.length === 0 ? (
            <Empty description="暂无命令" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <List
              dataSource={items}
              renderItem={(a) => (
                <List.Item
                  className={'automation-item' + (a.id === activeId ? ' active' : '')}
                  onClick={() => openDetail(a.id)}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="automation-item-name">{a.name}</div>
                    <div className="automation-item-cmd">{a.command}</div>
                  </div>
                  {runningIds.has(a.id) && <Tag color="processing">运行中</Tag>}
                  <Button
                    type="text"
                    size="small"
                    danger
                    aria-label="删除命令"
                    icon={<DeleteOutlined />}
                    onClick={(e) => {
                      e.stopPropagation()
                      handleRemove(a.id)
                    }}
                  />
                </List.Item>
              )}
            />
          )}
        </div>
      </div>

      <div className="automations-detail">
        {active ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <Typography.Title level={5} style={{ margin: 0, flex: 1 }}>
                {active.name}
              </Typography.Title>
              {runningIds.has(active.id) ? (
                <Button danger icon={<StopOutlined />} onClick={handleStop}>
                  停止
                </Button>
              ) : (
                <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleRun}>
                  运行
                </Button>
              )}
              <Button
                icon={<EditOutlined />}
                onClick={() => {
                  setEditing(active)
                  form.setFieldsValue({
                    name: active.name,
                    command: active.command,
                    cwd: active.cwd
                  })
                  setModalOpen(true)
                }}
              >
                编辑
              </Button>
              <Button
                icon={<ClearOutlined />}
                onClick={() => setLogs([])}
                disabled={logs.length === 0}
              >
                清空日志
              </Button>
            </div>

            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              命令
            </Typography.Text>
            <div className="automation-command-box">{active.command}</div>
            {active.cwd && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                工作目录：{active.cwd}
              </Typography.Text>
            )}

            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              输出
            </Typography.Text>
            <div className="automation-log" ref={logRef}>
              {logs.length === 0 ? (
                <span className="meta">（点击「运行」开始，输出将实时显示在这里）</span>
              ) : (
                logs.map((l, i) => (
                  <div key={i} className={l.isError ? 'err' : l.isMeta ? 'meta' : ''}>
                    {l.text}
                  </div>
                ))
              )}
            </div>
          </>
        ) : (
          <Empty style={{ marginTop: 120 }} description="选择左侧命令，或点击 + 新建" />
        )}
      </div>

      <Modal
        title={editing ? '编辑命令' : '新建命令'}
        open={modalOpen}
        onCancel={() => {
          setModalOpen(false)
          setEditing(null)
        }}
        onOk={() => form.submit()}
        okText="保存"
        cancelText="取消"
        width={520}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：清理临时文件" maxLength={30} />
          </Form.Item>
          <Form.Item name="command" label="命令" rules={[{ required: true, message: '请输入命令' }]}>
            <Input.TextArea
              placeholder="例如：del /q %TEMP%\*"
              autoSize={{ minRows: 2, maxRows: 4 }}
            />
          </Form.Item>
          <Form.Item name="cwd" label="工作目录（可选）">
            <Input placeholder="留空则使用用户目录" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
