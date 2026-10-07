/**
 * 「PDF → 逐页渲染成图 → OCR」的提取链路。
 *
 * 背景（审计 P3#9）：提取面板遇到无文本层的扫描件只会提示「请使用 OCR」把用户推出门，
 * 而项目里 PP-OCR 管线（utils/ppocr.ts）是现成的，TextTools 已在用。
 * 本模块把两端接上：渲染（pdf.js）→ 白底合成 → 逐页 recognizeImage →
 * 映射成与文本提取相同的 PdfTextPage 结构 → 复用同一条 markdown 输出路径。
 *
 * 本模块不含 DOM 之外的环境假设：`render` 与 `recognize` 由调用方注入
 * （浏览器传 renderPdfPages + recognizeImage；无头验收注入 node canvas 等价实现），
 * 因此整条链路可以被真实驱动做端到端取证。
 */
import type { OcrLineResult } from '@shared/types'
import type { PdfPageRender } from './pdfRender'
import type { PdfTextPage } from './pdfMarkdown'

export type OcrRenderFn = (
  data: Uint8Array,
  pageIndices: number[],
  opts?: { scale?: number; maxSide?: number }
) => Promise<PdfPageRender[]>

export type OcrRecognizeFn = (
  dataUrl: string,
  onProgress?: (stage: string) => void
) => Promise<OcrLineResult[]>

/**
 * OCR 渲染倍率：scale 2（A4 595pt → 1190px，正文 12~14pt 约 24~28px 高），
 * 长边上限 2200 与增强面板一致。
 * 理由：det 内部把长边压到 640 做检测、但 rec 从**原图**裁块再放大到 48px 高——
 * 低于 1.5 倍时小字在原图上就不足 20px，识别率明显下降；再高只是变慢，收益趋平。
 */
export const OCR_RENDER_OPTS = { scale: 2, maxSide: 2200 }

/** 单页进度：第 page/total 页 + recognizeImage 的阶段回调 */
export interface OcrPageProgress {
  page: number
  total: number
  stage: string
}

export interface OcrExtractResult {
  /** 与 extractPdfText 同构（复用 pagesToMarkdown 输出路径） */
  pages: PdfTextPage[]
  /** 识别出的总行数 */
  lineCount: number
  /** 平均识别置信度（0~1），供 UI 如实回显 */
  avgScore: number
}

/**
 * 白底合成不变式：保证交给 OCR/JPEG 的画布**不透明且底色为白**。
 *
 * 实测（tests/pdf-audit/probe-ocr 探针 + node 侧 alpha 探针）：pdfjs-dist 6.3.289
 * 在 Chromium 与 node canvas 下都默认填充不透明白底（透明像素 0）。但这一行为是
 * pdf.js 的实现细节（旧版本默认透明、`background` 参数也可改）——一旦变成透明渲染，
 * 透明像素在 JPEG 编码 / OCR 预处理里等效纯黑，整页会变成黑图。这里显式合成白底，
 * 把「输入必须是不透明白底」变成不依赖上游默认值的不变式。
 */
export function matteWhite(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = canvas.width
  out.height = canvas.height
  const ctx = out.getContext('2d')
  if (!ctx) return canvas
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.drawImage(canvas, 0, 0)
  return out
}

/**
 * 逐页 OCR。进度回调带「第几页 / 共几页 + 阶段」；
 * 首次调用会触发模型加载（det/rec/cls 三个会话），UI 必须提前说明这一点。
 */
export async function ocrExtractPages(
  bytes: Uint8Array,
  pageIndices: number[],
  deps: { render: OcrRenderFn; recognize: OcrRecognizeFn },
  onProgress?: (p: OcrPageProgress) => void
): Promise<OcrExtractResult> {
  const pages: PdfTextPage[] = []
  let lineCount = 0
  let scoreSum = 0
  for (let i = 0; i < pageIndices.length; i++) {
    const idx = pageIndices[i]
    const [p] = await deps.render(bytes, [idx], OCR_RENDER_OPTS)
    if (!p) {
      pages.push({ pageIndex: idx, lines: [] })
      onProgress?.({ page: i + 1, total: pageIndices.length, stage: '本页渲染失败，已跳过' })
      continue
    }
    const dataUrl = matteWhite(p.canvas).toDataURL('image/png')
    const lines = await deps.recognize(dataUrl, (stage) =>
      onProgress?.({ page: i + 1, total: pageIndices.length, stage })
    )
    pages.push({ pageIndex: idx, lines: lines.map((l) => l.text) })
    lineCount += lines.length
    scoreSum += lines.reduce((s, l) => s + l.score, 0)
  }
  return {
    pages,
    lineCount,
    avgScore: lineCount > 0 ? scoreSum / lineCount : 0
  }
}
