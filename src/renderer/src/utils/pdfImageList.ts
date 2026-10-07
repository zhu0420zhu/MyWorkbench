/**
 * PDF「图片对象」枚举：把每一页里被绘制的图片，连同它在 PDF 用户空间的位置、
 * 像素尺寸与旋转标记一起交出来，供「图片就地编辑」用。
 *
 * 为什么不用 `page.getAnnotations()` 或按 XObject 字典遍历：
 *   - 一个图片 XObject 可能被**多次**绘制（不同位置/缩放/旋转），按对象遍历只会
 *     得到一次，且拿不到落点；按**绘制指令**遍历才能得到每一处的真实包围盒。
 *   - 内联图片（BI/ID/EI）根本没有 XObject 对象可遍历。
 *
 * 做法（与 `pdfTextBlocks.ts` 同一套坐标系思路，但更直接）：
 *   1. `page.getOperatorList()` 拿到该页的操作符流；
 *   2. **自维护 CTM 栈**：save 入栈 / restore 出栈 / transform 右乘、
 *      paintFormXObjectBegin 入栈并乘矩阵、paintFormXObjectEnd 出栈；
 *   3. 遇到图像绘制算子时取当前 CTM。**图片绘制的是单位正方形 [0,1]×[0,1]**，
 *      把四角用 CTM 变换后取轴对齐包围盒 ⇒ 就是 PDF 用户空间的 `pdfRect`。
 *      像素宽高取自算子参数，不重复乘进包围盒。
 *
 * 坐标系：算子流的 CTM 是 **PDF 默认用户空间**（左下原点、**不含** /Rotate、
 * 不含 viewport 缩放），与 pdf-lib 作图、`pdfTextBlocks` 的 rect 完全一致。
 *
 * ## 内存铁律（刻意设计）
 * 枚举阶段**只产出标量**（页号/序号/矩形/像素尺寸/旋转），**不解码任何图像、不驻留
 * RGBA、不生成 base64**。一个几十页含多张照片的 PDF，若在这里就把每张图解码成
 * RGBA 再编码成 PNG data URL，内存峰值会按「张数 × 解码后像素」线性膨胀到 GB 级。
 * 需要像素时再调 `getPlacedImageDataUrl(bytes, img)` 单张惰性获取（用完即可回收）。
 *
 * ## 幂等性
 * 枚举只依赖操作符流，**不需要先 `page.render()`**，所以既快又不吃内存。
 * 取像素（`getPlacedImageDataUrl`）才需要渲染一次以触发 pdf.js 解码对象。
 *
 * ## 不漏图
 * pdf.js 为「同一图片连续重复绘制」和「连续多张内联图」做了算子级优化
 * （`paintImageXObjectRepeat` / `paintInlineImageXObjectGroup`）。不展开它们会
 * **静默少列图片**（用户在列表里找不到 → 选不中 → 删不掉/换不了，且毫无提示）。
 * 这里两种都按 pdf.js 官方渲染语义完整展开；真正无法纳入的绘制点会记进
 * `PdfImageScan.unsupportedOps`，由 UI 如实提示，**绝不静默**。
 *
 * 本文件依赖 pdf.js；只有 `getPlacedImageDataUrl` 需要 DOM（canvas）。
 */
import { OPS } from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { openPdfDocument } from './pdfRender'

/** 图片像素数据的来源定位（内部用；不对外暴露） */
type ImageSource =
  | { kind: 'xobject'; objId: string }
  /** 单张内联图片：数据就在操作符流第 opIndex 项的参数里 */
  | { kind: 'inline'; opIndex: number }
  /** 内联图片组：opIndex 处是一张合并图，entryIndex 指定其中的子图 */
  | { kind: 'inlineGroup'; opIndex: number; entryIndex: number }

export interface PlacedImage {
  /** 0 基页号 */
  page: number
  /** 稳定标识：`${page}:${drawIndex}` */
  key: string
  /**
   * 该页第几次图像绘制（= 该页操作符流里图像绘制项的序号，0 基，后画的在上层）。
   * 被过滤掉的绘制仍占号，所以序号可能有空洞 —— 这保证了它同时是
   * `getPlacedImageDataUrl` 重新定位该图的**稳定坐标**（见该函数注释）。
   */
  drawIndex: number
  /** pdf.js 对象名，**仅供展示与排错**（跨文档不稳定，不要拿它当键） */
  objId: string
  /** PDF 用户坐标（左下原点、未旋转空间），与 pdfTextBlocks 的 rect 同一坐标系 */
  pdfRect: { x: number; y: number; width: number; height: number }
  pixelWidth: number
  pixelHeight: number
  /** CTM 是否含旋转/镜像（非轴对齐），供 UI 提示 */
  rotated: boolean
}

/** 枚举结果：图片列表 + 覆盖度统计（UI 必须如实展示，不允许静默少列） */
export interface PdfImageScan {
  images: PlacedImage[]
  /** PDF 真实总页数（不受 opts.maxPages 影响） */
  totalPages: number
  /**
   * **未能纳入 `images` 的绘制点**。当前实现完整展开 repeat / inlineGroup，
   * 正常情况两个计数都是 0；一旦非 0，UI 必须提示「本页可能有图片未列出」。
   */
  unsupportedOps: {
    /** `paintImageXObjectRepeat` 中展开失败的绘制点 */
    repeat: number
    /** `paintInlineImageXObjectGroup` 中展开失败的内联图片张数 */
    inlineGroup: number
  }
  /** 按设计被过滤掉的 image mask 绘制数（mask 不是图片对象，不是缺陷） */
  skippedMasks: number
  /** 因小于 8×8pt 被过滤的绘制数（图标/装饰） */
  skippedSmall: number
}

/** 等待单个图像对象进入 pdf.js 对象存储的上限（超时即报错，不无限挂起） */
const OBJ_WAIT_MS = 4000

/** 小于该尺寸（pt）的绘制视为图标/装饰，不产出（避免噪声与海量小图） */
const MIN_DRAW_SIZE_PT = 8

/** 判定 CTM 是否含旋转：|b|、|c| 任一超过该阈值即视为非轴对齐 */
const ROTATION_EPS = 1e-3

/** 取像素时用于触发解码的渲染缩放（越小越快，能触发对象解析即可） */
const RESOLVE_SCALE = 0.5

type Mat = [number, number, number, number, number, number]

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0]

/** 从 OPS 里挑出运行时确实存在的算子编号（版本容错，不硬编码数字） */
function opId(name: string): number | null {
  const v = (OPS as unknown as Record<string, number | undefined>)[name]
  return typeof v === 'number' ? v : null
}

/** pdf.js v6 已移除 paintJpegXObject（JPEG 也走 paintImageXObject），老版本则存在 */
const OP_IMAGE = opId('paintImageXObject')
const OP_IMAGE_REPEAT = opId('paintImageXObjectRepeat')
const OP_INLINE = opId('paintInlineImageXObject')
const OP_INLINE_GROUP = opId('paintInlineImageXObjectGroup')
const OP_JPEG = opId('paintJpegXObject')
const OP_MASK = opId('paintImageMaskXObject')
const OP_MASK_REPEAT = opId('paintImageMaskXObjectRepeat')
const OP_MASK_GROUP = opId('paintImageMaskXObjectGroup')
const OP_MASK_SOLID = opId('paintSolidColorImageMask')

const MASK_OPS = new Set([OP_MASK, OP_MASK_REPEAT, OP_MASK_GROUP, OP_MASK_SOLID].filter((n): n is number => n !== null))

/** 非重复、非内联组的「普通图片绘制」算子集合 */
const SIMPLE_IMAGE_OPS = new Set([OP_IMAGE, OP_JPEG, OP_INLINE].filter((n): n is number => n !== null))

/* ------------------------------------------------------------------ *
 * 矩阵工具（pdf.js 约定：[a,b,c,d,e,f] 列向量；x' = a·x + c·y + e）
 * ------------------------------------------------------------------ */

/** m1 · m2（与 pdf.js `Util.transform` 一致，列向量矩阵乘法） */
function mul(m1: Mat, m2: Mat): Mat {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ]
}

function applyPoint(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/**
 * 单位正方形 [0,1]×[0,1] 经 CTM 后的轴对齐包围盒。
 * CTM 的 b/c 分量非零时（旋转/镜像），包围盒会大于原始 w×h —— 这是正确行为。
 */
function unitSquareAabb(m: Mat): { x: number; y: number; width: number; height: number } {
  const corners: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1]
  ]
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const [u, v] of corners) {
    const [x, y] = applyPoint(m, u, v)
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function toMat(raw: unknown): Mat {
  if (!Array.isArray(raw) || raw.length < 6) return IDENTITY
  const m = raw.slice(0, 6).map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0))
  return [m[0], m[1], m[2], m[3], m[4], m[5]]
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/* ------------------------------------------------------------------ *
 * 操作符流 → 图像绘制项
 * ------------------------------------------------------------------ */

interface RawDraw {
  ctm: Mat
  pixelWidth: number
  pixelHeight: number
  objId: string
  source: ImageSource
}

interface ScanTally {
  repeat: number
  inlineGroup: number
  masks: number
  small: number
}

interface OperatorListLike {
  fnArray: number[]
  argsArray: unknown[][]
}

/**
 * 扫一遍算子流，按绘制次序收集全部图像绘制点。
 * CTM 栈处理 save / restore / transform / paintFormXObjectBegin / paintFormXObjectEnd，
 * 并展开 pdf.js 的 repeat 与 inlineGroup 优化算子。
 */
function collectDraws(opList: OperatorListLike, tally: ScanTally): RawDraw[] {
  const { fnArray, argsArray } = opList
  const stack: Mat[] = []
  let ctm: Mat = IDENTITY
  const draws: RawDraw[] = []

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    const args = argsArray[i] ?? []

    if (fn === OPS.save) {
      stack.push(ctm)
      continue
    }
    if (fn === OPS.restore) {
      const prev = stack.pop()
      if (prev) ctm = prev
      continue
    }
    if (fn === OPS.transform) {
      ctm = mul(ctm, toMat(args))
      continue
    }
    if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm)
      ctm = mul(ctm, toMat(args[0]))
      continue
    }
    if (fn === OPS.paintFormXObjectEnd) {
      const prev = stack.pop()
      if (prev) ctm = prev
      continue
    }

    if (MASK_OPS.has(fn)) {
      // image mask 是模板/蒙版，不是图片对象：按设计过滤，但要计数（UI 可说明）
      tally.masks++
      continue
    }

    // --- 同图重复绘制：args = [objId, scaleX, scaleY, positions(扁平 x,y 对)] ---
    // 语义（pdf.js CanvasGraphics.paintImageXObjectRepeat）：原本是 N 组
    //   q  scaleX 0 0 scaleY tx ty cm  /Img Do  Q
    // 每组净效果 = 当前 CTM × [scaleX,0,0,scaleY,tx,ty] 映射单位正方形。
    if (fn === OP_IMAGE_REPEAT) {
      const objId = typeof args[0] === 'string' ? args[0] : ''
      const scaleX = num(args[1])
      const scaleY = num(args[2])
      const positions = args[3]
      if (objId === '' || !positions || typeof (positions as { length?: number }).length !== 'number') {
        tally.repeat++
        continue
      }
      const arr = positions as ArrayLike<number>
      if (arr.length === 0 || arr.length % 2 !== 0) {
        tally.repeat++
        continue
      }
      for (let p = 0; p + 1 < arr.length; p += 2) {
        const local: Mat = [scaleX, 0, 0, scaleY, num(arr[p]), num(arr[p + 1])]
        draws.push({
          ctm: mul(ctm, local),
          pixelWidth: 0,
          pixelHeight: 0,
          objId,
          source: { kind: 'xobject', objId }
        })
      }
      continue
    }

    // --- 内联图片组：args = [合并图 img, map[{transform,x,y,w,h}]] ---
    // 语义（pdf.js CanvasGraphics.paintInlineImageXObjectGroup）：每张子图
    // = 当前 CTM × entry.transform 映射单位正方形；像素为合并图里 (x,y,w,h) 那块。
    if (fn === OP_INLINE_GROUP) {
      const img = (args[0] ?? {}) as Record<string, unknown>
      const map = args[1]
      if (!Array.isArray(map) || map.length === 0) {
        tally.inlineGroup++
        continue
      }
      let ok = 0
      for (let k = 0; k < map.length; k++) {
        const entry = (map[k] ?? {}) as Record<string, unknown>
        const transform = entry.transform
        if (!Array.isArray(transform) || transform.length < 6) {
          tally.inlineGroup++
          continue
        }
        draws.push({
          ctm: mul(ctm, toMat(transform)),
          pixelWidth: num(entry.w) || num(img.width),
          pixelHeight: num(entry.h) || num(img.height),
          objId: `inline_group_p${i}_${k}`,
          source: { kind: 'inlineGroup', opIndex: i, entryIndex: k }
        })
        ok++
      }
      if (ok === 0) tally.inlineGroup++
      continue
    }

    if (!SIMPLE_IMAGE_OPS.has(fn)) continue

    if (fn === OP_INLINE) {
      const img = (args[0] ?? {}) as Record<string, unknown>
      draws.push({
        ctm,
        pixelWidth: num(img.width),
        pixelHeight: num(img.height),
        objId: `inline_p${i}`,
        source: { kind: 'inline', opIndex: i }
      })
      continue
    }

    // paintImageXObject / (旧版) paintJpegXObject：args = [objId, w, h]
    const objId = typeof args[0] === 'string' ? args[0] : ''
    if (objId === '') continue
    draws.push({
      ctm,
      pixelWidth: num(args[1]),
      pixelHeight: num(args[2]),
      objId,
      source: { kind: 'xobject', objId }
    })
  }
  return draws
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/**
 * 枚举 PDF 里的图片对象（逐页、逐次绘制）。
 *
 * **只产出标量**：不解码图像、不生成 base64、不驻留像素。像素按需用
 * `getPlacedImageDataUrl` 单张获取。
 *
 * - `opts.maxPages` 限制处理的页数（缺省全部）；`totalPages` 始终是真实总页数。
 * - 单页失败只跳过该页并在控制台 warn，不影响整份文档。
 * - 过滤掉 image mask 与小于 8×8pt 的绘制（计数都在返回结构里）。
 */
export async function listPdfImages(bytes: Uint8Array, opts?: { maxPages?: number }): Promise<PdfImageScan> {
  const doc: PDFDocumentProxy = await openPdfDocument(bytes)
  const totalPages = doc.numPages
  const maxPages = opts?.maxPages && opts.maxPages > 0 ? Math.floor(opts.maxPages) : doc.numPages
  const limit = Math.min(doc.numPages, maxPages)
  const images: PlacedImage[] = []
  const tally: ScanTally = { repeat: 0, inlineGroup: 0, masks: 0, small: 0 }

  try {
    for (let i = 1; i <= limit; i++) {
      try {
        const page = await doc.getPage(i)
        const opList = (await page.getOperatorList()) as unknown as OperatorListLike
        const draws = collectDraws(opList, tally)
        for (let di = 0; di < draws.length; di++) {
          const draw = draws[di]
          const rect = unitSquareAabb(draw.ctm)
          if (rect.width < MIN_DRAW_SIZE_PT || rect.height < MIN_DRAW_SIZE_PT) {
            tally.small++
            continue
          }
          images.push({
            page: i - 1,
            key: `${i - 1}:${di}`,
            // 序号取自**未过滤**的绘制序列：被过滤的绘制仍占号，
            // 于是 drawIndex 能作为 getPlacedImageDataUrl 重新定位该图的稳定坐标
            drawIndex: di,
            objId: draw.objId,
            pdfRect: rect,
            pixelWidth: Math.max(1, Math.round(draw.pixelWidth || rect.width)),
            pixelHeight: Math.max(1, Math.round(draw.pixelHeight || rect.height)),
            // CTM 的 b/c 分量非零 ⇒ 含旋转或镜像（非轴对齐）
            rotated: Math.abs(draw.ctm[1]) > ROTATION_EPS || Math.abs(draw.ctm[2]) > ROTATION_EPS
          })
        }
      } catch (e) {
        console.warn(`[pdfImageList] 第 ${i} 页图片枚举失败，已跳过：`, e)
      }
      // 让出事件循环，避免整份文档同步阻塞 UI
      await new Promise((r) => setTimeout(r, 0))
    }
  } finally {
    const disposable = doc as unknown as { destroy?: () => Promise<void> }
    if (typeof disposable.destroy === 'function') await disposable.destroy()
  }

  return {
    images,
    totalPages,
    unsupportedOps: { repeat: tally.repeat, inlineGroup: tally.inlineGroup },
    skippedMasks: tally.masks,
    skippedSmall: tally.small
  }
}

/* ------------------------------------------------------------------ *
 * 单张图片像素：惰性获取
 * ------------------------------------------------------------------ */

/**
 * 取某个 `PlacedImage` 的像素本体（png 或 jpeg 的 data URL）。
 * **每次调用只处理这一张**，返回后文档与中间画布都会被释放，不会长期占用内存。
 *
 * 定位方式刻意用 `(page, drawIndex)` **重新扫一遍该页的算子流**，而不是拿枚举时的
 * `objId` 直接去取：
 *   · 跨页共享的图片在 pdf.js 里叫 `g_<docId>_img_p<page>_<n>`，`docId` 是
 *     **每次 `getDocument` 自增**的计数器 —— 换一个文档实例，名字就变了（实测
 *     `g_d8_img_p1_1` 在下一个实例里根本不存在，只会等到超时）。
 *   · 页内图片叫 `img_p<page>_<n>` 虽然稳定，但内联图（BI/ID/EI）压根没有对象名。
 *   `(page, drawIndex)` 在同版本 pdf.js 下是确定的，重扫即可拿到**本文档实例**里
 *   正确的对象名 / 算子下标 / 子图下标。
 *
 * 已经是 JPEG 字节的对象原样 base64（不重编码，不掉质量）；
 * 其余（pdf.js 已解码成 RGBA/RGB/1bpp）编码成 PNG（无损）。
 */
export async function getPlacedImageDataUrl(bytes: Uint8Array, img: PlacedImage): Promise<string> {
  const doc: PDFDocumentProxy = await openPdfDocument(bytes)
  const canvas = document.createElement('canvas')
  try {
    const page = await doc.getPage(img.page + 1)
    const opList = (await page.getOperatorList()) as unknown as OperatorListLike
    const localTally: ScanTally = { repeat: 0, inlineGroup: 0, masks: 0, small: 0 }
    const draws = collectDraws(opList, localTally)
    const draw = draws[img.drawIndex]
    if (!draw) {
      throw new Error(`第 ${img.page + 1} 页没有第 ${img.drawIndex} 个图像绘制项（文档可能已变化）`)
    }

    if (draw.source.kind === 'xobject') {
      // 必须先渲染一次：否则 pdf.js 还没把图像对象解出来，get 会抛异常
      await renderPageOnce(page)
      const payload = await waitPageObj(page, draw.source.objId)
      const url = payloadToDataUrl(payload, canvas)
      if (!url) throw new Error(`图片对象 ${draw.source.objId} 的像素数据无法识别`)
      return url
    }

    const args = opList.argsArray[draw.source.opIndex] ?? []

    if (draw.source.kind === 'inline') {
      const url = payloadToDataUrl((args[0] ?? {}) as Record<string, unknown>, canvas)
      if (!url) throw new Error('内联图片的像素数据无法识别')
      return url
    }

    const merged = (args[0] ?? {}) as Record<string, unknown>
    const map = Array.isArray(args[1]) ? (args[1] as Array<Record<string, unknown>>) : []
    const entry = map[draw.source.entryIndex]
    if (!entry) throw new Error(`内联图片组缺少第 ${draw.source.entryIndex} 条子图信息`)
    const url = cropGroupEntryToDataUrl(merged, entry)
    if (!url) throw new Error('内联图片组的像素数据无法识别')
    return url
  } finally {
    const disposable = doc as unknown as { destroy?: () => Promise<void> }
    if (typeof disposable.destroy === 'function') await disposable.destroy()
  }
}

/** 渲染一整页（只为触发图像对象解析），用完即弃 */
async function renderPageOnce(page: PDFPageProxy): Promise<void> {
  const viewport = page.getViewport({ scale: RESOLVE_SCALE })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(viewport.width))
  canvas.height = Math.max(1, Math.round(viewport.height))
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  await page.render({ canvas, canvasContext: ctx, viewport } as Parameters<PDFPageProxy['render']>[0]).promise
}

/** pdf.js 的对象存储：`objs`（页内）与 `commonObjs`（跨页共享）接口一致 */
interface ObjsStorage {
  get: (objId: string, callback?: (data: unknown) => void) => unknown
}

/**
 * 按 pdf.js 自己的规则选对象存储：**对象名以 `g_` 开头的是 commonObjs（跨页复用），
 * 否则是页内 objs**。挑错存储会一直等不到回调（实测：同一张图被第 1、3 页共用时，
 * pdf.js 把它注册成 `g_d0_img_p2_1` 放进 commonObjs）。
 */
function pickObjs(page: PDFPageProxy, objId: string): ObjsStorage {
  return (objId.startsWith('g_') ? page.commonObjs : page.objs) as unknown as ObjsStorage
}

/**
 * 等一个图像对象就绪。
 * `objs.get(id, cb)` 在对象已就绪时会**同步**回调并返回 null；未就绪时挂到 pending。
 * 两种情况都要处理，并加超时兜底（个别对象永远不送达时不能无限挂起）。
 */
function waitPageObj(page: PDFPageProxy, objId: string): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let settled = false
    const settle = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      action()
    }
    const timer = setTimeout(() => settle(() => reject(new Error('等待图像对象超时: ' + objId))), OBJ_WAIT_MS)
    try {
      const immediate = pickObjs(page, objId).get(objId, (data: unknown) => {
        settle(() => resolve((data ?? {}) as Record<string, unknown>))
      })
      if (immediate !== null && immediate !== undefined) {
        settle(() => resolve(immediate as Record<string, unknown>))
      }
    } catch (e) {
      settle(() => reject(e instanceof Error ? e : new Error(String(e))))
    }
  })
}

/* ------------------------------------------------------------------ *
 * 图像对象 → data URL
 * ------------------------------------------------------------------ */

/** pdf.js ImageKind 编号 */
const IMAGE_KIND_GRAYSCALE_1BPP = 1
const IMAGE_KIND_RGB_24BPP = 2
const IMAGE_KIND_RGBA_32BPP = 3

function payloadToDataUrl(payload: Record<string, unknown>, canvas: HTMLCanvasElement): string | null {
  // 有的实现把解码结果放在 .bitmap（ImageBitmap / CanvasImageSource）
  const bitmap = payload.bitmap as CanvasImageSource | undefined
  if (bitmap && typeof bitmap === 'object') {
    const drawn = drawSourceToPng(bitmap, num(payload.width), num(payload.height), canvas)
    if (drawn) return drawn
  }

  const data = payload.data
  if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray)) return null

  // JPEG：pdf.js 有时直接把原始 JPEG 字节交出来，原样嵌入，绝不重编码
  if (isJpegBytes(data)) return 'data:image/jpeg;base64,' + bytesToBase64(data)

  const width = num(payload.width)
  const height = num(payload.height)
  if (width <= 0 || height <= 0) return null

  const kind = typeof payload.kind === 'number' ? payload.kind : undefined
  const rgba = toRgba(data, width, height, kind)
  if (!rgba) return null
  return rgbaToPngDataUrl(rgba, width, height, canvas)
}

/** 从内联图片组的**合并图**里裁出某一格，编码成 PNG */
function cropGroupEntryToDataUrl(merged: Record<string, unknown>, entry: Record<string, unknown>): string | null {
  const mw = num(merged.width)
  const mh = num(merged.height)
  const x = Math.round(num(entry.x))
  const y = Math.round(num(entry.y))
  const w = Math.round(num(entry.w))
  const h = Math.round(num(entry.h))
  if (mw <= 0 || mh <= 0 || w <= 0 || h <= 0) return null
  if (x < 0 || y < 0 || x + w > mw || y + h > mh) return null

  // 1) 把合并图落到一张临时 canvas（bitmap 或原始像素两条路）
  const src = document.createElement('canvas')
  src.width = mw
  src.height = mh
  const sctx = src.getContext('2d')
  if (!sctx) return null

  const bitmap = merged.bitmap as CanvasImageSource | undefined
  if (bitmap && typeof bitmap === 'object') {
    sctx.clearRect(0, 0, mw, mh)
    sctx.drawImage(bitmap, 0, 0, mw, mh)
  } else {
    const data = merged.data
    if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray)) return null
    const kind = typeof merged.kind === 'number' ? merged.kind : undefined
    const rgba = toRgba(data, mw, mh, kind)
    if (!rgba) return null
    const id = sctx.createImageData(mw, mh)
    id.data.set(rgba)
    sctx.putImageData(id, 0, 0)
  }

  // 2) 裁出子矩形并编码
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const octx = out.getContext('2d')
  if (!octx) return null
  try {
    octx.drawImage(src, x, y, w, h, 0, 0, w, h)
    return out.toDataURL('image/png')
  } catch {
    return null
  }
}

function isJpegBytes(b: Uint8Array | Uint8ClampedArray): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
}

/** 依 pdf.js ImageKind 把原始缓冲区转成 RGBA；无法判定时按长度推断，再退回灰度 */
function toRgba(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  kind: number | undefined
): Uint8ClampedArray | null {
  const px = width * height
  if (px <= 0) return null
  const out = new Uint8ClampedArray(px * 4)

  const isRgba = kind === IMAGE_KIND_RGBA_32BPP || (kind === undefined && data.length === px * 4)
  if (isRgba) {
    out.set(data.subarray(0, Math.min(data.length, px * 4)))
    return out
  }

  const isRgb = kind === IMAGE_KIND_RGB_24BPP || (kind === undefined && data.length === px * 3)
  if (isRgb) {
    for (let i = 0, j = 0; i < out.length; i += 4, j += 3) {
      out[i] = data[j] ?? 0
      out[i + 1] = data[j + 1] ?? 0
      out[i + 2] = data[j + 2] ?? 0
      out[i + 3] = 255
    }
    return out
  }

  if (kind === IMAGE_KIND_GRAYSCALE_1BPP) {
    // 1bpp：每行按字节对齐（右侧补零），位=1 表示黑（pdf.js 约定）
    const rowBytes = (width + 7) >> 3
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const byte = data[y * rowBytes + (x >> 3)] ?? 0
        const bit = (byte & (0x80 >> (x & 7))) !== 0
        const v = bit ? 0 : 255
        const o = (y * width + x) * 4
        out[o] = v
        out[o + 1] = v
        out[o + 2] = v
        out[o + 3] = 255
      }
    }
    return out
  }

  // 兜底：单通道灰度（8bpp）
  if (data.length >= px) {
    for (let i = 0, j = 0; i < out.length; i += 4, j++) {
      const v = data[j] ?? 0
      out[i] = v
      out[i + 1] = v
      out[i + 2] = v
      out[i + 3] = 255
    }
    return out
  }
  return null
}

function rgbaToPngDataUrl(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  canvas: HTMLCanvasElement
): string | null {
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  try {
    // 用 createImageData + set，避免 ImageData 构造签名对 TypedArray 泛型的严格约束
    const imgData = ctx.createImageData(width, height)
    imgData.data.set(rgba)
    ctx.putImageData(imgData, 0, 0)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

/** 直接把一个 CanvasImageSource（ImageBitmap 等）绘到 canvas 再编码 PNG */
function drawSourceToPng(
  source: CanvasImageSource,
  width: number,
  height: number,
  canvas: HTMLCanvasElement
): string | null {
  try {
    const w = width > 0 ? width : (source as ImageBitmap).width
    const h = height > 0 ? height : (source as ImageBitmap).height
    if (!w || !h) return null
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(source, 0, 0, w, h)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

/* --- base64 编码：手写，不依赖 btoa/Buffer，避免大图触发参数长度限制 --- */

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function bytesToBase64(bytes: Uint8Array | Uint8ClampedArray): string {
  const len = bytes.length
  const parts: string[] = []
  let chunk = ''
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i]
    const has1 = i + 1 < len
    const has2 = i + 2 < len
    const b1 = has1 ? bytes[i + 1] : 0
    const b2 = has2 ? bytes[i + 2] : 0
    chunk +=
      B64_CHARS[b0 >> 2] +
      B64_CHARS[((b0 & 3) << 4) | (b1 >> 4)] +
      (has1 ? B64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=') +
      (has2 ? B64_CHARS[b2 & 63] : '=')
    if (chunk.length >= 8192) {
      parts.push(chunk)
      chunk = ''
    }
  }
  if (chunk.length > 0) parts.push(chunk)
  return parts.join('')
}
