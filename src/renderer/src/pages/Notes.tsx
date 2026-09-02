import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Dropdown, Empty, Input, List, message, Modal, Popover, Segmented, Select, Skeleton, Space, Tag, Tabs, Tooltip, Typography } from 'antd'
import { DeleteOutlined, PlusOutlined, SaveOutlined, DownloadOutlined, UploadOutlined, TagsOutlined, ThunderboltOutlined, TableOutlined, FileAddOutlined, ToolOutlined, HistoryOutlined, BookOutlined } from '@ant-design/icons'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { Note, NoteMeta, NoteExportBundle, NoteTag } from '@shared/types'
import NoteTagsPanel from '../components/notesFeature/NoteTagsPanel'
import NoteIndexesPanel from '../components/notesFeature/NoteIndexesPanel'
import NoteRulesPanel from '../components/notesFeature/NoteRulesPanel'
import SnapshotDrawer from '../components/SnapshotDrawer'
import BookExportDialog from '../components/BookExportDialog'
import { importFilesToNotes, type NoteImportSummary } from '../utils/noteImport'

export default function Notes({ openNoteId }: { openNoteId?: string }) {
  const [metas, setMetas] = useState<NoteMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  // 增强功能状态
  const [tab, setTab] = useState('notes')
  const [tagInput, setTagInput] = useState('')
  const [tagPopOpen, setTagPopOpen] = useState(false)
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null)
  const [allTags, setAllTags] = useState<string[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [metaSaving, setMetaSaving] = useState(false)
  // 版本历史 / 导出成书
  const [historyOpen, setHistoryOpen] = useState(false)
  const [bookOpen, setBookOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const list = await window.api.notes.list()
      setMetas(list)
      setAllTags([...new Set(list.flatMap((m) => m.tags ?? []))].sort((a, b) => a.localeCompare(b)))
    } catch {
      message.error('加载笔记失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleCategoriesChanged = useCallback((cats: string[]): void => {
    setCategories(cats.filter(Boolean))
  }, [])

  const openNote = useCallback(async (id: string) => {
    setActiveId(id)
    setMode('edit')
    try {
      const n = await window.api.notes.get(id)
      if (n) {
        setNote(n)
        setContent(n.content)
        setDirty(false)
      }
    } catch {
      message.error('打开笔记失败')
    }
  }, [])

  // 外部跳转（Ctrl+K 搜索）指定打开某篇笔记
  useEffect(() => {
    if (openNoteId) openNote(openNoteId)
  }, [openNoteId, openNote])

  const html = useMemo(() => {
    if (mode !== 'preview') return ''
    try {
      return DOMPurify.sanitize(marked.parse(content) as string)
    } catch {
      return '<p>（预览渲染失败）</p>'
    }
  }, [mode, content])

  const handleCreate = async () => {
    try {
      const list = await window.api.notes.create('新笔记')
      setMetas(list)
      if (list.length > 0) openNote(list[0].id)
    } catch {
      message.error('创建失败')
    }
  }

  const handleSave = async () => {
    if (!activeId || !dirty) return
    setSaving(true)
    try {
      const list = await window.api.notes.update(activeId, content)
      setMetas(list)
      setDirty(false)
      message.success('已保存')
    } catch {
      message.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  /** 回滚：把历史正文写回编辑器，并立刻落盘，避免"回滚了但没保存"的困惑 */
  const handleRestore = useCallback(
    async (restored: string) => {
      if (!activeId) return
      setContent(restored)
      setDirty(true)
      try {
        const list = await window.api.notes.update(activeId, restored)
        setMetas(list)
        setDirty(false)
      } catch {
        message.error('回滚内容写入失败，请手动保存')
      }
    },
    [activeId]
  )

  const handleRemove = async (id: string) => {
    try {
      const list = await window.api.notes.remove(id)
      setMetas(list)
      if (activeId === id) {
        setActiveId(null)
        setNote(null)
        setContent('')
        setDirty(false)
      }
      message.success('已删除')
    } catch {
      message.error('删除失败')
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /* ---------- 元数据（标签/分类） ---------- */
  const saveMeta = async (meta: { tags?: string[]; category?: string; categorizedBy?: 'auto' | 'manual' }): Promise<void> => {
    if (!activeId) return
    setMetaSaving(true)
    try {
      const list = await window.api.notes.updateMeta(activeId, meta)
      setMetas(list)
      // 同步标签索引（新标签名入库，供标签云使用）
      if (meta.tags) {
        const known = new Set(allTags)
        for (const t of meta.tags) {
          if (!known.has(t)) await window.api.notesFeature.tags.add(t)
        }
        setAllTags([...new Set(list.flatMap((m) => m.tags ?? []))].sort((a, b) => a.localeCompare(b)))
      }
      if (meta.category !== undefined) {
        setNote((prev) => (prev ? { ...prev, ...meta } : prev))
      }
    } catch (err) {
      message.error('保存标签/分类失败：' + (err as Error).message)
    } finally {
      setMetaSaving(false)
    }
  }

  /* 标签批量输入：逗号/空格/顿号分隔 → 拆分去重 → 保存 */
  const tagCommit = async (raw: string): Promise<void> => {
    const parts = raw
      .split(/[,\s，、]+/)
      .map((x) => x.trim())
      .filter(Boolean)
    if (parts.length === 0) return
    if (!note) return
    const seen = new Set<string>()
    const merged: string[] = []
    for (const t of [...(note.tags ?? []), ...parts]) {
      const key = t.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        merged.push(t)
      }
    }
    setTagInput('')
    await saveMeta({ tags: merged })
  }

  const removeTag = (name: string): void => {
    if (!note) return
    void saveMeta({ tags: (note.tags ?? []).filter((t) => t !== name) })
  }

  /* 选择已有标签：合并去重后保存 */
  const addExistingTags = (names: string[]): void => {
    if (!note || names.length === 0) return
    const seen = new Set<string>()
    const merged: string[] = []
    for (const t of [...(note.tags ?? []), ...names]) {
      const k = t.toLowerCase()
      if (!seen.has(k)) {
        seen.add(k)
        merged.push(t)
      }
    }
    void saveMeta({ tags: merged })
  }

  /* ---------- 一键导出 / 导入 ---------- */
  const handleExportJson = async (): Promise<void> => {
    try {
      const bundle = await window.api.notesFeature.exportJson()
      const saved = await window.api.exportText(
        `notes-export-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(bundle, null, 2)
      )
      if (saved) message.success('已导出：' + saved)
    } catch (err) {
      message.error('导出失败：' + (err as Error).message)
    }
  }

  const handleExportMarkdown = async (): Promise<void> => {
    try {
      const md = await window.api.notesFeature.exportMarkdown()
      const saved = await window.api.exportText(
        `notes-export-${new Date().toISOString().slice(0, 10)}.md`,
        md
      )
      if (saved) message.success('已导出：' + saved)
    } catch (err) {
      message.error('导出失败：' + (err as Error).message)
    }
  }

  const handleImport = async (): Promise<void> => {
    try {
      const file = await window.api.pickBufferFile()
      if (!file) return
      const text = new TextDecoder().decode(file.data)
      const bundle = JSON.parse(text) as NoteExportBundle
      Modal.confirm({
        title: '导入笔记数据',
        content: `将导入 ${bundle.notes?.length ?? 0} 篇笔记、${bundle.tags?.length ?? 0} 个标签、${bundle.rules?.length ?? 0} 条分类规则、${bundle.indexTables?.length ?? 0} 张检索表。同名笔记会覆盖，现有配置将被替换。确定继续吗？`,
        okText: '导入',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: async () => {
          const r = await window.api.notesFeature.import(bundle)
          if (r.ok) {
            message.success(`导入完成：笔记 ${r.counts?.notes ?? 0} · 标签 ${r.counts?.tags ?? 0} · 规则 ${r.counts?.rules ?? 0} · 检索表 ${r.counts?.indexTables ?? 0}`)
            await load()
            if (activeId) void openNote(activeId)
          } else {
            message.error('导入失败：' + (r.error ?? '未知错误'))
          }
        }
      })
    } catch (err) {
      message.error('导入失败：' + (err as Error).message)
    }
  }

  /* ---------- 批量导入数据文件（CSV/JSON/Excel/TXT 等 → 笔记） ---------- */
  const handleImportFiles = async (): Promise<void> => {
    try {
      const files = await window.api.pickBufferFiles()
      if (!files || files.length === 0) return
      const summary: NoteImportSummary = await importFilesToNotes(files)
      if (summary.created.length > 0) {
        await load()
        if (summary.skipped.length === 0) {
          message.success(`已导入 ${summary.created.length} 个文件为笔记`)
          return
        }
      }
      // 有跳过项（或全部失败）时展示明细
      const skipList =
        summary.skipped.length > 0
          ? summary.skipped.map((s) => ({ name: s.name, reason: s.reason }))
          : []
      Modal.info({
        title: `批量导入结果`,
        content: (
          <div>
            <Typography.Paragraph style={{ marginBottom: 8 }}>
              成功导入 <Typography.Text strong>{summary.created.length}</Typography.Text> 个文件
              {summary.skipped.length > 0 && (
                <>
                  ，跳过 <Typography.Text strong type="danger">{summary.skipped.length}</Typography.Text> 个
                </>
              )}
            </Typography.Paragraph>
            {summary.skipped.length > 0 && (
              <div style={{ maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {skipList.map((s, i) => (
                  <div key={i} style={{ fontSize: 12, display: 'flex', gap: 8 }}>
                    <Typography.Text code style={{ flexShrink: 0, maxWidth: 220 }} ellipsis>
                      {s.name}
                    </Typography.Text>
                    <Typography.Text type="danger" style={{ flex: 1 }}>
                      {s.reason}
                    </Typography.Text>
                  </div>
                ))}
              </div>
            )}
          </div>
        ),
        width: 460
      })
    } catch (err) {
      message.error('导入失败：' + (err as Error).message)
    }
  }

  const q = query.trim().toLowerCase()
  const filtered = metas.filter((m) => {
    if (q && !m.title.toLowerCase().includes(q)) return false
    if (activeTag && !(m.tags ?? []).includes(activeTag)) return false
    if (categoryFilter && (m.category ?? '') !== categoryFilter) return false
    return true
  })

  return (
    <div className="notes-page" style={{ flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px 0', flexWrap: 'wrap' }}>
        <Tabs
          size="small"
          activeKey={tab}
          onChange={setTab}
          style={{ flex: 1, marginBottom: 0 }}
          items={[
            { key: 'notes', label: '笔记' },
            { key: 'tags', label: '标签' },
            { key: 'indexes', label: '检索表' },
            { key: 'rules', label: '分类规则' }
          ]}
        />
        <Space size={4}>
          <Button size="small" icon={<DownloadOutlined />} onClick={() => void handleExportJson()} title="导出全部数据（JSON，含标签/规则/检索表）">
            导出 JSON
          </Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={() => void handleExportMarkdown()} title="导出全部笔记（Markdown）">
            导出 MD
          </Button>
          <Dropdown
            menu={{
              items: [
                { key: 'files', label: '批量导入文件（CSV/JSON/Excel/TXT…）', icon: <FileAddOutlined />, onClick: () => void handleImportFiles() },
                { key: 'backup', label: '恢复备份（导入笔记数据包）', icon: <UploadOutlined />, onClick: () => void handleImport() }
              ]
            }}
          >
            <Button size="small" icon={<UploadOutlined />}>
              导入
            </Button>
          </Dropdown>
          <Button
            size="small"
            icon={<ToolOutlined />}
            title="把全部 GBK/非 UTF-8 笔记无损转为 UTF-8（修复乱码）"
            onClick={async () => {
              try {
                const r = await window.api.notes.repairAllEncodings()
                if (r.repaired > 0) {
                  message.success(`已扫描 ${r.scanned} 篇，修复 ${r.repaired} 篇编码为 UTF-8`)
                  await load()
                } else {
                  message.info(`已扫描 ${r.scanned} 篇，无需修复`)
                }
              } catch (err) {
                message.error('修复失败：' + (err as Error).message)
              }
            }}
          >
            修复编码
          </Button>
        </Space>
      </div>
      {tab === 'notes' && (
      <div className="notes-page" style={{ flex: 1, minHeight: 0 }}>
      <div className="notes-list">
        <div className="notes-list-header">
          <Typography.Text strong>笔记</Typography.Text>
          <Button
            type="text"
            size="small"
            icon={<PlusOutlined />}
            onClick={handleCreate}
            title="新建笔记"
          />
        </div>
        <Input.Search
          aria-label="搜索标题"
          placeholder="搜索标题"
          allowClear
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          size="small"
          style={{ marginBottom: 8 }}
        />
        <Select
          aria-label="分类筛选"
          size="small"
          style={{ width: 130, marginBottom: 8 }}
          value={categoryFilter ?? ''}
          onChange={(v) => setCategoryFilter(v || null)}
          options={[{ label: '全部分类', value: '' }, ...categories.map((c) => ({ label: c, value: c }))]}
        />
        <div style={{ marginBottom: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          <Tag.CheckableTag checked={!activeTag} onChange={() => setActiveTag(null)}>
            全部
          </Tag.CheckableTag>
          {allTags.map((t) => (
            <Tag.CheckableTag key={t} checked={activeTag === t} onChange={() => setActiveTag(t === activeTag ? null : t)}>
              {t}
            </Tag.CheckableTag>
          ))}
        </div>
        <div className="notes-list-body">
          {loading ? (
            <Skeleton active paragraph={{ rows: 6 }} />
          ) : filtered.length === 0 ? (
            <Empty description="暂无笔记" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <List
              dataSource={filtered}
              renderItem={(m) => (
                <List.Item
                  className={'notes-item' + (m.id === activeId ? ' active' : '')}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('.notes-item-delete')) return
                    openNote(m.id)
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="notes-item-title">{m.title}</div>
                    <div className="notes-item-time">{formatTime(m.updatedAt)}</div>
                  </div>
                  <Button
                    className="notes-item-delete"
                    type="text"
                    size="small"
                    danger
                    aria-label="删除笔记"
                    icon={<DeleteOutlined />}
                    onClick={() => handleRemove(m.id)}
                  />
                </List.Item>
              )}
            />
          )}
        </div>
      </div>
      <div className="notes-editor">
        {note ? (
          <>
            <div className="notes-editor-toolbar">
              <Typography.Text strong ellipsis style={{ flex: 1 }}>
                {note.title}
              </Typography.Text>
              <Segmented
                size="small"
                value={mode}
                onChange={(v) => setMode(v as 'edit' | 'preview')}
                options={[
                  { label: '编辑', value: 'edit' },
                  { label: '预览', value: 'preview' }
                ]}
              />
              {mode === 'edit' && (
                <Button
                  size="small"
                  type="primary"
                  icon={<SaveOutlined />}
                  disabled={!dirty}
                  loading={saving}
                  onClick={handleSave}
                >
                  保存
                </Button>
              )}
              <Button
                size="small"
                icon={<DownloadOutlined />}
                disabled={!content}
                onClick={async () => {
                  try {
                    const name = (note.title || '笔记') + '.md'
                    const saved = await window.api.exportText(name, content)
                    if (saved) message.success('已导出：' + saved)
                  } catch {
                    message.error('导出失败')
                  }
                }}
              >
                导出
              </Button>
              <Tooltip title="版本历史：查看与回滚这篇笔记的历次保存">
                <Button
                  size="small"
                  icon={<HistoryOutlined />}
                  disabled={!note}
                  onClick={() => setHistoryOpen(true)}
                >
                  历史
                </Button>
              </Tooltip>
              <Tooltip title="导出成书：把多篇笔记 / 写作草稿拼成一本书">
                <Button size="small" icon={<BookOutlined />} onClick={() => setBookOpen(true)}>
                  成书
                </Button>
              </Tooltip>
            </div>
            <div
              className="notes-editor-meta"
              style={{
                display: 'flex',
                gap: 8,
                padding: '6px 12px',
                alignItems: 'center',
                flexWrap: 'wrap',
                borderBottom: '1px solid var(--border-color, rgba(128,128,128,.15))'
              }}
            >
              <div style={{ flex: 1, minWidth: 200, display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                {(note.tags ?? []).map((t) => (
                  <Tag key={t} closable onClose={() => removeTag(t)} style={{ margin: 0 }}>
                    {t}
                  </Tag>
                ))}
                <Input
                  aria-label="添加标签"
                  size="small"
                  style={{ width: 180, borderStyle: 'dashed' }}
                  placeholder="+ 标签（逗号/空格分隔）"
                  prefix={<TagsOutlined />}
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onPressEnter={() => void tagCommit(tagInput)}
                  onBlur={() => {
                    if (tagInput.trim()) void tagCommit(tagInput)
                  }}
                  disabled={metaSaving}
                />
                <Popover
                  open={tagPopOpen}
                  onOpenChange={setTagPopOpen}
                  trigger="click"
                  placement="bottomLeft"
                  content={
                    <div style={{ width: 240, maxHeight: 320, overflowY: 'auto' }}>
                      {allTags.length === 0 ? (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          暂无已存在标签
                        </Typography.Text>
                      ) : (
                        <>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              选择已有标签（按使用频次）
                            </Typography.Text>
                            <Button
                              size="small"
                              type="link"
                              style={{ padding: 0, height: 'auto' }}
                              onClick={() => {
                                const rest = allTags.filter((t) => !(note.tags ?? []).includes(t))
                                if (rest.length > 0) {
                                  addExistingTags(rest)
                                  message.success(`已添加全部 ${rest.length} 个标签`)
                                }
                                setTagPopOpen(false)
                              }}
                            >
                              一键全选
                            </Button>
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {allTags
                              .map((t) => {
                                const used = (note.tags ?? []).includes(t)
                                return { t, used, count: metas.reduce((n, m) => n + (m.tags?.includes(t) ? 1 : 0), 0) }
                              })
                              .sort((a, b) => b.count - a.count)
                              .map(({ t, used, count }) => (
                                <Tag.CheckableTag
                                  key={t}
                                  checked={used}
                                  onChange={() => {
                                    if (used) removeTag(t)
                                    else addExistingTags([t])
                                  }}
                                >
                                  {t} ({count})
                                </Tag.CheckableTag>
                              ))}
                          </div>
                        </>
                      )}
                    </div>
                  }
                >
                  <Button size="small" type="dashed" icon={<TagsOutlined />} title="从已存在标签中选">
                    选择
                  </Button>
                </Popover>
              </div>
              <Select
                aria-label="笔记分类"
                mode="tags"
                maxCount={1}
                size="small"
                style={{ width: 150 }}
                placeholder="分类（可输入新分类）"
                value={note.category ? [note.category] : []}
                onChange={(v) => void saveMeta({ category: (v[0] as string)?.trim() || '', categorizedBy: 'manual' })}
                options={categories.map((c) => ({ label: c, value: c }))}
                disabled={metaSaving}
              />
              {note.category && (
                <Tag color={note.categorizedBy === 'manual' ? 'green' : 'blue'} style={{ margin: 0 }}>
                  {note.categorizedBy === 'manual' ? '手动' : '自动'}
                </Tag>
              )}
            </div>
            {mode === 'edit' ? (
              <textarea
                className="notes-textarea"
                value={content}
                onChange={(e) => {
                  setContent(e.target.value)
                  setDirty(true)
                }}
                placeholder={'支持 Markdown，第一行 "# 标题" 会作为笔记标题，Ctrl+S 保存'}
              />
            ) : (
              <div className="markdown-preview" dangerouslySetInnerHTML={{ __html: html }} />
            )}
          </>
        ) : (
          <Empty style={{ marginTop: 120 }} description="选择左侧笔记，或点击 + 新建" />
        )}
      </div>
      </div>
      )}
      {tab === 'tags' && (
        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          <NoteTagsPanel
            onFilterTag={(name) => {
              setActiveTag(name)
              setTab('notes')
            }}
            onTagsChanged={() => void load()}
          />
        </div>
      )}
      {tab === 'indexes' && (
        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          <NoteIndexesPanel onOpenNote={(id) => void openNote(id)} />
        </div>
      )}
      {tab === 'rules' && (
        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          <NoteRulesPanel onCategoriesChanged={handleCategoriesChanged} />
        </div>
      )}

      {activeId && (
        <SnapshotDrawer
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          kind="note"
          targetId={activeId}
          currentContent={content}
          onRestore={(c) => void handleRestore(c)}
        />
      )}
      <BookExportDialog
        open={bookOpen}
        onClose={() => setBookOpen(false)}
        defaultSelected={
          note && activeId ? [{ kind: 'note' as const, id: activeId }] : undefined
        }
      />
    </div>
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
