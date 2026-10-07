/* ============================================================
 * PDF 就地编辑器（保版式）
 * · 点选文字行 → 改内容 / 改样式（字号·字体·颜色·粗体·斜体·下划线·对齐）
 * · 多选（Ctrl 加选、Shift 范围选）批量改样式，Delete 清空文字
 * · 拖拽框选区域加批注高亮，也可对选中行一键高亮
 * · 完整撤销/重做，Ctrl+Z / Ctrl+Y
 * · 导出只覆盖被改动的文字与批注，图片、矢量、页面尺寸与其余文字保持原样
 *
 * 坐标：pdfTextBlocks 的 rect/baseline 是 PDF 用户坐标（左下原点、未旋转空间）；
 * 叠加层与框选都必须用同一 viewport 投影换算，旋转页不能拿 page.height 夹取。
 * ============================================================ */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, ColorPicker, Input, InputNumber, Segmented, Select, Space, Spin, Tag, Tooltip, Typography, message } from 'antd'
import {
  ArrowLeftOutlined,
  BoldOutlined,
  DownloadOutlined,
  HighlightOutlined,
  ItalicOutlined,
  PictureOutlined,
  RedoOutlined,
  ReloadOutlined,
  SaveOutlined,
  SwapOutlined,
  UnderlineOutlined,
  UndoOutlined,
  UnorderedListOutlined,
  DeleteOutlined,
  DragOutlined
} from '@ant-design/icons'
import type { InputRef } from 'antd'
import { openPdfDocument } from '../utils/pdfRender'
import { pdfBytesToTextRuns, type PdfTextRun } from '../utils/pdfTextBlocks'
import { replacePdfText, type PdfAnnotation, type TextReplacement } from '../utils/pdfInPlaceReplace'
import {
  getPlacedImageDataUrl,
  listPdfImages,
  type PdfImageScan,
  type PlacedImage
} from '../utils/pdfImageList'
import { applyImageOps, type ImageOp } from '../utils/pdfImageOps'
import type { Rgb } from '../utils/pdfText'

/** 可编辑页数上限（避免一次性渲染过多页面） */
const MAX_EDIT_PAGES = 30
/** 页面渲染目标 CSS 宽度（须小于内容区可用宽度，否则 CSS 缩窄会让叠加层错位） */
const TARGET_PAGE_WIDTH = 800
/** 撤销栈上限 */
const HISTORY_LIMIT = 60

type Align = 'left' | 'center' | 'right'

/** 与 pdfText.ts 栅格化文字一致的字体栈，保证预览与导出宽度接近 */
const FONT_STACK =
  '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Source Han Sans SC", ' +
  '"Noto Sans CJK SC", "WenQuanYi Micro Hei", SimHei, sans-serif'

/** 可选字体（栅格化时按 CSS 字体族渲染） */
const FONT_OPTIONS = [
  { label: '原文', value: '' },
  { label: '微软雅黑', value: 'Microsoft YaHei' },
  { label: '宋体', value: 'SimSun' },
  { label: '黑体', value: 'SimHei' },
  { label: '楷体', value: 'KaiTi' },
  { label: '仿宋', value: 'FangSong' },
  { label: 'Arial', value: 'Arial' },
  { label: 'Times New Roman', value: 'Times New Roman' }
]

const rgbCss = (c: Rgb): string => `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`

function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return { r: 0, g: 0, b: 0 }
  const n = parseInt(m[1], 16)
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }
}

function rgbToHex(c: Rgb): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0')
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`
}

/** 两个 PDF 用户坐标矩形是否（近似）相同 —— 用来把待处理项关联回枚举结果 */
function sameRect(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return (
    Math.abs(a.x - b.x) < 0.01 &&
    Math.abs(a.y - b.y) < 0.01 &&
    Math.abs(a.width - b.width) < 0.01 &&
    Math.abs(a.height - b.height) < 0.01
  )
}

/** 采样时整页渲染用的缩放（1 ≈ 1px/pt：够算平均色，又比 scale 2 省一半内存与时间） */
const SAMPLE_SCALE = 1
/** 采样用的整页画布缓存上限（页数）。一张 A4 页 scale1 约 1.9MB，12 页≈23MB 封顶 */
const SAMPLE_CACHE_MAX = 12

/** 采样用的一页渲染结果（画布 + 投影换算，同一页只渲染一次） */
interface CachedPageRender {
  canvas: HTMLCanvasElement
  vp: {
    scale: number
    width: number
    height: number
    convertToViewportPoint: (x: number, y: number) => number[]
  }
}

/**
 * 取（或渲染并缓存）某一页的采样用画布。
 * 不缓存的话，用户在一页上删 5 张图就是 5 次整页重渲染，大页面上每次近秒级。
 * 缓存由调用方持有并在文档重新加载时清空（见组件里的 sampleCacheRef）。
 */
async function renderPageForSampling(
  bytes: Uint8Array,
  page: number,
  cache: Map<number, CachedPageRender>
): Promise<CachedPageRender | null> {
  const hit = cache.get(page)
  if (hit) return hit
  const pdf = await openPdfDocument(bytes)
  try {
    const p = await pdf.getPage(page + 1)
    const vp = p.getViewport({ scale: SAMPLE_SCALE })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(vp.width))
    canvas.height = Math.max(1, Math.round(vp.height))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    await p.render({ canvas, canvasContext: ctx, viewport: vp } as Parameters<typeof p.render>[0]).promise
    const entry: CachedPageRender = { canvas, vp }
    if (cache.size >= SAMPLE_CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(page, entry)
    return entry
  } finally {
    ;(pdf as unknown as { destroy?: () => Promise<void> }).destroy?.()
  }
}

/**
 * 从页面**实际像素**采样图片四周环带的平均色，作为删除/替换/移动时的覆盖色。
 * 为什么要环带而不是图片本体：覆盖层要盖住图片原本占的位置，需要的是它周围的到底底色，
 * 采图片本体只会拿到图片自己的颜色，盖上去等于没盖。
 * 采样失败（渲染异常 / 环带全透明）返回 null，由调用方决定兜底并给出可见提示。
 */
async function sampleRegionColor(
  bytes: Uint8Array,
  cache: Map<number, CachedPageRender>,
  page: number,
  rect: { x: number; y: number; width: number; height: number }
): Promise<{ r: number; g: number; b: number } | null> {
  try {
    const entry = await renderPageForSampling(bytes, page, cache)
    if (!entry) return null
    const { canvas, vp } = entry
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    const [ax, ay] = vp.convertToViewportPoint(rect.x, rect.y + rect.height)
    const [bx, by] = vp.convertToViewportPoint(rect.x + rect.width, rect.y)
    const inX1 = Math.min(ax, bx)
    const inX2 = Math.max(ax, bx)
    const inY1 = Math.min(ay, by)
    const inY2 = Math.max(ay, by)

    const margin = Math.max(6, 0.15 * Math.min(rect.width, rect.height)) * vp.scale
    const x1 = Math.max(0, Math.floor(inX1 - margin))
    const x2 = Math.min(canvas.width, Math.ceil(inX2 + margin))
    const y1 = Math.max(0, Math.floor(inY1 - margin))
    const y2 = Math.min(canvas.height, Math.ceil(inY2 + margin))
    if (x2 - x1 < 2 || y2 - y1 < 2) return null

    const w = x2 - x1
    const data = ctx.getImageData(x1, y1, w, y2 - y1).data
    let r = 0
    let g = 0
    let b = 0
    let n = 0
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        // 跳过图片本体那一块，只统计四面环带
        if (x >= inX1 - 1 && x <= inX2 + 1 && y >= inY1 - 1 && y <= inY2 + 1) continue
        const i = ((y - y1) * w + (x - x1)) * 4
        if (data[i + 3] < 8) continue
        r += data[i]
        g += data[i + 1]
        b += data[i + 2]
        n++
      }
    }
    if (!n) return null
    return { r: r / n, g: g / n, b: b / n }
  } catch {
    return null
  }
}

/** 读本地 png/jpeg 为 data URL（渲染进程内的文件选择，无需主进程新增通道） */
function readImageAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result || ''))
    fr.onerror = () => reject(new Error('读取图片失败'))
    fr.readAsDataURL(file)
  })
}

/** 一行文字的编辑记录：存在即表示该行被改过 */
interface RunEdit {
  text: string
  align: Align
  fontSize: number
  color: Rgb
  fontFamily: string
  bold: boolean
  italic: boolean
  underline: boolean
}

interface AnnotationEdit extends PdfAnnotation {
  /** 本地 id，仅用于渲染 key 与撤销 */
  aid: string
}

interface Snapshot {
  edits: Record<string, RunEdit>
  annotations: AnnotationEdit[]
  imageOps: ImageOp[]
}

let measureCtx: CanvasRenderingContext2D | null | undefined
function measureTextWidth(text: string, px: number, fontFamily: string, bold: boolean, italic: boolean): number {
  if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d')
  if (!measureCtx) return text.length * px * 0.6
  const family = fontFamily ? `${fontFamily}, ${FONT_STACK}` : FONT_STACK
  measureCtx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${px}px ${family}`
  return measureCtx.measureText(text).width
}

interface RunBox {
  run: PdfTextRun
  left: number
  top: number
  width: number
  height: number
}

interface PageView {
  page: number
  src: string
  cssWidth: number
  cssHeight: number
  scale: number
  boxes: RunBox[]
  /** CSS 像素 → PDF 用户坐标（框选批注用） */
  toPdfPoint: (x: number, y: number) => [number, number]
  /** PDF 用户坐标 → CSS 像素（批注叠加层定位用；旋转页同样正确） */
  toCssPoint: (x: number, y: number) => [number, number]
}

/** 框选矩形（CSS 像素，相对当前页左上角） */
interface MarqueeRect {
  x: number
  y: number
  w: number
  h: number
}

/** 待拖拽定框的图片任务：插入一张新图，或把已有图移到新位置 */
type PendingImageTask =
  | { mode: 'insert'; dataUrl: string; name: string }
  | { mode: 'move'; source: PlacedImage }

interface DragState {
  view: PageView
  /** 拖拽起始页元素；用它而不是 event.currentTarget，鼠标划过子元素/其他页时坐标才不会错位 */
  el: HTMLDivElement
  sx: number
  sy: number
  rect: MarqueeRect | null
  /** 本次拖拽的目的：空白拖拽=加高亮；有待处理图片任务时=框选放置/移动目标框 */
  kind: 'annotate' | 'image'
  /** kind='image' 时要执行的任务 */
  task: PendingImageTask | null
}

/** 原始值 → 编辑基准（首次改动时以原值为起点） */
function baseEdit(run: PdfTextRun): RunEdit {
  return {
    text: run.text,
    align: run.align,
    fontSize: run.fontSize,
    color: run.color,
    fontFamily: run.fontFamily || '',
    bold: !!run.bold,
    italic: !!run.italic,
    underline: false
  }
}

/** 父组件据此拿到编辑器的保存能力（顶部「保存」按钮直接驱动本编辑器） */
export interface PdfInPlaceEditorHandle {
  /** 覆盖保存回原文件；写盘前先在**同目录**留一份带时间戳的备份 */
  saveToOriginal: () => Promise<boolean>
  /** 另存为新文件（不动原文件） */
  saveAs: () => Promise<boolean>
  /** 当前未保存的改动处数（文字改动 + 批注） */
  pendingCount: () => number
}

interface PdfInPlaceEditorProps {
  path: string
  name: string
  bytes: Uint8Array | null
  /** 离开编辑器；父组件负责「有未保存改动」的二次确认 */
  onExit: () => void
  /** 未保存改动处数变化时上报（顶部保存按钮的启用与关闭确认都要用） */
  onPendingChange?: (n: number) => void
  /** 覆盖保存成功后的回调，父组件据此重新从磁盘加载 */
  onSaved?: () => void
  /** 由父组件持有；挂载后填入保存能力 */
  apiRef?: { current: PdfInPlaceEditorHandle | null }
}

export default function PdfInPlaceEditor({
  path,
  name,
  bytes,
  onExit,
  onPendingChange,
  onSaved,
  apiRef
}: PdfInPlaceEditorProps) {
  const [loading, setLoading] = useState(true)
  const [progress, setProgress] = useState('')
  const [err, setErr] = useState('')
  const [views, setViews] = useState<PageView[]>([])
  const [runs, setRuns] = useState<PdfTextRun[]>([])
  const [totalPages, setTotalPages] = useState(0)
  const [edits, setEdits] = useState<Record<string, RunEdit>>({})
  const [annotations, setAnnotations] = useState<AnnotationEdit[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [exporting, setExporting] = useState(false)
  /** 框选中的临时矩形（CSS 像素，按页） */
  const [marquee, setMarquee] = useState<{ page: number; x: number; y: number; w: number; h: number } | null>(null)
  const inputRef = useRef<InputRef | null>(null)

  /* ---------- 图片编辑状态 ---------- */
  /** 待写入的图片操作；与文字/批注一样是「相对原文件的全量」，保存后仍保留 */
  const [imageOps, setImageOps] = useState<ImageOp[]>([])
  /** 枚举出的图片（惰性：只有标量，不含像素）；null = 尚未枚举 */
  const [imgList, setImgList] = useState<PlacedImage[] | null>(null)
  const [imgScan, setImgScan] = useState<PdfImageScan | null>(null)
  const [imgScanning, setImgScanning] = useState(false)
  const [selImgKey, setSelImgKey] = useState<string | null>(null)
  /** 已选好文件/目标、等待在页面上拖拽出目标框的任务（插入新图 / 移动已有图） */
  const [pendingTask, setPendingTask] = useState<PendingImageTask | null>(null)
  const pendingTaskRef = useRef<PendingImageTask | null>(null)
  /** 新图旋转（度）：作用于待插入的图、以及选中项已标记的替换 */
  const [imgRotate, setImgRotate] = useState<number>(0)
  /** 采样用的整页画布缓存；文档重新加载时必须清空 */
  const sampleCacheRef = useRef<Map<number, CachedPageRender>>(new Map())
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const filePickModeRef = useRef<'insert' | 'replace'>('insert')
  const [imgBusy, setImgBusy] = useState(false)

  /** 同步 pendingTask 到 ref：window 上的 move/up 只依赖 ref，避免重建监听 */
  const setPendingTaskBoth = useCallback((v: PendingImageTask | null) => {
    pendingTaskRef.current = v
    setPendingTask(v)
  }, [])

  const historyRef = useRef<Snapshot[]>([{ edits: {}, annotations: [], imageOps: [] }])
  const histIndexRef = useRef(0)
  const [, forceHistory] = useState(0)

  /**
   * 已保存基线。
   * 保版式改字是「在内容流末尾追加覆盖层」，原文字仍在文本层里——所以保存后重新提取文字，
   * 拿到的还是**旧文案**；若继续拿原始 run 当基准，面板会立刻"退回"旧文字，
   * 用户看起来就像「保存没有改变」。这里记住已保存的编辑状态，让面板保持显示用户改后的文字。
   */
  const savedRef = useRef<Snapshot>({ edits: {}, annotations: [], imageOps: [] })
  const [savedTick, setSavedTick] = useState(0)

  /** 记录一次改动（写历史后再应用） */
  const commit = useCallback(
    (next: Snapshot) => {
      const trimmed = historyRef.current.slice(0, histIndexRef.current + 1)
      trimmed.push(next)
      if (trimmed.length > HISTORY_LIMIT) trimmed.shift()
      historyRef.current = trimmed
      histIndexRef.current = trimmed.length - 1
      setEdits(next.edits)
      setAnnotations(next.annotations)
      setImageOps(next.imageOps)
      forceHistory((v) => v + 1)
    },
    []
  )

  const undo = useCallback(() => {
    if (histIndexRef.current <= 0) return
    histIndexRef.current -= 1
    const s = historyRef.current[histIndexRef.current]
    setEdits(s.edits)
    setAnnotations(s.annotations)
    setImageOps(s.imageOps)
    setActiveId(null)
    forceHistory((v) => v + 1)
  }, [])

  const redo = useCallback(() => {
    if (histIndexRef.current >= historyRef.current.length - 1) return
    histIndexRef.current += 1
    const s = historyRef.current[histIndexRef.current]
    setEdits(s.edits)
    setAnnotations(s.annotations)
    setImageOps(s.imageOps)
    setActiveId(null)
    forceHistory((v) => v + 1)
  }, [])

  const canUndo = histIndexRef.current > 0
  const canRedo = histIndexRef.current < historyRef.current.length - 1

  /* ---------- 载入：提取文字行 + 渲染页面背景 ---------- */
  useEffect(() => {
    if (!bytes) return
    let cancelled = false
    setLoading(true)
    setErr('')
    setEdits({})
    setAnnotations([])
    setSelected([])
    setImageOps([])
    setImgList(null)
    setImgScan(null)
    setSelImgKey(null)
    setPendingTask(null)
    pendingTaskRef.current = null
    sampleCacheRef.current.clear()
    historyRef.current = [{ edits: {}, annotations: [], imageOps: [] }]
    histIndexRef.current = 0
    savedRef.current = { edits: {}, annotations: [], imageOps: [] }
    setSavedTick((v) => v + 1)
    void (async () => {
      try {
        setProgress('正在解析 PDF 文字位置…')
        const r = await pdfBytesToTextRuns(bytes, {
          maxPages: MAX_EDIT_PAGES,
          onProgress: (done, total) => setProgress(`正在解析文字位置… ${done}/${total} 页`)
        })
        if (cancelled) return
        const allRuns = r.pages.flatMap((p) => p.runs)
        if (!allRuns.length) {
          setErr('这份 PDF 没有文字层（扫描件/图片型），无法就地改字；可用 PDF 工具里的 OCR 识别后另行编辑。')
          setLoading(false)
          return
        }
        setProgress('正在渲染页面…')
        // 自渲染：按目标宽度算精确 scale，保证叠加层与画布 1:1
        const pdf = await openPdfDocument(bytes)
        const out: PageView[] = []
        for (const blocks of r.pages) {
          if (cancelled) break
          const page = await pdf.getPage(blocks.page + 1)
          const vp1 = page.getViewport({ scale: 1 })
          const width = Math.min(TARGET_PAGE_WIDTH, Math.round(vp1.width * 2))
          const scale = width / vp1.width
          const vp = page.getViewport({ scale })
          const canvas = document.createElement('canvas')
          canvas.width = Math.round(vp.width)
          canvas.height = Math.round(vp.height)
          const ctx = canvas.getContext('2d')
          if (!ctx) continue
          await page.render({ canvas, canvasContext: ctx, viewport: vp } as Parameters<typeof page.render>[0]).promise
          const boxes: RunBox[] = blocks.runs.map((run) => {
            const [x1, y1] = vp.convertToViewportPoint(run.rect.x, run.rect.y + run.rect.height)
            const [x2, y2] = vp.convertToViewportPoint(run.rect.x + run.rect.width, run.rect.y)
            return {
              run,
              left: Math.min(x1, x2),
              top: Math.min(y1, y2),
              width: Math.abs(x2 - x1),
              height: Math.abs(y2 - y1)
            }
          })
          out.push({
            page: blocks.page,
            src: canvas.toDataURL('image/jpeg', 0.9),
            cssWidth: canvas.width,
            cssHeight: canvas.height,
            scale,
            boxes,
            toPdfPoint: (x: number, y: number) => vp.convertToPdfPoint(x, y) as [number, number],
            toCssPoint: (x: number, y: number) => vp.convertToViewportPoint(x, y) as [number, number]
          })
        }
        ;(pdf as unknown as { destroy?: () => Promise<void> }).destroy?.()
        if (cancelled) return
        setRuns(allRuns)
        setViews(out)
        setTotalPages(r.totalPages)
        setLoading(false)
        setProgress('')
      } catch (e) {
        if (!cancelled) {
          setErr('打开失败：' + (e as Error).message)
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [bytes])

  /* ---------- 选中与编辑 ---------- */
  const startEdit = useCallback(
    (run: PdfTextRun, mode: 'single' | 'toggle' | 'range') => {
      setSelected((prev) => {
        if (mode === 'toggle') return prev.includes(run.id) ? prev.filter((x) => x !== run.id) : [...prev, run.id]
        if (mode === 'range' && prev.length) {
          const all = runs.map((r) => r.id)
          const a = all.indexOf(prev[prev.length - 1])
          const b = all.indexOf(run.id)
          if (a >= 0 && b >= 0) {
            const [s, e] = a <= b ? [a, b] : [b, a]
            return Array.from(new Set([...prev, ...all.slice(s, e + 1)]))
          }
        }
        return [run.id]
      })
      if (mode === 'single') {
        setActiveId(run.id)
        setDraft(edits[run.id]?.text ?? run.text)
      }
    },
    [runs, edits]
  )

  const commitText = useCallback(() => {
    if (!activeId) return
    const run = runs.find((r) => r.id === activeId)
    setActiveId(null)
    if (!run) return
    const base = baseEdit(run)
    const cur = edits[activeId] ?? base
    const nextEdit: RunEdit = { ...cur, text: draft }
    const isOriginal = nextEdit.text === run.text && isSameStyle(nextEdit, base)
    const next = { ...edits }
    if (isOriginal) delete next[activeId]
    else next[activeId] = nextEdit
    commit({ edits: next, annotations, imageOps })
  }, [activeId, runs, edits, draft, annotations, imageOps, commit])

  /** 选中行批量套用样式 */
  const applyStyle = useCallback(
    (patch: Partial<Omit<RunEdit, 'text'>>) => {
      const ids = selected.length ? selected : activeId ? [activeId] : []
      if (!ids.length) {
        message.info('先点选一行文字（Ctrl 加选、Shift 范围选）')
        return
      }
      const next = { ...edits }
      for (const id of ids) {
        const run = runs.find((r) => r.id === id)
        if (!run) continue
        const cur = next[id] ?? baseEdit(run)
        next[id] = { ...cur, ...patch }
      }
      commit({ edits: next, annotations, imageOps })
    },
    [selected, activeId, edits, runs, annotations, imageOps, commit]
  )

  /** 清空选中行文字（等效删除这一行） */
  const deleteSelectedText = useCallback(() => {
    const ids = selected.length ? selected : activeId ? [activeId] : []
    if (!ids.length) return
    const next = { ...edits }
    for (const id of ids) {
      const run = runs.find((r) => r.id === id)
      if (!run) continue
      next[id] = { ...(next[id] ?? baseEdit(run)), text: '' }
    }
    commit({ edits: next, annotations, imageOps })
    message.success(`已删除 ${ids.length} 行文字（导出生效）`)
  }, [selected, activeId, edits, runs, annotations, imageOps, commit])

  /** 给选中行加/取消高亮批注 */
  const toggleHighlight = useCallback(
    (hex: string) => {
      const ids = selected.length ? selected : activeId ? [activeId] : []
      if (!ids.length) {
        message.info('先点选一行文字，或在页面上拖拽框选区域')
        return
      }
      const targets = runs.filter((r) => ids.includes(r.id))
      const already = targets.length > 0 && targets.every((r) => annotations.some((a) => a.rect.x === r.rect.x && a.rect.y === r.rect.y && a.kind === 'highlight'))
      let nextAnnots: AnnotationEdit[]
      if (already) {
        nextAnnots = annotations.filter(
          (a) => !(a.kind === 'highlight' && targets.some((r) => r.rect.x === a.rect.x && r.rect.y === a.rect.y))
        )
      } else {
        nextAnnots = [
          ...annotations,
          ...targets.map((r, i) => ({
            aid: `a${Date.now()}-${i}`,
            page: r.page,
            rect: { x: r.rect.x, y: r.rect.y, width: r.rect.width, height: r.rect.height },
            kind: 'highlight' as const,
            color: hexToRgb(hex),
            opacity: 0.35
          }))
        ]
      }
      commit({ edits, annotations: nextAnnots, imageOps })
    },
    [selected, activeId, runs, annotations, edits, imageOps, commit]
  )

  /* ---------- 图片：枚举 / 选择 / 删除 / 替换 / 插入 ---------- */

  /** 惰性枚举页面上的图片（只拿标量，不解码像素、不持有 base64） */
  const scanImages = useCallback(async () => {
    if (!bytes) return
    setImgScanning(true)
    try {
      const r = await listPdfImages(bytes, { maxPages: MAX_EDIT_PAGES })
      setImgList(r.images)
      setImgScan(r)
      if (!r.images.length) {
        message.info('这份 PDF 没有检测到可编辑的位图（文字与矢量图不受影响）')
      } else if (r.unsupportedOps.repeat || r.unsupportedOps.inlineGroup) {
        message.warning(
          `有 ${r.unsupportedOps.repeat} 组重复绘制、${r.unsupportedOps.inlineGroup} 组内联图组未能完整展开，列表可能不全`
        )
      }
    } catch (e) {
      message.error('图片枚举失败：' + (e as Error).message)
    } finally {
      setImgScanning(false)
    }
  }, [bytes])

  const selectedImage = useMemo(
    () => (imgList && selImgKey ? imgList.find((i) => i.key === selImgKey) ?? null : null),
    [imgList, selImgKey]
  )

  /** 当前选中图片已挂的删除/替换操作（用于按钮禁用与状态标签） */
  const selectedImageOp = useMemo(() => {
    if (!selectedImage) return null
    return (
      imageOps.find((o) => o.kind !== 'insert' && o.page === selectedImage.page && sameRect(o.pdfRect, selectedImage.pdfRect)) ?? null
    )
  }, [selectedImage, imageOps])

  /** 选中项缩略图：只在选中时惰性取一张，避免把整份文档的像素都拉进内存 */
  const [selThumb, setSelThumb] = useState('')
  useEffect(() => {
    let cancelled = false
    setSelThumb('')
    if (!bytes || !selectedImage) return
    void (async () => {
      try {
        const url = await getPlacedImageDataUrl(bytes, selectedImage)
        if (!cancelled) setSelThumb(url)
      } catch {
        /* 缩略图是可选增强，取不到不影响编辑 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [bytes, selectedImage])

  /** 采样覆盖色；失败时白色兜底并显式告警（绝不静默）。整页渲染按页复用缓存 */
  const coverColorFor = useCallback(
    async (img: PlacedImage): Promise<{ r: number; g: number; b: number }> => {
      const c = bytes ? await sampleRegionColor(bytes, sampleCacheRef.current, img.page, img.pdfRect) : null
      if (c) return c
      message.warning('未能从页面像素采样到覆盖色，已退回白色——若原背景非白色，覆盖处可能看得出色差')
      return { r: 255, g: 255, b: 255 }
    },
    [bytes]
  )

  /** 同一张原图只保留一条删除/替换操作（重复操作以最后一次为准） */
  const upsertImageOp = useCallback(
    (op: ImageOp) => {
      const next = imageOps.filter(
        (o) => !(o.kind !== 'insert' && o.page === op.page && sameRect(o.pdfRect, op.pdfRect))
      )
      next.push(op)
      commit({ edits, annotations, imageOps: next })
    },
    [imageOps, edits, annotations, commit]
  )

  const applyReplace = useCallback(
    async (dataUrl: string) => {
      const img = selectedImage
      if (!img) {
        message.warning('先在「图片列表」里选一张图片，再点「替换图片」')
        return
      }
      setImgBusy(true)
      try {
        const color = await coverColorFor(img)
        upsertImageOp({
          kind: 'replace',
          page: img.page,
          pdfRect: img.pdfRect,
          dataUrl,
          coverColor: color,
          rotate: imgRotate || undefined
        })
        message.success(`已标记替换第 ${img.page + 1} 页图片（保存后生效）${imgRotate ? `，新图旋转 ${imgRotate}°` : ''}`)
      } finally {
        setImgBusy(false)
      }
    },
    [selectedImage, coverColorFor, upsertImageOp, imgRotate]
  )

  const pickImageFile = useCallback((mode: 'insert' | 'replace') => {
    filePickModeRef.current = mode
    const input = fileInputRef.current
    if (!input) return
    input.value = ''
    input.click()
  }, [])

  const onFileChosen = useCallback(
    async (file: File | undefined) => {
      if (!file) return
      if (!/^image\/(png|jpeg)$/.test(file.type)) {
        message.error('只支持 PNG / JPEG 图片')
        return
      }
      let dataUrl = ''
      try {
        dataUrl = await readImageAsDataUrl(file)
      } catch (e) {
        message.error((e as Error).message)
        return
      }
      if (filePickModeRef.current === 'insert') {
        setPendingTaskBoth({ mode: 'insert', dataUrl, name: file.name })
        message.info('在页面上按住左键拖出一个矩形来选择放置区域；Esc 取消')
        return
      }
      await applyReplace(dataUrl)
    },
    [applyReplace, setPendingTaskBoth]
  )

  const deleteSelectedImage = useCallback(async () => {
    const img = selectedImage
    if (!img) {
      message.warning('先在「图片列表」里选一张图片，再点「删除图片」')
      return
    }
    setImgBusy(true)
    try {
      const color = await coverColorFor(img)
      upsertImageOp({ kind: 'delete', page: img.page, pdfRect: img.pdfRect, coverColor: color })
      message.success(
        `已标记删除第 ${img.page + 1} 页图片（保存后生效）。注意：这是用同色块盖住，并非真正抹除，图片数据仍留在文件里`
      )
    } finally {
      setImgBusy(false)
    }
  }, [selectedImage, coverColorFor, upsertImageOp])

  /** 进入「移动」待定框态：复用插入那套拖拽，只是任务换成 move */
  const moveSelectedImage = useCallback(() => {
    const img = selectedImage
    if (!img) {
      message.warning('先在「图片列表」里选一张图片，再点「移动图片」')
      return
    }
    setPendingTaskBoth({ mode: 'move', source: img })
    message.info('在页面上按住左键拖出图片的新位置；Esc 取消')
  }, [selectedImage, setPendingTaskBoth])

  /**
   * 切换新图旋转。除了作为「下一次插入/替换」的默认值，
   * 若选中项已经标记了替换，这里会立刻更新那条操作 —— 避免做成「只能选不能生效」的装饰。
   */
  const changeImgRotate = useCallback(
    (v: number) => {
      setImgRotate(v)
      const img = selectedImage
      if (!img) return
      const existing = imageOps.find(
        (o) => o.kind === 'replace' && o.page === img.page && sameRect(o.pdfRect, img.pdfRect)
      )
      if (!existing) return
      upsertImageOp({ ...existing, rotate: v || undefined })
    },
    [selectedImage, imageOps, upsertImageOp]
  )

  /** 旋转控件显示值：选中项已有替换操作时显示那条操作的旋转，否则显示待用默认值 */
  const shownRotate = useMemo(() => {
    const raw =
      selectedImageOp && selectedImageOp.kind === 'replace' ? selectedImageOp.rotate ?? 0 : imgRotate
    return [0, 90, 180, 270].includes(raw) ? raw : 0
  }, [selectedImageOp, imgRotate])

  /* ---------- 框选（空白处拖拽加高亮 / 已选图片时拖拽放置） ---------- */
  const dragRef = useRef<DragState | null>(null)

  const onPageMouseDown = (view: PageView, e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const el = e.currentTarget
    const b = el.getBoundingClientRect()
    const task = pendingTaskRef.current
    dragRef.current = {
      view,
      el,
      sx: e.clientX - b.left,
      sy: e.clientY - b.top,
      rect: null,
      kind: task ? 'image' : 'annotate',
      task
    }
    setMarquee(null)
  }

  /** 拖拽的 move/up 都挂在 window 上：鼠标移出页面或移出窗口也能正确收尾 */
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      const b = d.el.getBoundingClientRect()
      const x = e.clientX - b.left
      const y = e.clientY - b.top
      const w = Math.abs(x - d.sx)
      const h = Math.abs(y - d.sy)
      if (w + h < 6) {
        d.rect = null
        setMarquee(null)
        return
      }
      d.rect = { x: Math.min(x, d.sx), y: Math.min(y, d.sy), w, h }
      setMarquee({ page: d.view.page, ...d.rect })
    }
    const onUp = () => {
      const d = dragRef.current
      dragRef.current = null
      setMarquee(null)
      if (!d?.rect || d.rect.w < 8 || d.rect.h < 6) return
      const m = d.rect
      // CSS 像素 → PDF 用户坐标：必须走 toPdfPoint（toCssPoint 是它的逆变换，方向相反）
      const [px1, py1] = d.view.toPdfPoint(m.x, m.y + m.h)
      const [px2, py2] = d.view.toPdfPoint(m.x + m.w, m.y)
      const pdfRect = {
        x: Math.min(px1, px2),
        y: Math.min(py1, py2),
        width: Math.abs(px2 - px1),
        height: Math.abs(py2 - py1)
      }
      if (d.kind === 'image' && d.task) {
        if (d.task.mode === 'insert') {
          const op: ImageOp = {
            kind: 'insert',
            page: d.view.page,
            pdfRect,
            dataUrl: d.task.dataUrl,
            coverColor: { r: 255, g: 255, b: 255 },
            rotate: imgRotate || undefined
          }
          setPendingTaskBoth(null)
          commit({ edits, annotations, imageOps: [...imageOps, op] })
          message.success('已放置图片（保存/另存为时写入 PDF）')
        } else {
          // 移动：先取回原图像素（move 也是「盖住原位 + 在新位重画」），再生成 move 操作
          const src = d.task.source
          void (async () => {
            setImgBusy(true)
            try {
              let dataUrl = ''
              try {
                dataUrl = await getPlacedImageDataUrl(bytes as Uint8Array, src)
              } catch (err) {
                message.error('取回原图像素失败，无法移动：' + (err as Error).message)
                return
              }
              const color = await coverColorFor(src)
              upsertImageOp({
                kind: 'move',
                page: src.page,
                pdfRect: src.pdfRect,
                targetRect: pdfRect,
                dataUrl,
                coverColor: color,
                rotate: imgRotate || undefined
              })
              message.success(`已把第 ${src.page + 1} 页图片移到新位置（保存后生效）`)
            } finally {
              setImgBusy(false)
              setPendingTaskBoth(null)
            }
          })()
        }
        return
      }
      const anno: AnnotationEdit = {
        aid: `a${Date.now()}`,
        page: d.view.page,
        rect: pdfRect,
        kind: 'highlight',
        color: hexToRgb(highlightHexRef.current),
        opacity: 0.35
      }
      commit({ edits, annotations: [...annotations, anno], imageOps })
      message.success('已加高亮批注（导出后生效）')
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [commit, edits, annotations, imageOps, imgRotate, setPendingTaskBoth, bytes, coverColorFor, upsertImageOp])

  /** 高亮色（框选与按钮共用） */
  const highlightHexRef = useRef('#ffe58f')

  /* ---------- 预览 ---------- */
  const previewFor = useCallback(
    (box: RunBox, scale: number) => {
      const edit = edits[box.run.id]
      if (!edit) return null
      const px = edit.fontSize * scale
      const w = measureTextWidth(edit.text, px, edit.fontFamily, edit.bold, edit.italic)
      let left = box.left
      if (edit.align === 'center') left = box.left + (box.width - w) / 2
      else if (edit.align === 'right') left = box.left + box.width - w
      return {
        left,
        px,
        color: rgbCss(edit.color),
        bg: rgbCss(box.run.bgColor),
        text: edit.text,
        bold: edit.bold,
        italic: edit.italic,
        underline: edit.underline,
        fontFamily: edit.fontFamily ? `${edit.fontFamily}, ${FONT_STACK}` : FONT_STACK,
        align: edit.align
      }
    },
    [edits]
  )

  /* ---------- 导出 ---------- */
  /** 某行的基准：优先用「已保存状态」，否则用原始文字 */
  const baselineOf = useCallback(
    (run: PdfTextRun): RunEdit => savedRef.current.edits[run.id] ?? baseEdit(run),
    []
  )

  /** 相对**已保存基线**的未保存文字改动数（保存后应归零） */
  const changedCount = useMemo(() => {
    void savedTick
    let n = 0
    for (const run of runs) {
      const e = edits[run.id]
      const base = savedRef.current.edits[run.id] ?? baseEdit(run)
      if (e && (e.text !== base.text || !isSameStyle(e, base))) n++
    }
    return n
    // savedTick 参与：保存后 savedRef 变了但 runs/edits 引用不变，必须显式触发重算
  }, [runs, edits, savedTick])

  /** 相对已保存基线的新增批注数 */
  const newAnnotationCount = useMemo(() => {
    void savedTick
    const saved = savedRef.current.annotations
    return annotations.filter((a) => !saved.some((s) => s.aid === a.aid)).length
  }, [annotations, savedTick])

  /** 相对已保存基线的图片操作数（按对象身份比对：保存后基线就是当前数组） */
  const pendingImageCount = useMemo(() => {
    void savedTick
    const saved = savedRef.current.imageOps
    if (saved.length === imageOps.length && saved.every((o, i) => o === imageOps[i])) return 0
    const savedSet = new Set(saved)
    return imageOps.filter((o) => !savedSet.has(o)).length
  }, [imageOps, savedTick])

  /** 未保存的改动处数：文字改动 + 新增批注 + 图片操作 */
  const pendingCount = changedCount + newAnnotationCount + pendingImageCount

  /** 本次编辑相对**原始文件**的改动总数（导出按钮文案用；保存后不清零，因为它描述的是文件当前状态） */
  const totalChanged = useMemo(() => {
    let n = 0
    for (const run of runs) {
      const e = edits[run.id]
      if (e && (e.text !== run.text || !isSameStyle(e, baseEdit(run)))) n++
    }
    return n
  }, [runs, edits])

  useEffect(() => {
    onPendingChange?.(pendingCount)
  }, [pendingCount, onPendingChange])

  /** 生成叠加改写后的 PDF 字节；没有任何改动时返回 null */
  /**
   * 新文字超长检测（#75）：覆盖矩形不外扩（会涂白相邻内容），改为保存前可观测警告。
   * 用 canvas 粗量宽：新字串宽度 > 原 rect 宽度 × 1.15 即视为可能压住相邻内容。
   */
  const collectOverflowWarnings = useCallback((): string[] => {
    const warns: string[] = []
    const measure = document.createElement('canvas').getContext('2d')
    if (!measure) return warns
    for (const r of runs) {
      const e = edits[r.id]
      if (!e) continue
      if (e.text === r.text && isSameStyle(e, baseEdit(r))) continue
      const text = e.text ?? ''
      if (!text) continue
      measure.font = `${e.italic ? 'italic ' : ''}${e.bold ? '600 ' : '400 '}${e.fontSize || 12}px ${e.fontFamily || 'sans-serif'}`
      const w = measure.measureText(text).width
      const limit = Math.max(1, r.rect.width * 1.15)
      if (w > limit) {
        const label = text.slice(0, 12) + (text.length > 12 ? '…' : '')
        warns.push(
          `第 ${r.page + 1} 页「${label}」约 ${Math.round(w)}pt，超过原位 ${Math.round(r.rect.width)}pt，可能压住相邻内容`
        )
      }
    }
    return warns
  }, [runs, edits])
  const buildOutput = useCallback(async (): Promise<Uint8Array | null> => {
    if (!bytes) return null
    const reps: TextReplacement[] = []
    for (const r of runs) {
      const e = edits[r.id]
      if (!e) continue
      if (e.text === r.text && isSameStyle(e, baseEdit(r))) continue
      reps.push({
        page: r.page,
        rect: r.rect,
        baseline: r.baseline,
        fontSize: e.fontSize,
        color: e.color,
        bgColor: r.bgColor,
        align: e.align,
        newText: e.text,
        fontFamily: e.fontFamily || undefined,
        bold: e.bold,
        italic: e.italic,
        underline: e.underline
      })
    }
    const annos: PdfAnnotation[] = annotations.map(({ aid, ...rest }) => {
      void aid
      return rest
    })
    if (!reps.length && !annos.length && !imageOps.length) return null
    // 顺序固定：先补文字/批注（含可选的文本层清理），再叠图片操作 ——
    // 图片永远画在最后，保证插入/替换的图不会被文字覆盖层压住。
    let out = bytes
    // #75：新文字超长时保存前警告（不扩覆盖矩形，避免涂白相邻内容）
    const overflowWarns = collectOverflowWarnings()
    if (overflowWarns.length) {
      message.warning(
        `有 ${overflowWarns.length} 处新文字偏长，可能压住相邻内容；已照常保存。${overflowWarns[0]}`
      )
    }
    if (reps.length || annos.length) {
      out = await replacePdfText(bytes, reps, annos, {
        // 默认开启文本层清理：被改掉的旧文字从内容流里真正移除（外科式，视觉零影响，
        // 74/74 像素取证）。匹配有歧义的行保守放弃 —— 旧文字留在文本层，必须如实报数，
        // 不允许静默留下可被搜索/复制的旧内容却让用户以为已清除。
        scrubReplacedText: true,
        onScrubReport: (s) => {
          if (s.targetsSkipped > 0) {
            const reasons = Object.entries(s.reasons).map(([k, v]) => `${k}×${v}`).join('、') || '未知原因'
            message.warning(
              `有 ${s.targetsSkipped} 行旧文字无法从文本层清除（${reasons}），这些行仍可能被搜索或复制到`
            )
          }
        }
      })
    }
    if (imageOps.length) out = await applyImageOps(out, imageOps)
    if (out === bytes) return null
    return out
  }, [bytes, runs, edits, annotations, imageOps, collectOverflowWarnings])

  /**
   * 覆盖保存回原文件。
   * 覆盖重绘不可逆，所以**先在同目录写一份带时间戳的备份**再写回；
   * 备份必须与原文件同目录，否则过不了 pdf:write 的同目录产物校验。
   */
  const saveToOriginal = useCallback(async (): Promise<boolean> => {
    if (!path) {
      message.error('缺少原文件路径，无法覆盖保存；请改用「另存为」')
      return false
    }
    setExporting(true)
    try {
      const out = await buildOutput()
      if (!out) {
        message.warning('还没有做任何修改，无需保存')
        return false
      }
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const dot = path.lastIndexOf('.')
      const backup =
        dot > 0 ? `${path.slice(0, dot)}-备份-${stamp}${path.slice(dot)}` : `${path}-备份-${stamp}.pdf`
      if (bytes) {
        const okBk = await window.api.pdf.write(backup, bytes)
        if (!okBk) {
          message.error('备份写入失败，已取消覆盖保存（不做不可逆写入）')
          return false
        }
      }
      const ok = await window.api.pdf.write(path, out)
      if (!ok) {
        message.error('写回原文件失败：文件可能被其它程序占用，或所在目录不可写')
        return false
      }
      // 记下已保存基线：面板与「未保存」标记都相对它计算。
      // 注意导出始终基于**原始 bytes + 全量编辑**重建，所以连续保存是幂等的。
      savedRef.current = { edits, annotations, imageOps }
      setSavedTick((v) => v + 1)
      message.success(`已保存到原文件；自动备份：${backup.split(/[\\/]/).pop()}`)
      onSaved?.()
      return true
    } catch (e) {
      message.error('保存失败：' + (e as Error).message)
      return false
    } finally {
      setExporting(false)
    }
  }, [path, bytes, edits, annotations, imageOps, buildOutput, onSaved])

  /** 另存为新文件（不动原文件） */
  const saveAs = useCallback(async (): Promise<boolean> => {
    if (!bytes) return false
    setExporting(true)
    try {
      const out = await buildOutput()
      if (!out) {
        message.warning('还没有做任何修改')
        return false
      }
      const base = (name || path.split(/[\\/]/).pop() || '文档').replace(/\.pdf$/i, '')
      const target = await window.api.pdf.savePath(`${base}-已编辑.pdf`, ['pdf'])
      if (!target) return false
      const ok = await window.api.pdf.write(target, out)
      if (ok) {
        message.success(`已另存为：${target}（原版式与图片未改动）`)
        return true
      }
      message.error('写入失败，请检查目标目录权限')
      return false
    } catch (e) {
      message.error('另存为失败：' + (e as Error).message)
      return false
    } finally {
      setExporting(false)
    }
  }, [bytes, buildOutput, name, path])

  /** 把保存能力暴露给父组件：顶部「保存」按钮直接驱动这里，避免改动无处可存 */
  useEffect(() => {
    if (!apiRef) return
    apiRef.current = { saveToOriginal, saveAs, pendingCount: () => pendingCount }
    return () => {
      apiRef.current = null
    }
  }, [apiRef, saveToOriginal, saveAs, pendingCount])

  /* ---------- 快捷键 ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) {
        if (e.key === 'Escape') {
          setActiveId(null)
          setSelected([])
          if (pendingTaskRef.current) {
            setPendingTaskBoth(null)
            message.info('已取消图片操作')
          }
        }
        if (e.key === 'Delete' && !activeId) deleteSelectedText()
        return
      }
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault()
        redo()
      } else if (k === 'b') {
        e.preventDefault()
        applyStyle({ bold: !currentBold })
      } else if (k === 'i') {
        e.preventDefault()
        applyStyle({ italic: !currentItalic })
      } else if (k === 'u') {
        e.preventDefault()
        applyStyle({ underline: !currentUnderline })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /* ---------- 当前选中项的样式（供工具条显示） ---------- */
  const currentEdit = useCallback((): RunEdit | null => {
    const id = activeId ?? selected[0]
    if (!id) return null
    const run = runs.find((r) => r.id === id)
    if (!run) return null
    return edits[id] ?? baseEdit(run)
  }, [activeId, selected, runs, edits])

  const cur = currentEdit()
  const currentBold = !!cur?.bold
  const currentItalic = !!cur?.italic
  const currentUnderline = !!cur?.underline
  const hasTarget = !!(activeId || selected.length)

  if (loading) {
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Space direction="vertical" align="center">
          <Spin />
          <Typography.Text type="secondary">{progress || '正在准备…'}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            只读取文字位置与颜色，不会改动原文件
          </Typography.Text>
        </Space>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* 第一行：文件级操作 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Button icon={<ArrowLeftOutlined />} onClick={onExit}>
          返回文档
        </Button>
        <Button
          type="primary"
          icon={<SaveOutlined />}
          loading={exporting}
          disabled={!pendingCount}
          onClick={() => void saveToOriginal()}
        >
          {pendingCount > 0
            ? `保存（未存 ${changedCount} 处文字 / ${newAnnotationCount} 条批注${pendingImageCount ? ` / ${pendingImageCount} 处图片` : ''}）`
            : totalChanged > 0 || annotations.length > 0 || imageOps.length > 0
              ? '已保存'
              : '保存'}
        </Button>
        <Tooltip title="不动原文件，导出为新的 PDF">
          <Button icon={<DownloadOutlined />} loading={exporting} disabled={!pendingCount} onClick={() => void saveAs()}>
            另存为
          </Button>
        </Tooltip>
        <Space.Compact>
          <Tooltip title="撤销 Ctrl+Z">
            <Button icon={<UndoOutlined />} disabled={!canUndo} onClick={undo} />
          </Tooltip>
          <Tooltip title="重做 Ctrl+Y">
            <Button icon={<RedoOutlined />} disabled={!canRedo} onClick={redo} />
          </Tooltip>
        </Space.Compact>
        <Button
          icon={<ReloadOutlined />}
          disabled={!canUndo}
          onClick={() => commit({ edits: {}, annotations: [], imageOps: [] })}
        >
          全部还原
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          点文字即可就地修改 · Ctrl/Shift 多选 · 空白处拖拽加高亮 · 图片可插入/替换/删除 ·
          保存会覆盖原文件并自动在同目录留一份备份
        </Typography.Text>
        <Tooltip title="保版式改字默认会把被替换掉的旧文字从 PDF 文本层里真正移除（在本应用的文本提取里已不可见）；个别版式复杂的行可能保留，保存时会如实提示是哪几行。注意：其他 PDF 工具仍可能通过 ActualText 等机制提取到旧内容，本应用无法保证。">
          <Typography.Text type="secondary" style={{ fontSize: 12, cursor: 'help' }}>
            ⓘ 旧文字会被清除
          </Typography.Text>
        </Tooltip>
      </div>

      {/* 第二行：文字样式工具条 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexWrap: 'wrap',
          padding: '6px 8px',
          borderRadius: 8,
          border: '1px solid var(--border-color, rgba(128,128,128,.2))',
          background: 'var(--bg-elevated, rgba(255,255,255,.5))',
          opacity: hasTarget ? 1 : 0.55
        }}
      >
        <Select
          size="small"
          style={{ width: 118 }}
          value={cur?.fontFamily ?? ''}
          options={FONT_OPTIONS}
          onChange={(v) => applyStyle({ fontFamily: v })}
          disabled={!hasTarget}
          title="字体（栅格化渲染，中文安全）"
        />
        <InputNumber
          size="small"
          style={{ width: 74 }}
          min={4}
          max={200}
          step={1}
          value={cur ? Math.round(cur.fontSize * 10) / 10 : undefined}
          onChange={(v) => {
            if (typeof v === 'number' && Number.isFinite(v)) applyStyle({ fontSize: v })
          }}
          disabled={!hasTarget}
          addonAfter="pt"
          title="字号"
        />
        <Tooltip title="文字颜色">
          <ColorPicker
            size="small"
            value={cur ? rgbToHex(cur.color) : '#000000'}
            disabled={!hasTarget}
            onChangeComplete={(c) => applyStyle({ color: hexToRgb(c.toHexString()) })}
          />
        </Tooltip>
        <Space.Compact size="small">
          <Tooltip title="粗体 Ctrl+B">
            <Button type={currentBold ? 'primary' : 'default'} icon={<BoldOutlined />} disabled={!hasTarget} onClick={() => applyStyle({ bold: !currentBold })} />
          </Tooltip>
          <Tooltip title="斜体 Ctrl+I">
            <Button type={currentItalic ? 'primary' : 'default'} icon={<ItalicOutlined />} disabled={!hasTarget} onClick={() => applyStyle({ italic: !currentItalic })} />
          </Tooltip>
          <Tooltip title="下划线 Ctrl+U">
            <Button type={currentUnderline ? 'primary' : 'default'} icon={<UnderlineOutlined />} disabled={!hasTarget} onClick={() => applyStyle({ underline: !currentUnderline })} />
          </Tooltip>
        </Space.Compact>
        <Segmented
          size="small"
          value={cur?.align ?? 'left'}
          disabled={!hasTarget}
          onChange={(v) => applyStyle({ align: v as Align })}
          options={[
            { label: '左', value: 'left' },
            { label: '中', value: 'center' },
            { label: '右', value: 'right' }
          ]}
        />
        <Tooltip title="批注高亮颜色">
          <ColorPicker
            size="small"
            defaultValue="#ffe58f"
            onChangeComplete={(c) => {
              highlightHexRef.current = c.toHexString()
            }}
          />
        </Tooltip>
        <Tooltip title="对选中行加/取消高亮批注">
          <Button size="small" icon={<HighlightOutlined />} disabled={!hasTarget} onClick={() => toggleHighlight(highlightHexRef.current)}>
            高亮
          </Button>
        </Tooltip>
        <Tooltip title="清空选中行的文字（Delete）">
          <Button size="small" danger icon={<DeleteOutlined />} disabled={!hasTarget} onClick={deleteSelectedText}>
            删除文字
          </Button>
        </Tooltip>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {selected.length ? `已选 ${selected.length} 行` : '未选中'}
        </Typography.Text>
      </div>

      {/* 第三行：图片工具条（平铺可见，不做下拉菜单） */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexWrap: 'wrap',
          padding: '6px 8px',
          borderRadius: 8,
          border: '1px solid var(--border-color, rgba(128,128,128,.2))',
          background: 'var(--bg-elevated, rgba(255,255,255,.5))'
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg"
          style={{ display: 'none' }}
          onChange={(e) => void onFileChosen(e.target.files?.[0])}
        />
        <Button size="small" icon={<PictureOutlined />} onClick={() => pickImageFile('insert')}>
          插入图片
        </Button>
        <Tooltip title="对「图片列表」中选中的那张：用同色块盖住原图，再在原位画上新图">
          <Button
            size="small"
            icon={<SwapOutlined />}
            loading={imgBusy}
            disabled={!selectedImage}
            onClick={() => pickImageFile('replace')}
          >
            替换图片
          </Button>
        </Tooltip>
        <Tooltip title="对「图片列表」中选中的那张：盖住原位置，把这张图改画到你拖出的新框里">
          <Button
            size="small"
            icon={<DragOutlined />}
            loading={imgBusy}
            disabled={!selectedImage || !!pendingTask}
            onClick={moveSelectedImage}
          >
            移动图片
          </Button>
        </Tooltip>
        <Tooltip title="对「图片列表」中选中的那张：用从页面像素采样的同色块盖住（并非真正抹除）">
          <Button size="small" danger icon={<DeleteOutlined />} loading={imgBusy} disabled={!selectedImage} onClick={() => void deleteSelectedImage()}>
            删除图片
          </Button>
        </Tooltip>
        <Button
          size="small"
          type={imgList ? 'primary' : 'default'}
          icon={<UnorderedListOutlined />}
          loading={imgScanning}
          onClick={() => {
            if (imgList) {
              setImgList(null)
              setImgScan(null)
              setSelImgKey(null)
            } else {
              void scanImages()
            }
          }}
        >
          图片列表
        </Button>
        <Tooltip title="旋转「新图」：插入时用你选的档位，替换时立刻更新选中项那条替换（原图不动）。拖动的是目标框，旋转后按包围盒内接居中">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              新图旋转
            </Typography.Text>
            <Segmented
              size="small"
              value={shownRotate}
              onChange={(v) => changeImgRotate(Number(v))}
              options={[
                { label: '0°', value: 0 },
                { label: '90°', value: 90 },
                { label: '180°', value: 180 },
                { label: '270°', value: 270 }
              ]}
            />
          </span>
        </Tooltip>
        {pendingTask && (
          <>
            <Tag color="processing">
              {pendingTask.mode === 'insert' ? `待放置：${pendingTask.name}` : `待移动：第 ${pendingTask.source.page + 1} 页 · #${pendingTask.source.drawIndex + 1}`}
            </Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {pendingTask.mode === 'insert' ? '在页面上拖拽一个矩形确定放置区域' : '在页面上拖拽出图片要移动到的新位置'}
            </Typography.Text>
            <Button size="small" onClick={() => setPendingTaskBoth(null)}>
              取消
            </Button>
          </>
        )}
        {!pendingTask && !selectedImage && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            点「图片列表」枚举文档中的位图并选中一张，再执行替换/移动/删除
          </Typography.Text>
        )}
        {selectedImage && (
          <>
            <Tag color="blue">已选：第 {selectedImage.page + 1} 页 · 第 {selectedImage.drawIndex + 1} 处</Tag>
            {selectedImageOp && (
              <Tag color={selectedImageOp.kind === 'delete' ? 'red' : selectedImageOp.kind === 'move' ? 'purple' : 'orange'}>
                {selectedImageOp.kind === 'delete' ? '已标记删除' : selectedImageOp.kind === 'move' ? '已标记移动' : '已标记替换'}
              </Tag>
            )}
          </>
        )}
        {pendingImageCount > 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            共 {pendingImageCount} 处图片改动待保存
          </Typography.Text>
        )}
      </div>

      {/* 图片列表：枚举结果 + 选中项缩略图（惰性取图） */}
      {imgList && (
        <div
          style={{
            border: '1px solid var(--border-color, rgba(128,128,128,.25))',
            borderRadius: 8,
            padding: 8,
            maxHeight: 200,
            overflow: 'auto'
          }}
        >
          {imgScan && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              共 {imgList.length} 张位图（已跳过 {imgScan.skippedSmall} 张小于 8pt 的、{imgScan.skippedMasks} 张蒙版）
              {imgScan.unsupportedOps.repeat + imgScan.unsupportedOps.inlineGroup > 0
                ? ` · 未展开：重复 ${imgScan.unsupportedOps.repeat} / 内联组 ${imgScan.unsupportedOps.inlineGroup}`
                : ''}
            </Typography.Text>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {imgList.map((im) => {
              const op = imageOps.find((o) => o.kind !== 'insert' && o.page === im.page && sameRect(o.pdfRect, im.pdfRect))
              const active = im.key === selImgKey
              return (
                <button
                  key={im.key}
                  onClick={() => setSelImgKey(im.key)}
                  style={{
                    cursor: 'pointer',
                    textAlign: 'left',
                    border: active ? '1.5px solid #1668dc' : '1px solid rgba(128,128,128,.35)',
                    background: active ? 'rgba(22,104,220,.10)' : 'transparent',
                    borderRadius: 6,
                    padding: '4px 8px',
                    fontSize: 12,
                    color: 'inherit'
                  }}
                >
                  第 {im.page + 1} 页 · #{im.drawIndex + 1} · {Math.round(im.pdfRect.width)}×{Math.round(im.pdfRect.height)}pt ·{' '}
                  {im.pixelWidth}×{im.pixelHeight}px{im.rotated ? ' · 旋转' : ''}
                  {op ? (op.kind === 'delete' ? ' · 待删除' : ' · 待替换') : ''}
                </button>
              )
            })}
          </div>
          {selThumb && (
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <img src={selThumb} alt="选中图片预览" style={{ maxHeight: 90, maxWidth: 160, border: '1px solid rgba(128,128,128,.3)' }} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                选中项原图（按需解码，不预先加载全部图片）
              </Typography.Text>
            </div>
          )}
        </div>
      )}

      {err && <Alert type="warning" showIcon message={err} />}
      {!err && totalPages > views.length && (
        <Alert type="info" showIcon message={`这份 PDF 共 ${totalPages} 页，为控制内存只加载了前 ${views.length} 页用于编辑。`} />
      )}

      {!err && (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--bg-canvas, rgba(0,0,0,.04))', padding: 16 }}>
          {views.map((view) => (
            <div
              key={view.page}
              style={{
                position: 'relative',
                width: view.cssWidth,
                margin: '0 auto 20px',
                boxShadow: '0 1px 8px rgba(0,0,0,.18)',
                background: '#fff',
                cursor: 'crosshair'
              }}
              onMouseDown={(e) => {
                // 页面底图 <img> 会挡住空白区域的点击，所以目标元素是它时同样开始拖拽；
                // 文字行/弹层各自 stopPropagation，不会走到这里。
                const t = e.target as HTMLElement
                if (t === e.currentTarget || t.tagName === 'IMG') onPageMouseDown(view, e)
              }}
            >
              <img src={view.src} alt={`第 ${view.page + 1} 页`} style={{ display: 'block', width: '100%' }} draggable={false} />

              {/* 已枚举图片的外框：列表打开时可见，选中项高亮 */}
              {imgList
                ?.filter((im) => im.page === view.page)
                .map((im) => {
                  const [x1, y1] = view.toCssPoint(im.pdfRect.x, im.pdfRect.y + im.pdfRect.height)
                  const [x2, y2] = view.toCssPoint(im.pdfRect.x + im.pdfRect.width, im.pdfRect.y)
                  const active = im.key === selImgKey
                  const op = imageOps.find((o) => o.kind !== 'insert' && o.page === im.page && sameRect(o.pdfRect, im.pdfRect))
                  return (
                    <div
                      key={im.key}
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelImgKey(im.key)
                      }}
                      style={{
                        position: 'absolute',
                        left: Math.min(x1, x2),
                        top: Math.min(y1, y2),
                        width: Math.abs(x2 - x1),
                        height: Math.abs(y2 - y1),
                        border: active
                          ? '2px solid #1668dc'
                          : op
                            ? '2px dashed rgba(207,19,34,.85)'
                            : '2px dashed rgba(22,104,220,.55)',
                        background: active ? 'rgba(22,104,220,.10)' : 'transparent',
                        boxShadow: active ? '0 0 0 2px rgba(22,104,220,.25)' : 'none',
                        cursor: 'pointer'
                      }}
                      title={`第 ${im.page + 1} 页 · #${im.drawIndex + 1} · ${Math.round(im.pdfRect.width)}×${Math.round(im.pdfRect.height)}pt`}
                    />
                  )
                })}

              {/* 批注高亮（两个角都用 viewport 投影，旋转页也正确） */}
              {annotations
                .filter((a) => a.page === view.page)
                .map((a, i) => {
                  const [x1, y1] = view.toCssPoint(a.rect.x, a.rect.y + a.rect.height)
                  const [x2, y2] = view.toCssPoint(a.rect.x + a.rect.width, a.rect.y)
                  return (
                    <div
                      key={a.aid + i}
                      style={{
                        position: 'absolute',
                        left: Math.min(x1, x2),
                        top: Math.min(y1, y2),
                        width: Math.abs(x2 - x1),
                        height: Math.abs(y2 - y1),
                        background: rgbCss(a.color),
                        opacity: a.opacity ?? 0.35,
                        pointerEvents: 'none'
                      }}
                    />
                  )
                })}

              {/* 可点击文字行 */}
              {view.boxes.map((box) => {
                const preview = previewFor(box, view.scale)
                const isSelected = selected.includes(box.run.id)
                const isActive = activeId === box.run.id
                return (
                  <div key={box.run.id}>
                    <div
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        startEdit(box.run, e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'range' : 'single')
                      }}
                      title="点一下改这一行；Ctrl 加选、Shift 范围选"
                      style={{
                        position: 'absolute',
                        left: box.left,
                        top: box.top,
                        width: box.width,
                        height: box.height,
                        cursor: 'text',
                        outline: isActive
                          ? '1.5px solid #1668dc'
                          : isSelected
                            ? '1.5px solid rgba(22,104,220,.65)'
                            : preview
                              ? '1.5px dashed rgba(250,140,22,.9)'
                              : 'none',
                        background: 'transparent'
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected && !preview) e.currentTarget.style.background = 'rgba(22,104,220,.10)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent'
                      }}
                    />
                    {preview && (
                      <div
                        style={{
                          position: 'absolute',
                          left: preview.left,
                          top: box.top,
                          height: box.height,
                          background: preview.bg,
                          color: preview.color,
                          fontFamily: preview.fontFamily,
                          fontWeight: preview.bold ? 700 : 400,
                          fontStyle: preview.italic ? 'italic' : 'normal',
                          textDecoration: preview.underline ? 'underline' : 'none',
                          fontSize: preview.px,
                          lineHeight: `${box.height}px`,
                          textAlign: preview.align,
                          whiteSpace: 'pre',
                          pointerEvents: 'none'
                        }}
                      >
                        {preview.text}
                      </div>
                    )}
                    {isActive && (
                      <div
                        style={{
                          position: 'absolute',
                          left: Math.max(0, box.left),
                          top: box.top + box.height + 6,
                          zIndex: 10,
                          width: Math.min(560, Math.max(320, box.width)),
                          background: 'var(--bg-elevated, #fff)',
                          border: '1px solid var(--border-color, rgba(128,128,128,.35))',
                          borderRadius: 8,
                          padding: 10,
                          boxShadow: '0 6px 20px rgba(0,0,0,.22)'
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        <Input
                          ref={inputRef}
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onPressEnter={commitText}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') setActiveId(null)
                          }}
                          placeholder="输入新的文字（留空则删除这一行文字）"
                        />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                            回车确定 · Esc 取消 · 样式在上方工具条调整
                          </Typography.Text>
                          <div style={{ flex: 1 }} />
                          <Button size="small" onClick={() => setActiveId(null)}>
                            取消
                          </Button>
                          <Button size="small" type="primary" onClick={commitText}>
                            确定
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}

              {/* 框选矩形 */}
              {marquee && marquee.page === view.page && (
                <div
                  style={{
                    position: 'absolute',
                    left: marquee.x,
                    top: marquee.y,
                    width: marquee.w,
                    height: marquee.h,
                    background: pendingTask?.mode === 'insert' ? 'rgba(22,104,220,.20)' : 'rgba(255, 214, 102, .35)',
                    border: pendingTask?.mode === 'insert' ? '1px dashed rgba(22,104,220,.9)' : '1px dashed rgba(200,150,0,.9)',
                    pointerEvents: 'none'
                  }}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 判定编辑记录是否与原始样式一致（用于判断该行是否需要导出覆盖） */
function isSameStyle(a: RunEdit, b: RunEdit): boolean {
  return (
    a.align === b.align &&
    Math.abs(a.fontSize - b.fontSize) < 0.01 &&
    Math.abs(a.color.r - b.color.r) < 0.004 &&
    Math.abs(a.color.g - b.color.g) < 0.004 &&
    Math.abs(a.color.b - b.color.b) < 0.004 &&
    (a.fontFamily || '') === (b.fontFamily || '') &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline
  )
}
