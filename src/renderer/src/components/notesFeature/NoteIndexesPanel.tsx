import { useCallback, useEffect, useState } from 'react'
import { Button, DatePicker, Empty, Form, Input, message, Modal, Select, Skeleton, Space, Table, Tag, Typography } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import type { IndexHit, NoteIndexTable, NoteTag } from '@shared/types'

interface Props {
  onOpenNote: (id: string) => void
}

interface TableFormValues {
  name: string
  keywords?: string[]
  tags?: string[]
  range?: [Dayjs, Dayjs]
}

/** 检索表面板：自定义索引表 CRUD + 按关键词/标签/日期生成内容索引 */
export default function NoteIndexesPanel({ onOpenNote }: Props) {
  const [tables, setTables] = useState<NoteIndexTable[]>([])
  const [allTags, setAllTags] = useState<NoteTag[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<NoteIndexTable | null>(null)
  const [buildingId, setBuildingId] = useState<string | null>(null)
  const [hits, setHits] = useState<IndexHit[] | null>(null)
  const [form] = Form.useForm<TableFormValues>()

  const load = useCallback(async () => {
    try {
      const [t, tags] = await Promise.all([window.api.notesFeature.indexes.list(), window.api.notesFeature.tags.list()])
      setTables(t)
      setAllTags(tags)
    } catch {
      message.error('加载检索表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openModal = (table: NoteIndexTable | null): void => {
    setEditing(table)
    form.setFieldsValue({
      name: table?.name ?? '',
      keywords: table?.keywords ?? [],
      tags: table?.tags ?? [],
      range: table?.dateFrom || table?.dateTo ? [dayjs(table.dateFrom ?? Date.now() - 30 * 864e5), dayjs(table.dateTo ?? Date.now())] : undefined
    })
    setModalOpen(true)
  }

  const handleSubmit = async (values: TableFormValues): Promise<void> => {
    const input = {
      name: values.name,
      keywords: values.keywords ?? [],
      tags: values.tags ?? [],
      dateFrom: values.range?.[0]?.startOf('day').valueOf(),
      dateTo: values.range?.[1]?.endOf('day').valueOf()
    }
    try {
      const list = editing ? await window.api.notesFeature.indexes.update(editing.id, input) : await window.api.notesFeature.indexes.add(input)
      setTables(list)
      setModalOpen(false)
      setHits(null)
      message.success(editing ? '已保存' : '已创建')
    } catch (err) {
      message.error('保存失败：' + (err as Error).message)
    }
  }

  const handleRemove = (table: NoteIndexTable): void => {
    Modal.confirm({
      title: '删除检索表',
      content: `确定删除「${table.name}」吗？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const list = await window.api.notesFeature.indexes.remove(table.id)
        setTables(list)
        if (hits) setHits(null)
      }
    })
  }

  const build = async (table: NoteIndexTable): Promise<void> => {
    setBuildingId(table.id)
    try {
      const result = await window.api.notesFeature.indexes.build(table.id)
      setHits(result)
    } catch (err) {
      message.error('生成索引失败：' + (err as Error).message)
    } finally {
      setBuildingId(null)
    }
  }

  return (
    <div className="notes-feature-panel">
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openModal(null)}>
          新建检索表
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12, alignSelf: 'center' }}>
          按关键词 / 标签 / 日期维度索引笔记，生成后点击结果可直达笔记
        </Typography.Text>
      </div>

      {loading ? (
        <Skeleton active paragraph={{ rows: 4 }} />
      ) : tables.length === 0 ? (
        <Empty description="暂无检索表，点击「新建检索表」创建" />
      ) : (
        <Table
          size="small"
          rowKey="id"
          dataSource={tables}
          pagination={false}
          columns={[
            { title: '名称', dataIndex: 'name', width: 160 },
            {
              title: '维度',
              render: (_v, t) => {
                const dims = [
                  t.keywords?.length ? `关键词 ${t.keywords.length}` : null,
                  t.tags?.length ? `标签 ${t.tags.length}` : null,
                  t.dateFrom ? '日期范围' : null
                ].filter(Boolean)
                return <Typography.Text style={{ fontSize: 12 }}>{dims.join(' · ') || '—'}</Typography.Text>
              }
            },
            {
              title: '操作',
              width: 220,
              render: (_v, t) => (
                <Space size={4}>
                  <Button size="small" icon={<ThunderboltOutlined />} loading={buildingId === t.id} onClick={() => void build(t)}>
                    生成索引
                  </Button>
                  <Button size="small" aria-label="编辑检索表" icon={<EditOutlined />} onClick={() => openModal(t)} />
                  <Button size="small" danger aria-label="删除检索表" icon={<DeleteOutlined />} onClick={() => handleRemove(t)} />
                </Space>
              )
            }
          ]}
        />
      )}

      {hits && (
        <div style={{ marginTop: 16 }}>
          <Typography.Text strong style={{ fontSize: 13 }}>
            索引结果（{hits.length} 篇命中）
          </Typography.Text>
          {hits.length === 0 ? (
            <Empty description="没有笔记命中该检索表条件" style={{ padding: 24 }} />
          ) : (
            <Table
              size="small"
              rowKey="noteId"
              dataSource={hits}
              style={{ marginTop: 8 }}
              pagination={{ pageSize: 20, size: 'small', hideOnSinglePage: true }}
              columns={[
                {
                  title: '标题',
                  dataIndex: 'title',
                  ellipsis: true,
                  render: (v: string, h) => (
                    <Typography.Link onClick={() => onOpenNote(h.noteId)}>{v}</Typography.Link>
                  )
                },
                { title: '分类', dataIndex: 'category', width: 100, render: (v?: string) => (v ? <Tag color="geekblue">{v}</Tag> : <Typography.Text type="secondary" style={{ fontSize: 12 }}>未分类</Typography.Text>) },
                { title: '标签', dataIndex: 'tags', width: 180, render: (tags: string[]) => (tags.length > 0 ? tags.map((t) => <Tag key={t} style={{ marginRight: 4 }}>{t}</Tag>) : '—') },
                {
                  title: '命中',
                  render: (_v, h) => (
                    <Space size={4} wrap>
                      {h.matchedKeywords.map((k) => <Tag key={k} color="orange" style={{ marginRight: 0 }}>{k}</Tag>)}
                      {h.matchedTags.map((t) => <Tag key={t} color="purple" style={{ marginRight: 0 }}>{t}</Tag>)}
                    </Space>
                  )
                },
                {
                  title: '更新时间',
                  dataIndex: 'updatedAt',
                  width: 140,
                  render: (v: number) => new Date(v).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
                }
              ]}
            />
          )}
        </div>
      )}

      <Modal
        title={editing ? '编辑检索表' : '新建检索表'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        okText="保存"
        cancelText="取消"
        width={480}
      >
        <Form form={form} layout="vertical" onFinish={(v) => void handleSubmit(v)}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input maxLength={40} placeholder="如：项目待办索引" />
          </Form.Item>
          <Form.Item name="keywords" label="关键词（内容含任一即命中）">
            <Select mode="tags" placeholder="输入关键词后回车，如：会议 / 待办" open={false} suffixIcon={null} />
          </Form.Item>
          <Form.Item name="tags" label="标签（笔记含任一即命中）">
            <Select mode="multiple" placeholder="选择标签" options={allTags.map((t) => ({ label: t.name, value: t.name }))} allowClear />
          </Form.Item>
          <Form.Item name="range" label="日期范围（可选）">
            <DatePicker.RangePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
