import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import {
  Alert,
  Button,
  Empty,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Tag,
  Tooltip,
  Typography,
  message
} from 'antd'
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  UndoOutlined,
  WarningOutlined
} from '@ant-design/icons'
import type { ChapterMeta, Foreshadow, ForeshadowStatus, NovelProject } from '@shared/types'

/** 三种状态的展示元数据 */
const STATUS_META: Record<ForeshadowStatus, { label: string; color: string }> = {
  planted: { label: '已埋下', color: 'blue' },
  'payed-off': { label: '已回收', color: 'green' },
  abandoned: { label: '已放弃', color: 'default' }
}

/** 把作品的「卷 → 章」排成正确的阅读顺序（与主进程 foreshadowCore 同算法） */
function buildOrder(project: NovelProject): ChapterMeta[] {
  const vols = [...project.volumes].sort((a, b) => a.index - b.index)
  const byVol = new Map<string, ChapterMeta[]>()
  for (const c of project.chapters) {
    const arr = byVol.get(c.volumeId)
    if (arr) arr.push(c)
    else byVol.set(c.volumeId, [c])
  }
  const out: ChapterMeta[] = []
  for (const v of vols) {
    const list = byVol.get(v.id) ?? []
    list.sort((a, b) => a.index - b.index)
    out.push(...list)
  }
  return out
}

/** 从埋下章到当前章跨过的章数（不含埋下章）；任一侧缺失返回 null */
function gapOf(order: ChapterMeta[], plantedId: string, curId: string | null): number | null {
  if (!curId) return null
  const p = order.findIndex((c) => c.id === plantedId)
  const c = order.findIndex((x) => x.id === curId)
  if (p < 0 || c < 0) return null
  return c - p
}

interface ForeshadowPanelProps {
  projectId: string
  /** 当前正在编辑的章节（用于逾期提醒与回收标记） */
  currentChapterId: string | null
  /** 外部触发重新拉取（如从编辑器埋下了新伏笔） */
  reloadKey: number
}

export default function ForeshadowPanel({ projectId, currentChapterId, reloadKey }: ForeshadowPanelProps) {
  const [list, setList] = useState<Foreshadow[]>([])
  const [overdue, setOverdue] = useState<Foreshadow[]>([])
  const [order, setOrder] = useState<ChapterMeta[]>([])
  const [threshold, setThreshold] = useState(5)
  const [loading, setLoading] = useState(false)

  const [createOpen, setCreateOpen] = useState(false)
  const [draftContent, setDraftContent] = useState('')
  const [draftNote, setDraftNote] = useState('')

  const [editTarget, setEditTarget] = useState<Foreshadow | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editNote, setEditNote] = useState('')

  const titleOf = useCallback(
    (id: string): string => order.find((c) => c.id === id)?.title ?? '（章节已删除）',
    [order]
  )

  const reload = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const [fs, od, proj] = await Promise.all([
        window.api.novel.listForeshadows(projectId),
        currentChapterId
          ? window.api.novel.listOverdue(projectId, currentChapterId, threshold)
          : Promise.resolve([] as Foreshadow[]),
        window.api.novel.getProject(projectId)
      ])
      setList(fs)
      setOverdue(od)
      setOrder(proj ? buildOrder(proj) : [])
    } catch {
      message.error('加载伏笔失败')
    } finally {
      setLoading(false)
    }
  }, [projectId, currentChapterId, threshold])

  useEffect(() => {
    void reload()
  }, [reload, reloadKey])

  const groups = useMemo(() => {
    const g: Record<ForeshadowStatus, Foreshadow[]> = { planted: [], 'payed-off': [], abandoned: [] }
    for (const f of list) g[f.status].push(f)
    return g
  }, [list])

  /* ------------------------------ 操作 ------------------------------ */

  const handleCreate = async (): Promise<void> => {
    const c = draftContent.trim()
    if (!c) {
      message.warning('请填写伏笔内容')
      return
    }
    const curTitle = currentChapterId ? titleOf(currentChapterId) : '（未指定章节）'
    const f = await window.api.novel.createForeshadow({
      projectId,
      content: c,
      plantedChapterId: currentChapterId ?? '',
      plantedChapterTitle: curTitle,
      note: draftNote.trim() || undefined,
      status: 'planted'
    })
    if (f) {
      message.success('已埋下伏笔')
      setCreateOpen(false)
      setDraftContent('')
      setDraftNote('')
      void reload()
    }
  }

  const markPayoff = async (f: Foreshadow): Promise<void> => {
    if (!currentChapterId) {
      message.warning('请先打开要标记为回收的章节')
      return
    }
    const r = await window.api.novel.setForeshadowStatus(
      projectId,
      f.id,
      'payed-off',
      currentChapterId,
      titleOf(currentChapterId)
    )
    if (r) {
      message.success('已标记为回收')
      void reload()
    }
  }

  const rePlant = async (f: Foreshadow): Promise<void> => {
    await window.api.novel.setForeshadowStatus(projectId, f.id, 'planted')
    void reload()
  }

  const abandon = async (f: Foreshadow): Promise<void> => {
    await window.api.novel.setForeshadowStatus(projectId, f.id, 'abandoned')
    void reload()
  }

  const remove = async (f: Foreshadow): Promise<void> => {
    await window.api.novel.removeForeshadow(projectId, f.id)
    message.success('已删除')
    void reload()
  }

  const openEdit = (f: Foreshadow): void => {
    setEditTarget(f)
    setEditContent(f.content)
    setEditNote(f.note ?? '')
  }

  const saveEdit = async (): Promise<void> => {
    if (!editTarget) return
    const c = editContent.trim()
    if (!c) {
      message.warning('伏笔内容不能为空')
      return
    }
    await window.api.novel.updateForeshadow(projectId, editTarget.id, {
      content: c,
      note: editNote.trim() || undefined
    })
    setEditTarget(null)
    void reload()
  }

  /* ------------------------------ 渲染 ------------------------------ */

  const renderItem = (f: Foreshadow): ReactElement => {
    const gap = gapOf(order, f.plantedChapterId, currentChapterId)
    return (
      <div
        key={f.id}
        style={{
          padding: '8px 10px',
          borderRadius: 6,
          border: '1px solid var(--border-color, rgba(128,128,128,.18))',
          marginBottom: 8,
          background: 'var(--bg-subtle, rgba(128,128,128,.04))'
        }}
      >
        <div style={{ fontSize: 13, lineHeight: 1.6, wordBreak: 'break-word' }}>{f.content}</div>
        <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-secondary, #888)' }}>
          埋于《{f.plantedChapterTitle || '—'}》
          {f.status === 'planted' && gap !== null && gap > 0 && (
            <span style={{ color: '#d46b08' }}> · 已跨越 {gap} 章</span>
          )}
          {f.status === 'payed-off' && <> · 回收于《{f.payoffChapterTitle || '—'}》</>}
        </div>
        {f.note && (
          <div style={{ marginTop: 2, fontSize: 12, color: 'var(--text-secondary, #888)' }}>
            备注：{f.note}
          </div>
        )}
        <div style={{ marginTop: 6 }}>
          <Space size={4} wrap>
            <Tag color={STATUS_META[f.status].color} style={{ margin: 0 }}>
              {STATUS_META[f.status].label}
            </Tag>
            {f.status === 'planted' && (
              <Tooltip title="标记为已在本章回收">
                <Button size="small" type="text" icon={<CheckCircleOutlined />} onClick={() => void markPayoff(f)} />
              </Tooltip>
            )}
            {f.status !== 'planted' && (
              <Tooltip title="重新埋下（清空回收记录）">
                <Button size="small" type="text" icon={<UndoOutlined />} onClick={() => void rePlant(f)} />
              </Tooltip>
            )}
            {f.status === 'planted' && (
              <Tooltip title="放弃这条伏笔">
                <Button size="small" type="text" icon={<CloseCircleOutlined />} onClick={() => void abandon(f)} />
              </Tooltip>
            )}
            <Tooltip title="编辑内容与备注">
              <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEdit(f)} />
            </Tooltip>
            <Popconfirm title="删除这条伏笔？" okText="删除" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={() => void remove(f)}>
              <Button size="small" type="text" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          </Space>
        </div>
      </div>
    )
  }

  const renderGroup = (status: ForeshadowStatus): ReactElement | null => {
    const items = groups[status]
    if (!items.length) return null
    return (
      <div key={status} style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)', marginBottom: 6 }}>
          {STATUS_META[status].label}（{items.length}）
        </div>
        {items.map(renderItem)}
      </div>
    )
  }

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-color, rgba(128,128,128,.12))' }}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建伏笔
          </Button>
          <Space size={4}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary, #888)' }}>超过</span>
            <InputNumber
              aria-label="逾期阈值（章）"
              size="small"
              min={1}
              max={50}
              value={threshold}
              onChange={(v) => setThreshold(typeof v === 'number' ? v : 5)}
              style={{ width: 64 }}
            />
            <span style={{ fontSize: 12, color: 'var(--text-secondary, #888)' }}>章未回收提醒</span>
          </Space>
        </Space>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10 }}>
        {loading && list.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="加载中…" />
        ) : list.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有伏笔。在正文中选中一段文字，点浮层里的「埋伏笔」即可记录。" />
        ) : (
          <>
            {currentChapterId && overdue.length > 0 && (
              <Alert
                type="warning"
                showIcon
                icon={<WarningOutlined />}
                style={{ marginBottom: 10 }}
                message={`有 ${overdue.length} 个伏笔已埋下超过 ${threshold} 章仍未回收`}
                description={
                  <div style={{ maxHeight: 120, overflowY: 'auto' }}>
                    {overdue.map((f) => {
                      const gap = gapOf(order, f.plantedChapterId, currentChapterId)
                      return (
                        <div key={f.id} style={{ fontSize: 12, lineHeight: 1.8 }}>
                          · {f.content}（埋于《{f.plantedChapterTitle || '—'}》
                          {gap !== null && gap > 0 ? ` · 跨越 ${gap} 章` : ''}）
                        </div>
                      )
                    })}
                  </div>
                }
              />
            )}
            {(['planted', 'payed-off', 'abandoned'] as ForeshadowStatus[]).map(renderGroup)}
          </>
        )}
      </div>

      {/* 新建伏笔 */}
      <Modal
        open={createOpen}
        title="埋下伏笔"
        okText="埋下"
        cancelText="取消"
        destroyOnHidden
        onCancel={() => setCreateOpen(false)}
        onOk={() => void handleCreate()}
      >
        <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
          <Input.TextArea
            aria-label="伏笔内容"
            value={draftContent}
            onChange={(e) => setDraftContent(e.target.value)}
            placeholder="伏笔内容：埋下的原文片段，或你对这条线索的备注"
            autoSize={{ minRows: 3, maxRows: 6 }}
          />
          <Input
            aria-label="伏笔备注"
            value={draftNote}
            onChange={(e) => setDraftNote(e.target.value)}
            placeholder="备注（选填）"
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            将挂在当前章节《{currentChapterId ? titleOf(currentChapterId) : '（未指定章节）'}》下。
          </Typography.Text>
        </Space>
      </Modal>

      {/* 编辑伏笔 */}
      <Modal
        open={!!editTarget}
        title="编辑伏笔"
        okText="保存"
        cancelText="取消"
        destroyOnHidden
        onCancel={() => setEditTarget(null)}
        onOk={() => void saveEdit()}
      >
        <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
          <Input.TextArea
            aria-label="伏笔内容"
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            autoSize={{ minRows: 3, maxRows: 6 }}
          />
          <Input aria-label="伏笔备注" value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="备注（选填）" />
        </Space>
      </Modal>
    </div>
  )
}
