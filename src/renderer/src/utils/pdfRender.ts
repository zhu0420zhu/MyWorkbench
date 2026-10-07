/* pdf.js 渲染与文本提取：PDF 转图 / 文本→Markdown */
import * as pdfjs from 'pdfjs-dist'
// 走本地 worker，避免外网 CDN
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'

/** worker 惰性初始化 + 兜底：打包环境下 ?worker 偶发失效时退回主线程解析 */
let workerReady = false
function ensureWorker(): void {
  if (workerReady) return
  workerReady = true
  try {
    pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker()
  } catch {
    // 兜底：不设 workerPort，pdf.js 走 fake worker（慢但可用）
  }
}

export interface PdfPageRender {
  pageIndex: number
  canvas: HTMLCanvasElement
}

/** 渲染指定页到 canvas（devicePixelRatio 可控清晰度） */
export async function renderPdfPages(
  data: Uint8Array,
  pageIndices: number[],
  opts: { scale?: number; maxSide?: number } = {}
): Promise<PdfPageRender[]> {
  ensureWorker()
  const doc = await pdfjs.getDocument({ data: data.slice(0) }).promise
  const out: PdfPageRender[] = []
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
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(sx)
    canvas.height = Math.round(sy)
    const ctx = canvas.getContext('2d')
    if (!ctx) continue
    const vp = page.getViewport({ scale: (scale * canvas.width) / viewport.width })
    await page.render({ canvas, canvasContext: ctx, viewport: vp } as Parameters<typeof page.render>[0]).promise
    out.push({ pageIndex: idx, canvas })
  }
  ;(doc as unknown as { destroy?: () => Promise<void> }).destroy?.()
  return out
}

/** 打开 PDF 文档对象（供需要 viewport 坐标换算的场景使用，如保版式改字的叠加层定位） */
export async function openPdfDocument(data: Uint8Array): Promise<pdfjs.PDFDocumentProxy> {
  ensureWorker()
  return pdfjs.getDocument({ data: data.slice(0) }).promise
}

/** 多页竖向拼成长图 */
export function stackCanvasesVertically(pages: PdfPageRender[]): HTMLCanvasElement {
  if (!pages.length) return document.createElement('canvas')
  const width = Math.max(...pages.map((p) => p.canvas.width))
  const height = pages.reduce((s, p) => s + p.canvas.height, 0)
  const out = document.createElement('canvas')
  out.width = width
  out.height = height
  const ctx = out.getContext('2d')
  if (!ctx) return out
  let y = 0
  for (const p of pages) {
    ctx.drawImage(p.canvas, Math.floor((width - p.canvas.width) / 2), y)
    y += p.canvas.height
  }
  return out
}

export async function extractPdfText(data: Uint8Array): Promise<PdfTextPage[]> {
  ensureWorker()
  const doc = await pdfjs.getDocument({ data: data.slice(0) }).promise
  const pages: PdfTextPage[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    // 按 y 聚合成行
    type Item = { str: string; x: number; y: number; h: number }
    const items: Item[] = []
    for (const it of content.items) {
      const t = it as { str?: string; transform?: number[]; width?: number; height?: number }
      if (!t.str) continue
      const tr = t.transform || [1, 0, 0, 1, 0, 0]
      items.push({ str: t.str, x: tr[4], y: tr[5], h: t.height || 10 })
    }
    items.sort((a, b) => b.y - a.y || a.x - b.x)
    const lines: string[] = []
    let curY = Number.NaN
    let cur: string[] = []
    const yTol = 3
    for (const it of items) {
      if (!Number.isFinite(curY) || Math.abs(it.y - curY) <= yTol) {
        cur.push(it.str)
        if (!Number.isFinite(curY)) curY = it.y
      } else {
        lines.push(cur.join('').trim())
        cur = [it.str]
        curY = it.y
      }
    }
    if (cur.length) lines.push(cur.join('').trim())
    pages.push({
      pageIndex: i - 1,
      lines: lines.filter((l) => l.length > 0)
    })
  }
  ;(doc as unknown as { destroy?: () => Promise<void> }).destroy?.()
  return pages
}

/* PdfTextPage 与 pagesToMarkdown 移至 utils/pdfMarkdown.ts（不依赖 pdf.js），
 * 这里原地 re-export，既有导入方（PdfTools 等）不变。extractPdfText 仍返回 PdfTextPage。 */
import type { PdfTextPage } from './pdfMarkdown'
export { pagesToMarkdown, type PdfTextPage } from './pdfMarkdown'
