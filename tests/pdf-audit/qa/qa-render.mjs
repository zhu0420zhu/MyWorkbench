/**
 * QA 渲染适配层：把 src/renderer/src/utils/pdfRender.ts 的 renderPdfPages 语义
 * 落到 Node 无头环境（pdf.js + @napi-rs/canvas / Skia 后端）。
 *
 * 为什么需要它：pdfRender.ts 顶部有 `import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'`
 * —— 那是 Vite 专有的 worker 导入，Node 无法解析。产品代码本身不可改，
 * 故这里用【等价实现】替换「渲染」这一步：同样的 getDocument 参数、同样的
 * getViewport({scale}) + maxSide 缩放 + page.render，只是把 canvas 换成 Skia。
 * 其余（enhancePdf 编排、pdfEnhance 算法、pdfText 排版）都是真实产品代码。
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createCanvas } from '@napi-rs/canvas'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PDFJS_ROOT = join(HERE, '..', '..', '..', 'node_modules', 'pdfjs-dist')

export const PDFJS_OPTS = {
  isEvalSupported: false,
  disableFontFace: true,
  standardFontDataUrl: join(PDFJS_ROOT, 'standard_fonts') + '/',
  cMapUrl: join(PDFJS_ROOT, 'cmaps') + '/',
  cMapPacked: true
}

export async function getDoc(data, password) {
  return pdfjs.getDocument({ data: new Uint8Array(data), password, ...PDFJS_OPTS }).promise
}

/** 与 pdfRender.renderPdfPages 等价（唯一差别：canvas 后端） */
export async function renderPdfPages(data, pageIndices, opts = {}) {
  const doc = await getDoc(data)
  const out = []
  const scale = opts.scale ?? 2
  for (const idx of pageIndices) {
    if (idx < 0 || idx >= doc.numPages) continue
    const page = await doc.getPage(idx + 1)
    const viewport = page.getViewport({ scale })
    let sx = viewport.width
    let sy = viewport.height
    if (opts.maxSide && Math.max(sx, sy) > opts.maxSide) {
      const k = opts.maxSide / Math.max(sx, sy)
      sx *= k
      sy *= k
    }
    const canvas = createCanvas(Math.round(sx), Math.round(sy))
    const ctx = canvas.getContext('2d')
    if (!ctx) continue
    const vp = page.getViewport({ scale: (scale * canvas.width) / viewport.width })
    await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise
    out.push({ pageIndex: idx, canvas })
  }
  return out
}

/** 渲染单页成像素数据（供独立比对），返回 {data,w,h} */
export async function renderPagePixels(data, pageIndex, scale = 1.5, password) {
  const doc = await getDoc(data, password)
  const page = await doc.getPage(pageIndex + 1)
  const vp = page.getViewport({ scale })
  const canvas = createCanvas(Math.round(vp.width), Math.round(vp.height))
  const ctx = canvas.getContext('2d')
  await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return { data: img.data, w: canvas.width, h: canvas.height }
}

export function pageCount(data, password) {
  return getDoc(data, password).then((d) => d.numPages)
}

export async function extractText(data, password) {
  const doc = await getDoc(data, password)
  let out = ''
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const c = await page.getTextContent()
    out += c.items.map((it) => ('str' in it ? it.str : '')).join('')
  }
  return out
}

export async function extractTextPages(data, password) {
  const doc = await getDoc(data, password)
  const out = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const c = await page.getTextContent()
    out.push(c.items.map((it) => ('str' in it ? it.str : '')).join(''))
  }
  return out
}

/** 把 canvas 存成 PNG（返回落盘用字节） */
export function canvasToPng(canvas) {
  return canvas.encodeSync('png')
}

export { createCanvas }
