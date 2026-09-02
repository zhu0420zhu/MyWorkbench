import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  ColorPicker,
  Input,
  List,
  Modal,
  Radio,
  Segmented,
  Space,
  Tooltip,
  Typography,
  message
} from 'antd'
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  BookOutlined,
  ExportOutlined,
  PictureOutlined,
  PlusOutlined,
  ReloadOutlined
} from '@ant-design/icons'
import type {
  BookCoverOptions,
  BookCoverTemplate,
  BookExportInput,
  BookFormat,
  BookSourceItem
} from '@shared/types'

const FORMATS: Array<{ value: BookFormat; label: string; needPandoc: boolean }> = [
  { value: 'epub', label: 'EPUB 电子书', needPandoc: true },
  { value: 'docx', label: 'Word (.docx)', needPandoc: true },
  { value: 'pdf', label: 'PDF', needPandoc: true },
  { value: 'html', label: '网页 (.html)', needPandoc: true },
  { value: 'md', label: 'Markdown', needPandoc: false },
  { value: 'txt', label: '纯文本', needPandoc: false }
]

const KIND_LABEL: Record<BookSourceItem['kind'], string> = {
  note: '笔记',
  draft: '写作草稿',
  chapter: '作品章节'
}

const COVER_TEMPLATES: Array<{ value: BookCoverTemplate; label: string }> = [
  { value: 'classic', label: '典雅深色' },
  { value: 'minimal', label: '极简留白' },
  { value: 'gradient', label: '渐变现代' },
  { value: 'ink', label: '水墨中式' }
]

interface CoverDesignerProps {
  open: boolean
  bookTitle: string
  author: string
  onClose: () => void
  onPicked: (path: string, dataUrl?: string) => void
}

/**
 * 封面设计子弹窗：四套内置模板即时预览（主进程离屏渲染截图），也可直接选本地图片。
 * 拆成独立弹窗是为了不把主导出弹窗撑得过高。
 */
function CoverDesigner({ open, bookTitle, author, onClose, onPicked }: CoverDesignerProps) {
  const [template, setTemplate] = useState<BookCoverTemplate>('classic')
  const [accent, setAccent] = useState('#1f3a5f')
  const [subtitle, setSubtitle] = useState('')
  const [preview, setPreview] = useState<{ path: string; dataUrl?: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const render = useCallback(async () => {
    setBusy(true)
    try {
      const opts: BookCoverOptions = {
        title: bookTitle.trim() || '未命名作品',
        author: author.trim() || undefined,
        subtitle: subtitle.trim() || undefined,
        template,
        accent
      }
      const res = await window.api.book.generateCover(opts)
      if (res.ok && res.path) setPreview({ path: res.path, dataUrl: res.dataUrl })
      else message.error(res.error || '封面生成失败')
    } catch {
      message.error('封面生成失败')
    } finally {
      setBusy(false)
    }
  }, [bookTitle, author, subtitle, template, accent])

  // 打开时先渲染一张默认封面，避免面对空白
  useEffect(() => {
    if (open) void render()
    // 仅在打开瞬间触发，模板/配色变更由按钮驱动，避免每次输入都去渲染
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <Modal
      open={open}
      title="设计封面"
      width={640}
      okText="使用此封面"
      cancelText="取消"
      okButtonProps={{ disabled: !preview }}
      onOk={() => {
        if (preview) onPicked(preview.path, preview.dataUrl)
        onClose()
      }}
      onCancel={onClose}
      destroyOnHidden
    >
      <div style={{ display: 'flex', gap: 16 }}>
        <div
          style={{
            width: 216,
            height: 288,
            flex: '0 0 auto',
            border: '1px solid var(--lm-border, #d9d9d9)',
            borderRadius: 6,
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--lm-bg-subtle, #fafafa)'
          }}
        >
          {preview?.dataUrl ? (
            <img
              src={preview.dataUrl}
              alt="封面预览"
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {busy ? '正在渲染…' : '暂无预览'}
            </Typography.Text>
          )}
        </div>

        <Space direction="vertical" size={12} style={{ flex: 1, minWidth: 0 }}>
          <div>
            <Typography.Text strong style={{ fontSize: 13 }}>
              模板
            </Typography.Text>
            <div style={{ marginTop: 6 }}>
              <Segmented
                size="small"
                value={template}
                onChange={(v) => setTemplate(v as BookCoverTemplate)}
                options={COVER_TEMPLATES.map((t) => ({ label: t.label, value: t.value }))}
              />
            </div>
          </div>

          <div>
            <Typography.Text strong style={{ fontSize: 13 }}>
              主色
            </Typography.Text>
            <div style={{ marginTop: 6 }}>
              <ColorPicker
                value={accent}
                onChangeComplete={(c) => setAccent(c.toHexString())}
                showText
                presets={[
                  {
                    label: '推荐',
                    colors: ['#1f3a5f', '#7a3b2e', '#2f4f3f', '#4a3b6b', '#8a6d3b', '#20303a']
                  }
                ]}
              />
            </div>
          </div>

          <div>
            <Typography.Text strong style={{ fontSize: 13 }}>
              副标题（选填）
            </Typography.Text>
            <Input
              aria-label="副标题"
              size="small"
              style={{ marginTop: 6 }}
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
              placeholder="如：东方玄幻 · 第一卷"
              maxLength={24}
            />
          </div>

          <Space>
            <Button
              size="small"
              type="primary"
              ghost
              icon={<ReloadOutlined />}
              loading={busy}
              onClick={() => void render()}
            >
              重新渲染
            </Button>
            <Button
              size="small"
              icon={<PictureOutlined />}
              onClick={() => {
                void (async () => {
                  const res = await window.api.book.pickCover()
                  if (res.ok && res.path) {
                    onPicked(res.path, res.dataUrl)
                    onClose()
                  } else if (res.error && res.error !== '已取消') {
                    message.error(res.error)
                  }
                })()
              }}
            >
              改用本地图片
            </Button>
          </Space>

          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            封面用书名 / 作者即时绘制（1200×1600），改完模板或配色点「重新渲染」查看效果。
          </Typography.Text>
        </Space>
      </div>
    </Modal>
  )
}

interface BookExportDialogProps {
  open: boolean
  onClose: () => void
  /** 默认勾选的来源（如当前打开的笔记） */
  defaultSelected?: Array<{ kind: BookSourceItem['kind']; id: string }>
}

/**
 * 导出成书：选择若干笔记 / 写作草稿 → 排序 → 填书名作者 → 选格式导出。
 *
 * 每篇内容作为书中的一个一级标题章节，按顺序拼成一本 Markdown 合稿，
 * 再由 Pandoc 转 EPUB / DOCX / PDF / HTML；Markdown 与 TXT 直接落盘。
 */
export default function BookExportDialog({
  open,
  onClose,
  defaultSelected
}: BookExportDialogProps) {
  const [sources, setSources] = useState<BookSourceItem[]>([])
  const [selected, setSelected] = useState<BookSourceItem[]>([])
  const [format, setFormat] = useState<BookFormat>('epub')
  const [bookTitle, setBookTitle] = useState('未命名作品')
  const [author, setAuthor] = useState('')
  const [toc, setToc] = useState(true)
  const [typeset, setTypeset] = useState(true)
  const [cover, setCover] = useState<{ path: string; dataUrl?: string } | null>(null)
  const [coverOpen, setCoverOpen] = useState(false)
  const [pandocOk, setPandocOk] = useState(false)
  const [busy, setBusy] = useState(false)

  /**
   * defaultSelected 在父组件里通常是字面量数组，每次渲染都是新引用。
   * 若直接进 useEffect 依赖会触发「请求 → setState → 重渲染 → 新引用 → 再请求」的死循环，
   * 因此用 ref 承载最新值，effect 只依赖 open。
   */
  const presetRef = useRef(defaultSelected)
  presetRef.current = defaultSelected

  useEffect(() => {
    if (!open) return
    void (async () => {
      try {
        const list = await window.api.book.sources()
        setSources(list)
        const ok = await window.api.book.pandocAvailable()
        setPandocOk(ok)
        if (!ok) setFormat('md')
        const preset = presetRef.current ?? []
        const picked = preset
          .map((p) => list.find((s) => s.kind === p.kind && s.id === p.id))
          .filter((s): s is BookSourceItem => !!s)
        setSelected((prev) => (prev.length > 0 ? prev : picked))
      } catch {
        message.error('读取可导出内容失败')
      }
    })()
  }, [open])

  const remaining = useMemo(
    () => sources.filter((s) => !selected.some((x) => x.kind === s.kind && x.id === s.id)),
    [sources, selected]
  )

  const totalWords = useMemo(() => selected.reduce((sum, s) => sum + s.words, 0), [selected])

  const move = useCallback((index: number, delta: number) => {
    setSelected((prev) => {
      const next = [...prev]
      const target = index + delta
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }, [])

  const handleExport = useCallback(async () => {
    if (selected.length === 0) {
      message.warning('请先选择要导出的内容')
      return
    }
    setBusy(true)
    try {
      const input: BookExportInput = {
        items: selected.map((s) => ({ kind: s.kind, id: s.id })),
        format,
        bookTitle: bookTitle.trim() || '未命名作品',
        author: author.trim() || undefined,
        toc,
        typeset,
        coverImage: format === 'epub' ? (cover?.path ?? undefined) : undefined
      }
      const res = await window.api.book.export(input)
      if (res.ok) {
        message.success(`已导出：${res.path}`)
        onClose()
      } else if (res.error !== '已取消') {
        message.error(res.error || '导出失败')
      }
    } catch {
      message.error('导出失败')
    } finally {
      setBusy(false)
    }
  }, [selected, format, bookTitle, author, toc, typeset, cover, onClose])

  const needPandoc = FORMATS.find((f) => f.value === format)?.needPandoc ?? false
  // 排版样式表只对 EPUB / HTML 有意义；封面仅 EPUB 支持（Pandoc 限制）
  const canTypeset = format === 'epub' || format === 'html'
  const canCover = format === 'epub'

  return (
    <Modal
      open={open}
      title={
        <Space>
          <BookOutlined />
          导出成书
        </Space>
      }
      width={760}
      okText="导出"
      cancelText="取消"
      confirmLoading={busy}
      onOk={() => void handleExport()}
      onCancel={onClose}
      destroyOnHidden
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {!pandocOk && (
          <Alert
            type="warning"
            showIcon
            message="未检测到 Pandoc"
            description="EPUB / Word / PDF / 网页 需要 Pandoc 才能生成；当前可先导出 Markdown 或纯文本。安装 Pandoc 后重启应用即可解锁全部格式。"
          />
        )}

        <div>
          <Typography.Text strong>书名与作者</Typography.Text>
          <Space style={{ width: '100%', marginTop: 6 }} size={8}>
            <Input
              aria-label="书名"
              value={bookTitle}
              onChange={(e) => setBookTitle(e.target.value)}
              placeholder="书名"
              style={{ width: 260 }}
            />
            <Input
              aria-label="作者"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="作者（选填）"
              style={{ width: 200 }}
            />
          </Space>
        </div>

        <div>
          <Typography.Text strong>导出格式</Typography.Text>
          <div style={{ marginTop: 6 }}>
            <Radio.Group
              value={format}
              onChange={(e) => setFormat(e.target.value as BookFormat)}
              optionType="button"
              buttonStyle="solid"
            >
              {FORMATS.map((f) => (
                <Radio.Button
                  key={f.value}
                  value={f.value}
                  disabled={f.needPandoc && !pandocOk}
                >
                  {f.label}
                </Radio.Button>
              ))}
            </Radio.Group>
          </div>
          <Space size={16} style={{ marginTop: 8 }} wrap>
            {needPandoc && (
              <Checkbox checked={toc} onChange={(e) => setToc(e.target.checked)}>
                生成目录
              </Checkbox>
            )}
            {canTypeset && (
              <Tooltip title="首行缩进两字符、两端对齐按表意文字断行、章标题另起一页、着重号强调，并写入 lang=zh-CN">
                <Checkbox checked={typeset} onChange={(e) => setTypeset(e.target.checked)}>
                  中文排版优化
                </Checkbox>
              </Tooltip>
            )}
          </Space>
        </div>

        {canCover && (
          <div>
            <Typography.Text strong>封面</Typography.Text>
            <Space style={{ marginTop: 6 }} size={10} align="center">
              <div
                style={{
                  width: 54,
                  height: 72,
                  border: '1px solid var(--lm-border, #d9d9d9)',
                  borderRadius: 4,
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--lm-bg-subtle, #fafafa)'
                }}
              >
                {cover?.dataUrl ? (
                  <img
                    src={cover.dataUrl}
                    alt="封面"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <PictureOutlined style={{ color: '#bfbfbf' }} />
                )}
              </div>
              <Button size="small" onClick={() => setCoverOpen(true)}>
                {cover ? '更换封面' : '设计封面'}
              </Button>
              {cover && (
                <Button size="small" type="text" danger onClick={() => setCover(null)}>
                  清除
                </Button>
              )}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {cover ? '已设置封面，将写入 EPUB' : '不设置也可导出，只是没有封面页'}
              </Typography.Text>
            </Space>
          </div>
        )}

        <div>
          <Space style={{ marginBottom: 6 }}>
            <Typography.Text strong>章节顺序</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              已选 {selected.length} 篇 · 约 {totalWords.toLocaleString()} 字
            </Typography.Text>
          </Space>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <List
                size="small"
                bordered
                dataSource={selected}
                locale={{ emptyText: '从右侧添加要导出的内容' }}
                style={{ maxHeight: 260, overflow: 'auto' }}
                renderItem={(item, index) => (
                  <List.Item
                    actions={[
                      <Tooltip key="up" title="上移">
                        <Button
                          size="small"
                          type="text"
                          icon={<ArrowUpOutlined />}
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                        />
                      </Tooltip>,
                      <Tooltip key="down" title="下移">
                        <Button
                          size="small"
                          type="text"
                          icon={<ArrowDownOutlined />}
                          disabled={index === selected.length - 1}
                          onClick={() => move(index, 1)}
                        />
                      </Tooltip>,
                      <Button
                        key="rm"
                        size="small"
                        type="text"
                        danger
                        onClick={() =>
                          setSelected((prev) =>
                            prev.filter((p) => !(p.kind === item.kind && p.id === item.id))
                          )
                        }
                      >
                        移除
                      </Button>
                    ]}
                  >
                    <List.Item.Meta
                      title={
                        <span style={{ fontSize: 13 }}>
                          {index + 1}. {item.title}
                        </span>
                      }
                      description={
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {KIND_LABEL[item.kind]} · {item.words.toLocaleString()} 字
                        </Typography.Text>
                      }
                    />
                  </List.Item>
                )}
              />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <List
                size="small"
                bordered
                dataSource={remaining}
                locale={{ emptyText: '没有更多内容' }}
                style={{ maxHeight: 260, overflow: 'auto' }}
                renderItem={(item) => (
                  <List.Item
                    actions={[
                      <Button
                        key="add"
                        size="small"
                        type="text"
                        icon={<PlusOutlined />}
                        onClick={() => setSelected((prev) => [...prev, item])}
                      >
                        添加
                      </Button>
                    ]}
                  >
                    <List.Item.Meta
                      title={<span style={{ fontSize: 13 }}>{item.title}</span>}
                      description={
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {KIND_LABEL[item.kind]} · {item.words.toLocaleString()} 字
                        </Typography.Text>
                      }
                    />
                  </List.Item>
                )}
              />
            </div>
          </div>
        </div>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          <ExportOutlined /> 每篇内容作为书中的一章（一级标题），按顺序拼成合稿后转换。
        </Typography.Text>
      </Space>

      <CoverDesigner
        open={coverOpen}
        bookTitle={bookTitle}
        author={author}
        onClose={() => setCoverOpen(false)}
        onPicked={(path, dataUrl) => setCover({ path, dataUrl })}
      />
    </Modal>
  )
}
