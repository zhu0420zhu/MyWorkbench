/**
 * PDF 文本行提取：把 PDF 文本层变成**可定位的文本行**（「保版式改字」用）。
 *
 * 与既有 utils 的关系：
 *   - 载入方式照 utils/pdfToHtml.ts 的 `loadPdfjs()`：pdf.js 只在驱动函数里**动态 import**，
 *     本文件顶层不出现 pdf.js 运行时导入，也不出现 Vite 专有的 `?worker` 导入。
 *     这样纯函数区（groupItemsToRuns / sampleColors）能被 `node --experimental-strip-types`
 *     直接加载做无头验收——Node 下 `?worker` 的 default 是 undefined，顶层 `new PdfWorker()`
 *     会直接抛错。
 *   - 行内拼接**复用** pdfToHtml.ts 的 `joinTextItems`（中文逐字 item 之间不加空格的处理
 *     已经在那里验证过），不另写一套。
 *   - 颜色只取类型 `Rgb`（utils/pdfText.ts），且必须用 `import type`：pdfText.ts 顶层
 *     静态 import 了 pdf-lib，值导入会把 pdf-lib 拉进无头测试环境。
 *
 * 坐标系约定（容易踩坑，这里写死）：
 *   - pdf.js 的 `TextItem.transform` 在 **PDF 用户空间**（左下原点，未受 viewport 影响），
 *     这是 pdf.js 自己的文本层放置逻辑所依赖的语义。
 *   - `t = Util.transform(vp.transform, item.transform)` 得到设备坐标（左上原点，y 向下），
 *     再用 `vp.convertToPdfPoint(x, y)` 转回 PDF 用户坐标。因为 viewport 变换里含 /Rotate
 *     的旋转，取逆之后得到的仍是**未旋转**的 PDF 用户空间——这正是回写（pdf-lib 也在未旋转
 *     空间作图）需要的空间。
 *   - `rect` 的 y 是行框**下边缘**（左下原点下更容易理解），基线落在框内偏下 0.2×行高的位置。
 */
import type { Rgb } from './pdfText'
// 注意：这里必须写「无扩展名」——typecheck:web 的 moduleResolution=bundler 下带 .ts 扩展名会报
// TS5097。代价是无头 node 直跑需要仓库自带的 tests/loader.mjs 补 .ts（所有 test:pdf-* 脚本都这么做）。
import { joinTextItems } from './pdfToHtml'

export interface PdfTextRun {
  /** 形如 `p0-r3`，页面内唯一 */
  id: string
  /** 0 基页号 */
  page: number
  /** 该行原始文字 */
  text: string
  /** PDF 用户坐标（左下原点，pt）：该行文字的外接框 */
  rect: { x: number; y: number; width: number; height: number }
  /** 基线 y（PDF 用户坐标，左下原点） */
  baseline: number
  /** 字号（pt） */
  fontSize: number
  /** 真实字体名（如 "MicrosoftYaHei"），拿不到则回退 'Microsoft YaHei' */
  fontFamily: string
  /** 由字体名推断的粗体（Bold/Heavy/Black/Semibold） */
  bold?: boolean
  /** 由字体名推断的斜体 */
  italic?: boolean
  /** 文字颜色（从页面渲染像素采样） */
  color: Rgb
  /** 该行背景色（用于覆盖原文字） */
  bgColor: Rgb
  align: 'left' | 'center' | 'right'
}

export interface PdfTextPageBlocks {
  page: number
  /** 页面在 PDF 用户坐标系下的宽高（pt，已含 /Rotate 后的视口尺寸） */
  width: number
  height: number
  runs: PdfTextRun[]
}

/** groupItemsToRuns 的输入项（pdf.js TextItem 的投影，不含 pdf.js 类型） */
export interface PdfTextRunItem {
  str: string
  /** PDF 用户坐标 x（左边缘） */
  x: number
  /** PDF 用户坐标 y（与 baseline 同值，保留字段便于调用方直接使用） */
  y: number
  /** 基线 y（PDF 用户坐标） */
  baseline: number
  width: number
  height: number
  fontSize: number
  fontFamily: string
}

/* ------------------------------------------------------------------ *
 * 参数（集中在此，便于调参）
 * ------------------------------------------------------------------ */

/** 同行判定：基线差容差（pt）。pdf.js 同一行内不同字体的基线漂移在 2pt 以内 */
const Y_TOLERANCE = 2
/** 同行判定：字号相对差上限（相对两者较大值），上标/角标不该并入正文行 */
const SIZE_TOL_RATIO = 0.2
/** 同行判定：横向间距上限（×字号），超过则视为两个独立文本框（如左标题 + 右页码） */
const GAP_TOL_RATIO = 1.5
/** 行框下边缘到基线的距离 = 行高 × 此比例（近似 descent） */
const DESCENT_RATIO = 0.2

export const FALLBACK_FONT = 'Microsoft YaHei'

/** 从字体名推断粗体（覆盖 Bold/Heavy/Black/Semibold 等常见命名） */
export function inferBold(family: string): boolean {
  return /bold|heavy|black|semibold|ultra/i.test(family)
}

/** 从字体名推断斜体 */
export function inferItalic(family: string): boolean {
  return /italic|oblique/i.test(family)
}
/** 采样不出明显文字色时的兜底（近黑的深灰） */
const FALLBACK_COLOR: Rgb = { r: 0.13, g: 0.13, b: 0.13 }
const FALLBACK_BG: Rgb = { r: 1, g: 1, b: 1 }

/** 颜色量化：每通道保留高 4 bit（抗锯齿会产生大量中间色，量化后按桶计数才稳） */
const BUCKET_SHIFT = 4
/** 「高频颜色」取计数前 N 个桶作为候选 */
const TOP_K = 8
/** 候选色与背景色的归一化欧氏距离低于此值 → 认为该区域没有可见文字 */
const COLOR_DIST_MIN = 0.2
/** 采样时忽略的透明度上限 */
const ALPHA_MIN = 128
/** 颜色采样时行框向外扩的边距（×字号）：紧贴字形的框里几乎没有背景像素，必须外扩才取得到底色 */
const SAMPLE_PAD_RATIO = 0.35

/** 对齐判定：贴边阈值（×页面宽） */
const ALIGN_EDGE_RATIO = 0.1
/** 对齐判定：左右边距差阈值（×页面宽） */
const ALIGN_CENTER_DIFF_RATIO = 0.05
/** 对齐判定：居中时两边距各自的上限（×页面宽） */
const ALIGN_CENTER_MAX_RATIO = 0.25

/** 每页渲染采样倍率 */
const RENDER_SCALE = 2
const DEFAULT_MAX_PAGES = 200
const DEFAULT_FONT_SIZE = 12

/* ------------------------------------------------------------------ *
 * 纯函数区：行聚合
 * ------------------------------------------------------------------ */

/**
 * 按「基线分带 + 带内按横向间距切段」把文本项聚合成行。
 *
 * 为什么不是顺序扫描合并：顺序法在双栏/左右对齐混排（左标题 + 右页码同基线）时，
 * 会把左栏的下一行接到右栏的带上。分带法先把同基线同字号的项收进一个带，再在带内
 * 按 x 间距切成多段，左右两个文本框自然变成两个 run。
 */
export function groupItemsToRuns(items: PdfTextRunItem[], pageIndex: number, pageWidth: number): PdfTextRun[] {
  const usable = items.filter(
    (it) =>
      typeof it.str === 'string' &&
      it.str !== '' &&
      Number.isFinite(it.x) &&
      Number.isFinite(it.baseline) &&
      Number.isFinite(it.width)
  )
  const sorted = [...usable].sort((a, b) => b.baseline - a.baseline || a.x - b.x)

  const bands: Array<{ baseline: number; fontSize: number; items: PdfTextRunItem[] }> = []
  for (const it of sorted) {
    const size = Number.isFinite(it.fontSize) && it.fontSize > 0 ? it.fontSize : 0
    let hit: (typeof bands)[number] | null = null
    for (const band of bands) {
      if (Math.abs(it.baseline - band.baseline) > Y_TOLERANCE) continue
      // 字号任一未知时不做字号比较，避免把「拿不到字号」的项全都切成独立行
      if (band.fontSize > 0 && size > 0) {
        const max = Math.max(band.fontSize, size)
        if (Math.abs(band.fontSize - size) > SIZE_TOL_RATIO * max) continue
      }
      hit = band
      break
    }
    if (hit) hit.items.push(it)
    else bands.push({ baseline: it.baseline, fontSize: size, items: [it] })
  }

  const runs: PdfTextRun[] = []
  for (const band of bands) {
    const bandSize = band.fontSize > 0 ? band.fontSize : DEFAULT_FONT_SIZE
    const gapLimit = GAP_TOL_RATIO * bandSize
    const byX = [...band.items].sort((a, b) => a.x - b.x)

    const segments: PdfTextRunItem[][] = []
    let segment: PdfTextRunItem[] = []
    let prevRight = Number.NaN
    for (const it of byX) {
      if (segment.length > 0 && Number.isFinite(prevRight) && it.x - prevRight > gapLimit) {
        segments.push(segment)
        segment = []
      }
      segment.push(it)
      prevRight = Number.isFinite(prevRight) ? Math.max(prevRight, it.x + it.width) : it.x + it.width
    }
    if (segment.length > 0) segments.push(segment)

    for (const seg of segments) {
      const text = joinTextItems(
        seg.map((it) => ({
          str: it.str,
          x: it.x,
          width: it.width,
          size: it.fontSize > 0 ? it.fontSize : DEFAULT_FONT_SIZE
        }))
      )
      // 纯空白段（如两栏之间飘着的空格 item）不产出 run
      if (text === '') continue

      // 主导项（字符最多者）决定基线/字号/字体，避免上标或零星符号把整行带偏
      let dominant = seg[0]
      let bestLen = -1
      for (const it of seg) {
        const len = it.str.trim().length
        if (len > bestLen) {
          bestLen = len
          dominant = it
        }
      }
      const fontSize =
        dominant.fontSize > 0 ? dominant.fontSize : band.fontSize > 0 ? band.fontSize : DEFAULT_FONT_SIZE

      let left = Number.POSITIVE_INFINITY
      let right = Number.NEGATIVE_INFINITY
      let height = 0
      for (const it of seg) {
        if (it.x < left) left = it.x
        if (it.x + it.width > right) right = it.x + it.width
        const h = it.height > 0 ? it.height : it.fontSize > 0 ? it.fontSize : DEFAULT_FONT_SIZE
        if (h > height) height = h
      }
      if (!Number.isFinite(left) || !Number.isFinite(right)) {
        left = 0
        right = 0
      }
      if (right < left) right = left
      if (height <= 0) height = fontSize

      const baseline = Number.isFinite(dominant.baseline) ? dominant.baseline : 0
      const rect = { x: left, y: baseline - height * DESCENT_RATIO, width: right - left, height }
      const family =
        typeof dominant.fontFamily === 'string' && dominant.fontFamily.trim() !== ''
          ? dominant.fontFamily
          : FALLBACK_FONT

      runs.push({
        id: 'p' + pageIndex + '-r' + runs.length,
        page: pageIndex,
        text,
        rect,
        baseline,
        fontSize,
        fontFamily: family,
        bold: inferBold(family),
        italic: inferItalic(family),
        color: { r: FALLBACK_COLOR.r, g: FALLBACK_COLOR.g, b: FALLBACK_COLOR.b },
        bgColor: { r: FALLBACK_BG.r, g: FALLBACK_BG.g, b: FALLBACK_BG.b },
        align: classifyAlign(rect, pageWidth)
      })
    }
  }
  return runs
}

/**
 * 水平对齐判定。
 *
 * 顺序按规格：先判贴左边 / 贴右边，再看是否左右对称。
 * 注意规格里「居中要求两边距都 < 25% 页面宽」，因此一个很窄、左右边距都很大（如各 33%）
 * 的居中标题会被判成 left——这是规格的既定行为，不是实现错误。
 */
function classifyAlign(
  rect: { x: number; width: number },
  pageWidth: number
): 'left' | 'center' | 'right' {
  if (!Number.isFinite(pageWidth) || pageWidth <= 0) return 'left'
  const left = rect.x
  const right = pageWidth - (rect.x + rect.width)
  if (left < pageWidth * ALIGN_EDGE_RATIO) return 'left'
  if (right < pageWidth * ALIGN_EDGE_RATIO) return 'right'
  if (
    Math.abs(left - right) < pageWidth * ALIGN_CENTER_DIFF_RATIO &&
    left < pageWidth * ALIGN_CENTER_MAX_RATIO &&
    right < pageWidth * ALIGN_CENTER_MAX_RATIO
  ) {
    return 'center'
  }
  return 'left'
}

/* ------------------------------------------------------------------ *
 * 纯函数区：颜色采样
 * ------------------------------------------------------------------ */

/**
 * 从一段区域的 RGBA 像素判定「背景色」与「文字色」。
 *
 * pixels 是扁平的 RGBA（即 ImageData.data 的切片），不关心它来自多大区域：
 * 调用方负责把区域裁到行框附近（且**向外扩一点**，否则框内全是字，取不到底色）。
 *
 * 算法：按每通道高 4 bit 量化归桶；计数最大的桶的**通道均值**即 bgColor；
 * 再在计数前 TOP_K 的桶里挑与 bgColor 距离最远者作为 color；距离过小视为无文字，回退默认色。
 */
export function sampleColors(pixels: Uint8ClampedArray): { color: Rgb; bgColor: Rgb } {
  if (!pixels || pixels.length < 4) {
    return { color: cloneColor(FALLBACK_COLOR), bgColor: cloneColor(FALLBACK_BG) }
  }

  const counts = new Map<number, number>()
  const sums = new Map<number, [number, number, number]>()
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < ALPHA_MIN) continue
    const r = pixels[i]
    const g = pixels[i + 1]
    const b = pixels[i + 2]
    const key = ((r >> BUCKET_SHIFT) << 8) | ((g >> BUCKET_SHIFT) << 4) | (b >> BUCKET_SHIFT)
    counts.set(key, (counts.get(key) ?? 0) + 1)
    const sum = sums.get(key)
    if (sum) {
      sum[0] += r
      sum[1] += g
      sum[2] += b
    } else {
      sums.set(key, [r, g, b])
    }
  }
  if (counts.size === 0) {
    return { color: cloneColor(FALLBACK_COLOR), bgColor: cloneColor(FALLBACK_BG) }
  }

  const buckets = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])
  const meanOf = (key: number, count: number): Rgb => {
    const sum = sums.get(key)
    if (!sum) return cloneColor(FALLBACK_BG)
    return { r: sum[0] / count / 255, g: sum[1] / count / 255, b: sum[2] / count / 255 }
  }

  const bgColor = meanOf(buckets[0][0], buckets[0][1])
  let bestDist = -1
  let bestColor: Rgb | null = null
  for (const [key, count] of buckets.slice(0, TOP_K)) {
    const candidate = meanOf(key, count)
    const dist = Math.hypot(candidate.r - bgColor.r, candidate.g - bgColor.g, candidate.b - bgColor.b)
    if (dist > bestDist) {
      bestDist = dist
      bestColor = candidate
    }
  }

  if (!bestColor || bestDist < COLOR_DIST_MIN) {
    return { color: cloneColor(FALLBACK_COLOR), bgColor }
  }
  return { color: bestColor, bgColor }
}

function cloneColor(c: Rgb): Rgb {
  return { r: c.r, g: c.g, b: c.b }
}

/* ------------------------------------------------------------------ *
 * pdf.js 驱动区（纯函数区不得依赖本区）
 * ------------------------------------------------------------------ */

type PdfJsModule = typeof import('pdfjs-dist')
type PdfDocument = Awaited<ReturnType<PdfJsModule['getDocument']>['promise']>
type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>
type PageViewport = ReturnType<PdfPage['getViewport']>

let pdfjsPromise: Promise<PdfJsModule> | null = null

/**
 * 懒加载 pdf.js，载入方式与 utils/pdfToHtml.ts 一致（本地 worker，不引外网 CDN）。
 * 放到函数里是刻意的：Node 下 `?worker` 的 default 是 undefined，此时跳过 workerPort，
 * 无头验收根本不会走到这里。
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

interface RawTextItem {
  str?: string
  transform?: number[]
  width?: number
  height?: number
  fontName?: string
}

/** pdf.js 内部字体名（未解析出真实字体时就是这种） */
const INTERNAL_FONT_NAME_RE = /^g_\d+_f\d+$/
/** 子集前缀，如 `ABCDEF+MicrosoftYaHei` */
const SUBSET_PREFIX_RE = /^[A-Z]{6}\+/
/** 等待单个字体对象进入 commonObjs 的上限（超时即回退字体名，不拖住整篇提取） */
const FONT_WAIT_MS = 1500

/** 页内工作项：多带一个 fontName，字体名要等页面渲染完才能解析出来 */
interface WorkingItem extends PdfTextRunItem {
  fontName: string | null
}

/**
 * 字节 → 每页文本行（含位置、字体与颜色）。
 * `totalPages` 是 PDF 的真实总页数（即使被 opts.maxPages 截断）。
 *
 * 每页顺序是刻意的：**先渲染、再解析字体名、最后聚合行**。
 * 因为 `page.commonObjs` 里的字体对象要等 pdf.js 处理完页面内容才送达，
 * 在 `getTextContent()` 之后立刻 `commonObjs.get(fontName)` 会抛
 * “Requesting object that isn't resolved yet g_d1_f1.”——实测三个真实样本上一律抛出，
 * 那时只能拿到回退字体名。
 */
export async function pdfBytesToTextRuns(
  bytes: Uint8Array,
  opts?: { maxPages?: number; onProgress?: (done: number, total: number) => void }
): Promise<{ pages: PdfTextPageBlocks[]; totalPages: number }> {
  const maxPages = opts?.maxPages && opts.maxPages > 0 ? Math.floor(opts.maxPages) : DEFAULT_MAX_PAGES
  const pdfjs = await loadPdfjs()
  // slice(0) 与 pdfRender.ts / pdfToHtml.ts 一致：避免 pdf.js 转移调用方的 buffer
  const task = pdfjs.getDocument({ data: bytes.slice(0) })
  const doc = await task.promise
  try {
    const totalPages = doc.numPages
    const limit = Math.min(totalPages, maxPages)
    const pages: PdfTextPageBlocks[] = []

    for (let i = 1; i <= limit; i++) {
      const page = await doc.getPage(i)
      const vp = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      const working: WorkingItem[] = []

      for (const raw of content.items) {
        const item = raw as RawTextItem
        // 空串 item 不带任何信息；纯空白 item 必须留（它是「源里本来有空格」的唯一信号）
        if (typeof item.str !== 'string' || item.str === '') continue
        const tr: number[] = Array.isArray(item.transform) ? item.transform : [1, 0, 0, 1, 0, 0]
        const t: number[] = pdfjs.Util.transform(vp.transform, tr)
        if (!Number.isFinite(t[4]) || !Number.isFinite(t[5])) continue
        const pdfPoint: number[] = vp.convertToPdfPoint(t[4], t[5])
        if (!Number.isFinite(pdfPoint[0]) || !Number.isFinite(pdfPoint[1])) continue

        working.push({
          str: item.str,
          x: pdfPoint[0],
          y: pdfPoint[1],
          baseline: pdfPoint[1],
          width: typeof item.width === 'number' && Number.isFinite(item.width) ? item.width : 0,
          height: typeof item.height === 'number' && Number.isFinite(item.height) ? item.height : 0,
          fontSize: pickFontSize(item, tr),
          fontFamily: FALLBACK_FONT,
          fontName: typeof item.fontName === 'string' && item.fontName !== '' ? item.fontName : null
        })
      }

      // 无文本项（扫描件/纯图页）：没有行可产出，也就不必整页渲染一遍
      if (working.length === 0) {
        pages.push({ page: i - 1, width: vp.width, height: vp.height, runs: [] })
        opts?.onProgress?.(i, limit)
        continue
      }

      const rendered = await renderPageToImage(page)
      try {
        const families = await resolveFontFamilies(
          page,
          working.map((it) => it.fontName)
        )
        for (const it of working) {
          if (it.fontName === null) continue
          const family = families.get(it.fontName)
          if (family) it.fontFamily = family
        }
        const runs = groupItemsToRuns(working, i - 1, vp.width)
        applyRunColors(rendered, runs)
        pages.push({ page: i - 1, width: vp.width, height: vp.height, runs })
      } finally {
        rendered?.release()
      }
      opts?.onProgress?.(i, limit)
    }

    return { pages, totalPages }
  } finally {
    const disposable = doc as unknown as { destroy?: () => Promise<void> }
    if (typeof disposable.destroy === 'function') await disposable.destroy()
  }
}

/**
 * 字号取值：优先 `hypot(transform[2], transform[3])`（文本空间单位向量经 CTM 缩放后的模长，
 * 即有效字号），拿不到时退回 `item.height`，再退回 12。
 */
function pickFontSize(item: RawTextItem, transform: number[]): number {
  const hypot = Math.hypot(transform[2], transform[3])
  if (Number.isFinite(hypot) && hypot > 0) return hypot
  if (typeof item.height === 'number' && Number.isFinite(item.height) && item.height > 0) {
    return item.height
  }
  return DEFAULT_FONT_SIZE
}

/** 从 pdf.js 的 Font 对象里挑一个真实字体名；拿不到返回 null */
function pickFontName(font: unknown): string | null {
  if (!font || typeof font !== 'object') return null
  const record = font as { name?: unknown; fallbackName?: unknown }
  for (const candidate of [record.name, record.fallbackName]) {
    if (typeof candidate !== 'string') continue
    const trimmed = candidate.replace(SUBSET_PREFIX_RE, '').trim()
    if (trimmed === '' || INTERNAL_FONT_NAME_RE.test(trimmed)) continue
    return trimmed
  }
  return null
}

type CommonObjs = {
  get: (objId: string, callback?: (data: unknown) => void) => unknown
}

/**
 * 等一个 commonObj（字体）就绪。
 * `commonObjs.get(id)` 同步形式在数据没到时会抛，**必须**用回调形式（pdf.js 内部对回调
 * 挂的是 promise.then）；再加超时兜底，避免个别字体永远不送达时把整篇提取拖住。
 */
function waitCommonObj(page: PdfPage, objId: string, timeoutMs: number): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let settled = false
    const settle = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      action()
    }
    const timer = setTimeout(() => settle(() => reject(new Error('等待字体对象超时: ' + objId))), timeoutMs)
    try {
      const objs = page.commonObjs as unknown as CommonObjs
      const immediate = objs.get(objId, (data) => settle(() => resolve(data)))
      // 传了回调时 pdf.js 返回 null；真返回了对象说明已经就绪
      if (immediate !== null && immediate !== undefined) settle(() => resolve(immediate))
    } catch (e) {
      settle(() => reject(e instanceof Error ? e : new Error(String(e))))
    }
  })
}

/** 批量解析 fontName → 真实字体名；取不到一律 FALLBACK_FONT */
async function resolveFontFamilies(page: PdfPage, fontNames: Array<string | null>): Promise<Map<string, string>> {
  const unique = new Set<string>()
  for (const name of fontNames) {
    if (typeof name === 'string' && name !== '') unique.add(name)
  }
  const entries = await Promise.all(
    [...unique].map(async (name): Promise<[string, string]> => {
      try {
        const font = await waitCommonObj(page, name, FONT_WAIT_MS)
        return [name, pickFontName(font) ?? FALLBACK_FONT]
      } catch {
        return [name, FALLBACK_FONT]
      }
    })
  )
  return new Map(entries)
}

interface RenderedPage {
  image: ImageData
  vp: PageViewport
  release: () => void
}

/** 整页渲染到离屏 canvas（像素供颜色采样；同时把字体对象推进 commonObjs） */
async function renderPageToImage(page: PdfPage): Promise<RenderedPage | null> {
  const canvas = document.createElement('canvas')
  const scaled = page.getViewport({ scale: RENDER_SCALE })
  canvas.width = Math.max(1, Math.round(scaled.width))
  canvas.height = Math.max(1, Math.round(scaled.height))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    canvas.width = 0
    canvas.height = 0
    return null
  }
  const release = (): void => {
    canvas.width = 0
    canvas.height = 0
  }
  // 与 pdfRender.ts 同样的写法：用取整后的 canvas 尺寸反推 viewport，避免像素与坐标错位
  const vp = page.getViewport({ scale: (RENDER_SCALE * canvas.width) / scaled.width })
  await page.render({ canvas, canvasContext: ctx, viewport: vp } as Parameters<typeof page.render>[0]).promise
  return { image: ctx.getImageData(0, 0, canvas.width, canvas.height), vp, release }
}

/** 按每个 run 的框（向外扩一点）在已渲染像素上采样颜色 */
function applyRunColors(rendered: RenderedPage | null, runs: PdfTextRun[]): void {
  if (!rendered) return
  const { image, vp } = rendered
  for (const run of runs) {
    const pad = Math.max(1, run.fontSize * SAMPLE_PAD_RATIO)
    const left = run.rect.x - pad
    const right = run.rect.x + run.rect.width + pad
    const bottom = run.rect.y - pad
    const top = run.rect.y + run.rect.height + pad
    const cornerA: number[] = vp.convertToViewportPoint(left, top)
    const cornerB: number[] = vp.convertToViewportPoint(right, bottom)
    const x0 = clampInt(Math.min(cornerA[0], cornerB[0]), 0, image.width)
    const x1 = clampInt(Math.ceil(Math.max(cornerA[0], cornerB[0])), 0, image.width)
    const y0 = clampInt(Math.min(cornerA[1], cornerB[1]), 0, image.height)
    const y1 = clampInt(Math.ceil(Math.max(cornerA[1], cornerB[1])), 0, image.height)
    if (x1 - x0 < 1 || y1 - y0 < 1) continue
    const sampled = sampleColors(cropRgba(image.data, image.width, x0, y0, x1 - x0, y1 - y0))
    run.color = sampled.color
    run.bgColor = sampled.bgColor
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/** 从整页 RGBA 里剪一块出来（sampleColors 只接受扁平像素） */
function cropRgba(
  data: Uint8ClampedArray,
  sourceWidth: number,
  x: number,
  y: number,
  width: number,
  height: number
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4)
  for (let row = 0; row < height; row++) {
    const srcStart = ((y + row) * sourceWidth + x) * 4
    out.set(data.subarray(srcStart, srcStart + width * 4), row * width * 4)
  }
  return out
}
