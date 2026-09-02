import { useCallback, useMemo, useState } from 'react'
import {
  Button,
  Dropdown,
  Empty,
  Input,
  Popconfirm,
  Progress,
  Space,
  Tag,
  Tooltip,
  Typography,
  message
} from 'antd'
import {
  DeleteOutlined,
  DownOutlined,
  FileTextOutlined,
  FolderOutlined,
  MoreOutlined,
  PlusOutlined,
  RightOutlined
} from '@ant-design/icons'
import type { ChapterMeta, ChapterStatus, Volume } from '@shared/types'

/** 章节状态：标签文案与配色 */
export const STATUS_META: Record<ChapterStatus, { label: string; color: string }> = {
  outline: { label: '细纲', color: 'default' },
  draft: { label: '初稿', color: 'processing' },
  revised: { label: '已修订', color: 'cyan' },
  final: { label: '定稿', color: 'green' }
}

interface ChapterTreeProps {
  volumes: Volume[]
  chapters: ChapterMeta[]
  activeId: string | null
  onSelect: (chapterId: string) => void
  onCreateChapter: (volumeId: string) => void
  onCreateVolume: () => void
  onRemoveChapter: (chapterId: string) => void
  onRemoveVolume: (volumeId: string) => void
  /** 拖拽落位：目标卷 + 卷内插入位置 */
  onMoveChapter: (chapterId: string, toVolumeId: string, toIndex: number) => void
}

interface DragState {
  /** 正在拖动的章节 */
  chapterId: string | null
  /** 当前悬停的落点 */
  over: { volumeId: string; index: number } | null
}

/**
 * 章节树：按分卷分组，支持卷内与跨卷拖拽排序。
 *
 * 落点用「卷 id + 卷内插入位置」表达，而不是全局序号——跨卷移动时
 * 目标卷的插入位置才是作者真正关心的，全局序号在跨卷场景会算错。
 */
export default function ChapterTree({
  volumes,
  chapters,
  activeId,
  onSelect,
  onCreateChapter,
  onCreateVolume,
  onRemoveChapter,
  onRemoveVolume,
  onMoveChapter
}: ChapterTreeProps) {
  const [drag, setDrag] = useState<DragState>({ chapterId: null, over: null })
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [query, setQuery] = useState('')

  const byVolume = useMemo(() => {
    const map = new Map<string, ChapterMeta[]>()
    for (const v of volumes) map.set(v.id, [])
    for (const c of chapters) {
      const list = map.get(c.volumeId)
      if (list) list.push(c)
    }
    for (const list of map.values()) list.sort((a, b) => a.index - b.index)
    return map
  }, [volumes, chapters])

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    return new Set(
      chapters.filter((c) => c.title.toLowerCase().includes(q)).map((c) => c.id)
    )
  }, [chapters, query])

  const totalWords = useMemo(() => chapters.reduce((s, c) => s + c.wordCount, 0), [chapters])

  const toggleCollapse = useCallback((volumeId: string) => {
    setCollapsed((prev) => ({ ...prev, [volumeId]: !prev[volumeId] }))
  }, [])

  const handleDrop = useCallback(
    (volumeId: string, index: number) => {
      if (drag.chapterId) onMoveChapter(drag.chapterId, volumeId, index)
      setDrag({ chapterId: null, over: null })
    },
    [drag.chapterId, onMoveChapter]
  )

  if (volumes.length === 0) {
    return <Empty description="还没有分卷" />
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-color, rgba(128,128,128,.15))' }}>
        <Space style={{ width: '100%' }} size={6}>
          <Input.Search
            size="small"
            placeholder="搜索章节"
            aria-label="搜索章节"
            allowClear
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Tooltip title="新建分卷">
            <Button size="small" icon={<PlusOutlined />} onClick={onCreateVolume} />
          </Tooltip>
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12, marginTop: 6, display: 'block' }}>
          共 {chapters.length} 章 · 约 {totalWords.toLocaleString()} 字
        </Typography.Text>
      </div>

      <div
        role="tree"
        aria-label="作品章节树"
        style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 0' }}
      >
        {volumes.map((v) => {
          const list = byVolume.get(v.id) ?? []
          // 默认折叠全部分卷：长篇作品可达数百章，折叠后只渲染展开卷的章节，
          // 避免一次性生成数百个常驻 DOM 节点（大列表性能）。展开是单次点击。
          const isCollapsed = collapsed[v.id] ?? true
          const visible = matched ? list.filter((c) => matched.has(c.id)) : list
          const volWords = list.reduce((s, c) => s + c.wordCount, 0)

          return (
            <div key={v.id}>
              {/* 分卷头：同时是"放到该卷末尾"的落点 */}
              <div
                role="treeitem"
                aria-expanded={!isCollapsed}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    toggleCollapse(v.id)
                  } else if (e.key === 'ArrowRight' && isCollapsed) {
                    e.preventDefault()
                    toggleCollapse(v.id)
                  } else if (e.key === 'ArrowLeft' && !isCollapsed) {
                    e.preventDefault()
                    toggleCollapse(v.id)
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDrag((d) => ({ ...d, over: { volumeId: v.id, index: list.length } }))
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  handleDrop(v.id, list.length)
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '5px 8px',
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: 'pointer',
                  background:
                    drag.over?.volumeId === v.id
                      ? 'var(--ant-color-primary-bg, rgba(22,119,255,.08))'
                      : 'transparent'
                }}
              >
                <Button
                  type="text"
                  size="small"
                  style={{ padding: 0, width: 18, height: 18 }}
                  icon={isCollapsed ? <RightOutlined /> : <DownOutlined />}
                  onClick={() => toggleCollapse(v.id)}
                />
                <FolderOutlined style={{ opacity: 0.7 }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {v.title}
                </span>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {list.length}章/{volWords.toLocaleString()}字
                </Typography.Text>
                <Dropdown
                  trigger={['click']}
                  menu={{
                    items: [
                      { key: 'add', icon: <PlusOutlined />, label: '在此卷新建章节' },
                      { key: 'del', icon: <DeleteOutlined />, label: '删除分卷', danger: true }
                    ],
                    onClick: ({ key, domEvent }) => {
                      domEvent.stopPropagation()
                      if (key === 'add') onCreateChapter(v.id)
                      if (key === 'del') {
                        if (volumes.length <= 1) {
                          message.warning('至少要保留一个分卷')
                          return
                        }
                        onRemoveVolume(v.id)
                      }
                    }
                  }}
                >
                  <Button
                    type="text"
                    size="small"
                    aria-label="分卷操作菜单"
                    style={{ padding: 0, width: 18, height: 18 }}
                    icon={<MoreOutlined />}
                    onClick={(e) => e.stopPropagation()}
                  />
                </Dropdown>
              </div>

              {!isCollapsed && (
                <>
                  {visible.map((c, i) => {
                    const isOver = drag.over?.volumeId === v.id && drag.over.index === i
                    const st = STATUS_META[c.status]
                    return (
                      <div key={c.id}>
                        {/* 插入指示线 */}
                        {drag.chapterId && isOver && (
                          <div style={{ height: 2, background: 'var(--ant-color-primary, #1677ff)', margin: '0 8px' }} />
                        )}
                        <div
                          role="treeitem"
                          aria-selected={activeId === c.id}
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.target !== e.currentTarget) return
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              onSelect(c.id)
                            }
                          }}
                          draggable
                          onDragStart={() => setDrag({ chapterId: c.id, over: null })}
                          onDragEnd={() => setDrag({ chapterId: null, over: null })}
                          onDragOver={(e) => {
                            e.preventDefault()
                            setDrag((d) => ({ ...d, over: { volumeId: v.id, index: i } }))
                          }}
                          onDrop={(e) => {
                            e.preventDefault()
                            handleDrop(v.id, i)
                          }}
                          onClick={() => onSelect(c.id)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '5px 8px 5px 26px',
                            cursor: 'pointer',
                            fontSize: 13,
                            background:
                              activeId === c.id
                                ? 'var(--ant-color-primary-bg, rgba(22,119,255,.10))'
                                : 'transparent',
                            borderLeft:
                              activeId === c.id
                                ? '2px solid var(--ant-color-primary, #1677ff)'
                                : '2px solid transparent',
                            opacity: drag.chapterId === c.id ? 0.4 : 1
                          }}
                        >
                          <FileTextOutlined style={{ opacity: 0.5, fontSize: 12 }} />
                          <span
                            style={{
                              flex: 1,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap'
                            }}
                          >
                            {c.title}
                          </span>
                          <Tag color={st.color} style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: '16px' }}>
                            {st.label}
                          </Tag>
                          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                            {c.wordCount.toLocaleString()}
                          </Typography.Text>
                          {/* 删除章节不可逆（正文与版本快照一并清除），必须二次确认 */}
                          <Popconfirm
                            title={`删除「${c.title}」？`}
                            description="正文与该章的版本历史会一并删除，无法恢复。"
                            okText="删除"
                            okButtonProps={{ danger: true }}
                            cancelText="取消"
                            onConfirm={(e) => {
                              e?.stopPropagation()
                              onRemoveChapter(c.id)
                            }}
                            onCancel={(e) => e?.stopPropagation()}
                          >
                            <Button
                              type="text"
                              size="small"
                              danger
                              style={{ padding: 0, width: 18, height: 18, opacity: 0.6 }}
                              icon={<DeleteOutlined />}
                              onClick={(e) => e.stopPropagation()}
                            />
                          </Popconfirm>
                        </div>
                      </div>
                    )
                  })}
                  {/* 卷内末尾落点：拖到章节列表下方时追加到该卷最后 */}
                  {drag.chapterId && (
                    <div
                      style={{ height: 24 }}
                      onDragOver={(e) => {
                        e.preventDefault()
                        setDrag((d) => ({ ...d, over: { volumeId: v.id, index: list.length } }))
                      }}
                      onDrop={(e) => {
                        e.preventDefault()
                        handleDrop(v.id, list.length)
                      }}
                    />
                  )}
                  <Button
                    type="dashed"
                    size="small"
                    block
                    icon={<PlusOutlined />}
                    style={{ margin: '2px 8px 6px 26px', width: 'calc(100% - 34px)' }}
                    onClick={() => onCreateChapter(v.id)}
                  >
                    新建章节
                  </Button>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 作品进度条：目标字数达成情况 */
export function ProjectProgress({
  words,
  target,
  chapters
}: {
  words: number
  target: number
  chapters: number
}) {
  const pct = target > 0 ? Math.min(100, Math.round((words / target) * 100)) : 0
  return (
    <div style={{ padding: '8px 10px', borderTop: '1px solid var(--border-color, rgba(128,128,128,.15))' }}>
      {target > 0 ? (
        <>
          <Progress percent={pct} size="small" />
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {words.toLocaleString()} / {target.toLocaleString()} 字 · {chapters} 章
          </Typography.Text>
        </>
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {words.toLocaleString()} 字 · {chapters} 章（未设目标字数）
        </Typography.Text>
      )}
    </div>
  )
}
