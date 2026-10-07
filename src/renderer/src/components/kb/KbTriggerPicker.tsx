/* # 引用选择器：本地知识库 / 数据资产 / 世界书 挂载到当前对话 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Avatar, Empty, Input, List, Modal, Segmented, Space, Tag, Typography, message } from 'antd'
import {
  DatabaseOutlined,
  FileTextOutlined,
  BookOutlined,
  SearchOutlined
} from '@ant-design/icons'
import type { AssetType, KbCandidate, KbRefChannel, KbRefPick } from '@shared/types'

interface Props {
  open: boolean
  onClose: () => void
  /** 已选引用（受控） */
  value: KbRefPick[]
  onChange: (next: KbRefPick[]) => void
}

const KIND_LABEL: Record<AssetType, string> = {
  doc: '文档',
  data: '数据表',
  worldbook: '世界书'
}

const CHANNEL_LABEL: Record<KbRefChannel, string> = {
  rag: '检索',
  'full-text': '全文',
  schema: '表结构'
}

function kindIcon(kind: AssetType): React.ReactNode {
  if (kind === 'data') return <DatabaseOutlined />
  if (kind === 'worldbook') return <BookOutlined />
  return <FileTextOutlined />
}

export default function KbTriggerPicker({ open, onClose, value, onChange }: Props) {
  const [q, setQ] = useState('')
  const [list, setList] = useState<KbCandidate[]>([])
  const [loading, setLoading] = useState(false)
  const [kindFilter, setKindFilter] = useState<'all' | AssetType>('all')

  const refresh = useCallback(async (kw: string) => {
    setLoading(true)
    try {
      const r = await window.api.knowledgeBase.listCandidates(kw || undefined)
      setList(r ?? [])
    } catch (err) {
      message.error('加载知识库候选失败：' + (err as Error).message)
      setList([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh(q)
  }, [open, q, refresh])

  const filtered = useMemo(() => {
    if (kindFilter === 'all') return list
    return list.filter((c) => c.kind === kindFilter)
  }, [list, kindFilter])

  const isSelected = (c: KbCandidate): boolean => value.some((v) => v.kind === c.kind && v.id === c.id)

  const toggle = (c: KbCandidate): void => {
    if (isSelected(c)) {
      onChange(value.filter((v) => !(v.kind === c.kind && v.id === c.id)))
      return
    }
    onChange([
      ...value,
      { kind: c.kind, id: c.id, name: c.name, channel: c.defaultChannel }
    ])
  }

  const setChannel = (c: KbCandidate, channel: KbRefChannel): void => {
    onChange(
      value.map((v) => (v.kind === c.kind && v.id === c.id ? { ...v, channel } : v))
    )
  }

  return (
    <Modal
      title="引用本地知识库"
      open={open}
      onCancel={onClose}
      onOk={onClose}
      width={560}
      okText="完成"
      destroyOnHidden
    >
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        <Input
          prefix={<SearchOutlined />}
          placeholder="搜索文档 / 数据表 / 世界书…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          allowClear
        />
        <Segmented
          size="small"
          value={kindFilter}
          onChange={(v) => setKindFilter(v as 'all' | AssetType)}
          options={[
            { label: '全部', value: 'all' },
            { label: '文档', value: 'doc' },
            { label: '数据表', value: 'data' },
            { label: '世界书', value: 'worldbook' }
          ]}
        />
        <div style={{ maxHeight: 360, overflow: 'auto' }}>
          {loading ? (
            <div style={{ padding: 24, textAlign: 'center', opacity: 0.6 }}>加载中…</div>
          ) : filtered.length === 0 ? (
            <Empty
              description={
                q
                  ? '无匹配资产'
                  : '知识库为空 —— 请先到「本地知识库」页构建索引，或在数据整理中导入数据表'
              }
              style={{ margin: '32px 0' }}
            />
          ) : (
            <List
              size="small"
              dataSource={filtered}
              renderItem={(c) => {
                const sel = isSelected(c)
                const pick = value.find((v) => v.kind === c.kind && v.id === c.id)
                return (
                  <List.Item
                    onClick={() => toggle(c)}
                    style={{
                      cursor: 'pointer',
                      background: sel ? 'var(--accent-soft, rgba(22,119,255,.08))' : undefined,
                      borderRadius: 6,
                      paddingInline: 10
                    }}
                    actions={
                      sel && c.kind === 'doc'
                        ? [
                            <Segmented
                              key="ch"
                              size="small"
                              value={pick?.channel ?? c.defaultChannel}
                              onChange={(v) => {
                                // 阻止冒泡触发 toggle
                                setChannel(c, v as KbRefChannel)
                              }}
                              options={[
                                { label: '检索', value: 'rag' },
                                { label: '全文', value: 'full-text' }
                              ]}
                            />
                          ]
                        : undefined
                    }
                  >
                    <List.Item.Meta
                      avatar={<Avatar size="small" icon={kindIcon(c.kind)} style={{ background: sel ? '#1677ff' : undefined }} />}
                      title={
                        <Space size={6}>
                          <span>{c.name}</span>
                          <Tag style={{ margin: 0 }}>{KIND_LABEL[c.kind]}</Tag>
                          {sel && <Tag color="blue" style={{ margin: 0 }}>{CHANNEL_LABEL[pick?.channel ?? c.defaultChannel]}</Tag>}
                        </Space>
                      }
                      description={
                        <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                          {c.meta || KIND_LABEL[c.kind]}
                        </Typography.Text>
                      }
                    />
                  </List.Item>
                )
              }}
            />
          )}
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          已选 {value.length} 项 · 发送时注入系统上下文（文档默认 RAG，世界书全文，数据表注入列结构与样例）
        </Typography.Text>
      </Space>
    </Modal>
  )
}
