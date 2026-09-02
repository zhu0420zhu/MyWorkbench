import { useCallback, useEffect, useState } from 'react'
import { Button, Drawer, Empty, List, Modal, Popconfirm, Space, Tag, Tooltip, Typography, message } from 'antd'
import {
  ClockCircleOutlined,
  DeleteOutlined,
  EyeOutlined,
  PlusOutlined,
  RollbackOutlined
} from '@ant-design/icons'
import type { SnapshotKind, SnapshotMeta, SnapshotReason } from '@shared/types'

/** 快照来源 → 中文标签与配色 */
const REASON_META: Record<SnapshotReason, { label: string; color: string }> = {
  manual: { label: '手动保存点', color: 'blue' },
  auto: { label: '自动', color: 'default' },
  'pre-restore': { label: '回滚前留存', color: 'orange' },
  import: { label: '导入', color: 'purple' }
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

interface SnapshotDrawerProps {
  open: boolean
  onClose: () => void
  kind: SnapshotKind
  targetId: string
  /** 当前正文：用于手动打点与回滚前留存 */
  currentContent: string
  /** 回滚后回调（把历史正文写回编辑器） */
  onRestore: (content: string) => void
}

/**
 * 版本历史抽屉：按时间倒序列出快照点，支持查看、手动打点、回滚、删除。
 *
 * 列表展示"相对最新快照的字数变化 Δ"，让作者一眼看出某次保存是增是减。
 */
export default function SnapshotDrawer({
  open,
  onClose,
  kind,
  targetId,
  currentContent,
  onRestore
}: SnapshotDrawerProps) {
  const [items, setItems] = useState<SnapshotMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<{ meta: SnapshotMeta; content: string } | null>(null)

  const load = useCallback(async () => {
    if (!targetId) return
    setLoading(true)
    try {
      setItems(await window.api.snapshots.list(kind, targetId))
    } catch {
      message.error('加载版本历史失败')
    } finally {
      setLoading(false)
    }
  }, [kind, targetId])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const handleCreate = async (): Promise<void> => {
    const meta = await window.api.snapshots.create(kind, targetId, currentContent, '手动保存点')
    if (!meta) {
      message.info('内容与上一个版本相同，未重复记录')
      return
    }
    message.success('已记录当前版本')
    void load()
  }

  const handleRestore = async (snapId: string): Promise<void> => {
    const content = await window.api.snapshots.restore(kind, targetId, snapId, currentContent)
    if (content === null) {
      message.error('回滚失败')
      return
    }
    onRestore(content)
    message.success('已回滚（回滚前的版本也保留在历史里）')
    void load()
  }

  const handleRemove = async (snapId: string): Promise<void> => {
    await window.api.snapshots.remove(kind, targetId, snapId)
    void load()
  }

  const handlePreview = async (meta: SnapshotMeta): Promise<void> => {
    const content = await window.api.snapshots.get(kind, targetId, meta.id)
    if (content === null) {
      message.error('读取历史版本失败')
      return
    }
    setPreview({ meta, content })
  }

  // 以列表首项（最新）为基准计算字数变化
  const baseWords = items[0]?.words ?? 0

  return (
    <Drawer
      title="版本历史"
      placement="right"
      width={420}
      open={open}
      onClose={onClose}
      extra={
        <Tooltip title="把当前内容记为一个版本">
          <Button size="small" icon={<PlusOutlined />} onClick={() => void handleCreate()}>
            记录当前版本
          </Button>
        </Tooltip>
      }
    >
      {items.length === 0 && !loading ? (
        <Empty description="还没有历史版本，保存一次后会自动记录" />
      ) : (
        <List
          loading={loading}
          dataSource={items}
          renderItem={(item, index) => {
            const diff = index === 0 ? 0 : item.words - baseWords
            const reason = REASON_META[item.reason] ?? REASON_META.auto
            return (
              <List.Item
                actions={[
                  <Tooltip key="view" title="查看">
                    <Button
                      type="text"
                      size="small"
                      icon={<EyeOutlined />}
                      onClick={() => void handlePreview(item)}
                    />
                  </Tooltip>,
                  <Popconfirm
                    key="restore"
                    title="回滚到这个版本？"
                    description="当前内容会先存为一个版本，随时可以再回退回来。"
                    okText="回滚"
                    cancelText="取消"
                    onConfirm={() => void handleRestore(item.id)}
                  >
                    <Tooltip title="回滚到这个版本">
                      <Button type="text" size="small" icon={<RollbackOutlined />} />
                    </Tooltip>
                  </Popconfirm>,
                  <Popconfirm
                    key="del"
                    title="删除这个版本？"
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() => void handleRemove(item.id)}
                  >
                    <Tooltip title="删除">
                      <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                    </Tooltip>
                  </Popconfirm>
                ]}
              >
                <List.Item.Meta
                  avatar={<ClockCircleOutlined style={{ fontSize: 16, opacity: 0.6 }} />}
                  title={
                    <Space size={6} wrap>
                      <span style={{ fontSize: 12 }}>{formatTime(item.createdAt)}</span>
                      <Tag color={reason.color} style={{ marginInlineEnd: 0 }}>
                        {reason.label}
                      </Tag>
                      {index === 0 && <Tag color="green">最新</Tag>}
                    </Space>
                  }
                  description={
                    <Space size={8} wrap>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {item.words.toLocaleString()} 字
                      </Typography.Text>
                      {item.label && (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {item.label}
                        </Typography.Text>
                      )}
                      {diff !== 0 && (
                        <Typography.Text
                          style={{ fontSize: 12, color: diff > 0 ? '#3f8600' : '#cf1322' }}
                        >
                          {diff > 0 ? '+' : ''}
                          {diff.toLocaleString()} 字
                        </Typography.Text>
                      )}
                    </Space>
                  }
                />
              </List.Item>
            )
          }}
        />
      )}

      <Modal
        open={!!preview}
        title={preview ? `${formatTime(preview.meta.createdAt)} · ${preview.meta.words} 字` : ''}
        width={720}
        footer={[
          <Button key="close" onClick={() => setPreview(null)}>
            关闭
          </Button>,
          <Button
            key="restore"
            type="primary"
            icon={<RollbackOutlined />}
            onClick={() => {
              const id = preview?.meta.id
              setPreview(null)
              if (id) void handleRestore(id)
            }}
          >
            回滚到这个版本
          </Button>
        ]}
        onCancel={() => setPreview(null)}
      >
        <pre
          style={{
            maxHeight: '60vh',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            margin: 0,
            fontSize: 13,
            lineHeight: 1.7
          }}
        >
          {preview?.content}
        </pre>
      </Modal>
    </Drawer>
  )
}
