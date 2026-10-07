/**
 * 「保版式改字」样式取证的像素 / 几何度量工具。
 *
 * 目的：**用数字**证明样式改动真的生效（字号变大 → 墨迹包围盒变高；改红 → 红像素
 * 从 0 变成一大片；加下划线 → 基线下方凭空多出一条墨迹 …），而不是"看图正常"。
 *
 * 坐标系约定与 utils/pdfTextBlocks.ts 一致：
 *   - 入参 rect 一律是 PDF 用户坐标（左下原点、未旋转、pt）；
 *   - 渲染用 pdf.js viewport，并把取整后的 canvas 尺寸反推回 viewport，避免像素错位；
 *   - 页面在透明 canvas 上渲染后**白底合成**，这样"背景 = 白"是确定的，像素统计才可复现。
 *
 * 渲染后端用 @napi-rs/canvas（pdfjs-dist 的传递依赖，未新增 npm 包）。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const PDFJS_ROOT = join(ROOT, 'node_modules', 'pdfjs-dist')

export const PDFJS_KW = {
  isEvalSupported: false,
  disableFontFace: true,
  standardFontDataUrl: join(PDFJS_ROOT, 'standard_fonts') + '/',
  cMapUrl: join(PDFJS_ROOT, 'cmaps') + '/',
  cMapPacked: true
}

/**
 * 渲染一页（1 基页号）并白底合成，返回 { canvas, viewport, image }。
 * image 是白底合成后的 RGBA ImageData（页面背景确定是白，便于统计）。
 */
export async function renderPage(bytes, pageNo, scale = 2) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), ...PDFJS_KW })
  const doc = await task.promise
  try {
    const page = await doc.getPage(pageNo)
    const base = page.getViewport({ scale })
    const raw = createCanvas(Math.max(1, Math.round(base.width)), Math.max(1, Math.round(base.height)))
    const rawCtx = raw.getContext('2d', { willReadFrequently: true })
    // 用取整后的 canvas 尺寸反推 viewport，保证像素与 PDF 坐标一一对应
    const viewport = page.getViewport({ scale: (scale * raw.width) / base.width })
    await page.render({ canvas: raw, canvasContext: rawCtx, viewport }).promise

    const flat = createCanvas(raw.width, raw.height)
    const flatCtx = flat.getContext('2d', { willReadFrequently: true })
    flatCtx.fillStyle = '#ffffff'
    flatCtx.fillRect(0, 0, flat.width, flat.height)
    flatCtx.drawImage(raw, 0, 0)
    return { canvas: flat, viewport, image: flatCtx.getImageData(0, 0, flat.width, flat.height) }
  } finally {
    await task.destroy()
  }
}

/** PDF 用户坐标矩形 → 整数像素包围盒（含左/上，不含右/下） */
export function pdfRectToPixels(viewport, rect) {
  const a = viewport.convertToViewportPoint(rect.x, rect.y)
  const b = viewport.convertToViewportPoint(rect.x + rect.width, rect.y + rect.height)
  return {
    x0: Math.max(0, Math.floor(Math.min(a[0], b[0]))),
    y0: Math.max(0, Math.floor(Math.min(a[1], b[1]))),
    x1: Math.ceil(Math.max(a[0], b[0])),
    y1: Math.ceil(Math.max(a[1], b[1]))
  }
}

function clampRegion(rendered, rect) {
  const { x0, y0, x1, y1 } = pdfRectToPixels(rendered.viewport, rect)
  return {
    x0: Math.max(0, x0),
    y0: Math.max(0, y0),
    x1: Math.min(rendered.image.width, x1),
    y1: Math.min(rendered.image.height, y1)
  }
}

/** 区域内满足 predicate(r,g,b,a)（各通道 0..1）的像素数 */
export function countPixels(rendered, rect, predicate) {
  const { image } = rendered
  const r = clampRegion(rendered, rect)
  let n = 0
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const i = (y * image.width + x) * 4
      if (predicate(image.data[i] / 255, image.data[i + 1] / 255, image.data[i + 2] / 255, image.data[i + 3] / 255)) {
        n++
      }
    }
  }
  return n
}

/** 区域平均色（0..1）+ 像素数；空白区域应接近 {1,1,1} */
export function meanColor(rendered, rect) {
  const { image } = rendered
  const r = clampRegion(rendered, rect)
  let sr = 0
  let sg = 0
  let sb = 0
  let n = 0
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const i = (y * image.width + x) * 4
      sr += image.data[i]
      sg += image.data[i + 1]
      sb += image.data[i + 2]
      n++
    }
  }
  if (n === 0) return { r: 0, g: 0, b: 0, pixels: 0 }
  return { r: sr / n / 255, g: sg / n / 255, b: sb / n / 255, pixels: n }
}

/** 与白色的最大通道差超阈值即视为墨迹 */
export const isInk = (r, g, b, tol = 0.35) => Math.max(1 - r, 1 - g, 1 - b) > tol

/** 红色主导（判据写死，便于跨脚本复现）：r>0.55 且 g<0.45 且 b<0.45 */
export const isRed = (r, g, b) => r > 0.55 && g < 0.45 && b < 0.45

/** 区域墨迹像素数 */
export function inkCount(rendered, rect, tol = 0.35) {
  return countPixels(rendered, rect, (r, g, b) => isInk(r, g, b, tol))
}

/**
 * 区域内墨迹的包围盒（换算回 PDF pt）+ 墨迹像素数。
 * bbox 用"像素盒四角反投影"得到，避免逐像素做矩阵变换。
 */
export function inkBBox(rendered, rect, tol = 0.35) {
  const { image, viewport } = rendered
  const r = clampRegion(rendered, rect)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let n = 0
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const i = (y * image.width + x) * 4
      if (!isInk(image.data[i] / 255, image.data[i + 1] / 255, image.data[i + 2] / 255, tol)) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      n++
    }
  }
  if (n === 0) return { bbox: null, ink: 0 }
  // 像素 (minX, maxY+1) 是设备坐标下的左下角；像素 (maxX+1, minY) 是右上角
  const bottomLeft = viewport.convertToPdfPoint(minX, maxY + 1)
  const topRight = viewport.convertToPdfPoint(maxX + 1, minY)
  const x = Math.min(bottomLeft[0], topRight[0])
  const y = Math.min(bottomLeft[1], topRight[1])
  return {
    bbox: {
      x,
      y,
      width: Math.abs(topRight[0] - bottomLeft[0]),
      height: Math.abs(topRight[1] - bottomLeft[1])
    },
    ink: n
  }
}

/** 区域内的红色主导像素数；空白/黑字区域应接近 0 */
export function redInkCount(rendered, rect) {
  return countPixels(rendered, rect, isRed)
}

/** 严格位于给定 PDF 基线下方那条带内的墨迹像素数（用于证明下划线出现） */
export function subBaselineInkCount(rendered, rect, baselinePdf, tol = 0.35) {
  const bandHeight = baselinePdf - rect.y
  if (!(bandHeight > 0)) return 0
  return inkCount(rendered, { x: rect.x, y: rect.y, width: rect.width, height: bandHeight }, tol)
}

/** 取某页 /Font 资源里的 BaseFont 名（矢量路径换字体族的直接证据） */
export async function pageBaseFonts(bytes, pageNo1) {
  const doc = await PDFDocument.load(bytes)
  const page = doc.getPage(pageNo1 - 1)
  const res = page.node.Resources()
  if (!res) return []
  const fonts = res.lookup(PDFName.of('Font'), PDFDict)
  if (!fonts) return []
  const out = []
  for (const [, ref] of fonts.entries()) {
    const f = doc.context.lookup(ref, PDFDict)
    if (!f) continue
    const bf = f.get(PDFName.of('BaseFont'))
    if (bf) out.push(String(bf).replace(/^\//, ''))
  }
  return out.sort()
}

/** 页面文本层（pdf.js getTextContent 拼起来），用于"注解不改文字层"的断言 */
export async function pageText(bytes, pageNo1) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), ...PDFJS_KW })
  const doc = await task.promise
  try {
    const page = await doc.getPage(pageNo1)
    const content = await page.getTextContent()
    return content.items.filter((x) => 'str' in x).map((x) => x.str).join('')
  } finally {
    await task.destroy()
  }
}

/** 页面文本项的几何（PDF 用户坐标）：x / baseline / fontSize / width */
export async function textGeometry(bytes, pageNo1) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), ...PDFJS_KW })
  const doc = await task.promise
  try {
    const page = await doc.getPage(pageNo1)
    const content = await page.getTextContent()
    return content.items
      .filter((x) => 'str' in x)
      .map((x) => ({
        str: x.str,
        x: x.transform[4],
        baseline: x.transform[5],
        fontSize: Math.hypot(x.transform[2], x.transform[3]),
        width: x.width
      }))
  } finally {
    await task.destroy()
  }
}

export { ROOT }
