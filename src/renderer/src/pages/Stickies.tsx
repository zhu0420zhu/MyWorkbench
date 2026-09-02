import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Badge,
  Button,
  Calendar,
  DatePicker,
  Empty,
  Form,
  Input,
  message,
  Modal,
  Radio,
  Skeleton,
  Segmented,
  Typography
} from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { DeleteOutlined, EditOutlined, PlayCircleOutlined, PlusOutlined, PushpinOutlined } from '@ant-design/icons'
import type { StickyNote, StickyNoteInput } from '@shared/types'

const COLORS = ['#fff3b0', '#bde0fe', '#c7f9cc', '#ffd6e0', '#e0c3fc']

interface StickyFormValues {
  title?: string
  content: string
  color: string
  date?: Dayjs
  command?: string
}

export default function Stickies() {
  const [items, setItems] = useState<StickyNote[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<'list' | 'calendar'>('list')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<StickyNote | null>(null)
  const [presetDate, setPresetDate] = useState<string | null>(null)
  const [form] = Form.useForm<StickyFormValues>()

  const load = useCallback(async () => {
    try {
      setItems(await window.api.stickies.list())
    } catch {
      message.error('加载便利贴失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleCreate = (date?: string): void => {
    setEditing(null)
    setPresetDate(date ?? null)
    form.resetFields()
    if (date) form.setFieldsValue({ date: dayjs(date) })
    setModalOpen(true)
  }

  const handleSubmit = async (values: StickyFormValues): Promise<void> => {
    try {
      const input: StickyNoteInput = {
        title: values.title?.trim() || '',
        content: values.content,
        color: values.color,
        pinned: editing?.pinned ?? false,
        date: values.date ? values.date.format('YYYY-MM-DD') : undefined,
        command: values.command?.trim() || undefined
      }
      if (editing) {
        await window.api.stickies.update({ ...editing, ...input })
        message.success('已保存')
      } else {
        await window.api.stickies.create(input)
        message.success('已创建')
      }
      setModalOpen(false)
      setEditing(null)
      load()
    } catch {
      message.error('保存失败')
    }
  }

  const handleRemove = (id: string): void => {
    const note = items.find((n) => n.id === id)
    // 项目约定：不可逆操作必须二次确认，并写明连带影响
    Modal.confirm({
      title: '删除这张便利贴？',
      content: note?.pinned
        ? '删除后内容不可恢复；该便利贴正在置顶悬浮，其悬浮窗也会一并关闭。'
        : '删除后内容不可恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await window.api.stickies.remove(id)
          message.success('已删除')
          load()
        } catch {
          message.error('删除失败')
        }
      }
    })
  }

  const handleStick = async (note: StickyNote): Promise<void> => {
    try {
      if (note.pinned) {
        await window.api.stickies.unstick(note.id)
        await window.api.stickies.update({ ...note, pinned: false })
      } else {
        const ok = await window.api.stickies.stick(note.id)
        if (ok) await window.api.stickies.update({ ...note, pinned: true })
        else message.warning('悬浮失败')
      }
      load()
    } catch {
      message.error('操作失败')
    }
  }

  const openEdit = (note: StickyNote): void => {
    setEditing(note)
    form.setFieldsValue({
      title: note.title,
      content: note.content,
      color: note.color,
      date: note.date ? dayjs(note.date) : undefined,
      command: note.command
    })
    setModalOpen(true)
  }

  const handleOpenProgram = async (note: StickyNote): Promise<void> => {
    if (!note.command?.trim()) return
    const pid = await window.api.runCommand(note.command)
    if (pid == null) message.warning('无法执行该命令，请检查程序路径')
  }

  /* 按日期预索引便利贴（避免日历每格重复 filter） */
  const notesByDate = useMemo(() => {
    const m = new Map<string, StickyNote[]>()
    for (const n of items) {
      if (!n.date) continue
      const list = m.get(n.date)
      if (list) list.push(n)
      else m.set(n.date, [n])
    }
    return m
  }, [items])

  const dateCellRender = (date: Dayjs): React.ReactNode => {
    const key = date.format('YYYY-MM-DD')
    const dayNotes = notesByDate.get(key) ?? []
    if (dayNotes.length === 0) return null
    return (
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {dayNotes.slice(0, 4).map((n) => (
          <li key={n.id} style={{ marginBottom: 2 }}>
            <Badge
              color={n.color === '#fff3b0' ? '#faad14' : n.color === '#bde0fe' ? '#1890ff' : n.color === '#c7f9cc' ? '#52c41a' : n.color === '#ffd6e0' ? '#eb2f96' : '#722ed1'}
              text={
                <Typography.Text
                  ellipsis
                  style={{ fontSize: 12, cursor: 'pointer', maxWidth: 140 }}
                  onClick={(e) => {
                    e.stopPropagation()
                    openEdit(n)
                  }}
                >
                  {n.title || n.content.slice(0, 8)}
                </Typography.Text>
              }
            />
          </li>
        ))}
      </ul>
    )
  }

  const datedNotes = items.filter((n) => n.date)
  const undatedNotes = items.filter((n) => !n.date)

  return (
    <div className="dashboard-page">
      <div className="page-header">
        <Typography.Title level={4} style={{ margin: 0 }}>
          便利贴
        </Typography.Title>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Segmented
            value={view}
            onChange={(v) => setView(v as 'list' | 'calendar')}
            options={[
              { label: '列表', value: 'list' },
              { label: '任务日历', value: 'calendar' }
            ]}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => handleCreate()}>
            新建便利贴
          </Button>
        </div>
      </div>

      {loading ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : view === 'calendar' ? (
        <div className="sticky-calendar-wrap">
          <Calendar
            dateCellRender={dateCellRender}
            onSelect={(d) => {
              const key = d.format('YYYY-MM-DD')
              const existing = (notesByDate.get(key) ?? [])[0]
              if (existing) openEdit(existing)
              else handleCreate(key)
            }}
          />
        </div>
      ) : items.length === 0 ? (
        <Empty style={{ marginTop: 80 }} description="还没有便利贴，点击右上角新建" />
      ) : (
        <div className="stickies-grid">
          {items.map((n) => (
            <div key={n.id} className="sticky-card" style={{ background: n.color }}>
              <div className="sticky-card-actions">
                {n.command?.trim() ? (
                  <Button
                    type="text"
                    size="small"
                    icon={<PlayCircleOutlined style={{ color: '#389e0d' }} />}
                    onClick={() => handleOpenProgram(n)}
                    title="打开关联程序"
                  />
                ) : null}
                <Button
                  type="text"
                  size="small"
                  icon={<PushpinOutlined style={{ color: n.pinned ? '#fa541c' : undefined }} />}
                  onClick={() => handleStick(n)}
                  title={n.pinned ? '取消置顶悬浮' : '置顶悬浮到桌面'}
                />
                <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openEdit(n)} title="编辑" />
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => handleRemove(n.id)}
                  title="删除"
                />
              </div>
              {n.title && <div className="sticky-card-title">{n.title}</div>}
              <div className="sticky-card-content">{n.content || '（空白）'}</div>
              <div className="sticky-card-time">
                {n.date ? `📅 ${n.date} · ` : ''}
                {formatTime(n.updatedAt)}
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        title={editing ? '编辑便利贴' : '新建便利贴'}
        open={modalOpen}
        onCancel={() => {
          setModalOpen(false)
          setEditing(null)
        }}
        onOk={() => form.submit()}
        okText="保存"
        cancelText="取消"
        width={480}
      >
        <Form form={form} layout="vertical" initialValues={{ color: COLORS[0] }} onFinish={handleSubmit}>
          <Form.Item name="title" label="标题（可选）">
            <Input placeholder="例如：今天待办" maxLength={40} />
          </Form.Item>
          <Form.Item name="content" label="内容" rules={[{ required: true, message: '请输入内容' }]}>
            <Input.TextArea
              placeholder="记录待办、提醒、灵感…"
              autoSize={{ minRows: 5, maxRows: 12 }}
              style={{ background: '#fffdf5' }}
            />
          </Form.Item>
          <Form.Item name="date" label="任务日期（可选，显示在任务日历）">
            <DatePicker style={{ width: '100%' }} placeholder="选择日期" />
          </Form.Item>
          <Form.Item
            name="command"
            label="关联程序（可选）"
            tooltip="填程序路径或命令，如 notepad.exe 或 C:\\MyApp\\app.exe。悬浮窗上会出现「打开程序」按钮。"
          >
            <Input placeholder="例如：notepad.exe" maxLength={300} />
          </Form.Item>
          <Form.Item name="color" label="颜色">
            <Radio.Group>
              {COLORS.map((c) => (
                <Radio.Button
                  key={c}
                  value={c}
                  style={{
                    width: 36,
                    height: 36,
                    padding: 0,
                    background: c,
                    border: 'none',
                    marginRight: 8,
                    borderRadius: 8
                  }}
                />
              ))}
            </Radio.Group>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
