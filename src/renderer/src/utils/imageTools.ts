/* 图片工具核心：裁剪 / 背景移除 / 颜色替换 / 转换压缩 / 拼接 / 图标 —— 全部本地 Canvas 计算 */

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'bmp' | 'gif'

export interface LoadedImage {
  name: string
  width: number
  height: number
  size: number
  canvas: HTMLCanvasElement
}

export function loadImageFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error(`无法读取 ${file.name}`))
    }
    img.src = url
  })
}

export function imageToCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth || img.width
  canvas.height = img.naturalHeight || img.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('canvas 不可用')
  ctx.drawImage(img, 0, 0)
  return canvas
}

export async function loadImages(files: File[]): Promise<LoadedImage[]> {
  const out: LoadedImage[] = []
  for (const f of files) {
    try {
      const img = await loadImageFile(f)
      const canvas = imageToCanvas(img)
      out.push({ name: f.name, width: canvas.width, height: canvas.height, size: f.size, canvas })
    } catch {
      /* skip unreadable */
    }
  }
  return out
}

export function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = src.width
  c.height = src.height
  const ctx = c.getContext('2d')
  if (ctx) ctx.drawImage(src, 0, 0)
  return c
}

export async function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = 'image/png',
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b)
      else reject(new Error('导出失败'))
    }, type, quality)
  })
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`
  return `${bytes} B`
}

/* ---------- 裁剪 ---------- */

export type CropAspect = 'free' | '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3'

export const CROP_ASPECTS: Array<{ label: string; value: CropAspect; ratio?: number }> = [
  { label: '自由', value: 'free' },
  { label: '1:1', value: '1:1', ratio: 1 },
  { label: '4:3', value: '4:3', ratio: 4 / 3 },
  { label: '3:4', value: '3:4', ratio: 3 / 4 },
  { label: '16:9', value: '16:9', ratio: 16 / 9 },
  { label: '9:16', value: '9:16', ratio: 9 / 16 },
  { label: '3:2', value: '3:2', ratio: 3 / 2 },
  { label: '2:3', value: '2:3', ratio: 2 / 3 }
]

export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

export function cropCanvas(src: HTMLCanvasElement, rect: CropRect): HTMLCanvasElement {
  const x = Math.max(0, Math.round(rect.x))
  const y = Math.max(0, Math.round(rect.y))
  const w = Math.min(src.width - x, Math.round(rect.w))
  const h = Math.min(src.height - y, Math.round(rect.h))
  const out = document.createElement('canvas')
  out.width = Math.max(1, w)
  out.height = Math.max(1, h)
  const ctx = out.getContext('2d')
  if (ctx) ctx.drawImage(src, x, y, w, h, 0, 0, out.width, out.height)
  return out
}

export function fitAspectCrop(
  srcW: number,
  srcH: number,
  aspect: CropAspect
): CropRect {
  const def = CROP_ASPECTS.find((a) => a.value === aspect)
  if (!def?.ratio) return { x: 0, y: 0, w: srcW, h: srcH }
  const ratio = def.ratio
  let w = srcW
  let h = srcW / ratio
  if (h > srcH) {
    h = srcH
    w = srcH * ratio
  }
  return {
    x: Math.round((srcW - w) / 2),
    y: Math.round((srcH - h) / 2),
    w: Math.round(w),
    h: Math.round(h)
  }
}

/* ---------- 背景移除（颜色聚类 + 边缘羽化） ---------- */

export interface BgRemoveOptions {
  /** 采样点（0~1 归一化坐标），默认四角+四边中点 */
  samples?: Array<{ x: number; y: number }>
  /** 颜色容差 0~100 */
  tolerance: number
  /** 边缘羽化半径 0~8 */
  feather: number
  /** 是否保留最大连通前景 */
  keepLargest?: boolean
}

function colorDist(
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number
): number {
  // 感知加权距离
  const dr = r1 - r2
  const dg = g1 - g2
  const db = b1 - b2
  return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db)
}

export function removeBackground(src: HTMLCanvasElement, opts: BgRemoveOptions): HTMLCanvasElement {
  const w = src.width
  const h = src.height
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const sctx = src.getContext('2d', { willReadFrequently: true })
  const octx = out.getContext('2d')
  if (!sctx || !octx) return out

  const imageData = sctx.getImageData(0, 0, w, h)
  const data = imageData.data
  const alpha = new Uint8ClampedArray(w * h)

  const samples = opts.samples?.length
    ? opts.samples
    : [
        { x: 0.02, y: 0.02 }, { x: 0.98, y: 0.02 },
        { x: 0.02, y: 0.98 }, { x: 0.98, y: 0.98 },
        { x: 0.5, y: 0.02 }, { x: 0.5, y: 0.98 },
        { x: 0.02, y: 0.5 }, { x: 0.98, y: 0.5 }
      ]

  const bgColors: Array<[number, number, number]> = []
  for (const s of samples) {
    const px = Math.min(w - 1, Math.max(0, Math.round(s.x * (w - 1))))
    const py = Math.min(h - 1, Math.max(0, Math.round(s.y * (h - 1))))
    const i = (py * w + px) * 4
    bgColors.push([data[i], data[i + 1], data[i + 2]])
  }

  // 阈值：tolerance 0~100 → 距离 0~120
  const threshold = 20 + (opts.tolerance / 100) * 160

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      let minD = Infinity
      for (const bg of bgColors) {
        const d = colorDist(r, g, b, bg[0], bg[1], bg[2])
        if (d < minD) minD = d
        if (minD < threshold * 0.5) break
      }
      // 软过渡：阈值内透明，阈值边缘半透明
      const t = threshold
      if (minD < t * 0.65) {
        alpha[y * w + x] = 0
      } else if (minD < t) {
        alpha[y * w + x] = Math.round(((minD - t * 0.65) / (t * 0.35)) * 255)
      } else {
        alpha[y * w + x] = 255
      }
    }
  }

  // 仅保留最大连通前景（去掉背景中的杂点）
  if (opts.keepLargest !== false) {
    const labels = new Int32Array(w * h)
    let label = 0
    const stack: number[] = []
    let bestLabel = 0
    let bestSize = 0
    const sizes: number[] = [0]

    for (let i = 0; i < w * h; i++) {
      if (labels[i] || alpha[i] < 40) continue
      label++
      let size = 0
      stack.length = 0
      stack.push(i)
      labels[i] = label
      while (stack.length) {
        const cur = stack.pop()!
        size++
        const cx = cur % w
        const cy = (cur / w) | 0
        const neighbors = [cur - 1, cur + 1, cur - w, cur + w]
        const xs = [cx - 1, cx + 1, cx, cx]
        const ys = [cy, cy, cy - 1, cy + 1]
        for (let n = 0; n < 4; n++) {
          const ni = neighbors[n]
          if (xs[n] < 0 || xs[n] >= w || ys[n] < 0 || ys[n] >= h) continue
          if (labels[ni] || alpha[ni] < 40) continue
          labels[ni] = label
          stack.push(ni)
        }
      }
      sizes.push(size)
      if (size > bestSize) {
        bestSize = size
        bestLabel = label
      }
    }
    if (bestLabel > 0) {
      for (let i = 0; i < w * h; i++) {
        if (labels[i] !== bestLabel) alpha[i] = 0
      }
    }
  }

  // 边缘羽化：对 alpha 做 box blur
  const feather = Math.max(0, Math.round(opts.feather ?? 1))
  let finalAlpha: Uint8ClampedArray = alpha
  if (feather > 0) {
    finalAlpha = boxBlurAlpha(alpha, w, h, feather)
  }

  const outData = octx.createImageData(w, h)
  const od = outData.data
  for (let i = 0; i < w * h; i++) {
    od[i * 4] = data[i * 4]
    od[i * 4 + 1] = data[i * 4 + 1]
    od[i * 4 + 2] = data[i * 4 + 2]
    od[i * 4 + 3] = finalAlpha[i]
  }
  octx.putImageData(outData, 0, 0)
  return out
}

function boxBlurAlpha(src: Uint8ClampedArray, w: number, h: number, r: number): Uint8ClampedArray {
  const tmp = new Uint8ClampedArray(w * h)
  const out = new Uint8ClampedArray(w * h)
  const win = r * 2 + 1
  // horizontal
  for (let y = 0; y < h; y++) {
    let sum = 0
    for (let x = -r; x <= r; x++) {
      const xx = Math.min(w - 1, Math.max(0, x))
      sum += src[y * w + xx]
    }
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = Math.round(sum / win)
      const add = Math.min(w - 1, x + r + 1)
      const rem = Math.max(0, x - r)
      sum += src[y * w + add] - src[y * w + rem]
    }
  }
  // vertical
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let y = -r; y <= r; y++) {
      const yy = Math.min(h - 1, Math.max(0, y))
      sum += tmp[yy * w + x]
    }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = Math.round(sum / win)
      const add = Math.min(h - 1, y + r + 1)
      const rem = Math.max(0, y - r)
      sum += tmp[add * w + x] - tmp[rem * w + x]
    }
  }
  return out
}

/* ---------- 智能颜色替换 ---------- */

export interface ColorReplaceOptions {
  /** 目标颜色（被替换） */
  from: [number, number, number]
  /** 替换颜色 */
  to: [number, number, number]
  /** 容差 0~100 */
  tolerance: number
  /** 仅替换连通区域（从取样点泛洪） */
  contiguous?: boolean
  /** 泛洪起点（像素坐标），contiguous 时必填 */
  seed?: { x: number; y: number }
  /** 边缘过渡 0~4 */
  softness: number
}

export function replaceColor(src: HTMLCanvasElement, opts: ColorReplaceOptions): HTMLCanvasElement {
  const w = src.width
  const h = src.height
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const sctx = src.getContext('2d', { willReadFrequently: true })
  const octx = out.getContext('2d')
  if (!sctx || !octx) return out

  const imageData = sctx.getImageData(0, 0, w, h)
  const data = imageData.data
  const threshold = 10 + (opts.tolerance / 100) * 140
  const [fr, fg, fb] = opts.from
  const [tr, tg, tb] = opts.to

  const matched = new Uint8ClampedArray(w * h)

  if (opts.contiguous && opts.seed) {
    const sx = Math.min(w - 1, Math.max(0, opts.seed.x))
    const sy = Math.min(h - 1, Math.max(0, opts.seed.y))
    const visited = new Uint8Array(w * h)
    const stack = [sy * w + sx]
    visited[sy * w + sx] = 1
    while (stack.length) {
      const cur = stack.pop()!
      const i = cur * 4
      const d = colorDist(data[i], data[i + 1], data[i + 2], fr, fg, fb)
      if (d > threshold) continue
      matched[cur] = 1
      const cx = cur % w
      const cy = (cur / w) | 0
      const neighbors = [cur - 1, cur + 1, cur - w, cur + w]
      const xs = [cx - 1, cx + 1, cx, cx]
      const ys = [cy, cy, cy - 1, cy + 1]
      for (let n = 0; n < 4; n++) {
        const ni = neighbors[n]
        if (xs[n] < 0 || xs[n] >= w || ys[n] < 0 || ys[n] >= h) continue
        if (visited[ni]) continue
        visited[ni] = 1
        stack.push(ni)
      }
    }
  } else {
    for (let i = 0; i < w * h; i++) {
      const j = i * 4
      const d = colorDist(data[j], data[j + 1], data[j + 2], fr, fg, fb)
      if (d <= threshold) matched[i] = 1
    }
  }

  const soft = Math.max(0, opts.softness ?? 1)
  if (soft > 0) {
    // 对 matched 做轻度模糊，形成自然边缘
    const blurred = boxBlurAlpha(matched, w, h, soft)
    for (let i = 0; i < w * h; i++) {
      const t = blurred[i] / 255
      const j = i * 4
      if (t <= 0.02) continue
      data[j] = Math.round(data[j] * (1 - t) + tr * t)
      data[j + 1] = Math.round(data[j + 1] * (1 - t) + tg * t)
      data[j + 2] = Math.round(data[j + 2] * (1 - t) + tb * t)
    }
  } else {
    for (let i = 0; i < w * h; i++) {
      if (!matched[i]) continue
      const j = i * 4
      data[j] = tr
      data[j + 1] = tg
      data[j + 2] = tb
    }
  }

  octx.putImageData(imageData, 0, 0)
  return out
}

/* ---------- 压缩 / 转换 ---------- */

export const QUALITY_PRESETS = {
  high: { quality: 0.92, maxSide: 0, label: '高画质' },
  medium: { quality: 0.78, maxSide: 2560, label: '中等' },
  low: { quality: 0.55, maxSide: 1600, label: '压缩' }
} as const

export type QualityPreset = keyof typeof QUALITY_PRESETS

export function resizeCanvas(src: HTMLCanvasElement, maxSide: number): HTMLCanvasElement {
  if (!maxSide || maxSide <= 0) return cloneCanvas(src)
  const scale = Math.min(1, maxSide / Math.max(src.width, src.height))
  if (scale >= 1) return cloneCanvas(src)
  const w = Math.max(1, Math.round(src.width * scale))
  const h = Math.max(1, Math.round(src.height * scale))
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d')
  if (ctx) {
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(src, 0, 0, w, h)
  }
  return out
}

export function mimeOf(format: ImageFormat | string): string {
  const f = format.replace(/^\./, '').toLowerCase()
  if (f === 'jpg' || f === 'jpeg') return 'image/jpeg'
  if (f === 'webp') return 'image/webp'
  if (f === 'gif') return 'image/gif'
  if (f === 'bmp') return 'image/bmp'
  return 'image/png'
}

export async function compressImage(
  src: HTMLCanvasElement,
  preset: QualityPreset,
  format: ImageFormat = 'jpeg'
): Promise<{ blob: Blob; width: number; height: number; size: number }> {
  const p = QUALITY_PRESETS[preset]
  const resized = p.maxSide ? resizeCanvas(src, p.maxSide) : src
  const blob = await canvasToBlob(resized, mimeOf(format), p.quality)
  return { blob, width: resized.width, height: resized.height, size: blob.size }
}

export async function convertImage(
  src: HTMLCanvasElement,
  format: ImageFormat,
  quality = 0.92
): Promise<Blob> {
  return canvasToBlob(src, mimeOf(format), format === 'png' ? undefined : quality)
}

/* ---------- 长图拼接 ---------- */

export type StitchDir = 'vertical' | 'horizontal'

export function stitchImages(
  images: HTMLCanvasElement[],
  dir: StitchDir,
  gap = 0,
  background: string | null = null
): HTMLCanvasElement {
  if (!images.length) return document.createElement('canvas')
  const g = Math.max(0, Math.round(gap))
  const out = document.createElement('canvas')
  if (dir === 'vertical') {
    out.width = Math.max(...images.map((i) => i.width))
    out.height = images.reduce((s, i) => s + i.height, 0) + g * (images.length - 1)
  } else {
    out.height = Math.max(...images.map((i) => i.height))
    out.width = images.reduce((s, i) => s + i.width, 0) + g * (images.length - 1)
  }
  const ctx = out.getContext('2d')
  if (!ctx) return out
  if (background) {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, out.width, out.height)
  }
  let offset = 0
  for (const img of images) {
    if (dir === 'vertical') {
      const x = Math.floor((out.width - img.width) / 2)
      ctx.drawImage(img, x, offset)
      offset += img.height + g
    } else {
      const y = Math.floor((out.height - img.height) / 2)
      ctx.drawImage(img, offset, y)
      offset += img.width + g
    }
  }
  return out
}

/* ---------- 图标生成 ---------- */

export const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512] as const

export function makeIconSet(
  src: HTMLCanvasElement,
  sizes: number[] = [...ICON_SIZES],
  options: { padRatio?: number; background?: string | null; radius?: number } = {}
): Array<{ name: string; size: number; canvas: HTMLCanvasElement }> {
  const pad = options.padRatio ?? 0.08
  const out: Array<{ name: string; size: number; canvas: HTMLCanvasElement }> = []
  for (const size of sizes) {
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) continue
    if (options.background) {
      ctx.fillStyle = options.background
      if (options.radius) {
        roundRect(ctx, 0, 0, size, size, options.radius)
        ctx.fill()
      } else {
        ctx.fillRect(0, 0, size, size)
      }
    }
    const inner = size * (1 - pad * 2)
    const scale = Math.min(inner / src.width, inner / src.height)
    const dw = src.width * scale
    const dh = src.height * scale
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(src, (size - dw) / 2, (size - dh) / 2, dw, dh)
    out.push({ name: `icon-${size}x${size}.png`, size, canvas })
  }
  return out
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** 将多张 canvas 打包为 zip（store 模式，无额外依赖） */
export async function packCanvasesToZip(
  items: Array<{ name: string; canvas: HTMLCanvasElement }>
): Promise<Blob> {
  const files: Array<{ name: string; data: Uint8Array }> = []
  for (const item of items) {
    const blob = await canvasToBlob(item.canvas, 'image/png')
    const buf = new Uint8Array(await blob.arrayBuffer())
    files.push({ name: item.name, data: buf })
  }
  return zipStore(files)
}

/** 最小 ZIP（store，无压缩）——足够打包 PNG 图标 */
export function zipStore(files: Array<{ name: string; data: Uint8Array }>): Blob {
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  const encoder = new TextEncoder()
  const crcTable = makeCrcTable()

  for (const f of files) {
    const nameBytes = encoder.encode(f.name)
    const crc = crc32(f.data, crcTable)
    const local = new Uint8Array(30 + nameBytes.length)
    const dv = new DataView(local.buffer)
    dv.setUint32(0, 0x04034b50, true)
    dv.setUint16(4, 20, true)
    dv.setUint16(6, 0, true)
    dv.setUint16(8, 0, true) // store
    dv.setUint16(10, 0, true)
    dv.setUint16(12, 0, true)
    dv.setUint32(14, crc, true)
    dv.setUint32(18, f.data.length, true)
    dv.setUint32(22, f.data.length, true)
    dv.setUint16(26, nameBytes.length, true)
    dv.setUint16(28, 0, true)
    local.set(nameBytes, 30)
    chunks.push(local, f.data)

    const cen = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(cen.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, 0, true)
    cv.setUint16(14, 0, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, f.data.length, true)
    cv.setUint32(24, f.data.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    cen.set(nameBytes, 46)
    central.push(cen)

    offset += local.length + f.data.length
  }

  let centralSize = 0
  for (const c of central) centralSize += c.length
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  const parts: BlobPart[] = []
  for (const u of [...chunks, ...central, end]) {
    parts.push(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer)
  }
  return new Blob(parts, { type: 'application/zip' })
}

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
}

function crc32(data: Uint8Array, table: Uint32Array): number {
  let crc = 0 ^ -1
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xff]
  }
  return (crc ^ -1) >>> 0
}
