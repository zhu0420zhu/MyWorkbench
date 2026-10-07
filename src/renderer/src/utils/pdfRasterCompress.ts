/**
 * 图像化压缩的档位定义（无 DOM 依赖，可在无头环境下验收）。
 *
 * 修复的缺陷：同一「压缩」面板里，两种模式的「低/中/高」方向是反的 ——
 *   结构压缩：低 = 压得最轻、高 = 压得最狠；
 *   图像化压缩（旧）：低 = scale 1.0 / JPEG 55%（压得最狠），高 = 2.0 / 85%（压得最轻）。
 * 用户按同一面板的直觉选「低」，在两种模式下会拿到完全相反的结果。
 *
 * 现统一为**压缩强度**语义：低 → 高，压得越来越狠。且档位提示文案由 preset
 * 数值直接生成（不是手写死字符串），从结构上保证「文案承诺 == 实际参数」。
 *
 * 兜底策略与结构压缩共用 `keepSmallerOutput`（见 pdfCompress.ts）：任一档产出
 * 不小于原文件时保留原文件，绝不输出更大的文件。
 */
import { PDFDocument } from 'pdf-lib'
import { keepSmallerOutput } from './pdfCompress'
import { matteWhite } from './pdfOcrExtract'
import type { PdfPageRender } from './pdfRender'

export type RasterQuality = 'low' | 'medium' | 'high'

/** 渲染依赖：与 utils/pdfRender.renderPdfPages 同签名（仅用类型，不引入运行时依赖） */
export type RenderPdfPages = (
  data: Uint8Array,
  pageIndices: number[],
  opts?: { scale?: number; maxSide?: number }
) => Promise<PdfPageRender[]>

export interface RasterPreset {
  /** 栅格化倍率 */
  scale: number
  /** JPEG 编码质量 0~1 */
  jpeg: number
  /** 长边像素上限 */
  maxSide: number
  /** 本档结果的直白命名（按「拿到的结果」而非「压缩强度」描述） */
  result: string
}

export const RASTER_LEVEL_NAMES: Record<RasterQuality, string> = {
  low: '低',
  medium: '中',
  high: '高'
}

export const RASTER_PRESETS: Record<RasterQuality, RasterPreset> = {
  low: { scale: 2.0, jpeg: 0.85, maxSide: 2560, result: '高画质（体积最大）' },
  medium: { scale: 1.4, jpeg: 0.72, maxSide: 1920, result: '均衡（画质与体积折中）' },
  high: { scale: 1.0, jpeg: 0.55, maxSide: 1280, result: '最小体积（画质最低）' }
}

/** 档位提示：由 preset 数值生成，保证与实现一致 */
export function rasterLevelHint(quality: RasterQuality): string {
  const p = RASTER_PRESETS[quality]
  return (
    `压缩强度「${RASTER_LEVEL_NAMES[quality]}」= ${p.result}：` +
    `栅格化 ${p.scale} 倍（长边上限 ${p.maxSide}px）+ JPEG 质量 ${Math.round(p.jpeg * 100)}%。`
  )
}

/** 压缩强度递增的档位顺序（低 < 中 < 高），供 UI 与验收共用 */
export const RASTER_LEVELS: RasterQuality[] = ['low', 'medium', 'high']

/**
 * 图像化重采样压缩：按页渲染为 JPEG 再重建 PDF。
 *
 * `render` 是唯一的环境依赖（浏览器里是 utils/pdfRender.renderPdfPages，走 Chromium canvas；
 * 无头验收时注入 pdf.js + node canvas 的等价实现）。这样这条链路本身可以被真实驱动，
 * 而不是只能靠「看着像」来判断。返回值沿用两模式共用的兜底政策：不输出更大的文件。
 */
export async function rasterCompressPdf(
  bytes: Uint8Array,
  quality: RasterQuality,
  render: RenderPdfPages
): Promise<{ bytes: Uint8Array; keptOriginal: boolean }> {
  const preset = RASTER_PRESETS[quality]
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const n = src.getPageCount()
  const out = await PDFDocument.create()
  // 逐页渲染→JPEG→嵌入→丢弃 canvas，避免整本 PDF 画布同时驻留内存
  for (let i = 0; i < n; i++) {
    const [p] = await render(bytes, [i], { scale: preset.scale, maxSide: preset.maxSide })
    if (!p) continue
    // 白底合成不变式：透明像素在 JPEG 编码里等效纯黑（若上游改为透明渲染，
    // 文字页会压成黑页）。pdfjs 6.3.289 当前默认填充不透明白，此处保证不依赖该默认值。
    const blob = await new Promise<Blob>((resolve, reject) =>
      matteWhite(p.canvas).toBlob(
        (b) => (b ? resolve(b) : reject(new Error('JPEG 编码失败'))),
        'image/jpeg',
        preset.jpeg
      )
    )
    const jpeg = new Uint8Array(await blob.arrayBuffer())
    const img = await out.embedJpg(jpeg)
    // 沿用「画布像素即页面点尺寸」的既有换算（增强面板另有按原始点尺寸建页的路径）
    const page = out.addPage([p.canvas.width, p.canvas.height])
    page.drawImage(img, { x: 0, y: 0, width: p.canvas.width, height: p.canvas.height })
    // 释放画布内存
    p.canvas.width = 0
    p.canvas.height = 0
  }
  const produced = await out.save({ useObjectStreams: true })
  // 与结构压缩共用同一条兜底政策：不输出比原文件更大的结果
  return keepSmallerOutput(bytes, produced)
}
