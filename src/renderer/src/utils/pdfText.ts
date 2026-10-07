/**
 * PDF 文字加盖工具层：水印 / 页眉 / 页脚 / 任意位置插入文字。
 *
 * 核心难点是中文。pdf-lib 内置的 StandardFonts 只有 14 个 WinAnsi 字体，
 * 无法编码中文（会直接抛 `WinAnsi cannot encode "第"`）。要嵌入中文 TTF 必须
 * 引入 fontkit 并随包携带 10~20MB 字体，且把系统字体嵌进用户 PDF 还存在授权问题。
 *
 * 因此这里采用混合策略：
 *   - 纯 Latin 文本 → StandardFonts 矢量写入（文字可选、可检索、任意缩放都清晰）
 *   - 含非 Latin（如中文）→ 用 canvas 按高 DPI 渲染成透明 PNG 再嵌入
 *     （任意语言通吃，代价是文字不可选、缩放极限下略糊）
 *
 * 调用方通过 `stampTextAuto` 统一入口，无需关心走的是哪条路。
 */
import { PDFDocument, PDFFont, PDFPage, StandardFonts, degrees, rgb } from 'pdf-lib'

export interface Rgb {
  r: number
  g: number
  b: number
}

export interface TextStyle {
  /** 字号（pt） */
  fontSize: number
  color: Rgb
  /** 不透明度 0..1 */
  opacity: number
  /** 旋转角度（度，逆时针为正） */
  rotate?: number
  /** 字体族（CSS font-family），缺省用中文系统字体栈 */
  fontFamily?: string
  /** 粗体（栅格化时用 bold 字重，矢量路径由调用方选择 Bold 字体） */
  bold?: boolean
  /** 斜体 */
  italic?: boolean
  /** 下划线（在 PNG 内一并画出，保证与文字同色同透明度） */
  underline?: boolean
}

export type TextAlign = 'left' | 'center' | 'right'

/** 供 UI 展示本次走了哪条渲染路径 */
export type TextRenderMode = 'vector' | 'raster'

/**
 * 判断文本能否被 WinAnsi（StandardFonts）安全编码。
 *
 * 只放行 0x20–0x7E（可打印 ASCII）与 0xA0–0xFF（Latin-1 补充）。
 * 0x80–0x9F 区间在 CP1252 里只有零星几个可显示字符，其余是控制码会抛错，
 * 故整体排除，让这类文本走栅格化路径，稳妥。
 */
export function isWinAnsiSafe(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 0x0a || c === 0x0d || c === 0x09) continue
    const ok = (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff)
    if (!ok) return false
  }
  return true
}

/** 决定某段文本的渲染路径 */
export function pickRenderMode(text: string): TextRenderMode {
  return isWinAnsiSafe(text) ? 'vector' : 'raster'
}

/** 中文优先的系统字体栈 */
const FONT_STACK =
  '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Source Han Sans SC", ' +
  '"Noto Sans CJK SC", "WenQuanYi Micro Hei", SimHei, sans-serif'

/** 栅格化文本时的超采样倍率：4 倍足以在 400% 缩放下仍不显糊 */
const RASTER_SCALE = 4

export interface RasterText {
  png: Uint8Array
  /** 图像宽高（pt，即排版尺寸，不含超采样） */
  width: number
  height: number
  /** 基线相对图像底部的偏移（pt） */
  baselineFromBottom: number
}

/**
 * 把一段文字渲染成透明背景 PNG。
 * 返回的 width/height 是「排版尺寸(pt)」，已除掉超采样倍率，
 * 因此调用方可以按 pt 直接使用，不必关心内部倍率。
 */
export async function renderTextToPng(text: string, style: TextStyle): Promise<RasterText> {
  const fontPx = style.fontSize * RASTER_SCALE
  const family = style.fontFamily ? `${style.fontFamily}, ${FONT_STACK}` : FONT_STACK
  const cssFont = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${fontPx}px ${family}`
  const measure = document.createElement('canvas').getContext('2d')
  if (!measure) throw new Error('无法创建 2D 上下文')
  measure.font = cssFont
  const m = measure.measureText(text)
  const ascent = m.actualBoundingBoxAscent || fontPx * 0.8
  const descent = m.actualBoundingBoxDescent || fontPx * 0.2
  // 下划线需要在降部之外再留一点空间
  const underlinePad = style.underline ? Math.ceil(fontPx * 0.12) : 0
  const pad = Math.ceil(fontPx * 0.12)

  const w = Math.max(1, Math.ceil(m.width) + pad * 2)
  const h = Math.max(1, Math.ceil(ascent + descent) + pad * 2 + underlinePad)

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建 2D 上下文')
  ctx.clearRect(0, 0, w, h)
  ctx.font = cssFont
  ctx.textBaseline = 'alphabetic'
  const fill = `rgb(${Math.round(style.color.r * 255)},${Math.round(style.color.g * 255)},${Math.round(style.color.b * 255)})`
  ctx.fillStyle = fill
  // 透明度在 drawImage 阶段用 opacity 施加，这里保持不透明，
  // 避免 PNG 的 alpha 与 drawImage opacity 两次相乘导致过淡。
  const baseY = pad + ascent
  ctx.fillText(text, pad, baseY)
  if (style.underline) {
    const lineY = Math.min(h - 1, baseY + Math.max(1, fontPx * 0.11))
    const lineH = Math.max(1, fontPx * 0.055)
    ctx.fillRect(pad, lineY, Math.ceil(m.width), lineH)
  }

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png')
  )
  const png = new Uint8Array(await blob.arrayBuffer())
  canvas.width = 0
  canvas.height = 0
  return {
    png,
    width: w / RASTER_SCALE,
    height: h / RASTER_SCALE,
    baselineFromBottom: (pad + descent + underlinePad) / RASTER_SCALE
  }
}

export interface StampPlacement {
  /** 文字左边缘的 x（pt） */
  x: number
  /** 文字【基线】的 y（pt） */
  y: number
  /** 最大可用宽度（pt），超出则按比例缩小字号；不传则不缩放 */
  maxWidth?: number
  align?: TextAlign
}

export interface StampContext {
  doc: PDFDocument
  /** StandardFonts 复用缓存，避免每页重复 embed */
  fontCache: Map<string, PDFFont>
}

export function createStampContext(doc: PDFDocument): StampContext {
  return { doc, fontCache: new Map() }
}

async function getStandardFont(ctx: StampContext, name: StandardFonts): Promise<PDFFont> {
  const hit = ctx.fontCache.get(name)
  if (hit) return hit
  const f = await ctx.doc.embedFont(name)
  ctx.fontCache.set(name, f)
  return f
}

/**
 * 在页面上盖一段文字，自动选择矢量或栅格路径。
 * 返回实际使用的渲染方式，便于 UI 如实告知用户。
 */
export async function stampTextAuto(
  ctx: StampContext,
  page: PDFPage,
  text: string,
  placement: StampPlacement,
  style: TextStyle
): Promise<{ mode: TextRenderMode; width: number; height: number }> {
  const mode = pickRenderMode(text)
  let fontSize = style.fontSize
  let width = 0
  let height = 0

  if (mode === 'vector') {
    const font = await getStandardFont(ctx, StandardFonts.Helvetica)
    width = font.widthOfTextAtSize(text, fontSize)
    height = font.heightAtSize(fontSize)
    if (placement.maxWidth && width > placement.maxWidth) {
      fontSize = fontSize * (placement.maxWidth / width)
      width = font.widthOfTextAtSize(text, fontSize)
      height = font.heightAtSize(fontSize)
    }
    // 先按基线放置，再根据对齐方式回推左边缘
    let x = placement.x
    if (placement.align === 'center') x -= width / 2
    else if (placement.align === 'right') x -= width
    page.drawText(text, {
      x,
      y: placement.y,
      size: fontSize,
      font,
      color: rgb(style.color.r, style.color.g, style.color.b),
      opacity: style.opacity,
      rotate: degrees(style.rotate ?? 0)
    })
    return { mode, width, height }
  }

  const raster = await renderTextToPng(text, { ...style, fontSize })
  // 栅格路径下如需缩放，按比例重算字号后重新渲染一次
  if (placement.maxWidth && raster.width > placement.maxWidth) {
    fontSize = fontSize * (placement.maxWidth / raster.width)
    const again = await renderTextToPng(text, { ...style, fontSize })
    const img = await ctx.doc.embedPng(again.png)
    let x = placement.x
    if (placement.align === 'center') x -= again.width / 2
    else if (placement.align === 'right') x -= again.width
    page.drawImage(img, {
      x,
      y: placement.y - again.baselineFromBottom,
      width: again.width,
      height: again.height,
      opacity: style.opacity,
      rotate: degrees(style.rotate ?? 0)
    })
    return { mode, width: again.width, height: again.height }
  }

  const img = await ctx.doc.embedPng(raster.png)
  let x = placement.x
  if (placement.align === 'center') x -= raster.width / 2
  else if (placement.align === 'right') x -= raster.width
  page.drawImage(img, {
    x,
    y: placement.y - raster.baselineFromBottom,
    width: raster.width,
    height: raster.height,
    opacity: style.opacity,
    rotate: degrees(style.rotate ?? 0)
  })
  return { mode, width: raster.width, height: raster.height }
}

/** 页号/总页数/日期占位符替换，供页眉页脚使用 */
export function expandPlaceholders(text: string, pageNo: number, totalPages: number, date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const yyyy = date.getFullYear()
  const mm = pad(date.getMonth() + 1)
  const dd = pad(date.getDate())
  return text
    .replace(/\{page\}/gi, String(pageNo))
    .replace(/\{total\}/gi, String(totalPages))
    .replace(/\{date\}/gi, `${yyyy}-${mm}-${dd}`)
    .replace(/\{time\}/gi, `${pad(date.getHours())}:${pad(date.getMinutes())}`)
}

/**
 * 解析页码范围字符串，如 "1-3,5,8-" → [1,2,3,5,8,9,...total]
 * 返回 1-based 且已排序去重的页码数组。空字符串表示全部。
 * 越界项被裁掉；非法片段被忽略。
 */
export function parsePageRanges(input: string, total: number): number[] {
  const s = (input ?? '').trim()
  if (!s) return Array.from({ length: total }, (_, i) => i + 1)
  const picked = new Set<number>()
  for (const rawPart of s.split(/[,，;；\s]+/)) {
    const part = rawPart.trim()
    if (!part) continue
    const m = /^(\d+)?\s*(?:-\s*(\d+)?)?$/.exec(part)
    if (!m) continue
    const hasDash = part.includes('-')
    if (!hasDash) {
      const n = Number(m[1])
      if (n >= 1 && n <= total) picked.add(n)
      continue
    }
    let from = m[1] ? Number(m[1]) : 1
    let to = m[2] ? Number(m[2]) : total
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue
    if (from > to) [from, to] = [to, from]
    from = Math.max(1, from)
    to = Math.min(total, to)
    for (let n = from; n <= to; n++) picked.add(n)
  }
  return [...picked].sort((a, b) => a - b)
}

/**
 * 把文字以「自身几何中心」对齐到指定点。
 *
 * pdf-lib 的 rotate 是绕绘制原点 (x,y) 逆时针旋转，直接传页面中心会让旋转后的
 * 文字整体偏移。这里先算出文字半宽/半高在旋转后的位移，再从目标中心反推原点。
 * 视觉中心取基线以上约 0.35 倍字高（西文 x-height 到 cap-height 的中点附近）。
 */
export async function stampTextAtCenter(
  ctx: StampContext,
  page: PDFPage,
  text: string,
  cx: number,
  cy: number,
  style: TextStyle,
  maxWidth?: number
): Promise<{ mode: TextRenderMode; width: number; height: number }> {
  const rad = ((style.rotate ?? 0) * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)

  // 先用临时原点量一次尺寸（矢量路径可直接测；栅格路径需实测渲染宽度）
  let w: number
  let h: number
  if (pickRenderMode(text) === 'vector') {
    const font = await getStandardFont(ctx, StandardFonts.Helvetica)
    let fs = style.fontSize
    w = font.widthOfTextAtSize(text, fs)
    h = font.heightAtSize(fs)
    if (maxWidth && w > maxWidth) {
      fs = fs * (maxWidth / w)
      w = font.widthOfTextAtSize(text, fs)
      h = font.heightAtSize(fs)
    }
  } else {
    const probe = await renderTextToPng(text, style)
    w = probe.width
    h = probe.height
  }

  const halfW = w / 2
  const vCenter = h * 0.35
  const x = cx - (halfW * cos - vCenter * sin)
  const y = cy - (halfW * sin + vCenter * cos)
  return stampTextAuto(ctx, page, text, { x, y, maxWidth }, style)
}

/**
 * 平铺水印：按行列网格铺满整页，逐格居中盖印。
 * 相邻行错开半格，视觉上更均匀、更难被裁切掉。
 */
export async function stampWatermarkTile(
  ctx: StampContext,
  page: PDFPage,
  text: string,
  style: TextStyle,
  opts: { cols?: number; rows?: number } = {}
): Promise<TextRenderMode> {
  const { width, height } = page.getSize()
  const cols = Math.max(1, opts.cols ?? 3)
  const rows = Math.max(1, opts.rows ?? 4)
  const cellW = width / cols
  const cellH = height / rows
  let mode: TextRenderMode = 'vector'
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const offset = r % 2 === 0 ? 0 : cellW / 2
      const cx = c * cellW + cellW / 2 + offset
      if (cx - cellW / 4 > width) continue
      const cy = r * cellH + cellH / 2
      const res = await stampTextAtCenter(ctx, page, text, cx, cy, style, cellW * 0.92)
      mode = res.mode
    }
  }
  return mode
}
