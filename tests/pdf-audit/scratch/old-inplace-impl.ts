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
 *   - 纯 Latin 新文字 → StandardFonts.Helvetica 矢量写入：可选、可检索、缩放不糊；
 *   - 含中文等非 WinAnsi 字符 → canvas 高 DPI 渲染成透明 PNG 嵌入：
 *     任意语言通吃，代价是这段新文字不进文本层（不可选、不可检索）。
 *
 * 覆盖策略：先铺一块背景色矩形盖住原文字，再把新文字画上去。矩形比原外接框
 * 四周各外扩 1pt（上限字号 0.25 倍），因为原外接框通常是紧贴字形墨迹的，
 * 不外扩会留下抗锯齿残影；外扩太多又会糊到相邻元素，故设上限。
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { PDFFont } from 'pdf-lib'
import { isWinAnsiSafe, renderTextToPng } from '../../../src/renderer/src/utils/pdfText'
import type { Rgb } from '../../../src/renderer/src/utils/pdfText'

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
   * 可选：字体族（栅格化时用），默认中文系统字体栈。
   *
   * 注意：当前栅格器 `renderTextToPng` 的签名不接受自定义字体族（内部固定使用
   * 「中文优先系统字体栈」），且本模块不允许改动 pdfText.ts，因此该字段目前
   * 只作为调用方接口保留，传入不会改变渲染结果。
   */
  fontFamily?: string
}

/** 覆盖矩形的基础外扩量（pt）：原外接框偏紧，外扩一圈才能吃住抗锯齿边缘 */
const COVER_PAD_PT = 1
/** 覆盖矩形外扩量的上限（相对字号）：避免糊到相邻元素 */
const COVER_PAD_MAX_RATIO = 0.25

/**
 * 把一批文字替换回写到 PDF 上，返回新的文件字节。
 *
 * - `bytes` 原 PDF 字节；加密文件按「忽略加密」加载（此时内容流通常读不出，
 *   由调用方决定是否允许）。
 * - `reps` 替换清单，可跨页；页号越界的条目被忽略（不抛异常）。
 */
export async function replacePdfText(bytes: Uint8Array, reps: TextReplacement[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const pages = doc.getPages()

  // 按页归组（顺带丢掉越界页号）。分组的作用是保证同一页里
  // 「所有覆盖矩形」先于「所有新文字」落笔 —— 否则两条相邻替换中
  // 后者的覆盖矩形会把前者刚画好的新文字盖掉半截。
  const byPage = new Map<number, TextReplacement[]>()
  for (const rep of reps) {
    if (rep.page < 0 || rep.page >= pages.length) continue
    const list = byPage.get(rep.page)
    if (list) list.push(rep)
    else byPage.set(rep.page, [rep])
  }

  // Helvetica 整篇只嵌一次（embedFont 每次都往文档里塞一份字体对象）
  let helvetica: PDFFont | null = null

  for (const [pageIndex, list] of byPage) {
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
        if (!helvetica) helvetica = await doc.embedFont(StandardFonts.Helvetica)
        const width = helvetica.widthOfTextAtSize(rep.newText, rep.fontSize)
        page.drawText(rep.newText, {
          x: alignX(rep, width),
          y: rep.baseline,
          size: rep.fontSize,
          font: helvetica,
          color: rgb(rep.color.r, rep.color.g, rep.color.b)
        })
        continue
      }

      // 中文 / 非 WinAnsi：栅格化成透明 PNG 再贴回去。
      // 图片基线对齐：renderTextToPng 给的是「基线距图片底边」的偏移，
      // 所以图片左下角 y = 基线 y - 该偏移。
      const raster = await renderTextToPng(rep.newText, {
        fontSize: rep.fontSize,
        color: rep.color,
        opacity: 1
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
