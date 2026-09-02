import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Empty, Input, List, message, Modal, Skeleton, Typography } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { Tldraw, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'
import type { BoardMeta } from '@shared/types'

export default function Boards({ openBoardId }: { openBoardId?: string }) {
  const [boards, setBoards] = useState<BoardMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const editorRef = useRef<Editor | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const titleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const active = boards.find((b) => b.id === activeId) ?? null

  useEffect(() => {
    window.api.boards
      .list()
      .then(setBoards)
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (openBoardId) setActiveId(openBoardId)
  }, [openBoardId])

  useEffect(() => {
    const b = boards.find((x) => x.id === activeId)
    setTitle(b?.title ?? '')
  }, [activeId, boards])

  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  const loadSnapshotToEditor = useCallback((id: string): void => {
    window.api.boards.get(id).then((snap) => {
      const ed = editorRef.current
      if (!ed || !snap) return
      try {
        ed.loadSnapshot(snap as never)
        ed.clearHistory()
      } catch {
        /* 快照不兼容时忽略 */
      }
    })
  }, [])

  const onMount = useCallback(
    (editor: Editor) => {
      editorRef.current = editor
      if (activeIdRef.current) loadSnapshotToEditor(activeIdRef.current)

      const unsub = editor.store.listen(() => {
        clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => {
          const ed = editorRef.current
          const bid = activeIdRef.current
          if (ed && bid) {
            window.api.boards.save(bid, ed.getSnapshot())
          }
        }, 600)
      })
      return () => {
        unsub()
        clearTimeout(saveTimer.current)
      }
    },
    [loadSnapshotToEditor]
  )

  const switchBoard = (id: string): void => {
    setActiveId(id)
    loadSnapshotToEditor(id)
  }

  const handleCreate = async (): Promise<void> => {
    try {
      const list = await window.api.boards.create('新白板')
      setBoards(list)
      if (list.length > 0) switchBoard(list[0].id)
    } catch {
      message.error('创建失败')
    }
  }

  const handleRemove = async (id: string): Promise<void> => {
    const b = boards.find((x) => x.id === id)
    Modal.confirm({
      title: '删除白板',
      content: `确定删除「${b?.title ?? '该白板'}」吗？画布内容将不可恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const list = await window.api.boards.remove(id)
          setBoards(list)
          if (activeId === id) setActiveId(null)
          message.success('已删除')
        } catch {
          message.error('删除失败')
        }
      }
    })
  }

  const handleTitleChange = (value: string): void => {
    setTitle(value)
    if (!activeId) return
    clearTimeout(titleTimer.current)
    titleTimer.current = setTimeout(() => {
      window.api.boards.rename(activeId, value)
      setBoards((prev) =>
        prev.map((b) => (b.id === activeId ? { ...b, title: value.trim() || '未命名白板' } : b))
      )
    }, 500)
  }

  return (
    <div className="boards-page">
      <div className="boards-list">
        <div className="notes-list-header">
          <Typography.Text strong>白板</Typography.Text>
          <Button
            type="text"
            size="small"
            icon={<PlusOutlined />}
            onClick={handleCreate}
            title="新建白板"
          />
        </div>
        <div className="automations-list-body">
          {loading ? (
            <Skeleton active paragraph={{ rows: 6 }} />
          ) : boards.length === 0 ? (
            <Empty description="暂无白板" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <List
              dataSource={boards}
              renderItem={(b) => (
                <List.Item
                  className={'automation-item' + (b.id === activeId ? ' active' : '')}
                  onClick={() => switchBoard(b.id)}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="automation-item-name">{b.title}</div>
                    <div className="automation-item-cmd">更新于 {formatTime(b.updatedAt)}</div>
                  </div>
                  <Button
                    type="text"
                    size="small"
                    danger
                    aria-label="删除白板"
                    icon={<DeleteOutlined />}
                    onClick={(e) => {
                      e.stopPropagation()
                      handleRemove(b.id)
                    }}
                  />
                </List.Item>
              )}
            />
          )}
        </div>
      </div>

      <div className="boards-canvas">
        {active ? (
          <>
            <div className="boards-toolbar">
              <Input
                aria-label="白板标题"
                value={title}
                onChange={(e) => handleTitleChange(e.target.value)}
                placeholder="白板标题"
                style={{ width: 220, fontWeight: 600 }}
                size="small"
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                自动保存 · 无限画布（框选 / 画笔 / 便签 / 连线…）
              </Typography.Text>
            </div>
            <div className="boards-tldraw">
              <Tldraw onMount={onMount} />
            </div>
          </>
        ) : (
          <Empty style={{ marginTop: 120 }} description="选择左侧白板，或点击 + 新建" />
        )}
      </div>
    </div>
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
