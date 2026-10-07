/**
 * 文档处理器：打开主流格式 + 打印
 * 参考 VS Code 预览 / Typora / 本地阅读器布局：工具栏 + 纸感正文
 */
import { formatError } from '../utils/formatError'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Divider, Drawer, Dropdown, Empty, Input, Modal, Radio, Segmented, Select, Space, Spin, Tag, Tooltip, Typography, message } from 'antd'
import {
  ClearOutlined,
  CloseOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  FileAddOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  PrinterOutlined,
  RedoOutlined,
  ReloadOutlined,
  SaveOutlined,
  ScissorOutlined,
  SearchOutlined,
  SwapOutlined,
  TableOutlined,
  ThunderboltOutlined,
  UndoOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
  PlaySquareOutlined
} from '@ant-design/icons'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { PDFDocument } from 'pdf-lib'
import JSZip from 'jszip'
import { downloadBlob } from '../utils/imageTools'
import { renderPdfPages } from '../utils/pdfRender'
import { pdfBytesToHtml } from '../utils/pdfToHtml'
import type { DocOpenResult, SurgicalUnit } from '@shared/types'
import PdfTools, { TOOL_META, type PdfToolKey } from './PdfTools'
import PdfInPlaceEditor, { type PdfInPlaceEditorHandle } from './PdfInPlaceEditor'

const formatBytes = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`

const KIND_TAG: Record<string, { label: string; color: string }> = {
  markdown: { label: 'Markdown', color: 'blue' },
  text: { label: '文本', color: 'default' },
  code: { label: '代码', color: 'geekblue' },
  json: { label: 'JSON', color: 'purple' },
  csv: { label: '表格数据', color: 'cyan' },
  html: { label: 'HTML', color: 'orange' },
  pdf: { label: 'PDF', color: 'red' },
  image: { label: '图片', color: 'green' },
  office: { label: 'Office', color: 'gold' },
  binary: { label: '二进制', color: 'default' }
}

const RECENT_KEY = 'wb-docs-recent'
const MAX_RECENT = 12

/** 可编辑类型：对标 VS Code / Mark Text 的本地文本编辑能力 */
const EDITABLE_KINDS = new Set(['markdown', 'text', 'code', 'json', 'csv', 'html'])

/** 保真编辑（手术式）适用格式：按 doc.ext 判定，编辑的是磁盘上的原始文件 */
const SURGICAL_EXTS = new Set(['.docx', '.odt', '.ods', '.xlsx', '.pptx', '.odp', '.epub', '.doc', '.xls', '.rtf'])
/** legacy 格式：高保真转换编辑（转容器→手术改字→转回原格式），非逐字节保真 */
const LEGACY_SURGICAL_EXTS = new Set(['.doc', '.xls', '.rtf'])

/** 保真编辑渲染上限：单元数 >500 或文本总量 >200KB 时只渲染前 500 个 */
const FAITHFUL_MAX_RENDER = 500
const FAITHFUL_MAX_TEXT = 200 * 1024

const FAITHFUL_KIND_LABEL: Record<SurgicalUnit['kind'], string> = {
  paragraph: '段落',
  cell: '单元格',
  'slide-text': '幻灯片文本',
  'xhtml-block': '网页块'
}

/** Word 编辑：字体列表（系统栈，离线可用） */
const FONT_OPTIONS = [
  { label: '默认', value: '' },
  { label: '宋体', value: 'SimSun' },
  { label: '黑体', value: 'SimHei' },
  { label: '楷体', value: 'KaiTi' },
  { label: '仿宋', value: 'FangSong' },
  { label: '微软雅黑', value: 'Microsoft YaHei' },
  { label: '思源黑体', value: 'Source Han Sans SC' },
  { label: 'Times New Roman', value: 'Times New Roman' },
  { label: 'Arial', value: 'Arial' },
  { label: 'Georgia', value: 'Georgia' }
]

const LINE_HEIGHT_OPTIONS = [
  { label: '1.0', value: '1' },
  { label: '1.25', value: '1.25' },
  { label: '1.5', value: '1.5' },
  { label: '1.75', value: '1.75' },
  { label: '2.0', value: '2' },
  { label: '2.5', value: '2.5' }
]

/** 右键 AI 动作（直接调已配置的 OpenAI 兼容模型） */
const AI_ACTIONS = [
  { key: 'rewrite', label: '改写', hint: '保持原意，换一种说法，更流畅' },
  { key: 'expand', label: '扩写', hint: '在保持核心的前提下丰富细节与层次' },
  { key: 'condense', label: '缩写', hint: '压缩篇幅，保留关键信息' },
  { key: 'polish', label: '润色', hint: '提升文笔与可读性，不改变情节' },
  { key: 'scene', label: '场景增强', hint: '增强画面感、感官细节与节奏' },
  { key: 'deai', label: '去 AI 味', hint: '去掉模板腔，更像人写' },
  { key: 'tone', label: '改基调', hint: '调整语气基调（若用户未指定则偏严肃克制）' },
  { key: 'ask', label: '告诉 AI', hint: '根据上下文给出建议/分析，不要直接替换原文' },
  { key: 'summary', label: '总结', hint: '用要点概括这段内容' },
  { key: 'translate', label: '翻译', hint: '翻译成英文（若原文已是英文则译成中文）' }
] as const

function buildAiPrompt(key: string, text: string, extra?: string): string {
  const item = AI_ACTIONS.find((a) => a.key === key)
  const goal = item?.hint ?? '处理文本'
  return [
    `你是专业中文写作编辑。请对选中文本执行任务：${item?.label ?? key}。`,
    `要求：${goal}。`,
    extra?.trim() ? `附加要求：${extra.trim()}` : '',
    '只输出处理后的正文（若是「告诉 AI」「总结」，可输出简短说明），不要加「以下是」等开场白，不要用代码块包裹。',
    '',
    '【选中文本】',
    text
  ]
    .filter(Boolean)
    .join('\n')
}

function loadRecent(): DocOpenResult[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as DocOpenResult[]
  } catch {
    return []
  }
}

function saveRecent(list: DocOpenResult[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)))
  } catch {
    /* ignore */
  }
}

function formatSize(n?: number): string {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function csvToTableHtml(text: string): string {
  const sep = text.includes('\t') && !text.includes(',') ? '\t' : ','
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length)
  if (!lines.length) return '<p>（空文件）</p>'
  const parse = (line: string): string[] => {
    // 简易 CSV 切分（支持引号）
    const out: string[] = []
    let cur = ''
    let q = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (q) {
        if (c === '"' && line[i + 1] === '"') {
          cur += '"'
          i++
        } else if (c === '"') q = false
        else cur += c
      } else if (c === '"') q = true
      else if (c === sep) {
        out.push(cur)
        cur = ''
      } else cur += c
    }
    out.push(cur)
    return out.map((s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;'))
  }
  const head = parse(lines[0])
  const body = lines.slice(1, 200).map((l) => {
    const cells = parse(l)
    return `<tr>${head.map((_, i) => `<td>${cells[i] ?? ''}</td>`).join('')}</tr>`
  })
  return `<table class="docs-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body.join('')}</tbody></table>${
    lines.length > 200 ? `<p class="docs-note">仅显示前 200 行（共 ${lines.length - 1} 行数据）</p>` : ''
  }`
}

function jsonPretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** base64 → 字节数组（PDF 预览优先复用打开文档时已收到的字节） */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

/** PDF 内容编辑提示条：说明 PDF 如何进入 Word 式编辑，以及扫描件的 OCR 引导 */
function PdfEditHint({
  loading,
  ready,
  needOcr,
  note,
  onEdit
}: {
  loading: boolean
  ready: boolean
  needOcr: boolean
  note?: string
  onEdit: () => void
}) {
  if (loading) {
    return (
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        icon={<Spin size="small" />}
        message="正在提取 PDF 文字内容…"
        description="提取完成后即可切到「Word 模式」像编辑 Word 一样改内容，再导出为新的 PDF。"
      />
    )
  }
  if (needOcr) {
    return (
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message="这份 PDF 没有文字层（扫描件/图片型）"
        description={
          <span>
            {note || '无法提取可编辑文字。'}
            {' 可先用上方 PDF 工具的「PDF 文本提取」走 OCR 识别，再复制内容编辑。'}
          </span>
        }
      />
    )
  }
  if (ready) {
    return (
      <Alert
        type="success"
        showIcon
        style={{ marginBottom: 12 }}
        message="可以直接编辑这份 PDF 的文字内容"
        description={
          <Space size={8} wrap>
            <span>
              「编辑内容（保版式）」：在原页面上点哪行改哪行，导出后图片、色块与版式保持不变；「Word 模式（重排导出）」可套用完整排版菜单，但会重排成文档版式。
            </span>
            <Button size="small" type="primary" onClick={onEdit}>
              原样改字
            </Button>
          </Space>
        }
      />
    )
  }
  if (note) {
    return <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={note} />
  }
  return <></>
}

export default function DocsViewer() {
  /** 当前激活的 PDF 工具（null = 文档视图） */
  const [pdfTool, setPdfTool] = useState<PdfToolKey | null>(null)
  /** 右侧辅助抽屉（浮层，无遮罩）：编辑模式=实时预览 · 工具模式=参数面板。
   *  主舞台永远完整一块，辅助信息不挤压内容区，也没有固定上下/左右分栏。 */
  const [auxOpen, setAuxOpen] = useState(false)
  /** PDF 工具参数面板是否折叠（内嵌在统一舞台里，默认展开） */
  /** PDF 页面预览（pdf.js 渲染；Electron iframe 不带 PDF 查看器插件，blob URL 会白屏） */
  const [pdfPreview, setPdfPreview] = useState<{ pages: string[]; total: number; loading: boolean }>({
    pages: [],
    total: 0,
    loading: false
  })
  /** PDF 文本层 → 可编辑 HTML（让 PDF 也进 Word 模式，套用同一套完整菜单） */
  const [pdfEdit, setPdfEdit] = useState<{ loading: boolean; html: string; needOcr: boolean; note?: string }>({
    loading: false,
    html: '',
    needOcr: false
  })
  const [doc, setDoc] = useState<DocOpenResult | null>(null)
  /** 保版式编辑器（PdfInPlaceEditor）的保存能力：顶部「保存」必须直接驱动它，
   *  否则用户的就地改动没有任何常规保存入口 —— 曾表现为「修改后点保存没有改变」。 */
  const pdfEditorRef = useRef<PdfInPlaceEditorHandle | null>(null)
  /** 保版式编辑器里未保存的改动处数（文字 + 批注） */
  const [inplacePending, setInplacePending] = useState(0)
  /** 离开保版式编辑器时的三选弹窗（受控，避免 Esc/遮罩静默丢弃改动） */
  const [leaveAsk, setLeaveAsk] = useState(false)
  const [leaveSaving, setLeaveSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [zoom, setZoom] = useState(100)
  // 整合后不再有「左右分屏」模式：编辑与预览通过视图切换在同一区域内互斥呈现
  const [mode, setMode] = useState<'preview' | 'source' | 'edit' | 'rich' | 'inplace' | 'faithful'>('preview')

  /* ---------- 保真编辑（手术式：只改文字，不动字体/表格/图片/分页） ---------- */
  const [faithfulLoading, setFaithfulLoading] = useState(false)
  const [faithfulError, setFaithfulError] = useState('')
  const [faithfulUnits, setFaithfulUnits] = useState<SurgicalUnit[]>([])
  const [faithfulNote, setFaithfulNote] = useState('')
  const [faithfulValues, setFaithfulValues] = useState<Record<string, string>>({})
  const [faithfulFilter, setFaithfulFilter] = useState('')
  const [faithfulSaving, setFaithfulSaving] = useState(false)
  /** 离开保真编辑（有未保存修改）时的确认弹窗 */
  const [faithfulLeaveAsk, setFaithfulLeaveAsk] = useState(false)
  const afterFaithfulLeaveRef = useRef<(() => void) | null>(null)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [recent, setRecent] = useState<DocOpenResult[]>(() => loadRecent())
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  /** 另存为：格式选择弹窗 */
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [saveAsFormat, setSaveAsFormat] = useState('')
  // 查找替换
  const [findOpen, setFindOpen] = useState(false)
  const [findQ, setFindQ] = useState('')
  const [replaceQ, setReplaceQ] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  // 撤销栈（编辑区快照，上限 100）
  const undoRef = useRef<string[]>([])
  const redoRef = useRef<string[]>([])
  const draftRef = useRef('')
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const printRef = useRef<HTMLDivElement>(null)

  const canEdit = !!(doc?.ok && doc.kind && EDITABLE_KINDS.has(doc.kind) && doc.text != null)
  /** Word 模式的 HTML 源：DOCX/HTML 直接用 doc.html；PDF 用文本层提取结果 */
  const wordHtml = doc?.kind === 'pdf' ? pdfEdit.html : (doc?.html ?? '')
  /** PDF 原始字节（保版式改字编辑器需要；来源与预览一致，优先用打开时已下发的 base64） */
  const pdfBytesInline = useMemo(
    () => (doc?.ok && doc.kind === 'pdf' && doc.base64 ? base64ToBytes(doc.base64) : null),
    [doc?.ok, doc?.kind, doc?.base64]
  )
  /** 最近打开/无 base64 时从磁盘补读；否则保版式编辑器拿到 null 会整页空白 */
  const [pdfBytesDisk, setPdfBytesDisk] = useState<Uint8Array | null>(null)
  useEffect(() => {
    setPdfBytesDisk(null)
    if (!doc?.ok || doc.kind !== 'pdf') return
    if (pdfBytesInline?.byteLength) return
    if (!doc.path) return
    let cancelled = false
    void (async () => {
      try {
        const b = await window.api.pdf.read(doc.path!)
        if (!cancelled && b?.byteLength) setPdfBytesDisk(b)
      } catch {
        /* 保版式编辑器会显示错误态 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [doc?.ok, doc?.kind, doc?.path, pdfBytesInline])
  const pdfBytes = pdfBytesInline?.byteLength ? pdfBytesInline : pdfBytesDisk
  const isWordLike = !!(doc?.ok && (doc.kind === 'office' || doc.kind === 'html' || doc.kind === 'pdf') && wordHtml)

  // 无论从哪条路径进入编辑模式（顶栏按钮 / 视图切换 / 快捷键），都同步打开右侧实时预览。
  // 用户手动关闭抽屉后 mode 不变，不会被反复拉起；再次进入编辑时才重新打开。
  useEffect(() => {
    if (mode === 'edit' && canEdit && !isWordLike) setAuxOpen(true)
  }, [mode, canEdit, isWordLike])

  const richRef = useRef<HTMLDivElement | null>(null)
  const [richHtml, setRichHtml] = useState('')
  const [richDirty, setRichDirty] = useState(false)
  // 字体 / 段落
  const [fontFamily, setFontFamily] = useState('')
  const [lineHeight, setLineHeight] = useState('1.75')
  // 右键 AI
  const [aiMenu, setAiMenu] = useState<{ x: number; y: number; text: string } | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiAction, setAiAction] = useState<string>('')
  const [aiExtra, setAiExtra] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiResult, setAiResult] = useState('')
  const savedRangeRef = useRef<Range | null>(null)
  const textForRender = canEdit ? draft : (doc?.text ?? '')

  useEffect(() => {
    draftRef.current = draft
  }, [draft])

  useEffect(() => {
    if (isWordLike && wordHtml) {
      setRichHtml(wordHtml)
      setRichDirty(false)
    }
  }, [isWordLike, wordHtml])

  /** 仅在打开文档/切到 Word 视图时写入 DOM，打字过程中不再覆写（防跳动/丢字） */
  const richLoadedToken = useRef('')
  useEffect(() => {
    if (!isWordLike || mode !== 'rich' || !wordHtml) return
    const token = `${doc?.path ?? ''}|${wordHtml.length}|${doc?.size ?? 0}`
    if (richLoadedToken.current === token && richRef.current?.innerHTML) return
    // 等 DOM 挂载（key 重挂后 ref 需要一帧）
    const t = window.setTimeout(() => {
      const el = richRef.current
      if (!el) return
      el.innerHTML = DOMPurify.sanitize(wordHtml || '', {
        ADD_TAGS: ['img', 'table', 'tbody', 'thead', 'tr', 'td', 'th', 'blockquote', 'span'],
        ADD_ATTR: ['src', 'colspan', 'rowspan', 'class', 'style']
      })
      richLoadedToken.current = token
      setRichDirty(false)
    }, 0)
    return () => window.clearTimeout(t)
  }, [isWordLike, mode, doc?.path, wordHtml, doc?.size])

  const pushUndo = useCallback((prev: string) => {
    undoRef.current.push(prev)
    if (undoRef.current.length > 100) undoRef.current.shift()
    redoRef.current = []
  }, [])

  const setDraftWithUndo = useCallback(
    (next: string) => {
      const prev = draftRef.current
      if (prev === next) return
      pushUndo(prev)
      draftRef.current = next
      setDraft(next)
      setDirty(true)
    },
    [pushUndo]
  )

  const doUndo = useCallback(() => {
    const prev = undoRef.current.pop()
    if (prev === undefined) {
      message.info('没有可撤销的操作')
      return
    }
    redoRef.current.push(draftRef.current)
    draftRef.current = prev
    setDraft(prev)
    setDirty(true)
  }, [])

  const doRedo = useCallback(() => {
    const next = redoRef.current.pop()
    if (next === undefined) {
      message.info('没有可重做的操作')
      return
    }
    undoRef.current.push(draftRef.current)
    draftRef.current = next
    setDraft(next)
    setDirty(true)
  }, [])

  const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  const matchCount = useMemo(() => {
    if (!canEdit || !findQ) return 0
    try {
      const re = new RegExp(escapeRe(findQ), matchCase ? 'g' : 'gi')
      return (draft.match(re) || []).length
    } catch {
      return 0
    }
  }, [canEdit, findQ, matchCase, draft])

  const doReplaceAll = useCallback(() => {
    if (!canEdit || !findQ) return
    try {
      const re = new RegExp(escapeRe(findQ), matchCase ? 'g' : 'gi')
      const next = draft.replace(re, replaceQ)
      if (next === draft) {
        message.info('未找到匹配项')
        return
      }
      setDraftWithUndo(next)
      message.success('已全部替换')
    } catch (err) {
      message.error(formatError(err))
    }
  }, [canEdit, findQ, replaceQ, matchCase, draft, setDraftWithUndo])

  const doReplaceOne = useCallback(() => {
    if (!canEdit || !findQ) return
    const idx = matchCase ? draft.indexOf(findQ) : draft.toLowerCase().indexOf(findQ.toLowerCase())
    if (idx < 0) {
      message.info('未找到匹配项')
      return
    }
    const next = draft.slice(0, idx) + replaceQ + draft.slice(idx + findQ.length)
    setDraftWithUndo(next)
    message.success('已替换一处')
  }, [canEdit, findQ, replaceQ, matchCase, draft, setDraftWithUndo])

  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [blobUrl])

  // PDF 页面预览：pdf.js 分批渲染（前 30 页），替代不可用的 iframe 方案
  useEffect(() => {
    if (!doc?.ok || doc.kind !== 'pdf' || !doc.path) {
      setPdfPreview({ pages: [], total: 0, loading: false })
      return
    }
    let cancelled = false
    setPdfPreview((p) => ({ pages: [], total: 0, loading: true }))
    void (async () => {
      try {
        // 优先复用「打开文档」时已下发的 base64 字节：避免再走一次跨模块读 IPC
        // （pdf:read 路径授权依赖会话白名单，早期曾因打包重复实例导致永远被拒）
        const inline = doc.base64 ? base64ToBytes(doc.base64) : null
        const bytes = inline && inline.byteLength ? inline : await window.api.pdf.read(doc.path!)
        if (!bytes || !bytes.byteLength) throw new Error('读取 PDF 失败')
        const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true })
        const total = pdfDoc.getPageCount()
        const indices = Array.from({ length: Math.min(30, total) }, (_, i) => i)
        await new Promise((r) => setTimeout(r, 0)) // 加载态先上屏
        const pages = await renderPdfPages(bytes, indices, { scale: 1.4, maxSide: 1100 })
        if (cancelled) return
        setPdfPreview({
          pages: pages.map((p) => p.canvas.toDataURL('image/jpeg', 0.82)),
          total,
          loading: false
        })
      } catch (err) {
        if (!cancelled) {
          message.error('PDF 预览失败（文件可能受密码保护或已损坏）：' + formatError(err))
          setPdfPreview({ pages: [], total: 0, loading: false })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [doc?.path, doc?.kind, doc?.ok])

  // PDF → 可编辑 HTML：让 PDF 也能进 Word 模式（同一套完整菜单），提取在后台进行
  useEffect(() => {
    if (!doc?.ok || doc.kind !== 'pdf' || !doc.path) {
      setPdfEdit({ loading: false, html: '', needOcr: false })
      return
    }
    let cancelled = false
    setPdfEdit({ loading: true, html: '', needOcr: false })
    void (async () => {
      try {
        const bytes = doc.base64 ? base64ToBytes(doc.base64) : await window.api.pdf.read(doc.path!)
        if (!bytes || !bytes.byteLength) throw new Error('读取 PDF 失败')
        const r = await pdfBytesToHtml(bytes, { maxPages: 200 })
        if (cancelled) return
        setPdfEdit({ loading: false, html: r.html, needOcr: r.needOcr, note: r.note })
      } catch (err) {
        if (!cancelled) {
          setPdfEdit({ loading: false, html: '', needOcr: false, note: `文本层提取失败：${formatError(err)}` })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [doc?.path, doc?.kind, doc?.ok, doc?.base64])

  const pushRecent = useCallback((d: DocOpenResult) => {
    if (!d.path) return
    const next = [{ ...d, base64: undefined, text: d.text && d.text.length < 20000 ? d.text : undefined, html: undefined }, ...loadRecent().filter((x) => x.path !== d.path)]
    saveRecent(next)
    setRecent(loadRecent())
  }, [])

  const applyDoc = useCallback((d: DocOpenResult) => {
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl)
      setBlobUrl(null)
    }
    if (!d.ok) {
      if (d.error !== 'cancelled') {
        setDoc(d)
        message.error(d.error ?? '打开失败')
      }
      return
    }
    if (d.base64 && d.mime) {
      const bin = atob(d.base64)
      const arr = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
      const url = URL.createObjectURL(new Blob([arr], { type: d.mime }))
      setBlobUrl(url)
    }
    setDoc(d)
    setDraft(d.text ?? '')
    draftRef.current = d.text ?? ''
    undoRef.current = []
    redoRef.current = []
    setDirty(false)
    setFindOpen(false)
    setFindQ('')
    setReplaceQ('')
    if (d.html) {
      setRichHtml(d.html)
      setRichDirty(false)
      setMode('rich')
    } else if (d.kind === 'markdown') setMode('preview')
    else if (d.kind === 'code' || d.kind === 'json' || d.kind === 'csv' || d.kind === 'text') setMode('source')
    // PDF 默认进保版式编辑：像 WPS 一样直接看见页面并点击改字，不动版式
    // 表格（xlsx 等）转出的 PDF 预览不进就地编辑——保真编辑走手术链路，不是 PDF 就地编辑
    else if (d.kind === 'pdf') setMode(d.sourceKind === 'spreadsheet' ? 'preview' : 'inplace')
    else setMode('preview')
    setZoom(100)
    pushRecent(d)
  }, [blobUrl, pushRecent])

  const openPick = useCallback(async () => {
    setLoading(true)
    try {
      const d = await window.api.docs.pick()
      if (d) applyDoc(d)
    } catch (err) {
      message.error(formatError(err))
    } finally {
      setLoading(false)
    }
  }, [applyDoc])

  const openPath = useCallback(
    async (path: string) => {
      setLoading(true)
      try {
        const d = await window.api.docs.openPath(path)
        applyDoc(d)
      } catch (err) {
        message.error(formatError(err))
      } finally {
        setLoading(false)
      }
    },
    [applyDoc]
  )

  const doPrint = useCallback(async () => {
    if (!doc?.ok) {
      message.warning('请先打开文档')
      return
    }
    const r = await window.api.docs.print()
    if (!r.ok && r.error && r.error !== 'cancelled') message.warning(r.error)
  }, [doc])

  const execRich = useCallback((cmd: string, value?: string) => {
    richRef.current?.focus()
    try {
      document.execCommand(cmd, false, value)
    } catch {
      /* ignore */
    }
    setRichDirty(true)
  }, [])

  /** 从 DOM 读取当前富文本（保存/导出用，避免输入时 setState 重绘导致跳动） */
  const getRichDomHtml = useCallback((): string => {
    return richRef.current?.innerHTML ?? ''
  }, [])

  /** 对选区或整篇应用行高/字体 */
  const applyRichStyle = useCallback(
    (patch: { fontFamily?: string; lineHeight?: string }) => {
      const root = richRef.current
      if (!root) return
      const sel = window.getSelection()
      const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null
      const inEditor = range && root.contains(range.commonAncestorContainer)
      if (inEditor && range && !range.collapsed) {
        const span = document.createElement('span')
        if (patch.fontFamily) span.style.fontFamily = patch.fontFamily
        if (patch.lineHeight) span.style.lineHeight = patch.lineHeight
        try {
          range.surroundContents(span)
        } catch {
          span.appendChild(range.extractContents())
          range.insertNode(span)
        }
      } else {
        if (patch.fontFamily !== undefined) root.style.fontFamily = patch.fontFamily || 'inherit'
        if (patch.lineHeight !== undefined) root.style.lineHeight = patch.lineHeight
      }
      setRichDirty(true)
    },
    []
  )

  /** 段落：缩进 / 引用 / 行距到选中段 */
  const applyParagraph = useCallback(
    (kind: 'indent' | 'outdent' | 'quote' | 'unquote' | 'spaceLoose' | 'spaceTight') => {
      const root = richRef.current
      if (!root) return
      if (kind === 'indent') execRich('indent')
      else if (kind === 'outdent') execRich('outdent')
      else if (kind === 'quote') execRich('formatBlock', 'blockquote')
      else if (kind === 'unquote') execRich('formatBlock', 'p')
      else if (kind === 'spaceLoose') applyRichStyle({ lineHeight: '2' })
      else if (kind === 'spaceTight') applyRichStyle({ lineHeight: '1.35' })
    },
    [execRich, applyRichStyle]
  )

  const saveSelection = useCallback(() => {
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0)
      if (richRef.current?.contains(r.commonAncestorContainer)) {
        savedRangeRef.current = r.cloneRange()
        return sel.toString()
      }
    }
    return ''
  }, [])

  const onRichContextMenu = useCallback((e: React.MouseEvent) => {
    // 全局 AiSelectMenu 已处理选中右键；此处仅避免浏览器默认菜单干扰
    const sel = window.getSelection()
    if (sel && sel.toString().trim()) {
      e.preventDefault()
    }
  }, [])

  const openAiAction = useCallback(
    (key: string) => {
      if (!aiMenu?.text) return
      setAiAction(key)
      setAiExtra('')
      setAiResult('')
      setAiOpen(true)
      setAiMenu(null)
      // 自动跑一次
      setAiLoading(true)
      void window.api.ai
        .complete([{ role: 'user', content: buildAiPrompt(key, aiMenu.text) }])
        .then((r) => {
          if (r.ok) setAiResult((r.text ?? '').trim())
          else setAiResult('AI 调用失败：' + (r.error ?? '请先在设置中配置模型'))
        })
        .catch((err) => setAiResult((err as Error).message))
        .finally(() => setAiLoading(false))
    },
    [aiMenu]
  )

  const runAiAgain = useCallback(async () => {
    if (!aiMenu?.text || !aiAction) return
    setAiLoading(true)
    setAiResult('')
    try {
      const r = await window.api.ai.complete([{ role: 'user', content: buildAiPrompt(aiAction, aiMenu.text, aiExtra) }])
      if (r.ok) setAiResult((r.text ?? '').trim())
      else setAiResult('AI 调用失败：' + (r.error ?? '请配置 AI'))
    } catch (err) {
      setAiResult((err as Error).message)
    } finally {
      setAiLoading(false)
    }
  }, [aiMenu, aiAction, aiExtra])

  const replaceSelectionWith = useCallback(
    (text: string) => {
      const root = richRef.current
      if (!root || !text) return
      const range = savedRangeRef.current
      root.focus()
      try {
        if (range && root.contains(range.commonAncestorContainer)) {
          range.deleteContents()
          const node = document.createTextNode(text)
          range.insertNode(node)
          const after = document.createRange()
          after.setStartAfter(node)
          after.collapse(true)
          const sel = window.getSelection()
          sel?.removeAllRanges()
          sel?.addRange(after)
        } else {
          execRich('insertText', text)
          return
        }
        setRichDirty(true)
        message.success('已替换选中内容')
      } catch {
        execRich('insertText', text)
      }
    },
    [execRich]
  )

  const onRichInput = useCallback(() => {
    // 只标脏，不写回 state —— 避免 dangerouslySetInnerHTML 重绘导致光标跳到顶部
    setRichDirty(true)
  }, [])

  const exportRichDocx = useCallback(async () => {
    const html = getRichDomHtml() || richHtml
    const base = (doc?.name || '文档').replace(/\.[^.]+$/, '')
    const r = await window.api.docs.saveDocxAs(html, `${base}.docx`)
    if (r.ok) message.success('已导出 Word 文档')
    else if (r.error && r.error !== 'cancelled') message.error(r.error)
  }, [getRichDomHtml, richHtml, doc?.name])

  const exportRichHtml = useCallback(async () => {
    const html = getRichDomHtml() || richHtml
    const base = (doc?.name || '文档').replace(/\.[^.]+$/, '')
    const r = await window.api.docs.saveHtmlAs(html, `${base}.html`)
    if (r.ok) message.success('已导出 HTML')
    else if (r.error && r.error !== 'cancelled') message.error(r.error)
  }, [getRichDomHtml, richHtml, doc?.name])

  /** 导出 PDF：待编辑的富文本 HTML → LibreOffice → PDF 文件（另存为，不覆盖原 PDF） */
  const exportRichPdf = useCallback(async () => {
    const html = getRichDomHtml() || richHtml
    if (!html.trim()) {
      message.warning('当前没有可导出的内容')
      return
    }
    setSaving(true)
    try {
      const r = await window.api.docs.saveAsFormat({
        source: 'html',
        content: html,
        defaultName: doc?.name || '未命名',
        format: 'pdf'
      })
      if (r.ok && r.path) message.success('已导出 PDF：' + r.path)
      else if (r.error && r.error !== 'cancelled') message.error(r.error)
    } catch (err) {
      message.error(formatError(err))
    } finally {
      setSaving(false)
    }
  }, [getRichDomHtml, richHtml, doc?.name])

  /** Word 模式：保存回原文件 */
  const doSaveOffice = useCallback(async () => {
    if (!doc?.path || !isWordLike) return
    // PDF 编辑的是文本层（重排导出），写回原 .pdf 会损坏文件 —— 一律走「导出 PDF」另存
    if (doc.kind === 'pdf') {
      // 关键：不在 Word 模式时，能拿到的只有「文本层提取结果」，不含用户刚做的就地修改。
      // 这里若静默导出，用户看到的就是「点了保存但内容没变」——必须先明确引导。
      if (mode !== 'rich') {
        message.warning(
          'PDF 要先选编辑方式：顶部「编辑内容」可保原版式改字（保存会覆盖原文件并自动备份）；'
          + '切到「Word 模式（重排导出）」则重排成文档版式。'
        )
        return
      }
      await exportRichPdf()
      return
    }
    setSaving(true)
    try {
      const html = getRichDomHtml() || richHtml
      const r = await window.api.docs.saveOffice(doc.path, html)
      if (r.ok) {
        setRichDirty(false)
        message.success(r.note ? `已保存 · ${r.note}` : '已保存')
      } else {
        message.error(r.error ?? '保存失败')
      }
    } finally {
      setSaving(false)
    }
  }, [doc, isWordLike, mode, richHtml, getRichDomHtml, exportRichPdf])

  const doSaveRef = useRef<() => Promise<void>>(async () => undefined)
  const execRichRef = useRef<(cmd: string, value?: string) => void>(() => undefined)

  /* ==================== 保真编辑（手术式） ==================== */

  /** 有改动的单元数（newText 与原文不同） */
  const faithfulChanges = useMemo(
    () => faithfulUnits.reduce((n, u) => ((faithfulValues[u.id] ?? u.text) !== u.text ? n + 1 : n), 0),
    [faithfulUnits, faithfulValues]
  )
  const faithfulFiltered = useMemo(() => {
    const q = faithfulFilter.trim()
    return q ? faithfulUnits.filter((u) => u.text.includes(q)) : faithfulUnits
  }, [faithfulUnits, faithfulFilter])
  const faithfulVisible = useMemo(() => faithfulFiltered.slice(0, FAITHFUL_MAX_RENDER), [faithfulFiltered])

  const resetFaithful = useCallback(() => {
    setFaithfulUnits([])
    setFaithfulValues({})
    setFaithfulFilter('')
    setFaithfulError('')
    setFaithfulNote('')
    setFaithfulLoading(false)
  }, [])

  /** 进入保真编辑：抽取原始文件的可编辑文本单元 */
  const enterFaithful = useCallback(async () => {
    if (!doc?.ok || !doc.path) return
    setMode('faithful')
    setFaithfulLoading(true)
    setFaithfulError('')
    setFaithfulUnits([])
    setFaithfulValues({})
    setFaithfulFilter('')
    setFaithfulNote('')
    // 让 loading 态先上屏，再开始重活（项目纪律）
    await new Promise((r) => setTimeout(r, 0))
    try {
      const r = await window.api.docs.surgicalExtract(doc.path)
      if (!r.ok) {
        setFaithfulError(r.error ?? '无法提取文档文本单元')
        setFaithfulUnits([])
      } else {
        setFaithfulUnits(r.units ?? [])
        setFaithfulValues(Object.fromEntries((r.units ?? []).map((u) => [u.id, u.text])))
        setFaithfulNote(r.note ?? '')
      }
    } catch (err) {
      setFaithfulError(formatError(err))
    } finally {
      setFaithfulLoading(false)
    }
  }, [doc])

  /** 保存：把有改动的单元写回原始文件（主进程留 .bak 备份），成功后刷新预览 */
  const doFaithfulSave = useCallback(async () => {
    if (!doc?.path) return
    const edits = faithfulUnits
      .filter((u) => (faithfulValues[u.id] ?? u.text) !== u.text)
      .map((u) => ({ id: u.id, newText: faithfulValues[u.id] ?? u.text }))
    if (edits.length === 0) {
      message.info('无修改，未写盘')
      return
    }
    setFaithfulSaving(true)
    try {
      const r = await window.api.docs.surgicalApply(doc.path, edits)
      if (!r.ok) {
        message.error(r.error ?? '写回失败，原文件未改动')
        return
      }
      if (r.skipped?.length) {
        const reasons = Array.from(new Set(r.skipped.map((s) => s.reason))).join('；')
        message.warning(`${r.skipped.length} 处未能写回：${reasons.slice(0, 160)}`)
      }
      if ((r.changedCount ?? 0) > 0) {
        message.success(`已更新原文（备份：${(r.backupPath ?? '').split(/[\\/]/).pop() ?? ''}）`)
        resetFaithful()
        try {
          const d = await window.api.docs.openPath(doc.path)
          applyDoc(d)
        } catch (err) {
          message.error(formatError(err))
        }
        setMode('preview')
      } else {
        message.info('无修改，未写盘')
        resetFaithful()
        setMode('preview')
      }
    } finally {
      setFaithfulSaving(false)
    }
  }, [doc, faithfulUnits, faithfulValues, applyDoc, resetFaithful])

  /** 放弃：丢弃内存中的修改（原文件从未被改动，无需备份担心） */
  const doFaithfulDiscard = useCallback(() => {
    const discard = () => {
      resetFaithful()
      setMode('preview')
    }
    if (faithfulChanges > 0) {
      Modal.confirm({
        title: `放弃 ${faithfulChanges} 处未保存的修改？`,
        content: '磁盘上的原文件不受影响，只是丢弃这次编辑。',
        okText: '放弃修改',
        okButtonProps: { danger: true },
        cancelText: '继续编辑',
        onOk: discard
      })
      return
    }
    discard()
  }, [faithfulChanges, resetFaithful])

  /** 统一保存：就地编辑 / 文本编辑 / Word 视图 */
  const doUnifiedSave = useCallback(async () => {
    // 保真编辑：保存 = 手术式写回原始文件
    if (mode === 'faithful') {
      await doFaithfulSave()
      return
    }
    // 保版式就地编辑：保存 = 覆盖原 PDF（编辑器内部先在同目录备份再写回）
    if (mode === 'inplace') {
      const api = pdfEditorRef.current
      if (!api) {
        message.warning('编辑器还在准备中，请稍候再保存')
        return
      }
      if (api.pendingCount() === 0) {
        message.info('没有需要保存的改动')
        return
      }
      await api.saveToOriginal()
      return
    }
    if (isWordLike && (mode === 'rich' || richDirty || mode === 'source')) {
      await doSaveOffice()
      return
    }
    if (canEdit) {
      await doSaveRef.current()
      return
    }
    if (isWordLike) {
      await doSaveOffice()
      return
    }
    message.warning('当前文档没有可保存的编辑内容')
  }, [isWordLike, mode, richDirty, canEdit, doSaveOffice, doFaithfulSave])

  /** 关闭文档 */
  const doClose = useCallback(() => {
    const dirtyAny = dirty || richDirty || inplacePending > 0 || (mode === 'faithful' && faithfulChanges > 0)
    const finish = () => {
      setDoc(null)
      setDraft('')
      draftRef.current = ''
      setRichHtml('')
      setRichDirty(false)
      setDirty(false)
      setInplacePending(0)
      setFindOpen(false)
      resetFaithful()
      setMode('preview')
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl)
        setBlobUrl(null)
      }
    }
    if (!dirtyAny) {
      finish()
      return
    }
    Modal.confirm({
      title: '关闭文档？',
      content: '有未保存的修改，关闭后将丢失。',
      okText: '仍要关闭',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: finish
    })
  }, [dirty, richDirty, inplacePending, mode, faithfulChanges, blobUrl, resetFaithful])

  /** 离开保版式编辑器：有未保存改动时用**受控三选**弹窗，
   *  不能用 Modal.confirm —— 它的 onCancel 会被 Esc / 点遮罩触发，
   *  而"丢弃未保存的编辑"是不可逆的用户数据损失。 */
  /** 离开保版式编辑器的**统一出口**：任何会卸载编辑器或重载文档的动作都必须先过这里。
   *  这里用 ref 记住「离开后要做什么」，所以丢弃/保存两条路径都不会丢掉用户的原意图。 */
  const afterLeaveRef = useRef<(() => void) | null>(null)

  const guardInplaceExit = useCallback(
    (next: () => void) => {
      if (mode === 'inplace' && inplacePending > 0) {
        afterLeaveRef.current = next
        setLeaveAsk(true)
        return
      }
      // 保真编辑：有未保存修改时切走需确认（原文件未被改动，确认即可丢弃）
      if (mode === 'faithful' && faithfulChanges > 0) {
        afterFaithfulLeaveRef.current = next
        setFaithfulLeaveAsk(true)
        return
      }
      next()
    },
    [mode, inplacePending, faithfulChanges]
  )

  const finishFaithfulLeave = useCallback(() => {
    const next = afterFaithfulLeaveRef.current
    afterFaithfulLeaveRef.current = null
    setFaithfulLeaveAsk(false)
    resetFaithful()
    if (next) next()
    else setMode('preview')
  }, [resetFaithful])

  const finishLeave = useCallback(() => {
    const next = afterLeaveRef.current
    afterLeaveRef.current = null
    setLeaveAsk(false)
    setInplacePending(0)
    if (next) next()
    else setMode('preview')
  }, [])

  const doLeaveSaving = useCallback(async () => {
    setLeaveSaving(true)
    try {
      const ok = await pdfEditorRef.current?.saveToOriginal()
      if (ok) finishLeave()
    } finally {
      setLeaveSaving(false)
    }
  }, [finishLeave])

  const doSave = useCallback(async () => {
    if (!doc?.path || !canEdit) {
      message.warning('当前文档不可编辑保存')
      return
    }
    setSaving(true)
    try {
      const r = await window.api.docs.save(doc.path, draft)
      if (r.ok) {
        setDirty(false)
        setDoc((prev) => (prev ? { ...prev, text: draft } : prev))
        message.success('已保存')
      } else {
        message.error(r.error ?? '保存失败')
      }
    } finally {
      setSaving(false)
    }
  }, [doc, canEdit, draft])

  useEffect(() => {
    doSaveRef.current = doSave
  }, [doSave])

  useEffect(() => {
    execRichRef.current = execRich
  }, [execRich])

  // 注意：不要再给 doSaveRef 赋「doUnifiedSave」之类包装——doUnifiedSave 内部会调
  // doSaveRef.current()，覆盖成自身会造成自递归卡死（曾出现：打开 txt 后按 Ctrl+S 冻结）。

  // 快捷键：Ctrl+S 保存 · Ctrl+F 查找 · Ctrl+Z/Y 撤销重做 · Ctrl+W 关闭
  useEffect(() => {
    if (!canEdit && !isWordLike) return
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const k = e.key.toLowerCase()
      if (k === 'f') {
        if (!canEdit) return
        e.preventDefault()
        setFindOpen(true)
        setMode((m) => (m === 'preview' || m === 'source' ? 'edit' : m))
      } else if (k === 's') {
        e.preventDefault()
        void doUnifiedSave()
      } else if (k === 'w') {
        e.preventDefault()
        doClose()
      } else if (k === 'z' && !e.shiftKey) {
        e.preventDefault()
        if (isWordLike && mode === 'rich') execRichRef.current('undo')
        else doUndo()
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault()
        if (isWordLike && mode === 'rich') execRichRef.current('redo')
        else doRedo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canEdit, isWordLike, mode, doc?.kind, doUndo, doRedo, doUnifiedSave, doClose])

  /** 另存为：按文档类型给出可选格式清单（不承诺不存在的格式） */
  const saveAsOptions = useMemo<Array<{ value: string; label: string; viaPandoc?: boolean }>>(() => {
    if (!doc?.ok) return []
    if (isWordLike) {
      return [
        { value: 'pdf', label: 'PDF 文档（.pdf）' },
        { value: 'docx', label: 'Word 文档（.docx）', viaPandoc: true },
        { value: 'odt', label: 'OpenDocument（.odt）', viaPandoc: true },
        { value: 'rtf', label: 'RTF 富文本（.rtf）', viaPandoc: true },
        { value: 'epub', label: 'EPUB 电子书（.epub）', viaPandoc: true },
        { value: 'html', label: 'HTML 网页（.html）' },
        { value: 'md', label: 'Markdown（.md）', viaPandoc: true }
      ]
    }
    if (doc.kind === 'markdown') {
      return [
        { value: 'md', label: 'Markdown（.md）' },
        { value: 'txt', label: '纯文本（.txt）' },
        { value: 'html', label: 'HTML 网页（.html）', viaPandoc: true },
        { value: 'docx', label: 'Word 文档（.docx）', viaPandoc: true },
        { value: 'odt', label: 'OpenDocument（.odt）', viaPandoc: true }
      ]
    }
    const ext = (doc.ext || '.txt').replace(/^\./, '')
    return [
      { value: ext, label: `原格式（.${ext}）` },
      { value: 'txt', label: '纯文本（.txt）' }
    ]
  }, [doc, isWordLike])

  const openSaveAs = useCallback(() => {
    if (!canEdit && !isWordLike) {
      message.warning('当前文档不支持另存（仅文本 / Markdown / Word 类文档可另存）')
      return
    }
    setSaveAsFormat(saveAsOptions[0]?.value || '')
    setSaveAsOpen(true)
  }, [canEdit, isWordLike, saveAsOptions])

  const doSaveAsConfirm = useCallback(async () => {
    if (!saveAsFormat) return
    const wordLike = isWordLike
    setSaveAsOpen(false)
    setSaving(true)
    try {
      const r = await window.api.docs.saveAsFormat({
        source: wordLike ? 'html' : 'text',
        content: wordLike ? getRichDomHtml() || richHtml : draft,
        defaultName: doc?.name || '未命名',
        format: saveAsFormat
      })
      if (r.ok && r.path) {
        message.success('已另存：' + r.path)
        // 与现有保存逻辑一致：另存后切换到新文件
        const reopened = await window.api.docs.openPath(r.path)
        applyDoc(reopened)
      } else if (r.error && r.error !== 'cancelled') {
        message.error(r.error)
      }
    } catch (err) {
      message.error(formatError(err))
    } finally {
      setSaving(false)
    }
  }, [saveAsFormat, isWordLike, richHtml, draft, doc, applyDoc, getRichDomHtml])

  const doClearContent = useCallback(() => {
    if (!canEdit) return
    Modal.confirm({
      title: '清空文档内容？',
      content: '将清空编辑器中的全部文本；保存前可「重新加载」从磁盘恢复。',
      okText: '清空',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => {
        setDraft('')
        setDirty(true)
        message.success('已清空编辑区（未保存到磁盘）')
      }
    })
  }, [canEdit])

  /* ---------- PPT 工具（sourceKind==='slides' 时可用） ----------
   * 解包/生成/压缩在渲染层完成（jszip + pptxgenjs，vite 打包）；
   * 需要 LibreOffice 的 pptx→pdf 走主进程 ppt:to-pdf。 */

  const [pptBusy, setPptBusy] = useState('')
  const [pptTextModal, setPptTextModal] = useState<{ title: string; text: string } | null>(null)

  const readPptxBytes = useCallback(async (): Promise<Uint8Array | null> => {
    if (!doc?.path) return null
    const bytes = await window.api.pdf.read(doc.path)
    if (!bytes) message.error('读取 PPT 文件失败')
    return bytes ?? null
  }, [doc])

  /** 从 pptx（zip）的 slide XML 提取逐页文本（a:t 节点） */
  const extractPptText = useCallback(async (): Promise<string> => {
    const bytes = await readPptxBytes()
    if (!bytes) return ''
    const zip = await JSZip.loadAsync(bytes)
    const names = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
      .sort((a, b) => Number(a.match(/(\d+)/)?.[1] ?? 0) - Number(b.match(/(\d+)/)?.[1] ?? 0))
    const parts: string[] = []
    for (let i = 0; i < names.length; i++) {
      const xml = await zip.files[names[i]].async('string')
      const texts = Array.from(xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)).map((m) => m[1])
      parts.push(`—— 第 ${i + 1} 页 ——\n${texts.join('\n')}`)
    }
    return parts.join('\n\n')
  }, [readPptxBytes])

  const pptToPdfBytesSafe = useCallback(async (): Promise<Uint8Array | null> => {
    if (!doc?.path) return null
    setPptBusy('正在转换为 PDF…')
    try {
      const r = await window.api.ppt.toPdf(doc.path)
      if (!r.ok || !r.bytes) {
        message.error(r.error ?? 'PPT 转 PDF 失败')
        return null
      }
      return r.bytes
    } finally {
      setPptBusy('')
    }
  }, [doc])

  const baseName = (doc?.name || '演示文稿').replace(/\.[^.]+$/, '')

  const pptSavePdf = useCallback(async () => {
    const bytes = await pptToPdfBytesSafe()
    if (!bytes) return
    const target = await window.api.pdf.savePath(baseName + '.pdf', ['pdf'])
    if (target && (await window.api.pdf.write(target, bytes))) message.success('已导出 PDF：' + target)
  }, [pptToPdfBytesSafe, baseName])

  const pptExportImages = useCallback(async () => {
    const bytes = await pptToPdfBytesSafe()
    if (!bytes) return
    setPptBusy('正在渲染页面图片…')
    try {
      const doc2 = await PDFDocument.load(bytes, { ignoreEncryption: true })
      const indices = doc2.getPageIndices()
      const pages = await renderPdfPages(bytes, indices, { scale: 2, maxSide: 2200 })
      for (const p of pages) {
        const blob = await new Promise<Blob>((resolve, reject) =>
          p.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('导出失败'))), 'image/png')
        )
        downloadBlob(blob, `${baseName}-p${p.pageIndex + 1}.png`)
        await new Promise((r) => setTimeout(r, 120))
      }
      message.success(`已导出 ${pages.length} 页图片`)
    } catch (err) {
      message.error('导出图片失败：' + formatError(err))
    } finally {
      setPptBusy('')
    }
  }, [pptToPdfBytesSafe, baseName])

  const pptExtractImages = useCallback(async () => {
    setPptBusy('正在提取图片素材…')
    try {
      const bytes = await readPptxBytes()
      if (!bytes) return
      const zip = await JSZip.loadAsync(bytes)
      const media = Object.keys(zip.files).filter((n) => /^ppt\/media\//i.test(n) && !zip.files[n].dir)
      if (!media.length) {
        message.warning('该 PPT 内没有可提取的图片素材')
        return
      }
      for (const name of media) {
        const blob = await zip.files[name].async('blob')
        downloadBlob(blob, name.split('/').pop() || name)
        await new Promise((r) => setTimeout(r, 100))
      }
      message.success(`已提取 ${media.length} 个媒体文件`)
    } catch (err) {
      message.error('提取图片失败：' + formatError(err))
    } finally {
      setPptBusy('')
    }
  }, [readPptxBytes])

  const pptCompress = useCallback(async () => {
    setPptBusy('正在重新压缩…')
    try {
      const bytes = await readPptxBytes()
      if (!bytes) return
      const zip = await JSZip.loadAsync(bytes)
      const out = await zip.generateAsync({
        type: 'uint8array',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 }
      })
      const before = bytes.length
      const after = out.length
      if (after >= before) {
        message.info(`该文件已充分压缩（${formatBytes(before)} → ${formatBytes(after)}），未产出更大文件`)
        return
      }
      const target = await window.api.pdf.savePath(baseName + '-compressed.pptx', ['pptx'])
      if (target && (await window.api.pdf.write(target, out))) {
        message.success(`已压缩：${formatBytes(before)} → ${formatBytes(after)}`)
      }
    } catch (err) {
      message.error('压缩失败：' + formatError(err))
    } finally {
      setPptBusy('')
    }
  }, [readPptxBytes, baseName])

  const aiFromPptText = useCallback(
    async (title: string, prompt: (text: string) => string): Promise<string | null> => {
      const text = await extractPptText()
      if (!text.trim()) {
        message.warning('未能从该 PPT 提取到文本')
        return null
      }
      setPptBusy('AI 处理中…')
      try {
        const r = await window.api.ai.complete([{ role: 'user', content: prompt(text) }])
        if (r.ok && r.text) {
          const result = `${title}\n\n${r.text}`
          setPptTextModal({ title, text: result })
          return r.text
        }
        message.error(r.error ?? 'AI 处理失败')
        return null
      } finally {
        setPptBusy('')
      }
    },
    [extractPptText]
  )

  const pptAiText = useCallback(async () => {
    // 文本提取：先直接展示原始逐页文本，可再手动让 AI 整理
    const text = await extractPptText()
    if (!text.trim()) {
      message.warning('未能从该 PPT 提取到文本（可能是 .ppt 旧格式，请先另存为 .pptx）')
      return
    }
    setPptTextModal({ title: 'PPT 文本提取', text })
  }, [extractPptText])

  const pptAiOutline = useCallback(() => {
    void aiFromPptText('AI 整理 · PPT 大纲', (text) =>
      `以下是一份 PPT 的逐页文本。请整理为结构化大纲（保留页序，用 Markdown 标题与要点输出，不要额外寒暄）：\n\n${text}`
    )
  }, [aiFromPptText])

  const pptAiDraft = useCallback(async () => {
    setPptBusy('AI 生成 PPT 草稿中…')
    try {
      const text = await extractPptText()
      const topic = text.trim()
        ? `基于以下原始内容重构成一份更清晰专业的演示文稿`
        : `生成一份关于「${doc?.name?.replace(/\.[^.]+$/, '') || '主题'}」的演示文稿`
      const r = await window.api.ai.complete([
        {
          role: 'user',
          content:
            `${topic}。要求：8 页以内；每页有简短标题与 2-4 条要点；面向汇报场景。\n` +
            `只输出 JSON 数组，不要任何解释或代码围栏，格式：[{"title":"页标题","bullets":["要点1","要点2"]}]` +
            (text.trim() ? `\n\n原始内容：\n${text}` : '')
        }
      ])
      if (!r.ok || !r.text) {
        message.error(r.error ?? 'AI 生成失败')
        return
      }
      const jsonStr = (r.text.match(/\[[\s\S]*\]/) || [])[0]
      if (!jsonStr) {
        message.error('AI 返回内容无法解析为幻灯片结构，请重试')
        return
      }
      const slides = JSON.parse(jsonStr) as Array<{ title: string; bullets: string[] }>
      if (!Array.isArray(slides) || !slides.length) {
        message.error('AI 返回的幻灯片为空，请重试')
        return
      }
      const PptxGenJS = (await import('pptxgenjs')).default
      const pres = new PptxGenJS()
      pres.defineLayout({ name: 'W16x9', width: 13.333, height: 7.5 })
      pres.layout = 'W16x9'
      for (const s of slides) {
        const slide = pres.addSlide()
        slide.addText(String(s.title || '未命名'), { x: 0.6, y: 0.5, w: 12.1, h: 1, fontSize: 28, bold: true })
        slide.addText(
          (s.bullets || []).map((b) => ({ text: String(b), options: { bullet: true, breakLine: true } })),
          { x: 0.9, y: 1.8, w: 11.5, h: 5.2, fontSize: 16 }
        )
      }
      const blob = (await pres.write({ outputType: 'blob' })) as Blob
      downloadBlob(blob, `${doc?.name?.replace(/\.[^.]+$/, '') || 'draft'}-AI草稿.pptx`)
      message.success(`已生成 ${slides.length} 页 PPT 草稿`)
    } catch (err) {
      message.error('生成 PPT 草稿失败：' + formatError(err))
    } finally {
      setPptBusy('')
    }
  }, [extractPptText, doc])

  const PPT_MENU_ITEMS = useMemo(
    () => [
      { key: 'save-pdf', label: '另存为 PDF' },
      { key: 'export-images', label: '导出图片（逐页 PNG）' },
      { key: 'extract-images', label: '提取图片素材（PPT 内嵌）' },
      { key: 'compress', label: '压缩另存（重新打包）' },
      { type: 'divider' as const },
      { key: 'ai-text', label: 'AI 文本提取（逐页原文）' },
      { key: 'ai-outline', label: 'AI 整理大纲' },
      { key: 'ai-draft', label: 'AI 生成 PPT 草稿（.pptx）' }
    ],
    []
  )

  const handlePptTool = useCallback(
    (key: string) => {
      const run: Record<string, () => Promise<void> | void> = {
        'save-pdf': pptSavePdf,
        'export-images': pptExportImages,
        'extract-images': pptExtractImages,
        compress: pptCompress,
        'ai-text': pptAiText,
        'ai-outline': pptAiOutline,
        'ai-draft': pptAiDraft
      }
      const fn = run[key]
      if (fn) void fn()
    },
    [pptSavePdf, pptExportImages, pptExtractImages, pptCompress, pptAiText, pptAiOutline, pptAiDraft]
  )

  const doClearRecent = useCallback(() => {
    Modal.confirm({
      title: '清空最近打开记录？',
      content: '仅清除本机列表，不会删除磁盘上的文件。',
      okText: '清空',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => {
        saveRecent([])
        setRecent([])
        message.success('已清空最近打开')
      }
    })
  }, [])

  const doReload = useCallback(async () => {
    if (!doc?.path) return
    if (dirty) {
      const ok = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: '重新加载？',
          content: '未保存的修改将丢失。',
          okText: '重新加载',
          okButtonProps: { danger: true },
          cancelText: '取消',
          onOk: () => resolve(true),
          onCancel: () => resolve(false)
        })
      })
      if (!ok) return
    }
    await openPath(doc.path)
  }, [doc, dirty, openPath])

  const rendered = useMemo(() => {
    if (!doc?.ok) return null
    if (doc.html && !isWordLike && mode !== 'edit' && mode !== 'source') {
      return { __html: DOMPurify.sanitize(doc.html) }
    }
    if (isWordLike && mode === 'preview') {
      return { __html: DOMPurify.sanitize(doc.html || '', { ADD_TAGS: ['img', 'table', 'tbody', 'thead', 'tr', 'td', 'th'], ADD_ATTR: ['src', 'class', 'style'] }) }
    }
    if (doc.kind === 'markdown' && mode === 'preview') {
      return { __html: DOMPurify.sanitize(marked.parse(textForRender) as string) }
    }
    if (doc.kind === 'csv' && mode === 'preview') {
      return { __html: csvToTableHtml(textForRender) }
    }
    if (doc.kind === 'json' && mode === 'preview') {
      return { __html: DOMPurify.sanitize(`<pre class="docs-pre">${jsonPretty(textForRender).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`) }
    }
    if (doc.kind === 'html' && mode === 'preview') {
      return { __html: DOMPurify.sanitize(textForRender, { ADD_TAGS: ['img', 'table', 'tbody', 'thead', 'tr', 'td', 'th'], ADD_ATTR: ['src', 'class', 'style'] }) }
    }
    return null
  }, [doc, mode, textForRender, isWordLike])

  const kindMeta = doc?.kind ? KIND_TAG[doc.kind] : null
  const surgicalCapable = !!(doc?.ok && doc.path && SURGICAL_EXTS.has((doc.ext ?? '').toLowerCase()))
  const withFaithful = (opts: Array<{ label: string; value: typeof mode; disabled?: boolean }>) =>
    surgicalCapable ? [...opts, { label: '保真编辑', value: 'faithful' as const }] : opts
  const showViewMode =
    doc?.ok &&
    (doc.kind === 'markdown' ||
      doc.kind === 'csv' ||
      doc.kind === 'json' ||
      doc.kind === 'html' ||
      doc.kind === 'office' ||
      doc.kind === 'pdf' ||
      EDITABLE_KINDS.has(doc.kind ?? '') ||
      !!doc.html)

  return (
    <div className="dashboard-page docs-viewer-page" style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* 统一工作条：文件信息 · 文件操作 · 文档视图 · PDF 工具 全部平铺在同一行（自动换行），
          不再按「上/下」切成标题行、工具栏行、参数面板行三层 */}
      <div className="page-header tt-v2-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '6px 0', borderBottom: '1px solid var(--border-color, rgba(128,128,128,.15))' }}>
        <Typography.Text strong style={{ fontSize: 13, marginInlineEnd: 2 }}>
          文档处理
        </Typography.Text>
        {doc?.ok && <FileTextOutlined />}
        {doc?.ok && (
          <Typography.Text strong ellipsis style={{ maxWidth: 180 }} title={doc.name}>
            {doc.name}
          </Typography.Text>
        )}
        {doc?.ok && kindMeta && <Tag color={kindMeta.color}>{kindMeta.label}</Tag>}
        {doc?.ok && doc.sourceKind === 'spreadsheet' && (
          <Tag color="cyan" style={{ margin: 0 }}>
            表格预览
          </Tag>
        )}
        {doc?.ok && (
          <Tag color={dirty || richDirty || (mode === 'inplace' && inplacePending > 0) || (mode === 'faithful' && faithfulChanges > 0) ? 'orange' : 'default'} style={{ margin: 0 }}>
            {dirty || richDirty || (mode === 'inplace' && inplacePending > 0) || (mode === 'faithful' && faithfulChanges > 0) ? '未保存' : '已同步'}
          </Tag>
        )}
        <Divider type="vertical" style={{ margin: '0 4px' }} />
        <Space wrap size={4}>
          <Button type="primary" icon={<FolderOpenOutlined />} onClick={() => void openPick()} loading={loading}>
            打开
          </Button>
          {doc?.ok && (
            <Button
              icon={<SaveOutlined />}
              loading={saving}
              disabled={mode === 'inplace' ? inplacePending === 0 : !(canEdit || isWordLike)}
              onClick={() => void doUnifiedSave()}
              title={
                mode === 'inplace'
                  ? '保存就地编辑结果：覆盖原 PDF，并在同目录留一份带时间戳的备份'
                  : doc?.kind === 'pdf'
                    ? 'PDF 不能直接覆写：按当前视图导出为新文件'
                    : 'Ctrl+S'
              }
            >
              保存{dirty || richDirty || (mode === 'inplace' && inplacePending > 0) || (mode === 'faithful' && faithfulChanges > 0) ? ' *' : ''}
            </Button>
          )}
          {doc?.ok && (
            <Button icon={<CloseOutlined />} onClick={doClose} title="Ctrl+W">
              关闭
            </Button>
          )}
          {canEdit && (
            <Button
              icon={<EditOutlined />}
              type={mode === 'edit' ? 'primary' : 'default'}
              onClick={() => { setMode('edit'); if (canEdit && !isWordLike) setAuxOpen(true) }}
            >
              编辑
            </Button>
          )}
          {doc?.ok && doc.path && SURGICAL_EXTS.has((doc.ext ?? '').toLowerCase()) && (
            <Tooltip
              title={
                LEGACY_SURGICAL_EXTS.has((doc.ext ?? '').toLowerCase())
                  ? '保真编辑（高保真转换）：经容器转换改字后转回原格式，版式可能有细节差异，保留 .bak'
                  : '保真编辑：只改文字，字体/表格/图片/分页完全不动'
              }
            >
              <Button
                icon={<ScissorOutlined />}
                type={mode === 'faithful' ? 'primary' : 'default'}
                onClick={() => { if (mode !== 'faithful') guardInplaceExit(() => void enterFaithful()) }}
              >
                保真编辑
              </Button>
            </Tooltip>
          )}
          {isWordLike && mode !== 'inplace' && (
            <Dropdown
              menu={{
                items: [
                  { key: 'docx', label: '导出 Word（.docx）' },
                  { key: 'html', label: '导出 HTML' }
                ],
                onClick: ({ key }) => {
                  if (key === 'docx') void exportRichDocx()
                  if (key === 'html') void exportRichHtml()
                }
              }}
            >
              <Button icon={<FileAddOutlined />}>导出</Button>
            </Dropdown>
          )}
          {doc?.ok && doc.sourceKind === 'slides' && (
            <Dropdown
              menu={{ items: PPT_MENU_ITEMS, onClick: ({ key }) => handlePptTool(String(key)) }}
              overlayStyle={{ maxHeight: 420, overflowY: 'auto' }}
            >
              <Button icon={<PlaySquareOutlined />} loading={!!pptBusy}>
                PPT 工具{pptBusy ? ` · ${pptBusy}` : ''}
              </Button>
            </Dropdown>
          )}
          {(canEdit || isWordLike) && mode !== 'inplace' && (
            <Button icon={<FileAddOutlined />} onClick={openSaveAs}>
              另存为
            </Button>
          )}
          {canEdit && (
            <Tooltip title="查找 / 替换（Ctrl+F）">
              <Button icon={<SearchOutlined />} type={findOpen ? 'primary' : 'default'} onClick={() => setFindOpen((v) => !v)}>
                查找
              </Button>
            </Tooltip>
          )}
          {canEdit && !isWordLike && (
            <Tooltip title="撤销（Ctrl+Z）">
              <Button icon={<UndoOutlined />} onClick={doUndo} />
            </Tooltip>
          )}
          {canEdit && !isWordLike && (
            <Tooltip title="重做（Ctrl+Y）">
              <Button icon={<RedoOutlined />} onClick={doRedo} />
            </Tooltip>
          )}
          <Tooltip title="打印 / 导出 PDF">
            <Button icon={<PrinterOutlined />} onClick={() => void doPrint()} disabled={!doc?.ok}>
              打印
            </Button>
          </Tooltip>
          {doc?.path && (
            <Button icon={<ReloadOutlined />} onClick={() => guardInplaceExit(() => void doReload())}>
              重新加载
            </Button>
          )}
        </Space>

        <Divider type="vertical" style={{ margin: '0 4px' }} />
        <Tag color="blue" style={{ marginInlineEnd: 2 }}>
          文档
        </Tag>
        {doc?.ok && doc.kind === 'pdf' && doc.sourceKind !== 'spreadsheet' && (
          <Button size="small" type={mode === 'inplace' ? 'primary' : 'default'} onClick={() => { setPdfTool(null); setMode('inplace') }}>
            编辑内容
          </Button>
        )}
        {isWordLike && (
          <Button size="small" type={mode === 'rich' ? 'primary' : 'default'} onClick={() => guardInplaceExit(() => setMode('rich'))}>
            Word 模式
          </Button>
        )}
        <Divider type="vertical" style={{ margin: '0 4px' }} />
        {doc?.ok && doc.sourceKind !== 'spreadsheet' && (
          <>
            <Tag color="red" style={{ marginInlineEnd: 2 }}>
              PDF 工具
            </Tag>
            {TOOL_META.map((t) => (
              <Button
                key={t.key}
                size="small"
                type={pdfTool === t.key ? 'primary' : 'default'}
                title={t.desc}
                onClick={() => guardInplaceExit(() => { setPdfTool(t.key); setAuxOpen(true); if (mode === 'inplace') setMode('preview') })}
              >
                {t.title}
              </Button>
            ))}
            {pdfTool && (
              <Button size="small" icon={<CloseOutlined />} onClick={() => setPdfTool(null)}>
                收起工具
              </Button>
            )}
          </>
        )}
      </div>
      {/* 流程步骤条：单页内按「阶段」组织，点任意一步直接跳到对应操作。
          它不是分栏——只是把原本散在多个区域的操作收敛成一条可点的导航。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '6px 0' }}>
        {[
          { k: 'open', label: '① 选择文件', active: !doc?.ok, onClick: () => void openPick() },
          {
            k: 'edit',
            label: '② 查看 / 编辑',
            active: !!doc?.ok && !pdfTool,
            onClick: () => guardInplaceExit(() => setMode(doc?.kind === 'pdf' ? 'preview' : 'edit'))
          },
          {
            k: 'tool',
            label: '③ 处理工具',
            active: !!pdfTool,
            onClick: () => {
              if (!pdfTool) setPdfTool(TOOL_META[0]?.key ?? null)
              setAuxOpen(true)
            }
          },
          {
            k: 'out',
            label: '④ 保存 / 导出',
            active: dirty || richDirty || (mode === 'inplace' && inplacePending > 0) || (mode === 'faithful' && faithfulChanges > 0),
            onClick: () => void doUnifiedSave()
          }
        ].map((s) => (
          <Button key={s.k} size="small" type={s.active ? 'primary' : 'default'} onClick={s.onClick}>
            {s.label}
          </Button>
        ))}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {!doc?.ok
            ? '先打开一个文件，后续所有步骤都在本页完成'
            : pdfTool
              ? '处理结果会写回下方同一区域的预览'
              : '编辑与处理共用下方同一区域，不再分成上下或左右两块'}
        </Typography.Text>
      </div>

      {/*
        整合要点：PDF 工具的参数面板**不再单占一条横向区块**（原来是「工具在上、内容在下」
        的上下分栏）。它作为可折叠面板嵌进下方统一舞台里，与预览/编辑同处一个滚动容器。
      */}


      {/* 同一编辑画布：文档占满，工具设置浮在其上，不拆成上下/左右两块 */}
      <div
        style={{
          position: 'relative',
          minHeight: 0,
          flex: 1,
          border: '1px solid var(--border-color, rgba(128,128,128,.22))',
          borderRadius: 12,
          overflow: 'hidden',
          background: 'var(--bg-elevated, #fff)',
          boxShadow: '0 2px 12px rgba(0,0,0,.06)'
        }}
      >
        
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* 视图切换 + 格式菜单行：无内容时整行不渲染 */}
      {doc?.ok && showViewMode && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
            padding: '8px 0',
            borderBottom: '1px solid var(--border-color, rgba(128,128,128,.15))',
            marginBottom: 8
          }}
        >
          <Segmented
            size="small"
            value={mode}
            onChange={(v) => {
              guardInplaceExit(() => {
                const m = v as typeof mode
                setMode(m)
                // 进入编辑模式时同步打开右侧实时预览（用户可手动关闭）
                if (m === 'edit' && canEdit && !isWordLike) setAuxOpen(true)
              })
            }}
            options={
              doc.kind === 'pdf'
                ? withFaithful([
                    { label: 'PDF 预览', value: 'preview' },
                    { label: '编辑内容（保版式）', value: 'inplace', disabled: doc.sourceKind === 'spreadsheet' },
                    {
                      label: pdfEdit.loading ? 'Word 模式（提取中…）' : 'Word 模式（重排导出）',
                      value: 'rich',
                      disabled: !wordHtml
                    },
                    { label: '源码 HTML', value: 'source', disabled: !wordHtml }
                  ])
                : isWordLike
                  ? withFaithful([
                      { label: 'Word 视图', value: 'rich' },
                      { label: '源码 HTML', value: 'source' }
                    ])
                  : canEdit && doc.kind === 'markdown'
                    ? [
                        { label: '预览', value: 'preview' },
                        { label: '源码', value: 'source' },
                        { label: '编辑', value: 'edit' },
                      ]
                    : canEdit
                      ? [
                          { label: '预览', value: 'preview' },
                          { label: '编辑', value: 'edit' }
                        ]
                      : withFaithful([
                          { label: '预览', value: 'preview' },
                          { label: '源码', value: 'source' }
                        ])
            }
          />
          {(doc.kind === 'markdown' || doc.kind === 'text' || doc.kind === 'code' || doc.kind === 'json') && (
            <>
              <Tooltip title="缩小">
                <Button size="small" icon={<ZoomOutOutlined />} onClick={() => setZoom((z) => Math.max(70, z - 10))} />
              </Tooltip>
              <span style={{ fontSize: 12, minWidth: 36, textAlign: 'center' }}>{zoom}%</span>
              <Tooltip title="放大">
                <Button size="small" icon={<ZoomInOutlined />} onClick={() => setZoom((z) => Math.min(180, z + 10))} />
              </Tooltip>
            </>
          )}
        </div>
      )}

      {/*
        整合要点：工具参数与「实时预览」都不再占主舞台的空间（此前先是独立 38vh 横条、
        后是内嵌折叠条，都会挤压内容区）。二者统一收进右侧无遮罩抽屉（浮层）：
        主舞台永远完整一块，抽屉按上下文切换内容——见页面底部的 <Drawer>。
      */}

      {/* 查找替换 */}
      {findOpen && canEdit && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            padding: '8px 10px',
            marginBottom: 8,
            borderRadius: 8,
            border: '1px solid var(--border-color, rgba(128,128,128,.2))',
            background: 'var(--bg-elevated, #fff)'
          }}
        >
          <Input size="small" placeholder="查找" value={findQ} onChange={(e) => setFindQ(e.target.value)} style={{ width: 160 }} allowClear />
          <Input size="small" placeholder="替换为" value={replaceQ} onChange={(e) => setReplaceQ(e.target.value)} style={{ width: 160 }} allowClear />
          <Checkbox checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)}>
            区分大小写
          </Checkbox>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {findQ ? `${matchCount} 处匹配` : ''}
          </Typography.Text>
          <Button size="small" icon={<SwapOutlined />} onClick={doReplaceOne}>
            替换一处
          </Button>
          <Button size="small" type="primary" onClick={doReplaceAll}>
            全部替换
          </Button>
          <Button size="small" type="text" onClick={() => setFindOpen(false)}>
            关闭
          </Button>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--bg-subtle, rgba(128,128,128,.04))' }}>
        <div ref={printRef} className="docs-print-root" style={{ maxWidth: 920, margin: '0 auto', padding: '20px 28px 40px', transformOrigin: 'top center' }}>
          {loading && !doc && (
            <div style={{ padding: 48, textAlign: 'center' }}>
              <Spin tip="加载中…" />
            </div>
          )}
          {!doc && !loading && (
            <div style={{ padding: 48 }}>
              <Empty description="选择本地文件开始预览。支持 MD / TXT / PDF / DOCX / 图片 / JSON / CSV / 代码等。">
                <Button type="primary" icon={<FolderOpenOutlined />} onClick={() => void openPick()}>
                  打开文档
                </Button>
              </Empty>
              {recent.length > 0 && (
                <div style={{ marginTop: 24 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      最近打开
                    </Typography.Text>
                    <Button size="small" type="link" danger icon={<DeleteOutlined />} onClick={doClearRecent}>
                      清空记录
                    </Button>
                  </div>
                  <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {recent.map((r, i) => (
                      <Button key={r.path ?? String(i)} size="small" onClick={() => void openPath(r.path ?? '')}>
                        {r.name}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {doc?.ok && doc.kind === 'pdf' && mode === 'inplace' && (
            <PdfInPlaceEditor
              path={doc.path ?? ''}
              name={doc.name ?? ''}
              bytes={pdfBytes}
              apiRef={pdfEditorRef}
              onPendingChange={setInplacePending}
              onSaved={() => setInplacePending(0)}
              onExit={() => guardInplaceExit(() => setMode('preview'))}
            />
          )}

          {doc?.ok && mode === 'faithful' && (
            <div
              className="docs-paper"
              style={{
                background: 'var(--bg-elevated, #fff)',
                borderRadius: 10,
                border: '1px solid var(--border-color, rgba(128,128,128,.15))',
                padding: 0,
                minHeight: 320,
                boxShadow: '0 2px 12px rgba(0,0,0,.04)',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column'
              }}
            >
              <Alert
                type="info"
                showIcon
                style={{ borderRadius: 0 }}
                message="手术式编辑只改文字，字体/表格/图片/分页完全不动；排版级调整请用 Word 式编辑"
                description={
                  LEGACY_SURGICAL_EXTS.has((doc.ext ?? '').toLowerCase())
                    ? 'DOC/XLS/RTF 采用高保真转换编辑（转容器→手术改字→转回原格式），版式可能存在个别细节差异；重要文件请保留 .bak 备份。'
                    : (doc.ext ?? '').toLowerCase() === '.xlsx'
                      ? '提示：.xlsx 的单元格文本使用共享字符串，修改可能与文档中其他同文本的单元格联动更新。'
                      : undefined
                }
              />
              {faithfulNote && (
                <div style={{ padding: '6px 16px 0' }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {faithfulNote}
                  </Typography.Text>
                </div>
              )}
              {faithfulLoading && (
                <div style={{ textAlign: 'center', padding: 56 }}>
                  <Spin />
                  <div style={{ marginTop: 10 }}>
                    <Typography.Text type="secondary">正在解析文档文本单元…</Typography.Text>
                  </div>
                </div>
              )}
              {!faithfulLoading && faithfulError && (
                <div style={{ padding: 28 }}>
                  <Empty description={faithfulError} />
                </div>
              )}
              {!faithfulLoading && !faithfulError && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--border-color, rgba(128,128,128,.12))', flexWrap: 'wrap' }}>
                    <Input
                      allowClear
                      size="small"
                      placeholder="过滤单元（按文本包含匹配）"
                      prefix={<SearchOutlined />}
                      value={faithfulFilter}
                      onChange={(e) => setFaithfulFilter(e.target.value)}
                      style={{ width: 260 }}
                    />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {faithfulFiltered.length === faithfulUnits.length
                        ? `共 ${faithfulUnits.length} 个文本单元`
                        : `匹配 ${faithfulFiltered.length} / 共 ${faithfulUnits.length} 个文本单元`}
                    </Typography.Text>
                    {faithfulFiltered.length > FAITHFUL_MAX_RENDER && (
                      <Typography.Text type="warning" style={{ fontSize: 12 }}>
                        共 {faithfulFiltered.length} 个单元，已显示前 {FAITHFUL_MAX_RENDER}，可用过滤框缩小范围
                      </Typography.Text>
                    )}
                  </div>
                  <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                    {faithfulVisible.map((u) => {
                      const v = faithfulValues[u.id] ?? u.text
                      const changed = v !== u.text
                      return (
                        <div key={u.id} style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-color, rgba(128,128,128,.1))' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                            <Tag color="blue" style={{ margin: 0 }}>
                              {FAITHFUL_KIND_LABEL[u.kind]}
                            </Tag>
                            <Typography.Text type="secondary" style={{ fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={u.id}>
                              {u.id}
                            </Typography.Text>
                            {changed && (
                              <Tag color="orange" style={{ margin: 0 }}>
                                已修改
                              </Tag>
                            )}
                          </div>
                          <Input.TextArea
                            autoSize
                            value={v}
                            aria-label={`文本单元 ${u.id}`}
                            onChange={(e) => setFaithfulValues((prev) => ({ ...prev, [u.id]: e.target.value }))}
                            style={{ fontSize: 13, lineHeight: 1.6 }}
                          />
                        </div>
                      )
                    })}
                    {faithfulVisible.length === 0 && (
                      <div style={{ padding: 28 }}>
                        <Empty description="没有匹配的文本单元" />
                      </div>
                    )}
                  </div>
                  <div
                    style={{
                      position: 'sticky',
                      bottom: 0,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '10px 16px',
                      borderTop: '1px solid var(--border-color, rgba(128,128,128,.12))',
                      background: 'var(--bg-elevated, #fff)'
                    }}
                  >
                    <Button type="primary" icon={<SaveOutlined />} loading={faithfulSaving} disabled={faithfulChanges === 0} onClick={() => void doFaithfulSave()}>
                      保存（{faithfulChanges} 处修改）
                    </Button>
                    <Button disabled={faithfulSaving} onClick={doFaithfulDiscard}>
                      放弃
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}

          {doc?.ok && mode !== 'inplace' && mode !== 'faithful' && (
            <div
              className="docs-paper"
              style={{
                background: 'var(--bg-elevated, #fff)',
                borderRadius: 10,
                border: '1px solid var(--border-color, rgba(128,128,128,.15))',
                padding: mode === 'edit' ? 0 : 28,
                minHeight: 320,
                boxShadow: '0 2px 12px rgba(0,0,0,.04)',
                fontSize: `${zoom}%`,
                lineHeight: 1.75,
                overflow: 'hidden'
              }}
            >

              {doc.kind === 'pdf' && mode === 'preview' && (
                <PdfEditHint loading={pdfEdit.loading} ready={!!wordHtml} needOcr={pdfEdit.needOcr} note={pdfEdit.note} onEdit={() => setMode('rich')} />
              )}
              {doc.kind === 'pdf' && mode === 'preview' &&
                (pdfPreview.pages.length > 0 ? (
                  <div style={{ background: 'var(--bg-canvas, rgba(0,0,0,.03))' }}>
                    {pdfPreview.pages.map((src, i) => (
                      <img
                        key={i}
                        src={src}
                        alt={`第 ${i + 1} 页`}
                        style={{ display: 'block', width: '100%', maxWidth: 900, margin: '0 auto 12px', boxShadow: '0 1px 6px rgba(0,0,0,.14)', borderRadius: 2 }}
                      />
                    ))}
                    {pdfPreview.total > pdfPreview.pages.length && (
                      <div style={{ textAlign: 'center', padding: '4px 0 12px' }}>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          已预览前 {pdfPreview.pages.length} 页 / 共 {pdfPreview.total} 页 · 需要查看或处理全部页面请用上方 PDF 工具
                        </Typography.Text>
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ textAlign: 'center', padding: 40 }}>
                    {pdfPreview.loading ? <Spin /> : <Typography.Text type="secondary">暂无预览（可用顶部「编辑内容」进保版式改文字，或用上方 PDF 工具做结构处理）</Typography.Text>}
                  </div>
                ))}
              {doc.kind === 'image' && blobUrl && (
                <div style={{ textAlign: 'center', padding: 28 }}>
                  <img src={blobUrl} alt={doc.name} style={{ maxWidth: '100%', maxHeight: '72vh', objectFit: 'contain' }} />
                </div>
              )}

              {isWordLike && mode === 'rich' && (
                <div className="docs-word-editor" style={{ padding: 20, fontSize: `${zoom}%` }}>
                  {doc.kind === 'pdf' && (
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message="正在按「重排导出」方式编辑 PDF 文字"
                      description="下面是提取出的文字，可使用完整排版菜单修改；导出的 PDF 为重新排版后的文档版式——原始设计版式（照片、色块、分栏位置）不会保留。若要保持原版式，请切到「编辑内容（保版式）」。"
                    />
                  )}
                  <div
                    ref={richRef}
                    key={`rich-${doc?.path ?? 'x'}-${doc?.html?.length ?? 0}`}
                    className="docs-word-body markdown-preview docs-md"
                    contentEditable
                    suppressContentEditableWarning
                    spellCheck={false}
                    onInput={onRichInput}
                    onContextMenu={onRichContextMenu}
                    style={{ minHeight: 420, outline: 'none', lineHeight: 1.8, cursor: 'text', userSelect: 'text', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                  />
                </div>
              )}

              {isWordLike && mode === 'source' && (
                <pre
                  className="docs-pre"
                  style={{ margin: 0, padding: 20, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '0.88em', lineHeight: 1.55, maxHeight: '70vh', overflow: 'auto' }}
                >
                  {getRichDomHtml() || richHtml}
                </pre>
              )}

              {/* 编辑区：单栏占满，不再与预览左右并排；看结果用上方「预览 / 源码」切换 */}
              {canEdit && !isWordLike && mode === 'edit' && (
                <div style={{ display: 'flex', height: '68vh', minHeight: 320 }}>
                  <Input.TextArea
                    ref={taRef}
                    aria-label="文档编辑区"
                    value={draft}
                    onChange={(e) => setDraftWithUndo(e.target.value)}
                    style={{
                      flex: 1,
                      width: '100%',
                      height: '100%',
                      resize: 'none',
                      borderRadius: 0,
                      fontSize: 13,
                      lineHeight: 1.7,
                      fontFamily: doc.kind === 'code' || doc.kind === 'json' ? 'ui-monospace, Consolas, monospace' : undefined,
                      border: 'none'
                    }}
                    placeholder="在此编辑…（Ctrl+F 查找替换 · Ctrl+S 保存 · Ctrl+Z/Y 撤销重做 · 用上方「预览 / 源码」查看结果）"
                  />
                </div>
              )}

              {!(isWordLike && (mode === 'rich' || mode === 'source')) && !(canEdit && !isWordLike && mode === 'edit') && (
                <div style={{ padding: mode === 'source' ? 0 : undefined }}>
                  {rendered && mode !== 'source' && (
                    <div className="markdown-preview docs-md" style={{ fontSize: '1em' }} dangerouslySetInnerHTML={rendered} />
                  )}
                  {!rendered && doc.text != null && (mode === 'source' || ['text', 'code'].includes(doc.kind ?? '')) && (
                    <pre
                      className="docs-pre"
                      style={{ margin: 0, padding: mode === 'source' ? 20 : 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, Consolas, "Courier New", monospace', fontSize: '0.92em', lineHeight: 1.6 }}
                    >
                      {doc.kind === 'json' ? jsonPretty(textForRender) : textForRender}
                    </pre>
                  )}
                  {!rendered && doc.text == null && !blobUrl && (
                    <div style={{ padding: 28 }}>
                      <Empty description={doc.error ?? '无法预览此文件'} />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        </div>
        </div>
      </div>

      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          .docs-print-root, .docs-print-root * { visibility: visible !important; }
          .docs-print-root {
            position: absolute !important;
            left: 0; top: 0; width: 100%;
            max-width: none !important;
            padding: 0 !important;
          }
          .docs-paper {
            border: none !important;
            box-shadow: none !important;
            border-radius: 0 !important;
            padding: 0 !important;
          }
          .page-header, .docs-viewer-page > div:first-child { display: none !important; }
        }
        .docs-md h1, .docs-md h2, .docs-md h3 { margin-top: 1.2em; margin-bottom: 0.5em; line-height: 1.35; }
        .docs-md pre, .docs-pre {
          background: rgba(128,128,128,.08);
          padding: 12px 14px;
          border-radius: 8px;
          overflow: auto;
        }
        .docs-md code { font-family: ui-monospace, Consolas, monospace; font-size: 0.92em; }
        .docs-md table, .docs-table { border-collapse: collapse; width: 100%; margin: 12px 0; }
        .docs-md th, .docs-md td, .docs-table th, .docs-table td {
          border: 1px solid rgba(128,128,128,.28);
          padding: 6px 10px;
          font-size: 0.94em;
        }
        .docs-table th { background: rgba(128,128,128,.08); font-weight: 600; }
        .docs-md img { max-width: 100%; }
        .docs-md blockquote {
          border-left: 3px solid var(--color-primary, #1677ff);
          margin: 12px 0;
          padding: 4px 12px;
          opacity: 0.9;
        }
        .docs-note { font-size: 12px; opacity: 0.65; margin-top: 8px; }
      `}</style>

      <Modal
        title={`还有 ${inplacePending} 处就地编辑没保存`}
        open={leaveAsk}
        closable={false}
        maskClosable={false}
        keyboard={false}
        footer={[
          <Button
            key="cancel"
            onClick={() => {
              afterLeaveRef.current = null
              setLeaveAsk(false)
            }}
          >
            取消（继续编辑）
          </Button>,
          <Button key="discard" danger onClick={finishLeave}>
            丢弃改动并离开
          </Button>,
          <Button key="save" type="primary" loading={leaveSaving} onClick={() => void doLeaveSaving()}>
            保存到原文件并离开
          </Button>
        ]}
      >
        <Typography.Paragraph style={{ marginBottom: 6 }}>
          保存会把改动写回原 PDF，并在同目录自动留一份带时间戳的备份文件；图片与版式不变。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
          选择「丢弃改动并离开」不会改动磁盘上的原文件，只是放弃这次未保存的编辑。
        </Typography.Paragraph>
      </Modal>

      <Modal
        title={`还有 ${faithfulChanges} 处保真编辑没保存`}
        open={faithfulLeaveAsk}
        closable={false}
        maskClosable={false}
        keyboard={false}
        footer={[
          <Button
            key="cancel"
            onClick={() => {
              afterFaithfulLeaveRef.current = null
              setFaithfulLeaveAsk(false)
            }}
          >
            取消（继续编辑）
          </Button>,
          <Button key="discard" danger onClick={finishFaithfulLeave}>
            丢弃改动并离开
          </Button>,
          <Button
            key="save"
            type="primary"
            loading={faithfulSaving}
            onClick={() => {
              afterFaithfulLeaveRef.current = null
              setFaithfulLeaveAsk(false)
              void doFaithfulSave()
            }}
          >
            保存到原文件并离开
          </Button>
        ]}
      >
        <Typography.Paragraph style={{ marginBottom: 6 }}>
          保存会把改动以手术式写回原始文件（只改文字，其余字节不动），并在同目录自动留一份 .bak 备份。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
          选择「丢弃改动并离开」不会改动磁盘上的原文件，只是放弃这次未保存的编辑。
        </Typography.Paragraph>
      </Modal>

      <Modal
        title="另存为"
        open={saveAsOpen}
        onCancel={() => setSaveAsOpen(false)}
        onOk={() => void doSaveAsConfirm()}
        okText="选择位置并保存"
        cancelText="取消"
        okButtonProps={{ disabled: !saveAsFormat, loading: saving }}
        width={460}
      >
        <Radio.Group value={saveAsFormat} onChange={(e) => setSaveAsFormat(e.target.value)} style={{ width: '100%' }}>
          <Space direction="vertical" style={{ width: '100%' }} size={6}>
            {saveAsOptions.map((o) => (
              <Radio key={o.value} value={o.value}>
                {o.label}
              </Radio>
            ))}
          </Space>
        </Radio.Group>
      </Modal>

      {/* 右侧辅助抽屉（浮层、无遮罩、不挤压主舞台）：
          - 编辑模式 → 实时预览（随输入更新，Markdown 渲染 / 纯文本）
          - 工具模式 → PDF 工具参数（全高滚动，不再有 46vh 高度限制）
          两类内容互斥：选了工具优先显示工具，否则在编辑态显示预览。 */}
      <Drawer
        open={auxOpen}
        onClose={() => {
          setAuxOpen(false)
          if (pdfTool) setPdfTool(null)
        }}
        placement="right"
        width={460}
        mask={false}
        styles={{ body: { padding: '12px 14px', overflow: 'auto' } }}
        title={
          pdfTool
            ? TOOL_META.find((t) => t.key === pdfTool)?.title ?? 'PDF 工具'
            : canEdit && !isWordLike && mode === 'edit'
              ? '实时预览'
              : '辅助面板'
        }
        extra={
          <Button
            size="small"
            type="text"
            icon={<CloseOutlined />}
            onClick={() => {
              setAuxOpen(false)
              if (pdfTool) setPdfTool(null)
            }}
          />
        }
      >
        {pdfTool ? (
          <PdfTools
            embedded
            initialTool={pdfTool}
            initialFile={doc?.ok && doc.kind === 'pdf' && doc.path ? { path: doc.path, name: doc.name ?? '', size: doc.size ?? 0 } : null}
            onExit={() => {
              setPdfTool(null)
              setAuxOpen(false)
            }}
            onEditContent={() => {
              setPdfTool(null)
              setAuxOpen(false)
              setMode('inplace')
            }}
          />
        ) : canEdit && !isWordLike && (mode === 'edit' || mode === 'source') ? (
          rendered ? (
            <div className="markdown-preview docs-md" style={{ fontSize: '1em' }} dangerouslySetInnerHTML={rendered} />
          ) : (
            <pre className="docs-pre" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
              {textForRender}
            </pre>
          )
        ) : (
          <Empty description={doc?.ok ? '当前视图没有辅助内容。进入编辑模式看实时预览，或点上方 PDF 工具。' : '先打开一个文件。'} />
        )}
      </Drawer>
    </div>
  )
}
