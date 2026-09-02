import { useCallback, useEffect, useState } from 'react'
import { Button, Empty, Input, message, Modal, Skeleton, Tag, Typography } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import type { NoteMeta, NoteTag } from '@shared/types'

interface Props {
  onFilterTag: (name: string) => void
  onTagsChanged: () => void
}

/** 标签管理面板：标签云 + 标签 CRUD（重命名/删除会同步到所有笔记） */
export default function NoteTagsPanel({ onFilterTag, onTagsChanged }: Props) {
  const [tags, setTags] = useState<NoteTag[]>([])
  const [notes, setNotes] = useState<NoteMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [renameTarget, setRenameTarget] = useState<NoteTag | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const load = useCallback(async () => {
    try {
      const [t, n] = await Promise.all([window.api.notesFeature.tags.list(), window.api.notes.list()])
      setTags(t)
      setNotes(n)
    } catch {
      message.error('加载标签失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const countMap = new Map<string, number>()
  for (const n of notes) {
    for (const t of n.tags ?? []) countMap.set(t, (countMap.get(t) ?? 0) + 1)
  }
  // 未被笔记使用的标签也展示（计数 0）
  for (const t of tags) if (!countMap.has(t.name)) countMap.set(t.name, 0)

  const cloud = [...countMap.entries()].sort((a, b) => b[1] - a[1])
  const maxCount = Math.max(1, ...cloud.map(([, c]) => c))

  const handleAdd = async (): Promise<void> => {
    const name = newName.trim()
    if (!name) return
    const list = await window.api.notesFeature.tags.add(name)
    setTags(list)
    setNewName('')
    onTagsChanged()
    message.success('已添加标签')
  }

  const handleRename = async (): Promise<void> => {
    if (!renameTarget) return
    const value = renameValue.trim()
    if (!value) return
    const list = await window.api.notesFeature.tags.rename(renameTarget.name, value)
    setTags(list)
    setRenameTarget(null)
    onTagsChanged()
    message.success('已重命名并同步到笔记')
  }

  const handleRemove = (tag: NoteTag): void => {
    const affected = countMap.get(tag.name) ?? 0
    Modal.confirm({
      title: '删除标签',
      content: affected > 0 ? `将删除标签「${tag.name}」并从 ${affected} 篇笔记中移除。确定吗？` : `确定删除标签「${tag.name}」吗？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const list = await window.api.notesFeature.tags.remove(tag.name)
        setTags(list)
        onTagsChanged()
        message.success('已删除')
      }
    })
  }

  return (
    <div className="notes-feature-panel">
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <Input
          size="small"
          style={{ width: 220 }}
          placeholder="新标签名称"
          aria-label="新标签名称"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onPressEnter={() => void handleAdd()}
        />
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => void handleAdd()}>
          添加标签
        </Button>
      </div>

      {loading ? (
        <Skeleton active paragraph={{ rows: 4 }} />
      ) : cloud.length === 0 ? (
        <Empty description="暂无标签，在笔记编辑区为笔记添加标签后，这里会生成标签云" />
      ) : (
        <>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
            标签云（字号表示使用频率，点击可筛选笔记）
          </Typography.Text>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 16 }}>
            {cloud.map(([name, count]) => {
              const size = count === 0 ? 12 : 12 + Math.round((count / maxCount) * 10)
              return (
                <Tag
                  key={name}
                  style={{ fontSize: size, cursor: 'pointer', padding: '4px 10px', borderRadius: 12 }}
                  color={count > 0 ? 'processing' : 'default'}
                  onClick={() => onFilterTag(name)}
                >
                  {name} ({count})
                </Tag>
              )
            })}
          </div>

          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
            全部标签（管理）
          </Typography.Text>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 560 }}>
            {cloud.map(([name, count]) => (
              <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderRadius: 8, border: '1px solid var(--border-color, rgba(128,128,128,.2))' }}>
                <Tag style={{ margin: 0 }}>{name}</Tag>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {count} 篇
                </Typography.Text>
                <div style={{ flex: 1 }} />
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  title="重命名"
                  onClick={() => {
                    setRenameTarget(tags.find((t) => t.name === name) ?? { name, createdAt: 0 })
                    setRenameValue(name)
                  }}
                />
                <Button type="text" size="small" danger icon={<DeleteOutlined />} title="删除" onClick={() => handleRemove({ name, createdAt: 0 })} />
              </div>
            ))}
          </div>
        </>
      )}

      <Modal
        title="重命名标签"
        open={!!renameTarget}
        onCancel={() => setRenameTarget(null)}
        onOk={() => void handleRename()}
        okText="重命名"
        cancelText="取消"
        width={380}
      >
        <Input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          placeholder="新标签名称"
          aria-label="新标签名称"
          onPressEnter={() => void handleRename()}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          重命名会同步更新所有引用该标签的笔记。
        </Typography.Text>
      </Modal>
    </div>
  )
}
