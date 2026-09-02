import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Empty, Form, Input, message, Modal, Select, Skeleton, Space, Table, Tag, Typography } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined, TagsOutlined, ThunderboltOutlined } from '@ant-design/icons'
import type { CategoryRule, NoteMeta } from '@shared/types'

interface Props {
  onCategoriesChanged: (categories: string[]) => void
}

interface RuleFormValues {
  name: string
  keywords: string[]
  category: string
}

/** 智能分类面板：规则 CRUD + 分类维护 + 一键全量自动分类（手动调整过的笔记保持不动） */
export default function NoteRulesPanel({ onCategoriesChanged }: Props) {
  const [rules, setRules] = useState<CategoryRule[]>([])
  const [notes, setNotes] = useState<NoteMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<CategoryRule | null>(null)
  const [applying, setApplying] = useState(false)
  // 分类管理
  const [catModal, setCatModal] = useState(false)
  const [catRenameTarget, setCatRenameTarget] = useState<string | null>(null)
  const [catRenameValue, setCatRenameValue] = useState('')
  const [form] = Form.useForm<RuleFormValues>()

  const load = useCallback(async () => {
    try {
      const [list, noteList] = await Promise.all([window.api.notesFeature.rules.list(), window.api.notes.list()])
      setRules(list)
      setNotes(noteList)
      onCategoriesChanged([...new Set(list.map((r) => r.category))])
    } catch {
      message.error('加载分类规则失败')
    } finally {
      setLoading(false)
    }
  }, [onCategoriesChanged])

  useEffect(() => {
    void load()
  }, [load])

  // 分类使用统计：来自规则 + 笔记实际使用
  const catStats = useMemo(() => {
    const noteCount = new Map<string, number>()
    for (const n of notes) {
      const c = n.category
      if (c) noteCount.set(c, (noteCount.get(c) ?? 0) + 1)
    }
    const ruleCount = new Map<string, number>()
    for (const r of rules) ruleCount.set(r.category, (ruleCount.get(r.category) ?? 0) + 1)
    const all = new Set<string>([...noteCount.keys(), ...ruleCount.keys()])
    return [...all]
      .map((name) => ({
        name,
        notes: noteCount.get(name) ?? 0,
        rules: ruleCount.get(name) ?? 0
      }))
      .sort((a, b) => b.notes - a.notes)
  }, [notes, rules])

  /** 重命名分类：同步笔记 category + 引用该分类的规则 */
  const renameCategory = async (oldName: string): Promise<void> => {
    const newName = catRenameValue.trim()
    if (!newName || newName === oldName) return
    try {
      // 1) 同步规则
      for (const r of rules.filter((r) => r.category === oldName)) {
        await window.api.notesFeature.rules.update(r.id, { name: r.name, keywords: r.keywords, category: newName })
      }
      // 2) 同步笔记
      for (const n of notes.filter((n) => n.category === oldName)) {
        await window.api.notes.updateMeta(n.id, { category: newName })
      }
      await load()
      message.success(`分类「${oldName}」已重命名为「${newName}」`)
    } catch (err) {
      message.error('重命名失败：' + (err as Error).message)
    }
  }

  /** 删除分类：清空笔记分类 + 删除引用该分类的规则（提示影响范围） */
  const removeCategory = (name: string): void => {
    const stats = catStats.find((c) => c.name === name)
    Modal.confirm({
      title: '删除分类',
      content: `将清空 ${stats?.notes ?? 0} 篇笔记的该分类${(stats?.rules ?? 0) > 0 ? `，并删除 ${stats?.rules ?? 0} 条引用该分类的规则` : ''}。确定吗？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          for (const r of rules.filter((r) => r.category === name)) {
            await window.api.notesFeature.rules.remove(r.id)
          }
          for (const n of notes.filter((n) => n.category === name)) {
            await window.api.notes.updateMeta(n.id, { category: '', categorizedBy: 'manual' })
          }
          await load()
          message.success(`已删除分类「${name}」`)
        } catch (err) {
          message.error('删除失败：' + (err as Error).message)
        }
      }
    })
  }

  const openModal = (rule: CategoryRule | null): void => {
    setEditing(rule)
    form.setFieldsValue(rule ? { name: rule.name, keywords: rule.keywords, category: rule.category } : { name: '', keywords: [], category: '' })
    setModalOpen(true)
  }

  const handleSubmit = async (values: RuleFormValues): Promise<void> => {
    try {
      const list = editing
        ? await window.api.notesFeature.rules.update(editing.id, { name: values.name, keywords: values.keywords ?? [], category: values.category })
        : await window.api.notesFeature.rules.add({ name: values.name, keywords: values.keywords ?? [], category: values.category })
      setRules(list)
      onCategoriesChanged([...new Set(list.map((r) => r.category))])
      setModalOpen(false)
      message.success(editing ? '已保存' : '已添加')
    } catch (err) {
      message.error('保存失败：' + (err as Error).message)
    }
  }

  const handleRemove = (rule: CategoryRule): void => {
    Modal.confirm({
      title: '删除分类规则',
      content: `确定删除规则「${rule.name}」吗？已分配的自动分类不会自动清除。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const list = await window.api.notesFeature.rules.remove(rule.id)
        setRules(list)
        onCategoriesChanged([...new Set(list.map((r) => r.category))])
      }
    })
  }

  const apply = async (): Promise<void> => {
    Modal.confirm({
      title: '一键自动分类',
      content: '将按规则对全部笔记重新分类（规则未命中的自动分类会清空；你手动调整过的分类保持不变）。确定执行吗？',
      okText: '执行',
      cancelText: '取消',
      onOk: async () => {
        setApplying(true)
        try {
          const r = await window.api.notesFeature.rules.apply()
          message.success(`自动分类完成：更新 ${r.updated} 篇，新分类 ${r.classified} 篇`)
          onCategoriesChanged([...new Set(rules.map((x) => x.category))])
        } catch (err) {
          message.error('执行失败：' + (err as Error).message)
        } finally {
          setApplying(false)
        }
      }
    })
  }

  return (
    <div className="notes-feature-panel">
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openModal(null)}>
          新建规则
        </Button>
        <Button size="small" icon={<ThunderboltOutlined />} loading={applying} onClick={() => void apply()}>
          一键自动分类
        </Button>
        <Button size="small" icon={<TagsOutlined />} onClick={() => setCatModal(true)}>
          管理分类
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12, alignSelf: 'center' }}>
          规则按顺序匹配，内容含任一关键词即归入对应分类；在笔记编辑区可手动调整分类（手动优先）
        </Typography.Text>
      </div>

      {loading ? (
        <Skeleton active paragraph={{ rows: 4 }} />
      ) : rules.length === 0 ? (
        <Empty description="暂无分类规则，点击「新建规则」添加（如：工作 → 会议/周报/项目）" />
      ) : (
        <Table
          size="small"
          rowKey="id"
          dataSource={rules}
          pagination={false}
          style={{ maxWidth: 760 }}
          columns={[
            { title: '规则名', dataIndex: 'name', width: 160 },
            {
              title: '分类',
              dataIndex: 'category',
              width: 140,
              render: (v: string) => <Tag color="geekblue">{v}</Tag>
            },
            {
              title: '关键词',
              dataIndex: 'keywords',
              render: (keywords: string[]) =>
                keywords.length > 0 ? (
                  <Space size={4} wrap>
                    {keywords.map((k) => (
                      <Tag key={k} style={{ marginRight: 0 }}>{k}</Tag>
                    ))}
                  </Space>
                ) : (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>—</Typography.Text>
                )
            },
            {
              title: '操作',
              width: 110,
              render: (_v, r) => (
                <Space size={4}>
                  <Button size="small" aria-label="编辑规则" icon={<EditOutlined />} onClick={() => openModal(r)} />
                  <Button size="small" danger aria-label="删除规则" icon={<DeleteOutlined />} onClick={() => handleRemove(r)} />
                </Space>
              )
            }
          ]}
        />
      )}

      <Modal
        title={editing ? '编辑规则' : '新建规则'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        okText="保存"
        cancelText="取消"
        width={460}
      >
        <Form form={form} layout="vertical" onFinish={(v) => void handleSubmit(v)}>
          <Form.Item name="name" label="规则名称" rules={[{ required: true, message: '请输入规则名称' }]}>
            <Input maxLength={30} placeholder="如：工作相关" />
          </Form.Item>
          <Form.Item name="keywords" label="关键词（内容含任一即归入该分类）" rules={[{ required: true, message: '至少一个关键词' }]}>
            <Select mode="tags" placeholder="输入关键词后回车，如：会议 / 周报 / 项目" open={false} suffixIcon={null} />
          </Form.Item>
          <Form.Item name="category" label="分类名称" rules={[{ required: true, message: '请输入分类名称' }]}>
            <Input maxLength={20} placeholder="如：工作" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 分类管理：聚合全部分类，支持重命名/删除（同步笔记与规则） */}
      <Modal
        title="管理分类"
        open={catModal}
        onCancel={() => setCatModal(false)}
        footer={null}
        width={480}
      >
        {catStats.length === 0 ? (
          <Empty description="暂无分类。可在规则中新建，或直接在笔记编辑区输入新分类名" style={{ padding: 24 }} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {catStats.map((c) => (
              <div
                key={c.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--border-color, rgba(128,128,128,.2))'
                }}
              >
                <Tag color="geekblue" style={{ margin: 0 }}>
                  {c.name}
                </Tag>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {c.notes} 篇笔记{c.rules > 0 ? ` · ${c.rules} 条规则` : ''}
                </Typography.Text>
                <div style={{ flex: 1 }} />
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  title="重命名"
                  onClick={() => {
                    setCatRenameTarget(c.name)
                    setCatRenameValue(c.name)
                  }}
                />
                <Button type="text" size="small" danger icon={<DeleteOutlined />} title="删除" onClick={() => removeCategory(c.name)} />
              </div>
            ))}
          </div>
        )}
      </Modal>

      <Modal
        title="重命名分类"
        open={!!catRenameTarget}
        onCancel={() => setCatRenameTarget(null)}
        onOk={() => {
          if (catRenameTarget) void renameCategory(catRenameTarget)
          setCatRenameTarget(null)
        }}
        okText="重命名"
        cancelText="取消"
        width={360}
      >
        <Input value={catRenameValue} aria-label="新分类名称" onChange={(e) => setCatRenameValue(e.target.value)} placeholder="新分类名称" onPressEnter={() => {
          if (catRenameTarget) void renameCategory(catRenameTarget)
          setCatRenameTarget(null)
        }} />
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          将同步更新所有使用该分类的笔记与分类规则。
        </Typography.Text>
      </Modal>
    </div>
  )
}
