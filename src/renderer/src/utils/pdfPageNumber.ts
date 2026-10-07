/**
 * 加页码的落位计算与预览变换（纯函数，可无头测试）。
 *
 * 关键约束：页码用 `StandardFonts.Helvetica` 渲染，编码为 WinAnsi，
 * **无法编码中文**（会抛 `WinAnsi cannot encode "第"`）。内置模板只产出数字与 ASCII，
 * 自定义模板若含中文必须在导出前提前拦下，不能等到产出阶段才抛异常。
 *
 * 预览叠加用的坐标变换与 pdf.js `page.getViewport().transform` **逐项一致**
 * （已用 pdfjs-dist 实测比对 0/90/180/270 四个角度），因此旋转页也不会错位。
 */

export type PageNumberTemplate = 'number' | 'pageof' | 'dash' | 'custom'

export const PAGE_NUMBER_POSITIONS: Array<{ value: string; label: string }> = [
  { value: 'bottom-left', label: '左下' },
  { value: 'bottom-center', label: '底部居中' },
  { value: 'bottom-right', label: '右下' },
  { value: 'top-left', label: '左上' },
  { value: 'top-center', label: '顶部居中' },
  { value: 'top-right', label: '右上' },
  { value: 'middle-left', label: '左侧居中' },
  { value: 'middle-center', label: '页面居中' },
  { value: 'middle-right', label: '右侧居中' }
]

/** 自定义模板里的占位符：{n} = 页码，{total} = 总页数 */
export function buildPageLabel(o: {
  template: PageNumberTemplate
  custom: string
  n: number
  total: number
}): string {
  switch (o.template) {
    case 'pageof':
      return `${o.n} / ${o.total}`
    case 'dash':
      return `- ${o.n} -`
    case 'custom': {
      const t = o.custom.trim() || '{n}'
      return t.replace(/\{total\}/g, String(o.total)).replace(/\{n\}/g, String(o.n))
    }
    default:
      return String(o.n)
  }
}

/**
 * 页码落位：与导出时的 `page.drawText` 参数**完全一致**。
 * 返回 pdf-lib 的基线坐标（y 自页面底部算起，单位 pt）。
 */
export function pageNumberPlacement(o: {
  position: string
  textWidth: number
  fontSize: number
  margin: number
  pageW: number
  pageH: number
}): { x: number; y: number } {
  let x = o.margin
  let y = o.margin
  if (o.position.includes('center')) x = (o.pageW - o.textWidth) / 2
  else if (o.position.includes('right')) x = o.pageW - o.textWidth - o.margin
  if (o.position.includes('top')) y = o.pageH - o.margin - o.fontSize
  else if (o.position.includes('middle')) y = (o.pageH - o.fontSize) / 2
  return { x, y }
}

export interface PreviewTransform {
  /** 渲染视口宽高（旋转 90/270 时宽高互换） */
  width: number
  height: number
  /** SVG matrix(a b c d e f)：把页面坐标（原点左下、y 向上）映射到视口坐标（原点左上、y 向下） */
  matrix: [number, number, number, number, number, number]
}

/** 与 pdf.js `page.getViewport({scale:1}).transform` 完全相同的变换 */
export function pagePreviewTransform(pageW: number, pageH: number, rotation: number): PreviewTransform {
  const rot = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360
  switch (rot) {
    case 90:
      return { width: pageH, height: pageW, matrix: [0, 1, 1, 0, 0, 0] }
    case 180:
      return { width: pageW, height: pageH, matrix: [-1, 0, 0, 1, pageW, 0] }
    case 270:
      return { width: pageH, height: pageW, matrix: [0, -1, -1, 0, pageH, pageW] }
    default:
      return { width: pageW, height: pageH, matrix: [1, 0, 0, -1, 0, pageH] }
  }
}

/** 该字体能否编码这段文本（Helvetica/WinAnsi 不能编码中文等非 Latin 字符） */
export function canEncode(font: { widthOfTextAtSize: (t: string, s: number) => number }, text: string): boolean {
  try {
    font.widthOfTextAtSize(text, 12)
    return true
  } catch {
    return false
  }
}

/** 文本宽度（不可编码时返回 undefined，避免预览阶段直接抛异常） */
export function safeTextWidth(
  font: { widthOfTextAtSize: (t: string, s: number) => number },
  text: string,
  size: number
): number | undefined {
  try {
    return font.widthOfTextAtSize(text, size)
  } catch {
    return undefined
  }
}
