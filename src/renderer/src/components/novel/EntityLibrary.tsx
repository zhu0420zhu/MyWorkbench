/**
 * 设定库面板（右栏「设定库」标签页）
 *
 * 三件事：
 *  1. 六类实体卡的增删改查 + 别名维护（别名决定上下文能不能召回对）
 *  2. 动态状态：随章节推进的"当前处境"，写第 N 章时只取截至本章的最新状态
 *  3. 实体关系网（在关系图弹窗里连边）
 *
 * **为什么列表页要显示"本章出场次数"**：设定库最容易烂尾的地方是"建了一堆卡但写章时
 * 根本不用"。把识别结果直接标在列表上，作者一眼能看出哪张卡是死的、哪张卡漏了别名。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Dropdown,
  Empty,
  Input,
  List,
  Popconfirm,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message
} from 'antd'
import {
  ApartmentOutlined,
  PlusOutlined,
  PushpinOutlined,
  SearchOutlined
} from '@ant-design/icons'
import type { ChapterMeta, EntityKind, EntityMeta, EntityMention } from '@shared/types'
import { ENTITY_KIND_META } from '@shared/types'
import EntityDrawer from './EntityDrawer'
import RelationGraph from './RelationGraph'

interface EntityLibraryProps {
  projectId: string
  /** 当前章节：新建动态状态时默认挂在此章 */
  chapterId: string | null
  /** 当前章节标题（抽屉里显示用） */
  chapterTitle: string
  /** 当前章节正文：识别"本章出场实体" */
  chapterContent: string
  /** 全部分卷章节：动态状态要选"从哪一章起生效" */
  chapters: ChapterMeta[]
}

const KINDS: EntityKind[] = ['character', 'location', 'faction', 'item', 'concept', 'event']

export default function EntityLibrary({
  projectId,
  chapterId,
  chapterTitle,
  chapterContent,
  chapters
}: EntityLibraryProps) {
  const [entities, setEntities] = useState<EntityMeta[]>([])
  const [mentions, setMentions] = useState<EntityMention[]>([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [kindFilter, setKindFilter] = useState<EntityKind | 'all'>('all')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [graphOpen, setGraphOpen] = useState(false)

  // 组件卸载后不再 setState：切作品/切章节时旧的识别请求可能晚到
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.api.novel.listEntities(projectId)
      if (aliveRef.current) setEntities(list)
    } catch {
      if (aliveRef.current) message.error('设定库加载失败')
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [projectId])

  // 切作品重置筛选与选中，避免沿用上一部的设定
  const [loadedProject, setLoadedProject] = useState('')
  if (projectId !== loadedProject) {
    setLoadedProject(projectId)
    setKindFilter('all')
    setKeyword('')
    setEditingId(null)
  }

  useEffect(() => {
    void load()
  }, [load])

  // 正文识别防抖 600ms：别在作者每敲一个字时就扫一遍全文
  useEffect(() => {
    if (!projectId || !chapterContent) {
      setMentions([])
      return
    }
    const timer = window.setTimeout(() => {
      void window.api.novel
        .detectMentions(projectId, chapterContent)
        .then((r) => {
          if (aliveRef.current) setMentions(r)
        })
        .catch(() => undefined)
    }, 600)
    return () => window.clearTimeout(timer)
  }, [projectId, chapterContent])

  const mentionMap = useMemo(() => {
    const m = new Map<string, EntityMention>()
    for (const x of mentions) m.set(x.entityId, x)
    return m
  }, [mentions])

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return entities
      .filter((e) => (kindFilter === 'all' ? true : e.kind === kindFilter))
      .filter((e) => {
        if (!kw) return true
        return (
          e.name.toLowerCase().includes(kw) ||
          e.tagline.toLowerCase().includes(kw) ||
          e.aliases.some((a) => a.toLowerCase().includes(kw))
        )
      })
      // 钉住的在前，其次按本章出场次数，最后按手动排序
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        const ca = mentionMap.get(a.id)?.count ?? 0
        const cb = mentionMap.get(b.id)?.count ?? 0
        if (ca !== cb) return cb - ca
        return a.index - b.index
      })
  }, [entities, kindFilter, keyword, mentionMap])

  const handleCreate = useCallback(
    async (kind: EntityKind) => {
      const created = await window.api.novel.createEntity({
        projectId,
        kind,
        name: `新的${ENTITY_KIND_META[kind].label}`,
        firstChapterId: chapterId ?? undefined
      })
      if (!created) {
        message.error('创建失败')
        return
      }
      await load()
      setEditingId(created.id)
    },
    [projectId, chapterId, load]
  )

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await window.api.novel.removeEntity(projectId, id)
        setEntities((prev) => prev.filter((e) => e.id !== id))
        if (editingId === id) setEditingId(null)
        message.success('已删除')
      } catch {
        message.error('删除失败')
      }
    },
    [projectId, editingId]
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Space size={4} style={{ width: '100%' }}>
          <Input
            aria-label="搜索名称 / 别名"
            size="small"
            allowClear
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索名称 / 别名"
            prefix={<SearchOutlined style={{ opacity: 0.45 }} />}
          />
          <Dropdown
            trigger={['click']}
            menu={{
              items: KINDS.map((k) => ({ key: k, label: ENTITY_KIND_META[k].label })),
              onClick: ({ key }) => void handleCreate(key as EntityKind)
            }}
          >
            <Button size="small" type="primary" aria-label="新建实体" icon={<PlusOutlined />} />
          </Dropdown>
          <Tooltip title="关系图">
            <Button size="small" icon={<ApartmentOutlined />} onClick={() => setGraphOpen(true)} />
          </Tooltip>
        </Space>

        <Space size={2} wrap>
          <Tag.CheckableTag
            checked={kindFilter === 'all'}
            onChange={() => setKindFilter('all')}
            style={{ fontSize: 11, marginInlineEnd: 0 }}
          >
            全部 {entities.length}
          </Tag.CheckableTag>
          {KINDS.map((k) => {
            const n = entities.filter((e) => e.kind === k).length
            if (!n) return null
            return (
              <Tag.CheckableTag
                key={k}
                checked={kindFilter === k}
                onChange={() => setKindFilter(kindFilter === k ? 'all' : k)}
                style={{ fontSize: 11, marginInlineEnd: 0 }}
              >
                {ENTITY_KIND_META[k].label} {n}
              </Tag.CheckableTag>
            )
          })}
        </Space>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px 8px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin size="small" />
          </div>
        ) : filtered.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span style={{ fontSize: 12 }}>
                {entities.length === 0 ? '还没有设定卡' : '没有匹配的设定卡'}
              </span>
            }
          >
            {entities.length === 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                点右上角 + 建立人物 / 地点 / 势力…
              </Typography.Text>
            )}
          </Empty>
        ) : (
          <List
            size="small"
            dataSource={filtered}
            renderItem={(e) => {
              const hit = mentionMap.get(e.id)
              return (
                <List.Item
                  onClick={() => setEditingId(e.id)}
                  style={{
                    cursor: 'pointer',
                    padding: '6px 8px',
                    borderRadius: 6,
                    background: editingId === e.id ? 'var(--hover-bg, rgba(0,0,0,.04))' : undefined
                  }}
                  actions={[
                    <Popconfirm
                      key="del"
                      title={`删除「${e.name}」？`}
                      description="相关关系与动态状态会一并清除。"
                      okText="删除"
                      okButtonProps={{ danger: true }}
                      cancelText="取消"
                      onConfirm={() => void handleDelete(e.id)}
                      onCancel={(ev) => ev?.stopPropagation()}
                    >
                      <Button
                        size="small"
                        type="text"
                        danger
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        删除
                      </Button>
                    </Popconfirm>
                  ]}
                >
                  <List.Item.Meta
                    style={{ alignItems: 'flex-start' }}
                    title={
                      <Space size={4} style={{ flexWrap: 'wrap' }}>
                        {e.pinned && <PushpinOutlined style={{ fontSize: 11, opacity: 0.6 }} />}
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{e.name}</span>
                        <Tag
                          color={ENTITY_KIND_META[e.kind].color}
                          style={{ fontSize: 10, lineHeight: '16px', marginInlineEnd: 0 }}
                        >
                          {ENTITY_KIND_META[e.kind].label}
                        </Tag>
                        {hit && hit.count > 0 && (
                          <Tooltip title={`本章出现 ${hit.count} 次（命中「${hit.matched}」）`}>
                            <Tag style={{ fontSize: 10, lineHeight: '16px', marginInlineEnd: 0 }}>
                              本章 {hit.count}
                            </Tag>
                          </Tooltip>
                        )}
                      </Space>
                    }
                    description={
                      e.tagline ? (
                        <Typography.Text
                          type="secondary"
                          style={{ fontSize: 11 }}
                          ellipsis={{ tooltip: e.tagline }}
                        >
                          {e.tagline}
                        </Typography.Text>
                      ) : (
                        <Typography.Text type="secondary" style={{ fontSize: 11, opacity: 0.6 }}>
                          未填写简介
                        </Typography.Text>
                      )
                    }
                  />
                </List.Item>
              )
            }}
          />
        )}
      </div>

      <EntityDrawer
        projectId={projectId}
        entityId={editingId}
        entities={entities}
        chapters={chapters}
        chapterId={chapterId}
        chapterTitle={chapterTitle}
        onClose={() => setEditingId(null)}
        onSaved={(m) => {
          setEntities((prev) => {
            const i = prev.findIndex((x) => x.id === m.id)
            if (i < 0) return [...prev, m]
            const next = [...prev]
            next[i] = m
            return next
          })
        }}
      />

      <RelationGraph
        projectId={projectId}
        entities={entities}
        open={graphOpen}
        onClose={() => setGraphOpen(false)}
        onOpenEntity={(id) => {
          setGraphOpen(false)
          setEditingId(id)
        }}
        onChanged={() => void load()}
      />
    </div>
  )
}
