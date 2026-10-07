/**
 * 【自动生成，勿手改】由 tests/pdf-audit/qa/qa-gen-tools.mjs 从
 * src/renderer/src/pages/PdfTools.tsx 原样抽取。函数体与产品代码逐字节一致。
 */
import { PDFDocument, degrees, rgb, StandardFonts } from 'pdf-lib'
import { renderPdfPages } from './qa-render.mjs'
import { enhanceImageData, analyze, STRENGTH_PRESETS } from '../../../src/renderer/src/utils/pdfEnhance.ts'
import {
  createStampContext,
  parsePageRanges,
  expandPlaceholders,
  stampWatermarkTile,
  stampTextAtCenter,
  stampTextAuto
} from '../../../src/renderer/src/utils/pdfText.ts'

/* 类型占位：strip-types 只剥离语法、不解析类型，故 any 即可 */
type EnhanceStat = any
type EnhanceStrength = 'light' | 'medium' | 'strong'
type TextRenderMode = any
type TextStyle = any
type TextAlign = any
type Rgb = any
type StampKind = any
type WatermarkLayout = any
type StampOptions = any
type StampResult = any
type ImageStats = any

/* ==================== 以下为原样抽取 ==================== */

async function enhancePdf(
  bytes: Uint8Array,
  strength: EnhanceStrength,
  format: 'jpeg' | 'png',
  onProgress?: (done: number, total: number, stat: EnhanceStat) => void
): Promise<{ out: Uint8Array; stats: EnhanceStat[] }> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const n = src.getPageCount()
  const out = await PDFDocument.create()
  // 保留文档级信息（旧实现会静默清空，属数据丢失）
  out.setTitle(src.getTitle() ?? '')
  out.setAuthor(src.getAuthor() ?? '')
  out.setSubject(src.getSubject() ?? '')
  out.setKeywords([...(src.getKeywords() ?? '')].length ? (src.getKeywords() as string).split(' ') : [])
  // 只设 Creator：Producer 表示「生成该 PDF 的工具」，本工具并未参与生成，
  // 强行写入会误导下游（如扫码枪/审计系统）对文件来源的判断。
  out.setCreator('LingmoWorkbench')

  const preset = STRENGTH_PRESETS[strength]
  // 三档使用同一栅格化倍率与同一上限：让"强度"只由色调映射激进度决定，
  // 避免分辨率差异污染对比度/灰雾等度量（详见 STRENGTH_PRESETS 注释）。
  const maxSide = 2200
  const stats: EnhanceStat[] = []

  for (let i = 0; i < n; i++) {
    const originalSize = src.getPage(i).getSize()
    const [render] = await renderPdfPages(bytes, [i], { scale: preset.renderScale, maxSide })
    if (!render) continue
    const canvas = render.canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) continue
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const before = analyze(img.data)
    const { auto, whitenThreshold, whitenApplied } = enhanceImageData(
      img.data,
      canvas.width,
      canvas.height,
      strength
    )
    ctx.putImageData(img, 0, 0)
    const after = analyze(img.data)
    const stat: EnhanceStat = {
      page: i + 1,
      before,
      after,
      blackPoint: auto.blackPoint,
      whitePoint: auto.whitePoint,
      whitenThreshold,
      whitenApplied
    }
    stats.push(stat)

    const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png'
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('图像编码失败'))), mime, 0.92)
    )
    const imgBytes = new Uint8Array(await blob.arrayBuffer())
    const embedded = format === 'jpeg' ? await out.embedJpg(imgBytes) : await out.embedPng(imgBytes)
    // 关键：按源页面点尺寸建页，保证物理尺寸不变
    const page = out.addPage([originalSize.width, originalSize.height])
    page.drawImage(embedded, { x: 0, y: 0, width: originalSize.width, height: originalSize.height })

    // 逐页释放画布，避免整本 PDF 的画布同时驻留内存
    canvas.width = 0
    canvas.height = 0
    onProgress?.(i + 1, n, stat)
  }
  return { out: await out.save({ useObjectStreams: true }), stats }
}

async function applyTextStamp(bytes: Uint8Array, o: StampOptions): Promise<StampResult> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const total = doc.getPageCount()
  const pages = parsePageRanges(o.range, total)
  const ctx = createStampContext(doc)
  const modes = new Set<TextRenderMode>()

  for (const pageNo of pages) {
    const page = doc.getPage(pageNo - 1)
    const { width, height } = page.getSize()
    const text = expandPlaceholders(o.text, pageNo, total)
    if (!text) continue
    const style: TextStyle = {
      fontSize: o.fontSize,
      color: o.color,
      opacity: o.opacity,
      rotate: o.kind === 'watermark' ? o.rotate : 0
    }

    if (o.kind === 'watermark') {
      if (o.layout === 'tile') {
        modes.add(await stampWatermarkTile(ctx, page, text, style))
      } else if (o.layout === 'diagonal') {
        // 沿对角线铺开：可用宽度取页面对角线的 85%，保证不超出页面
        const diag = Math.sqrt(width * width + height * height)
        const res = await stampTextAtCenter(ctx, page, text, width / 2, height / 2, style, diag * 0.85)
        modes.add(res.mode)
      } else {
        const res = await stampTextAtCenter(ctx, page, text, width / 2, height / 2, style, width * 0.9)
        modes.add(res.mode)
      }
      continue
    }

    // 页眉 / 页脚：基线位置留出字高的余量，避免贴边被裁
    const lift = o.fontSize * 1.25
    const y = o.kind === 'header' ? height - o.margin - lift : o.margin
    const x = o.align === 'left' ? o.margin : o.align === 'right' ? width - o.margin : width / 2
    const res = await stampTextAuto(
      ctx,
      page,
      text,
      { x, y, align: o.align, maxWidth: width - o.margin * 2 },
      style
    )
    modes.add(res.mode)
  }

  return { out: await doc.save({ useObjectStreams: true }), pages, modes: [...modes], total }
}

export { enhancePdf, applyTextStamp }
