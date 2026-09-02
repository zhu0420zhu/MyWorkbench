import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Avatar,
  Button,
  Empty,
  Input,
  List,
  Popconfirm,
  Space,
  Tag,
  Tooltip,
  Typography,
  message
} from 'antd'
import {
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  ImportOutlined,
  PlusOutlined,
  SearchOutlined,
  StarFilled,
  StarOutlined
} from '@ant-design/icons'
import type { CharacterMeta, CharCard } from './types'
import { EMPTY_CARD } from './types'

interface Props {
  selectedId: string | null
  onSelect: (id: string) => void
  onEdit: (meta: CharacterMeta) => void
}

function charInitial(card: CharCard): string {
  return (card.name || '?').slice(0, 1)
}

export default function CharacterLibrary({ selectedId, onSelect, onEdit }: Props) {
  const [chars, setChars] = useState<CharacterMeta[]>([])
  const [search, setSearch] = useState('')
  const [defaultId, setDefaultId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    try {
      const list = (await window.api.sillytavern.charsList()) as CharacterMeta[]
      setChars(list)
      setDefaultId((await window.api.sillytavern.charsDefaultGet()) as string | null)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return chars
    return chars.filter(
      (c) =>
        c.card.name.toLowerCase().includes(q) ||
        (c.card.tags ?? []).some((t) => t.toLowerCase().includes(q)) ||
        c.card.description.toLowerCase().includes(q)
    )
  }, [chars, search])

  const create = useCallback(async () => {
    const id = `char_${Date.now()}`
    await window.api.sillytavern.charsSave(id, EMPTY_CARD('新角色'))
    await refresh()
    const list = (await window.api.sillytavern.charsList()) as CharacterMeta[]
    const meta = list.find((c) => c.id === id)
    if (meta) onEdit(meta)
  }, [refresh, onEdit])

  const remove = useCallback(
    async (id: string) => {
      await window.api.sillytavern.charsDelete(id)
      if (selectedId === id) onSelect('')
      await refresh()
    },
    [refresh, selectedId, onSelect]
  )

  const toggleDefault = useCallback(
    async (id: string) => {
      const next = defaultId === id ? null : id
      await window.api.sillytavern.charsDefaultSet(next)
      setDefaultId(next)
    },
    [defaultId]
  )

  const importFile = useCallback(
    async (file: File) => {
      try {
        const buf = new Uint8Array(await file.arrayBuffer())
        const meta = (await window.api.sillytavern.charsImport(buf)) as CharacterMeta | null
        if (meta) {
          message.success(`已导入角色「${meta.card.name}」`)
        } else {
          message.error('无法解析该文件（需为 PNG 角色卡或 JSON 卡片）')
        }
        await refresh()
      } catch (e) {
        message.error('导入失败：' + (e as Error).message)
      }
    },
    [refresh]
  )

  const exportChar = useCallback(
    async (id: string, card: CharCard) => {
      try {
        const res = (await window.api.sillytavern.charsExport(id)) as { bytes: Uint8Array; isPng: boolean }
        await window.api.exportBuffer(`${card.name}.${res.isPng ? 'png' : 'json'}`, res.bytes)
      } catch (e) {
        message.error('导出失败：' + (e as Error).message)
      }
    },
    []
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '10px 12px', display: 'flex', gap: 8, flexDirection: 'column' }}>
        <Space style={{ width: '100%' }}>
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => void create()}>
            新建
          </Button>
          <Button size="small" icon={<ImportOutlined />} onClick={() => fileRef.current?.click()}>
            导入
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".png,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importFile(f)
              e.target.value = ''
            }}
          />
        </Space>
        <Input
          size="small"
          allowClear
          aria-label="搜索角色 / 标签"
          prefix={<SearchOutlined />}
          placeholder="搜索角色 / 标签"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px 8px' }}>
        {filtered.length === 0 ? (
          <Empty style={{ marginTop: 40 }} image={Empty.PRESENTED_IMAGE_SIMPLE} description={search ? '无匹配角色' : '还没有角色卡'} />
        ) : (
          <List
            size="small"
            dataSource={filtered}
            renderItem={(c) => {
              const active = c.id === selectedId
              return (
                <List.Item
                  onClick={() => onSelect(c.id)}
                  style={{
                    cursor: 'pointer',
                    padding: '6px 8px',
                    borderRadius: 8,
                    background: active ? 'rgba(22,119,255,.08)' : undefined,
                    border: active ? '1px solid rgba(22,119,255,.4)' : '1px solid transparent'
                  }}
                  actions={[
                    <Tooltip key="edit" title="编辑角色卡">
                      <Button size="small" type="text" icon={<EditOutlined />} onClick={(e) => { e.stopPropagation(); onEdit(c) }} />
                    </Tooltip>,
                    <Tooltip key="export" title="导出卡片">
                      <Button size="small" type="text" icon={<DownloadOutlined />} onClick={(e) => { e.stopPropagation(); void exportChar(c.id, c.card) }} />
                    </Tooltip>,
                    <Tooltip key="default" title={defaultId === c.id ? '取消默认' : '设为默认角色'}>
                      <Button
                        size="small"
                        type="text"
                        icon={defaultId === c.id ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined />}
                        onClick={(e) => { e.stopPropagation(); void toggleDefault(c.id) }}
                      />
                    </Tooltip>,
                    <Popconfirm
                      key="del"
                      title="删除该角色？"
                      onConfirm={(e) => { e?.stopPropagation(); void remove(c.id) }}
                      onCancel={(e) => e?.stopPropagation()}
                    >
                      <Button size="small" type="text" danger aria-label="删除该角色" icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
                    </Popconfirm>
                  ]}
                >
                  <List.Item.Meta
                    avatar={
                      <Avatar style={{ background: '#1677ff', flexShrink: 0 }} size={34}>
                        {charInitial(c.card)}
                      </Avatar>
                    }
                    title={
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Typography.Text ellipsis style={{ maxWidth: 120, fontSize: 13 }}>
                          {c.card.name || c.id}
                        </Typography.Text>
                        {defaultId === c.id && <Tag color="gold" style={{ margin: 0, fontSize: 10 }}>默认</Tag>}
                      </div>
                    }
                    description={
                      <Typography.Text type="secondary" ellipsis style={{ fontSize: 11, maxWidth: 150, display: 'block' }}>
                        {(c.card.tags ?? []).join(' · ') || c.card.description || '未填写描述'}
                      </Typography.Text>
                    }
                  />
                </List.Item>
              )
            }}
          />
        )}
      </div>
    </div>
  )
}
