/**
 * PDF「保版式改字」回写层：在原 PDF 上只替换被改动的文字，其余一切保持原样。
 *
 * 与「盖水印 / 加页眉」那类工具的差别在于目标：那边是往干净页面上叠东西，
 * 这边是**在已经排好版的页面上就地替换**。因此有两条铁律：
 *
 *   1. 不用 copyPages 重建文档。任何重建都会让图片/矢量图形/字体子集/
 *      页面尺寸细节重新序列化一遍，视觉上也许看不出来，但版式细节与字节
 *      都会变。这里直接在原 PDFDocument 的页对象上追加绘制指令。
 *   2. 不改动原页面内容流，只往页面末尾追加覆盖矩形与新文字的对象。
 *      pdf-lib 的 page.drawXxx 就是这么工作的（pushOperators），
 *      于是「未编辑的页」在输出文件里仍是原来那段字节。
 *
 * 渲染路径与 pdfText.ts 保持同一套策略（刻意不引入 fontkit 与 10~20MB
 * 中文字体）：
 *   - 纯 Latin 新文字 → StandardFonts 矢量写入：可选、可检索、缩放不糊；
 *     字体族只在内置的 Helvetica 四态里选（bold/italic 决定具体面）；
 *   - 含中文等非 WinAnsi 字符 → canvas 高 DPI 渲染成透明 PNG 嵌入：
 *     任意语言通吃，字体族/粗体/斜体/下划线都交给 canvas 处理，
 *     代价是这段新文字不进文本层（不可选、不可检索）。
 *
 * 覆盖策略：先铺一块背景色矩形盖住原文字，再把新文字画上去。矩形比原外接框
 * 四周各外扩 1pt（上限字号 0.25 倍），因为原外接框通常是紧贴字形墨迹的，
 * 不外扩会留下抗锯齿残影；外扩太多又会糊到相邻元素，故设上限。
 *
 * 批注（`PdfAnnotation`）：highlight / underline / strike / box / note。
 * 落笔顺序固定为「覆盖矩形 → 新文字 → 批注」，因此批注永远压在新文字之上。
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { PDFFont, PDFPage } from 'pdf-lib'
import { isWinAnsiSafe, renderTextToPng } from './pdfText'
import type { Rgb } from './pdfText'
import { scrubPdfTextLayer } from './pdfTextLayerScrub'
import type { PdfTextScrubTarget } from './pdfTextLayerScrub'

export type { PdfTextScrubStats } from './pdfTextLayerScrub'

/** replacePdfText 的可选行为开关 */
export interface ReplacePdfTextOptions {
  /**
   * 是否把「被替换掉的原文字」从 PDF 文本层里真正删掉（默认 false）。
   *
   * 关闭时（含不传 opts）行为与旧版**逐字节一致**：原内容流一字不改，只追加
   * 覆盖矩形与新文字，旧文字仍可被选中/复制/检索。
   *
   * 打开时会在覆盖重绘之前，把能与替换目标**唯一匹配**的原文字显示算子从内容流里
   * 摘掉，于是旧文字从文本层消失。因为该区域稍后会被不透明的覆盖矩形盖住，
   * 视觉像素零变化；匹配有歧义的一律放弃（旧文字保留，见 `onScrubReport`）。
   */
  scrubReplacedText?: boolean
  /** 清理统计回执（仅在 scrubReplacedText 为 true 时回调一次） */
  onScrubReport?: (stats: import('./pdfTextLayerScrub').PdfTextScrubStats) => void
}

export interface TextReplacement {
  /** 0 基页号 */
  page: number
  /** 原文字外接框（PDF 用户坐标，左下原点，pt） */
  rect: { x: number; y: number; width: number; height: number }
  /** 原文字基线 y（PDF 用户坐标） */
  baseline: number
  /** 原字号（pt） */
  fontSize: number
  /** 原文字颜色 */
  color: Rgb
  /** 原背景色（用于覆盖原文字） */
  bgColor: Rgb
  align: 'left' | 'center' | 'right'
  /** 新文字（空串 = 删除该行文字） */
  newText: string
  /**
   * 可选：字体族（CSS font-family）。只在栅格路径（含中文等非 WinAnsi 字符）生效，
   * 缺省用中文系统字体栈；矢量路径只有内置 Helvetica 四态，该字段不适用。
   */
  fontFamily?: string
  /** 可选：粗体。栅格路径用 bold 字重；矢量路径改用 HelveticaBold（+Oblique） */
  bold?: boolean
  /** 可选：斜体。栅格路径用 italic 字形；矢量路径改用 HelveticaOblique（+Bold） */
  italic?: boolean
  /** 可选：下划线。两条路径都会画（栅格画进 PNG，矢量补一条线段） */
  underline?: boolean
}

/** 批注 / 高亮标注（坐标同样是 PDF 用户空间：左下原点、未旋转） */
export interface PdfAnnotation {
  /** 0 基页号；越界页号被忽略（不抛异常） */
  page: number
  /** PDF 用户坐标（左下原点）矩形 */
  rect: { x: number; y: number; width: number; height: number }
  kind: 'highlight' | 'underline' | 'strike' | 'box' | 'note'
  color: Rgb
  /** 不透明度 0..1；缺省 highlight 0.35，其余 1 */
  opacity?: number
  /** note 的便签文字（可含中文）；缺省则只画图标 */
  text?: string
}

/** 覆盖矩形的基础外扩量（pt）：原外接框偏紧，外扩一圈才能吃住抗锯齿边缘 */
const COVER_PAD_PT = 1
/** 覆盖矩形外扩量的上限（相对字号）：避免糊到相邻元素 */
const COVER_PAD_MAX_RATIO = 0.25

/** 下划线默认不透明度 */
const HIGHLIGHT_DEFAULT_OPACITY = 0.35

/** underline / strike 的粗细 = rect 高 × 此比例，下限若干 pt */
const ANNOT_LINE_THICKNESS_RATIO = 0.08
const ANNOT_LINE_MIN_THICKNESS = 0.6

/** note 图标（圆角方块）边长与圆角半径（pt） */
const NOTE_ICON_SIZE = 14
const NOTE_ICON_RADIUS = 3
/** note 便签文字字号（pt）与图标右侧的间距（pt） */
const NOTE_TEXT_SIZE = 9.5
const NOTE_TEXT_GAP = 2

/** 文字视觉中心占字号的比例（用于让 note 便签文字与图标垂直居中对齐） */
const TEXT_VISUAL_CENTER_RATIO = 0.35

/**
 * 下划线相对基线的偏移与粗细（相对字号）。
 * 与 pdfText.ts 栅格路径里的取值保持一致（基线下方 0.11×字号、0.055×字号粗），
 * 这样矢量路径与栅格路径画出来的下划线位置不会打架。
 */
const UNDERLINE_OFFSET_RATIO = 0.11
const UNDERLINE_THICKNESS_RATIO = 0.055
const UNDERLINE_MIN_THICKNESS = 0.5

type PdfColor = ReturnType<typeof rgb>

/** bold/italic → 内置 Helvetica 家族的具体字面 */
function pickStandardFont(bold?: boolean, italic?: boolean): StandardFonts {
  if (bold && italic) return StandardFonts.HelveticaBoldOblique
  if (bold) return StandardFonts.HelveticaBold
  if (italic) return StandardFonts.HelveticaOblique
  return StandardFonts.Helvetica
}

/**
 * 把一批文字替换（可选附带批注）回写到 PDF 上，返回新的文件字节。
 *
 * - `bytes` 原 PDF 字节；加密文件按「忽略加密」加载（此时内容流通常读不出，
 *   由调用方决定是否允许）。
 * - `reps` 替换清单，可跨页；页号越界的条目被忽略（不抛异常）。
 * - `annotations` 第三参可选：批注清单，只影响其所在页，页号越界同样被忽略。
 *   不传时行为与旧版完全一致（输出字节也一致）。
 * - `opts` 第四参可选：目前只有一个开关 `scrubReplacedText`。省略或为 false 时，
 *   输出与旧实现**逐字节等价**（回归由 tests/pdf-text-scrub.ts 守护）。
 */
export async function replacePdfText(
  bytes: Uint8Array,
  reps: TextReplacement[],
  annotations?: PdfAnnotation[],
  opts?: ReplacePdfTextOptions
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const pages = doc.getPages()

  // 按页归组（顺带丢掉越界页号）。分组的作用是保证同一页里
  // 「所有覆盖矩形」先于「所有新文字」落笔 —— 否则两条相邻替换中
  // 后者的覆盖矩形会把前者刚画好的新文字盖掉半截。
  const repsByPage = groupByPage(reps, pages.length)
  const annotationsByPage = groupByPage(annotations ?? [], pages.length)

  // 文本层清理必须发生在任何覆盖绘制之前：一旦追加了新文字，扫描就会把
  // 我们刚画上去的字也算进候选，可能误删。
  //
  // #region scrub-optional —— 整段是本功能的唯一改动点，关闭开关时这段不执行。
  // （tests/pdf-text-scrub.ts 会把 #region…#endregion 之间的代码整段剥掉，生成
  //   「没有本功能」的等价实现，用来逐字节验证向后兼容。改动本段时请保持标记完整。）
  if (opts?.scrubReplacedText === true && reps.length > 0) {
    const targets: PdfTextScrubTarget[] = []
    for (const [pageIndex, list] of repsByPage) {
      for (const rep of list) {
        targets.push({
          page: pageIndex,
          rect: rep.rect,
          baseline: rep.baseline,
          fontSize: rep.fontSize
        })
      }
    }
    if (targets.length > 0) {
      const stats = scrubPdfTextLayer(doc, targets)
      opts.onScrubReport?.(stats)
    }
  }
  // #endregion scrub-optional

  // 标准字体按「字面」缓存：每个面整篇只 embed 一次（embedFont 每次都往文档里塞一份字体对象）
  const fontCache = new Map<StandardFonts, PDFFont>()
  const getStandardFont = async (name: StandardFonts): Promise<PDFFont> => {
    const hit = fontCache.get(name)
    if (hit) return hit
    const font = await doc.embedFont(name)
    fontCache.set(name, font)
    return font
  }

  for (const [pageIndex, list] of repsByPage) {
    const page = pages[pageIndex]

    for (const rep of list) {
      const pad = Math.min(COVER_PAD_PT, rep.fontSize * COVER_PAD_MAX_RATIO)
      page.drawRectangle({
        x: rep.rect.x - pad,
        y: rep.rect.y - pad,
        width: rep.rect.width + pad * 2,
        height: rep.rect.height + pad * 2,
        color: rgb(rep.bgColor.r, rep.bgColor.g, rep.bgColor.b)
      })
    }

    for (const rep of list) {
      if (rep.newText === '') continue // 空串 = 只删不留

      if (isWinAnsiSafe(rep.newText)) {
        const font = await getStandardFont(pickStandardFont(rep.bold, rep.italic))
        const width = font.widthOfTextAtSize(rep.newText, rep.fontSize)
        const x = alignX(rep, width)
        const color = rgb(rep.color.r, rep.color.g, rep.color.b)
        page.drawText(rep.newText, {
          x,
          y: rep.baseline,
          size: rep.fontSize,
          font,
          color
        })
        if (rep.underline) drawVectorUnderline(page, x, rep.baseline, width, rep.fontSize, color)
        continue
      }

      // 中文 / 非 WinAnsi：栅格化成透明 PNG 再贴回去。
      // 图片基线对齐：renderTextToPng 给的是「基线距图片底边」的偏移，
      // 所以图片左下角 y = 基线 y - 该偏移。
      const raster = await renderTextToPng(rep.newText, {
        fontSize: rep.fontSize,
        color: rep.color,
        opacity: 1,
        fontFamily: rep.fontFamily,
        bold: rep.bold,
        italic: rep.italic,
        underline: rep.underline
      })
      const image = await doc.embedPng(raster.png)
      page.drawImage(image, {
        x: alignX(rep, raster.width),
        y: rep.baseline - raster.baselineFromBottom,
        width: raster.width,
        height: raster.height
      })
    }
  }

  // 批注统一放在最后画（且与替换分属两个循环）：同一页里批注永远压在新文字之上。
  // 因为每个页面的绘制只写自己那条内容流，跨页先后顺序不影响结果。
  for (const [pageIndex, list] of annotationsByPage) {
    await drawAnnotations(pages[pageIndex], doc, list)
  }

  // 关掉对象流：保持经典交叉引用结构，输出可被逐字节比对
  // （对象流会把对象打包进压缩流，比对工具就没法逐对象比对了）
  return doc.save({ useObjectStreams: false })
}

/** 按对齐方式把新内容的左边缘定在原外接框内 */
function alignX(rep: TextReplacement, width: number): number {
  switch (rep.align) {
    case 'center':
      return rep.rect.x + (rep.rect.width - width) / 2
    case 'right':
      return rep.rect.x + rep.rect.width - width
    default:
      return rep.rect.x
  }
}

/** 矢量路径的下划线：基线下方一条实线，长度 = 文字宽度 */
function drawVectorUnderline(
  page: PDFPage,
  x: number,
  baseline: number,
  width: number,
  fontSize: number,
  color: PdfColor
): void {
  const y = baseline - fontSize * UNDERLINE_OFFSET_RATIO
  page.drawLine({
    start: { x, y },
    end: { x: x + width, y },
    thickness: Math.max(UNDERLINE_MIN_THICKNESS, fontSize * UNDERLINE_THICKNESS_RATIO),
    color
  })
}

/** 按页归组并丢弃越界页号 */
function groupByPage<T extends { page: number }>(items: T[], pageCount: number): Map<number, T[]> {
  const map = new Map<number, T[]>()
  for (const item of items) {
    if (item.page < 0 || item.page >= pageCount) continue
    const list = map.get(item.page)
    if (list) list.push(item)
    else map.set(item.page, [item])
  }
  return map
}

/** 依次绘制同一页上的全部批注（调用方保证这是该页的最后一步） */
async function drawAnnotations(page: PDFPage, doc: PDFDocument, list: PdfAnnotation[]): Promise<void> {
  for (const ann of list) {
    const color = rgb(ann.color.r, ann.color.g, ann.color.b)
    const { x, y, width, height } = ann.rect

    switch (ann.kind) {
      case 'highlight':
        drawFilledRect(page, ann.rect, color, ann.opacity ?? HIGHLIGHT_DEFAULT_OPACITY)
        break

      case 'underline': {
        const thickness = annotLineThickness(height)
        page.drawRectangle(
          opacityOption({ x, y, width, height: thickness }, ann.opacity, 1, color)
        )
        break
      }

      case 'strike': {
        const thickness = annotLineThickness(height)
        page.drawRectangle(
          opacityOption({ x, y: y + (height - thickness) / 2, width, height: thickness }, ann.opacity, 1, color)
        )
        break
      }

      case 'box':
        // 只描边：不传 color，pdf-lib 就不会发填充算子（fill）
        page.drawRectangle({ x, y, width, height, borderColor: color, borderWidth: 1 })
        break

      case 'note':
        await drawNote(page, doc, ann, color)
        break
    }
  }
}

/** underline / strike 的线宽：矩形高的固定比例，带下限 */
function annotLineThickness(rectHeight: number): number {
  return Math.max(ANNOT_LINE_MIN_THICKNESS, rectHeight * ANNOT_LINE_THICKNESS_RATIO)
}

/**
 * 组装一个实心矩形的绘制参数。
 * 不透明度 ≥ 1 时不传 `opacity`：pdf-lib 一旦看到该字段就会额外写一个
 * ExtGState 对象，白白把输出弄脏（不透明绘制本来就不需要）。
 */
function opacityOption(
  rect: { x: number; y: number; width: number; height: number },
  opacity: number | undefined,
  fallback: number,
  color: PdfColor
): { x: number; y: number; width: number; height: number; color: PdfColor; opacity?: number } {
  const resolved = opacity ?? fallback
  return resolved < 1 ? { ...rect, color, opacity: resolved } : { ...rect, color }
}

/** 实心矩形；不透明度 ≥ 1 时同样省掉 ExtGState */
function drawFilledRect(
  page: PDFPage,
  rect: { x: number; y: number; width: number; height: number },
  color: PdfColor,
  opacity: number
): void {
  page.drawRectangle(opacityOption(rect, opacity, 1, color))
}

/**
 * note 批注：在 rect 右上角画一个 14×14pt 的圆角实心方块，右侧接便签文字。
 *
 * 坐标陷阱：pdf-lib 的 drawSvgPath 先 translate(x, y) 再 scale(1, -1)（SVG 的 y 轴朝下），
 * 所以 SVG 原点是 (x, y)、SVG 的 +y 在 PDF 空间里是往下的。把图标「SVG 空间的左上角」
 * 放在矩形右上角，即 x = rect 右边 - 边长、y = rect 顶边，图标就落在右上角且不越界。
 */
async function drawNote(
  page: PDFPage,
  doc: PDFDocument,
  ann: PdfAnnotation,
  color: PdfColor
): Promise<void> {
  const { x, y, width, height } = ann.rect
  const size = NOTE_ICON_SIZE
  const iconX = x + width - size
  const iconTop = y + height
  const r = Math.min(NOTE_ICON_RADIUS, size / 2)
  const path =
    `M ${r} 0 L ${size - r} 0 A ${r} ${r} 0 0 1 ${size} ${r} ` +
    `L ${size} ${size - r} A ${r} ${r} 0 0 1 ${size - r} ${size} ` +
    `L ${r} ${size} A ${r} ${r} 0 0 1 0 ${size - r} ` +
    `L 0 ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`

  if (ann.opacity !== undefined && ann.opacity < 1) {
    page.drawSvgPath(path, { x: iconX, y: iconTop, color, opacity: ann.opacity })
  } else {
    page.drawSvgPath(path, { x: iconX, y: iconTop, color })
  }

  if (!ann.text) return

  const raster = await renderTextToPng(ann.text, {
    fontSize: NOTE_TEXT_SIZE,
    color: ann.color,
    opacity: 1
  })
  const image = await doc.embedPng(raster.png)
  page.drawImage(image, {
    x: x + width + NOTE_TEXT_GAP,
    y: iconTop - size / 2 - NOTE_TEXT_SIZE * TEXT_VISUAL_CENTER_RATIO - raster.baselineFromBottom,
    width: raster.width,
    height: raster.height
  })
}
