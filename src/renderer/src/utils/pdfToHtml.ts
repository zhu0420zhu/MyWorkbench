/**
 * PDF 文本层 → 可编辑的结构化 HTML（「文档处理」页 Word 模式富文本用）。
 *
 * 与 utils/pdfRender.ts 的关系与差异：
 *   - 载入方式一致：同一份**本地** worker（vite 的 `?worker` 导入）+ GlobalWorkerOptions，
 *     不引外网 CDN。
 *   - 但不能照抄成顶层静态 import。实测（node 22 / pdfjs-dist 6.3.289）：
 *       1) Node 下 `?worker` 模块的 default 是 undefined（没有打包器做转换），
 *          顶层 `new PdfWorker()` 会抛 `TypeError: PdfWorker is not a constructor`；
 *       2) 无头环境（tests/）只需要纯函数，拉进 pdf.js 毫无收益。
 *     因此 pdf.js 只在 loadPdfjs() 里**动态 import**，本文件顶部不出现任何 pdf.js
 *     运行时导入——纯函数区（joinTextItems / textPagesToHtml / buildPdfHtmlResult）
 *     可以被 node --experimental-strip-types 直接加载做无头验收。
 *
 * 中文是这里的头号难点：pdf.js 常把一个汉字输出成一个 item，且会在 item 之间插入
 * 空格（`str === ' '` 的独立 item，或前一个 item 的尾随空格）。拼接规则见 joinTextItems。
 */

export interface PdfTextLine {
  text: string
  y: number
  size: number
}

export interface PdfTextPage {
  page: number
  lines: PdfTextLine[]
}

export interface PdfHtmlResult {
  html: string
  pages: number
  chars: number
  needOcr: boolean
  note?: string
}

/** 行内文本片段（pdf.js TextItem 的投影；纯数据，不含 pdf.js 类型） */
export interface PdfTextItem {
  str: string
  x: number
  width: number
  size: number
}

const OCR_NOTE = '未检测到文本层（可能是扫描件），可用 OCR 识别后编辑'
/** 非空白字符总数低于此值视为「没有文本层」（扫描件） */
const MIN_TEXT_CHARS = 20

/** 同行 y 容差：实测同一行内不同字体的基线漂移在 3pt 以内 */
const Y_TOLERANCE = 3
/** 英文两段之间补空格的 x 间距阈值（相对字号）：正常词间距约 0.25em，字内间距近 0 */
const SPACE_GAP_RATIO = 0.22
/** 标题：短行 + 字号显著大于正文 */
const HEADING_MAX_CHARS = 40
const H1_RATIO = 1.8
const H2_RATIO = 1.35
const DEFAULT_FONT_SIZE = 12
/** 段落断点：行距明显大于行距基准，或超过 1.75 倍正文字号（行数太少时的兜底） */
const PARAGRAPH_GAP_RATIO = 1.5
const PARAGRAPH_GAP_ABS_RATIO = 1.75

/** CJK 与全角：汉字（含扩展 A/兼容区）、CJK 标点、假名、全角 ASCII */
const CJK_CLASS =
  '\\u3000-\\u303F\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\uFF00-\\uFFEF'
const CJK_RE = new RegExp('[' + CJK_CLASS + ']')
/** 「CJK + 半角空格 + CJK」——逐字输出时被拆开的汉字之间不允许留空格 */
const CJK_GAP_RE = new RegExp('([' + CJK_CLASS + '])[ \\t]+([' + CJK_CLASS + '])', 'g')
const WORD_CHAR_RE = /^[0-9A-Za-z]$/
/**
 * 列表标记。两种真实形态都要认：
 *   - `- xxx` / `* xxx`（半角标记，后面必须有空白，否则 `-5℃` 会被误判）
 *   - `•xxx` / `1.xxx`（中文 PDF 里项目符号/序号常是独立 item，和正文之间**没有空格**，
 *     实测 LibreOffice 导出的中文 PDF 就是 `•` + `无序列表第一项` 两个 item）
 * 有序列表的 `(?!\d)` 用来挡住 `1.5倍` / `2026年` 这类行首数字。
 */
const UL_MARKER_RE = /^(?:[•·]\s*|[-*]\s+)(.+)$/
const OL_MARKER_RE = /^\d+[.、)]\s*(?!\d)(.+)$/

function isCjk(ch: string): boolean {
  return CJK_RE.test(ch)
}

function isWordChar(ch: string): boolean {
  return WORD_CHAR_RE.test(ch)
}

/**
 * 反复塌掉「CJK + 空格 + CJK」里的空格（直到不动）：
 * 一次全局替换只能吃掉不重叠的匹配，"中 文 编 辑" 需要两轮。
 */
function collapseCjkSpaces(s: string): string {
  let out = s
  for (;;) {
    const next = out.replace(CJK_GAP_RE, '$1$2')
    if (next === out) return out
    out = next
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/* ------------------------------------------------------------------ *
 * 纯函数区：行内拼接
 * ------------------------------------------------------------------ */

/**
 * 行内文本片段 → 一行文本。
 *
 * 规则：
 *   - 汉字/全角之间**绝不**插空格，源里夹的空格也会被塌掉（pdf.js 常把「中 文」拆成 中 + ' ' + 文）；
 *   - 源里本来就有空白就保留（原稿在「验证 PDF 文本层」里打的空格要留住，编辑出来才和原稿一致）；
 *   - 纯靠 x 间距推断时只认「半角字母/数字相邻」且间距超过 0.22em，避免凭空加空格或 "Fig . 1"；
 *   - 纯空白 item 只作「这里有间隔」的记号，自身不进结果，也不推进 lastEnd ——
 *     这样 `Hello` + `' '` + `World` 不会重复补两个空格。
 */
export function joinTextItems(items: PdfTextItem[]): string {
  const ordered = items.filter((it) => it.str !== '').sort((a, b) => a.x - b.x)
  let out = ''
  let lastEnd = Number.NaN
  let sawGap = false
  for (const it of ordered) {
    const raw = it.str
    if (/^\s*$/.test(raw)) {
      sawGap = true
      continue
    }
    if (/^\s/.test(raw)) sawGap = true
    const tailPadding = /\s$/.test(raw)
    const core = raw.trim()
    if (out === '') {
      out = core
    } else {
      const prev = out.charAt(out.length - 1)
      const next = core.charAt(0)
      let space = false
      // 汉字/全角之间即使源里有空格也绝不留（实测 pdf.js 会把「中 文」拆成中 + ' ' + 文）
      if (!(isCjk(prev) && isCjk(next))) {
        const threshold = Math.max(1, it.size * SPACE_GAP_RATIO)
        const wideGap = Number.isFinite(lastEnd) && it.x - lastEnd > threshold
        // 源里本来就有空白就保留：原稿在中英之间打的空格要留住，编辑出来才和原稿一致；
        // 纯靠 x 间距推断时只认「半角字母/数字相邻」，避免 "Fig" + "." + "1" → "Fig . 1"
        space = sawGap || (isWordChar(prev) && isWordChar(next) && wideGap)
      }
      out += (space ? ' ' : '') + core
    }
    lastEnd = it.x + it.width
    sawGap = tailPadding
  }
  return collapseCjkSpaces(out).trim()
}

/* ------------------------------------------------------------------ *
 * 纯函数区：结构启发式
 * ------------------------------------------------------------------ */

interface TextRow {
  kind: 'blank' | 'text'
  text: string
  size: number
  y: number
  page: number
}

function toRows(pages: PdfTextPage[]): TextRow[] {
  const rows: TextRow[] = []
  for (const page of pages) {
    for (const line of page.lines) {
      const text = collapseCjkSpaces(line.text).trim()
      const size = Number.isFinite(line.size) && line.size > 0 ? line.size : 0
      const y = Number.isFinite(line.y) ? line.y : 0
      // 空行保留成 blank 记号：显式空行 = 强制分段
      rows.push({ kind: text === '' ? 'blank' : 'text', text, size, y, page: page.page })
    }
  }
  return rows
}

function headingLevel(text: string, size: number, medianSize: number): 0 | 1 | 2 {
  if (size <= 0 || text.length > HEADING_MAX_CHARS) return 0
  if (size >= medianSize * H1_RATIO) return 1
  if (size >= medianSize * H2_RATIO) return 2
  return 0
}

function listMarker(text: string): { type: 'ul' | 'ol'; text: string } | null {
  const ul = UL_MARKER_RE.exec(text)
  if (ul) return { type: 'ul', text: ul[1] }
  const ol = OL_MARKER_RE.exec(text)
  if (ol) return { type: 'ol', text: ol[1] }
  return null
}

function isParagraphBreak(prev: TextRow | null, cur: TextRow, gapLimit: number): boolean {
  if (!prev) return false
  // 跨页时 y 是各页自己的坐标系，不可直接比较，直接断段最稳
  if (prev.page !== cur.page) return true
  return Math.abs(cur.y - prev.y) > gapLimit
}

/** 同段续行：中英紧贴不插空格，纯半角之间补一个空格 */
function appendLine(prev: string, next: string): string {
  if (prev === '') return next
  const a = prev.charAt(prev.length - 1)
  const b = next.charAt(0)
  const sep = isCjk(a) || isCjk(b) ? '' : ' '
  return collapseCjkSpaces(prev + sep + next)
}

/**
 * 文本页 → HTML 片段（纯函数，不触碰 pdf.js/electron）。
 *
 * 输出：块之间以 '\n' 连接，无尾随换行；无内容返回 ''。
 * 页与页之间不插页码标题，只保证段落顺序正确。
 */
export function textPagesToHtml(pages: PdfTextPage[]): string {
  const rows = toRows(pages)
  const textRows = rows.filter((r) => r.kind === 'text')
  const sizes = textRows.map((r) => r.size).filter((s) => s > 0)
  const medianSize = sizes.length > 0 ? median(sizes) : DEFAULT_FONT_SIZE
  const gaps: number[] = []
  for (let i = 1; i < textRows.length; i++) {
    if (textRows[i - 1].page !== textRows[i].page) continue
    gaps.push(Math.abs(textRows[i].y - textRows[i - 1].y))
  }
  // 行距基准不能直接用中位数：实测 LibreOffice 导出的中文 PDF，行内行距 16.65/16.75、
  // 段距 29.9/30.9，中位数被段距抬到 20.8，阈值 1.5×20.8+1=32.2 把段距全吞了。
  // 行内行距永远是一致的较小值，故取「不小于 0.8 倍字号的最小行距」当行距基准；
  // 取不到候选（行数太少）时退回中位数。
  let pitch = median(gaps)
  for (const gap of gaps) {
    if (gap >= medianSize * 0.8 && gap < pitch) pitch = gap
  }
  const gapLimit = Math.max(pitch * PARAGRAPH_GAP_RATIO + 1, medianSize * PARAGRAPH_GAP_ABS_RATIO)

  const blocks: string[] = []
  let pending = ''
  let listType: 'ul' | 'ol' | null = null
  let listItems: string[] = []

  const flushList = (): void => {
    if (listType !== null && listItems.length > 0) {
      const items = listItems.map((t) => '<li>' + escapeHtml(t) + '</li>').join('\n')
      blocks.push('<' + listType + '>\n' + items + '\n</' + listType + '>')
    }
    listType = null
    listItems = []
  }
  const flushParagraph = (): void => {
    if (pending !== '') blocks.push('<p>' + escapeHtml(pending) + '</p>')
    pending = ''
  }
  const flushAll = (): void => {
    flushList()
    flushParagraph()
  }

  let prev: TextRow | null = null
  for (const row of rows) {
    if (row.kind === 'blank') {
      flushAll()
      continue
    }
    const level = headingLevel(row.text, row.size, medianSize)
    if (level > 0) {
      flushAll()
      const tag = level === 1 ? 'h1' : 'h2'
      blocks.push('<' + tag + '>' + escapeHtml(row.text) + '</' + tag + '>')
    } else {
      const marker = listMarker(row.text)
      if (marker) {
        flushParagraph()
        if (listType !== marker.type) {
          flushList()
          listType = marker.type
        }
        listItems.push(marker.text)
      } else {
        // 普通正文行打断任何进行中的列表
        flushList()
        if (isParagraphBreak(prev, row, gapLimit)) flushParagraph()
        pending = appendLine(pending, row.text)
      }
    }
    prev = row
  }
  flushAll()
  return blocks.join('\n')
}

/* ------------------------------------------------------------------ *
 * 纯函数区：结果组装（无文本层 → OCR 提示）
 * ------------------------------------------------------------------ */

export function buildPdfHtmlResult(pages: PdfTextPage[], totalPages: number): PdfHtmlResult {
  const chars = pages.reduce(
    (n, p) => n + p.lines.reduce((m, l) => m + l.text.replace(/\s+/g, '').length, 0),
    0
  )
  if (chars < MIN_TEXT_CHARS) {
    // 这里只给提示，不调 OCR（OCR 链路在 utils/pdfOcrExtract.ts，由调用方决定是否走）
    return { html: '', pages: totalPages, chars, needOcr: true, note: OCR_NOTE }
  }
  return { html: textPagesToHtml(pages), pages: totalPages, chars, needOcr: false }
}

/* ------------------------------------------------------------------ *
 * pdf.js 驱动区（动态载入，纯函数区不得依赖本区）
 * ------------------------------------------------------------------ */

type PdfJsModule = typeof import('pdfjs-dist')

let pdfjsPromise: Promise<PdfJsModule> | null = null

/**
 * 懒加载 pdf.js。载入方式与 utils/pdfRender.ts 保持一致的「本地 worker」，
 * 但放到函数里：Node 下 `?worker` 的 default 是 undefined，此时跳过 workerPort
 * （无头验收只需要纯函数，根本不会走到这里）。
 */
async function loadPdfjs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async (): Promise<PdfJsModule> => {
      const pdfjs = await import('pdfjs-dist')
      const workerModule = (await import('pdfjs-dist/build/pdf.worker.min.mjs?worker')) as {
        default?: new () => Worker
      }
      if (typeof workerModule.default === 'function') {
        pdfjs.GlobalWorkerOptions.workerPort = new workerModule.default()
      }
      return pdfjs
    })()
  }
  return pdfjsPromise
}

interface PositionedItem extends PdfTextItem {
  y: number
}

type RawTextItem = {
  str?: string
  transform?: number[]
  width?: number
  height?: number
}

const DEFAULT_MAX_PAGES = 200

/**
 * 字节 → 文本层 → 结构化 HTML。
 * `pages` 返回 PDF 的真实总页数（即使受 opts.maxPages 截断）。
 */
export async function pdfBytesToHtml(
  bytes: Uint8Array,
  opts?: { maxPages?: number }
): Promise<PdfHtmlResult> {
  const maxPages = opts?.maxPages && opts.maxPages > 0 ? Math.floor(opts.maxPages) : DEFAULT_MAX_PAGES
  const pdfjs = await loadPdfjs()
  // slice(0) 与 pdfRender.ts 一致：避免 pdf.js 转移/回收调用方的 buffer
  const task = pdfjs.getDocument({ data: bytes.slice(0) })
  const doc = await task.promise
  try {
    const total = doc.numPages
    const limit = Math.min(total, maxPages)
    const pages: PdfTextPage[] = []
    for (let i = 1; i <= limit; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const positioned: PositionedItem[] = []
      for (const raw of content.items) {
        const item = raw as RawTextItem
        // 空串 item 不带任何信息（LibreOffice 每行开头都会发一个），直接丢；
        // 但纯空白 item 必须留着——它是「源里这里本来有空格」的唯一信号，
        // 丢了就会把中文稿里「验证 PDF 文本层」的空格一起吃没。留不留由 joinTextItems 决定。
        if (typeof item.str !== 'string' || item.str === '') continue
        const tr = item.transform || [1, 0, 0, 1, 0, 0]
        if (!Number.isFinite(tr[4]) || !Number.isFinite(tr[5])) continue
        positioned.push({
          str: item.str,
          x: tr[4],
          y: tr[5],
          width: typeof item.width === 'number' ? item.width : 0,
          size: Math.abs(tr[3]) || item.height || 10
        })
      }
      positioned.sort((a, b) => b.y - a.y || a.x - b.x)

      const lines: PdfTextLine[] = []
      let cur: PositionedItem[] = []
      let curY = Number.NaN
      const flush = (): void => {
        if (cur.length > 0) {
          const text = joinTextItems(cur)
          if (text !== '') {
            // 行字号取「字符最多的那个 item」的字号，避免上标/角标把整行字号带偏
            let size = cur[0].size
            let best = 0
            for (const it of cur) {
              const len = it.str.trim().length
              if (len > best) {
                best = len
                size = it.size
              }
            }
            lines.push({ text, y: curY, size })
          }
        }
        cur = []
      }
      for (const it of positioned) {
        if (!Number.isFinite(curY) || Math.abs(it.y - curY) <= Y_TOLERANCE) {
          if (!Number.isFinite(curY)) curY = it.y
          cur.push(it)
        } else {
          flush()
          curY = it.y
          cur.push(it)
        }
      }
      flush()
      pages.push({ page: i, lines })
    }
    return buildPdfHtmlResult(pages, total)
  } finally {
    const disposable = doc as unknown as { destroy?: () => Promise<void> }
    if (typeof disposable.destroy === 'function') await disposable.destroy()
  }
}
