/**
 * PDF「图片就地编辑」回写层：在原 PDF 上直接对图片对象做增删改移，其余一切保持原样。
 *
 * 与 `pdfInPlaceReplace.ts`（保版式改字）同宗，两条铁律不变：
 *
 *   1. **不用 copyPages 重建文档**。重建会把图片/矢量/字体子集重新序列化一遍，
 *      视觉上也许看不出来，但版式细节与字节都会变。这里直接在原 PDFDocument 的
 *      页对象上追加绘制指令（pdf-lib 的 `page.drawXxx` 就是往页面内容流尾部
 *      pushOperators），于是「没被编辑的页」在输出文件里仍是原来那段字节。
 *   2. **不改动原页面内容流，只往页面末尾追加**覆盖矩形与新图片的对象。
 *
 * 输出统一 `save({ useObjectStreams: false })`：保持经典交叉引用结构，
 * 便于逐对象字节比对（对象流会把对象打包进压缩流，比对工具就没法逐对象比了）。
 *
 * 坐标：本模块全程使用 **PDF 用户坐标**（左下原点、未旋转空间），
 * 与 `pdfTextBlocks.ts` 的 `rect`、`pdfImageList.ts` 的 `pdfRect` 同一坐标系。
 *
 * 绘制顺序 = ops 数组顺序，后画的在上层 ⇒ 天然支持重排 z 序。
 *
 * 关于旋转：pdf-lib 的 `drawImage({ rotate })` 输出的是
 *   `q 1 0 0 1 x y cm  cosθ sinθ -sinθ cosθ 0 0 cm  w 0 0 h 0 0 cm /Img Do Q`
 * 即「先 translate 到 (x,y)，再绕该点旋转，再缩放到 w×h」——旋转是**绕 (x,y) 这个
 * 左下角**，不是绕图像中心。所以带 rotate 时不能直接把 x/y 当成目标框左下角，
 * 必须按旋转后的**包围盒**反推落点，否则图像会整体跑到目标框外面去。
 * 见 `placementFor()`。
 *
 * 本文件刻意不依赖 DOM（无 canvas / 无 atob），纯 pdf-lib + 手写 base64 编解码，
 * 因此能被 `node --experimental-strip-types` 直接加载做无头验收。
 */
import { PDFDocument, degrees, rgb } from 'pdf-lib'
import type { PDFImage, PDFPage } from 'pdf-lib'

/** 一条图片操作（坐标均为 PDF 用户坐标） */
export interface ImageOp {
  kind: 'insert' | 'delete' | 'replace' | 'move'
  /** 0 基页号 */
  page: number
  /** replace/move 是原始位置；insert 是目标位置 */
  pdfRect: { x: number; y: number; width: number; height: number }
  /** insert/replace/move 必填：图片 data URL（png/jpeg） */
  dataUrl?: string
  /** move 的目标位置 */
  targetRect?: { x: number; y: number; width: number; height: number }
  /** delete/replace/move 覆盖原位置用的填充色（调用方从原图四周环带采样得到），0..1 */
  coverColor: { r: number; g: number; b: number }
  /** 可选：顺时针旋转角度（度）。绕目标框左下角，内部已按包围盒补偿 */
  rotate?: number
}

const KIND_LIST: ImageOp['kind'][] = ['insert', 'delete', 'replace', 'move']

/** 旋转圈数归一化时用到的容差（把 359.9999… 视作 360） */
const FULL_TURN_EPS = 1e-6

/** 已嵌入图片按 dataUrl 缓存：同一张图多处复用只 embed 一次（embed 每次都往文档塞一份对象） */
type ImageCache = Map<string, PDFImage>

/**
 * 把一批图片操作回写到 PDF 上，返回新的文件字节。
 *
 * - `ops` 为空数组时，输出与「只做 load + save(no object streams)」的往返结果一致，
 *   原有对象（含图片 XObject 原始流）字节不变。
 * - 任意一条操作非法（矩形非正、页号越界、缺 dataUrl…）都会**先于绘制**抛可读 Error，
 *   不产出半成品文件。
 */
export async function applyImageOps(bytes: Uint8Array, ops: ImageOp[]): Promise<Uint8Array> {
  if (!Array.isArray(ops)) throw new Error('applyImageOps: ops 必须是数组')
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new Error('applyImageOps: bytes 必须是非空的 Uint8Array')
  }

  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const pages = doc.getPages()

  // 先全量校验：任何一条非法都不进入绘制阶段，避免「画了一半」的中间态
  for (let i = 0; i < ops.length; i++) {
    try {
      validateOp(ops[i], pages.length)
    } catch (e) {
      throw new Error(`第 ${i} 条图片操作非法: ${errMessage(e)}`)
    }
  }

  if (ops.length === 0) return doc.save({ useObjectStreams: false })

  const cache: ImageCache = new Map()
  for (const op of ops) {
    const page = pages[op.page]
    switch (op.kind) {
      case 'insert':
        await drawImageAt(page, doc, op, op.pdfRect, cache)
        break
      case 'delete':
        drawCover(page, op.pdfRect, op.coverColor)
        break
      case 'replace':
        drawCover(page, op.pdfRect, op.coverColor)
        await drawImageAt(page, doc, op, op.pdfRect, cache)
        break
      case 'move':
        drawCover(page, op.pdfRect, op.coverColor)
        // 校验阶段已保证 targetRect 存在
        await drawImageAt(page, doc, op, op.targetRect as ImageOp['pdfRect'], cache)
        break
    }
  }

  return doc.save({ useObjectStreams: false })
}

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function assertRect(rect: unknown, label: string): asserts rect is ImageOp['pdfRect'] {
  if (!rect || typeof rect !== 'object') throw new Error(`${label} 缺失或不是对象`)
  const r = rect as Record<string, unknown>
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const v = r[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`${label}.${key} 必须是有限数字（当前 ${String(v)}）`)
    }
  }
  if ((r.width as number) <= 0 || (r.height as number) <= 0) {
    throw new Error(`${label} 的 width/height 必须为正数（当前 ${r.width}×${r.height}）`)
  }
}

function validateOp(op: ImageOp, pageCount: number): void {
  if (!op || typeof op !== 'object') throw new Error('操作项不是对象')
  if (!KIND_LIST.includes(op.kind)) {
    throw new Error(`未知的操作类型: ${String(op.kind)}（应为 ${KIND_LIST.join(' / ')}）`)
  }
  if (typeof op.page !== 'number' || !Number.isInteger(op.page)) {
    throw new Error(`page 必须是整数（当前 ${String(op.page)}）`)
  }
  if (op.page < 0 || op.page >= pageCount) {
    throw new Error(`page 越界: ${op.page}（文档共 ${pageCount} 页，合法范围 0..${pageCount - 1}）`)
  }
  assertRect(op.pdfRect, 'pdfRect')

  if (op.kind === 'insert' || op.kind === 'replace' || op.kind === 'move') {
    if (typeof op.dataUrl !== 'string' || op.dataUrl.trim() === '') {
      throw new Error(`${op.kind} 操作缺少 dataUrl`)
    }
  }
  if (op.kind === 'move') {
    if (!op.targetRect) throw new Error('move 操作缺少 targetRect')
    assertRect(op.targetRect, 'targetRect')
  }
  if (op.rotate !== undefined && (typeof op.rotate !== 'number' || !Number.isFinite(op.rotate))) {
    throw new Error(`rotate 必须是有限数字（度，当前 ${String(op.rotate)}）`)
  }
  // 覆盖色是 delete/replace/move 的**必填**参数，拿到脏值必须炸：
  // 白色兜底会在彩色背景页上留一块显眼白斑，而且不报错 —— 正是「静默产出错东西」。
  if (op.kind !== 'insert') assertCoverColor(op.coverColor)
}

function assertCoverColor(color: unknown): void {
  if (!color || typeof color !== 'object') {
    throw new Error('coverColor 缺失：delete/replace/move 必须提供覆盖色（请从原图四周环带采样）')
  }
  for (const key of ['r', 'g', 'b'] as const) {
    const v = (color as Record<string, unknown>)[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`coverColor.${key} 必须是有限数字（当前 ${String(v)}）`)
    }
  }
}

/* ------------------------------------------------------------------ *
 * 绘制
 * ------------------------------------------------------------------ */

/** 画一块实心覆盖矩形，盖住原始图片位置 */
function drawCover(
  page: PDFPage,
  rect: ImageOp['pdfRect'],
  color: { r: number; g: number; b: number }
): void {
  page.drawRectangle({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    color: rgb(norm01(color.r), norm01(color.g), norm01(color.b))
  })
}

/**
 * 覆盖色通道归一化：0..1 直接用；>1 视为 0..255 刻度（UI 采样可能是 0..255）；
 * 最后夹到 [0,1]。非有限值在 validateOp 阶段就已抛错，这里不会遇到。
 */
function norm01(v: number): number {
  const x = v > 1 ? v / 255 : v
  return Math.min(1, Math.max(0, x))
}

/** 嵌入（带缓存）dataUrl 对应的图片，并按 rect 绘制 */
async function drawImageAt(
  page: PDFPage,
  doc: PDFDocument,
  op: ImageOp,
  rect: ImageOp['pdfRect'],
  cache: ImageCache
): Promise<void> {
  const dataUrl = op.dataUrl as string
  let image = cache.get(dataUrl)
  if (!image) {
    const parsed = parseDataUrl(dataUrl)
    image = await embedByMime(doc, parsed.bytes, parsed.mime)
    cache.set(dataUrl, image)
  }

  const place = placementFor(rect, op.rotate, image.width, image.height)
  const rotate = op.rotate ?? 0
  page.drawImage(image, {
    x: place.x,
    y: place.y,
    width: place.width,
    height: place.height,
    ...(rotate % 360 === 0 ? {} : { rotate: degrees(rotate) })
  })
}

/**
 * 算出 `drawImage` 的落点参数，使**旋转后的图像包围盒**落在目标 `rect` 内。
 *
 * - `rotate` 缺省 / 360 的整数倍：直接铺满 rect（左下角对齐，无需补偿）。
 * - `rotate` 为 180：铺满 rect，但 pdf-lib 绕左下角旋转 180° 会把包围盒甩到
 *   左下方，故落点要加上 (width, height) 补偿回原框。
 * - 其余角度（典型 90/270）：保持原图长宽比，旋转后**内接**于 rect 并居中
 *   —— 旋转后的包围盒尺寸随角度变化（w·|cos| + h·|sin| 等），硬铺满会拉伸变形。
 */
function placementFor(
  rect: ImageOp['pdfRect'],
  rotateDeg: number | undefined,
  pixelWidth: number,
  pixelHeight: number
): { x: number; y: number; width: number; height: number } {
  const deg = rotateDeg ?? 0
  const norm = ((deg % 360) + 360) % 360

  if (norm < FULL_TURN_EPS || Math.abs(norm - 180) < FULL_TURN_EPS) {
    const flip = Math.abs(norm - 180) < FULL_TURN_EPS
    return {
      x: flip ? rect.x + rect.width : rect.x,
      y: flip ? rect.y + rect.height : rect.y,
      width: rect.width,
      height: rect.height
    }
  }

  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const aspect = pixelHeight > 0 ? pixelWidth / pixelHeight : 1
  const absCos = Math.abs(cos)
  const absSin = Math.abs(sin)

  // 图像局部尺寸 (w,h) 经旋转后的包围盒尺寸：
  //   bboxW = w·|cos| + h·|sin|,  bboxH = w·|sin| + h·|cos|
  // 令 w = aspect·k、h = k 保持长宽比，取最大 k 使包围盒不越出 rect。
  const denomW = aspect * absCos + absSin
  const denomH = aspect * absSin + absCos
  const k = Math.min(rect.width / (denomW || 1), rect.height / (denomH || 1))
  const w = aspect * k
  const h = k

  const bbox = rotatedAabb(cos, sin, w, h)
  return {
    x: rect.x + (rect.width - bbox.width) / 2 - bbox.minX,
    y: rect.y + (rect.height - bbox.height) / 2 - bbox.minY,
    width: w,
    height: h
  }
}

/** 单位正方形 [0,1]×[0,1] 先按 (w,h) 缩放、再旋转 θ 后的包围盒（未平移） */
function rotatedAabb(
  cos: number,
  sin: number,
  w: number,
  h: number
): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } {
  const corners: Array<[number, number]> = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h]
  ]
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const [u, v] of corners) {
    const x = cos * u - sin * v
    const y = sin * u + cos * v
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
}

/* ------------------------------------------------------------------ *
 * data URL → PDFImage
 * ------------------------------------------------------------------ */

const DATA_URL_RE = /^data:([^,]*?),(.*)$/s

function parseDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const m = DATA_URL_RE.exec(dataUrl.trim())
  if (!m) throw new Error('dataUrl 不是合法的 data: URL（应以 data: 开头）')

  const meta = m[1]
  const payload = m[2]
  const isBase64 = /;base64/i.test(meta)
  const declared = (meta.split(';')[0] || '').trim().toLowerCase()

  let bytes: Uint8Array
  if (isBase64) {
    bytes = decodeBase64(payload)
  } else {
    bytes = percentDecode(payload)
  }
  if (bytes.length === 0) throw new Error('dataUrl 解码后为空')

  const mime =
    declared && declared !== 'application/octet-stream' ? declared : sniffMime(bytes)
  return { bytes, mime }
}

async function embedByMime(doc: PDFDocument, bytes: Uint8Array, mime: string): Promise<PDFImage> {
  const m = mime.toLowerCase()
  try {
    if (m === 'image/png') return await doc.embedPng(bytes)
    if (m === 'image/jpeg' || m === 'image/jpg') return await doc.embedJpg(bytes)
  } catch (e) {
    throw new Error(`嵌入图片失败（${mime}）: ${errMessage(e)}`)
  }
  throw new Error(`不支持的图片格式: ${mime || '未知'}（仅支持 image/png 与 image/jpeg）`)
}

/** 从魔数判断图片类型（data URL 未声明 MIME 时兜底） */
function sniffMime(b: Uint8Array): string {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return 'image/png'
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return 'image/jpeg'
  }
  return ''
}

/* --- 手写 base64 解码：不依赖 atob / Buffer，浏览器与 Node 都能跑 --- */

const B64_LOOKUP = ((): Int16Array => {
  const table = new Int16Array(256).fill(-1)
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  for (let i = 0; i < chars.length; i++) table[chars.charCodeAt(i)] = i
  return table
})()

function decodeBase64(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9+/=]/g, '')
  if (clean.length === 0) return new Uint8Array(0)

  let padding = 0
  if (clean[clean.length - 1] === '=') padding++
  if (clean.length >= 2 && clean[clean.length - 2] === '=') padding++
  const outLen = Math.floor((clean.length * 3) / 4) - padding
  if (outLen < 0) throw new Error('base64 内容长度非法')

  const out = new Uint8Array(outLen)
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = codeLookup(clean, i)
    const c1 = codeLookup(clean, i + 1)
    const c2 = codeLookup(clean, i + 2)
    const c3 = codeLookup(clean, i + 3)
    if (c0 < 0 || c1 < 0) throw new Error('base64 含非法字符')
    const n = (c0 << 18) | (c1 << 12) | ((c2 < 0 ? 0 : c2) << 6) | (c3 < 0 ? 0 : c3)
    if (o < outLen) out[o++] = (n >> 16) & 0xff
    if (o < outLen) out[o++] = (n >> 8) & 0xff
    if (o < outLen) out[o++] = n & 0xff
  }
  return out
}

/** 取第 index 个 base64 字符的值；越界或 '=' 返回 -1 */
function codeLookup(s: string, index: number): number {
  if (index < 0 || index >= s.length) return -1
  const ch = s.charCodeAt(index)
  if (ch === 0x3d /* '=' */) return -1
  return B64_LOOKUP[ch]
}

function percentDecode(input: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '%' && i + 2 < input.length) {
      const code = Number.parseInt(input.slice(i + 1, i + 3), 16)
      if (Number.isFinite(code)) {
        out.push(code & 0xff)
        i += 2
        continue
      }
    }
    out.push(ch.charCodeAt(0) & 0xff)
  }
  return Uint8Array.from(out)
}
