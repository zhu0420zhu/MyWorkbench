/**
 * `src/renderer/src/utils/pdfImageOps.ts` 的无头验收。
 *
 * 用 pdf-lib 自造一份测试 PDF（第 1 页 JPEG、第 2 页纯文字、第 3 页 PNG），
 * 逐条断言图片操作的**真实效果**，并把原始证据（字节、算子原文、矩阵数值）打出来，
 * 而不是只说一句「测试通过」。
 *
 * 运行（managed node 22）：
 *   "C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" \
 *     --experimental-strip-types tests/pdf-image-ops.ts
 *
 * 本文件不依赖 DOM：图片素材由 @napi-rs/canvas 现场生成（纯 Node 可用）。
 */
import zlib from 'node:zlib'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { createCanvas } from '@napi-rs/canvas'
import { applyImageOps, type ImageOp } from '../src/renderer/src/utils/pdfImageOps.ts'

/* ------------------------------------------------------------------ *
 * 断言工具
 * ------------------------------------------------------------------ */

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log('  \u2713 ' + msg)
  } else {
    failed++
    console.error('  \u2717 FAIL: ' + msg)
  }
}

function assertEq(actual: unknown, expected: unknown, msg: string): void {
  const ok = actual === expected
  if (ok) {
    passed++
    console.log('  \u2713 ' + msg)
  } else {
    failed++
    console.error(
      '  \u2717 FAIL: ' + msg + '\n      期望: ' + JSON.stringify(expected) + '\n      实际: ' + JSON.stringify(actual)
    )
  }
}

function assertNear(actual: number, expected: number, tol: number, msg: string): void {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tol
  if (ok) {
    passed++
    console.log('  \u2713 ' + msg + '（' + actual.toFixed(4) + ' \u2248 ' + expected + '，容差 ' + tol + '）')
  } else {
    failed++
    console.error(
      '  \u2717 FAIL: ' + msg + '\n      期望: ' + expected + ' \u00b1 ' + tol + '\n      实际: ' + actual
    )
  }
}

async function assertRejects(fn: () => Promise<unknown>, re: RegExp, msg: string): Promise<void> {
  try {
    await fn()
    failed++
    console.error('  \u2717 FAIL: ' + msg + '\n      期望抛错（匹配 ' + re + '），但成功返回了')
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e)
    if (re.test(text)) {
      passed++
      console.log('  \u2713 ' + msg + '\n      抛出: ' + text)
    } else {
      failed++
      console.error('  \u2717 FAIL: ' + msg + '\n      期望匹配: ' + re + '\n      实际消息: ' + text)
    }
  }
}

/* ------------------------------------------------------------------ *
 * 原始字节工具
 * ------------------------------------------------------------------ */

/** 字节 → latin1 字符串（1 字节 = 1 字符，可安全做正则与逐字节比较） */
function latin1(bytes: Uint8Array): string {
  let out = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  }
  return out
}

function toBytes(v: Uint8Array | Buffer): Uint8Array {
  return v instanceof Uint8Array ? v : new Uint8Array(v)
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * 按 `N G obj ... endobj` 拆出全部间接对象（跳过 stream 内容里的 "endobj" 假匹配）。
 * 返回 Map<"num gen", body>。
 */
function extractObjects(bytes: Uint8Array): Map<string, string> {
  const text = latin1(bytes)
  const map = new Map<string, string>()
  const re = /(\d+)\s+(\d+)\s+obj/g
  const starts: Array<{ key: string; bodyStart: number; matchEnd: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    starts.push({ key: m[1] + ' ' + m[2], bodyStart: m.index + m[0].length, matchEnd: re.lastIndex })
  }
  for (const s of starts) {
    const streamIdx = text.indexOf('stream', s.matchEnd)
    const endobjIdx = text.indexOf('endobj', s.matchEnd)
    let end = endobjIdx
    if (streamIdx !== -1 && (endobjIdx === -1 || streamIdx < endobjIdx)) {
      const endstreamIdx = text.indexOf('endstream', streamIdx)
      end = text.indexOf('endobj', endstreamIdx)
    }
    if (end === -1) continue
    map.set(s.key, text.slice(s.bodyStart, end))
  }
  return map
}

/** 剔除 /Type /XRef 与 /Type /ObjStm 后的对象表（任务约定的比对口径） */
function extractComparableObjects(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>()
  for (const [k, body] of extractObjects(bytes)) {
    if (/\/Type\s*\/XRef\b/.test(body)) continue
    if (/\/Type\s*\/ObjStm\b/.test(body)) continue
    out.set(k, body)
  }
  return out
}

function compareMaps(
  a: Map<string, string>,
  b: Map<string, string>,
  label: string
): void {
  const keysA = [...a.keys()].sort()
  const keysB = [...b.keys()].sort()
  assertEq(keysB.join(','), keysA.join(','), label + '：对象编号集合一致')
  let diff = 0
  for (const k of keysA) {
    if (a.get(k) !== b.get(k)) {
      if (diff === 0) {
        console.error('      首个不一致对象 [obj ' + k + ']')
        console.error('        基准: ' + JSON.stringify((a.get(k) ?? '').slice(0, 200)))
        console.error('        输出: ' + JSON.stringify((b.get(k) ?? '').slice(0, 200)))
      }
      diff++
    }
  }
  assertEq(diff, 0, label + '：' + keysA.length + ' 个对象逐字节一致（差异 ' + diff + ' 个）')
}

/** 收集某个 PDF 里全部图像 XObject：objKey → { width, height, body } */
function imageObjects(bytes: Uint8Array): Map<string, { width: number; height: number; body: string }> {
  const out = new Map<string, { width: number; height: number; body: string }>()
  for (const [key, body] of extractObjects(bytes)) {
    if (!/\/Subtype\s*\/Image\b/.test(body)) continue
    const w = /\/Width\s+(\d+)/.exec(body)
    const h = /\/Height\s+(\d+)/.exec(body)
    out.set(key, { width: w ? Number(w[1]) : -1, height: h ? Number(h[1]) : -1, body })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 内容流解析（含 CTM 求值），用于读回「真画上去的东西」
 * ------------------------------------------------------------------ */

type Mat6 = [number, number, number, number, number, number]

/** m1 · m2（列向量约定，与 PDF 内容流 `cm` 的右乘语义一致） */
function mul(m1: Mat6, m2: Mat6): Mat6 {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ]
}

function applyPoint(m: Mat6, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

const UNIT_CORNERS: Array<[number, number]> = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1]
]

function unitCorners(m: Mat6): Array<[number, number]> {
  return UNIT_CORNERS.map(([u, v]) => applyPoint(m, u, v))
}

function cornersToBox(corners: Array<[number, number]>): {
  x: number
  y: number
  width: number
  height: number
} {
  const xs = corners.map((c) => c[0])
  const ys = corners.map((c) => c[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

interface ParsedPage {
  /** 每个填充路径（顶点已变换到 PDF 用户空间）与当时的填充色 */
  fills: Array<{ coords: Array<[number, number]>; color: number[] }>
  /** 每次 Do 的图像名与用户空间包围盒 */
  dos: Array<{ name: string; box: { x: number; y: number; width: number; height: number }; corners: Array<[number, number]> }>
  raw: string
}

function parsePageOps(text: string): ParsedPage {
  const out: ParsedPage = { fills: [], dos: [], raw: text }
  const tokens = text.split(/[\s\r\n]+/).filter((t) => t !== '')
  const stack: Mat6[] = []
  let ctm: Mat6 = [1, 0, 0, 1, 0, 0]
  const nums: number[] = []
  let lastName = ''
  let fillColor: number[] = [0, 0, 0]
  let path: Array<[number, number]> = []

  const isNum = (t: string): boolean => !t.startsWith('/') && t !== '' && !Number.isNaN(Number(t))

  for (const t of tokens) {
    if (isNum(t)) {
      nums.push(Number(t))
      continue
    }
    switch (t) {
      case 'q':
        stack.push([...ctm] as Mat6)
        break
      case 'Q': {
        const p = stack.pop()
        if (p) ctm = p
        break
      }
      case 'cm':
        if (nums.length >= 6) ctm = mul(ctm, nums.slice(-6) as unknown as Mat6)
        break
      case 'rg':
        if (nums.length >= 3) fillColor = nums.slice(-3)
        break
      case 'g':
        if (nums.length >= 1) {
          const v = nums[nums.length - 1]
          fillColor = [v, v, v]
        }
        break
      case 'm':
      case 'l':
      case 'c':
        if (nums.length >= 2) {
          path.push(applyPoint(ctm, nums[nums.length - 2], nums[nums.length - 1]))
        }
        break
      case 're':
        if (nums.length >= 4) {
          const [x, y, w, h] = nums.slice(-4)
          for (const [ux, uy] of [
            [x, y],
            [x + w, y],
            [x + w, y + h],
            [x, y + h]
          ]) {
            path.push(applyPoint(ctm, ux, uy))
          }
        }
        break
      case 'f':
      case 'F':
      case 'f*':
        if (path.length >= 3) out.fills.push({ coords: path, color: [...fillColor] })
        path = []
        break
      case 'n':
        path = []
        break
      case 'Do':
        out.dos.push({ name: lastName, box: cornersToBox(unitCorners(ctm)), corners: unitCorners(ctm) })
        break
      default:
        if (t.startsWith('/')) lastName = t
        break
    }
    nums.length = 0
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 从 pdf-lib 文档对象里取内容流
 * ------------------------------------------------------------------ */

interface StreamLike {
  getContents?: () => Uint8Array
  getContentsString?: () => string
  contents?: Uint8Array
}

function pageContentRefs(doc: PDFDocument, index: number): unknown[] {
  const node = doc.getPages()[index].node as unknown as { Contents: () => unknown }
  const contents = node.Contents()
  if (!contents) return []
  const arr = contents as { asArray?: () => unknown[] }
  return typeof arr.asArray === 'function' ? arr.asArray() : [contents]
}

/** 页面**全部**内容流的原始字节（未解压；用于「别的页没动」的字节比对） */
function pageStreamBytes(doc: PDFDocument, index: number): Uint8Array {
  let acc = new Uint8Array(0)
  for (const ref of pageContentRefs(doc, index)) {
    const stream = doc.context.lookup(ref as never) as StreamLike
    const bytes = typeof stream.getContents === 'function' ? stream.getContents() : stream.contents ?? new Uint8Array(0)
    const merged = new Uint8Array(acc.length + bytes.length)
    merged.set(acc, 0)
    merged.set(bytes, acc.length)
    acc = merged
  }
  return acc
}

/** 内容流解压：pdf-lib 写入的页面内容流都是 Flate；解不开就当明文原样返回 */
function inflateBytes(bytes: Uint8Array): Uint8Array {
  try {
    const out = zlib.inflateSync(Buffer.from(bytes))
    return new Uint8Array(out)
  } catch {
    return bytes
  }
}

function streamPlain(stream: StreamLike): string {
  const bytes = typeof stream.getContents === 'function' ? stream.getContents() : stream.contents ?? new Uint8Array(0)
  return latin1(inflateBytes(bytes))
}

function refKey(ref: unknown): string {
  const r = ref as { objectNumber?: number; generationNumber?: number }
  if (typeof r.objectNumber === 'number' && typeof r.generationNumber === 'number') {
    return r.objectNumber + ' ' + r.generationNumber
  }
  return String(ref)
}

/** 页面全部内容流的**明文**（逐流解压后拼接） */
function pageOpsText(doc: PDFDocument, index: number): string {
  let text = ''
  for (const ref of pageContentRefs(doc, index)) {
    text += streamPlain(doc.context.lookup(ref as never) as StreamLike)
  }
  return text
}

/**
 * 页面**新增**的算子明文。
 * pdf-lib 追加绘制时只往 Contents 数组尾部注册一条**新流**、原流不动，
 * 因此「输出页的流引用 − 基准页的流引用」就是新增的那些流（对象号由 pdf-lib 保留）。
 * 万一引用比对失效，再退回「输出明文 − 基准明文前缀」。
 */
function appendedOpsText(outDoc: PDFDocument, baseDoc: PDFDocument, index: number): string {
  const baseKeys = new Set(pageContentRefs(baseDoc, index).map(refKey))
  const newRefs = pageContentRefs(outDoc, index).filter((r) => !baseKeys.has(refKey(r)))
  if (newRefs.length > 0) {
    let text = ''
    for (const ref of newRefs) text += streamPlain(outDoc.context.lookup(ref as never) as StreamLike)
    return text
  }
  const full = pageOpsText(outDoc, index)
  const before = pageOpsText(baseDoc, index)
  return before !== '' && full.startsWith(before) ? full.slice(before.length) : full
}

/* ------------------------------------------------------------------ *
 * 造测试素材
 * ------------------------------------------------------------------ */

function makeImages(): { jpeg: Uint8Array; png: Uint8Array } {
  const jc = createCanvas(40, 24)
  const jctx = jc.getContext('2d')
  jctx.fillStyle = '#2f6fd0'
  jctx.fillRect(0, 0, 40, 24)
  jctx.fillStyle = '#ffd400'
  jctx.fillRect(10, 6, 18, 12)

  const pc = createCanvas(28, 18)
  const pctx = pc.getContext('2d')
  pctx.fillStyle = '#1f9d55'
  pctx.fillRect(0, 0, 28, 18)
  pctx.fillStyle = '#ffffff'
  pctx.fillRect(4, 4, 8, 8)

  return { jpeg: toBytes(jc.toBuffer('image/jpeg', 85)), png: toBytes(pc.toBuffer('image/png')) }
}

function dataUrl(mime: string, bytes: Uint8Array): string {
  return 'data:' + mime + ';base64,' + Buffer.from(bytes).toString('base64')
}

async function buildBasePdf(images: { jpeg: Uint8Array; png: Uint8Array }): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const jpg = await doc.embedJpg(images.jpeg)
  const png = await doc.embedPng(images.png)

  const p1 = doc.addPage([600, 400])
  p1.drawImage(jpg, { x: 50, y: 260, width: 200, height: 120 })

  const p2 = doc.addPage([500, 500])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  p2.drawText('page two: text only, no images here', { x: 40, y: 420, size: 18, font, color: rgb(0.1, 0.1, 0.1) })

  const p3 = doc.addPage([400, 300])
  p3.drawImage(png, { x: 100, y: 100, width: 140, height: 90 })

  return doc.save({ useObjectStreams: false })
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const images = makeImages()
  const jpegUrl = dataUrl('image/jpeg', images.jpeg)
  const pngUrl = dataUrl('image/png', images.png)
  console.log('[素材] JPEG ' + images.jpeg.length + ' 字节；PNG ' + images.png.length + ' 字节')

  const base = await buildBasePdf(images)
  console.log('[素材] 测试 PDF ' + base.length + ' 字节（第1页 JPEG / 第2页纯文字 / 第3页 PNG）')
  console.log('       原始图像 XObject: ' + JSON.stringify([...imageObjects(base)].map(([k, v]) => k + '=' + v.width + 'x' + v.height)))

  const baseDoc = await PDFDocument.load(base)
  const basePages = baseDoc.getPages()
  const baseMediaBoxes = basePages.map((p) => p.getMediaBox())
  const baseStream1 = pageStreamBytes(baseDoc, 0)
  const baseStream3 = pageStreamBytes(baseDoc, 2)
  const baseImages = imageObjects(base)

  console.log('\n[A] 零变化：ops=[] 时输出与输入逐对象字节一致')
  const outA = await applyImageOps(base, [])
  console.log('      输入 ' + base.length + ' 字节 / 输出 ' + outA.length + ' 字节')
  assertEq(bytesEqual(outA, base), true, '整体字节完全相同（load+save 往返无损）')
  compareMaps(extractComparableObjects(base), extractComparableObjects(outA), '剔除 XRef/ObjStm 后')

  console.log('\n[B] 不动别的页：只对第 2 页 insert，第 1/3 页内容流与原有图像必须原封不动')
  const insertPng: ImageOp = {
    kind: 'insert',
    page: 1,
    pdfRect: { x: 60, y: 60, width: 84, height: 54 },
    dataUrl: pngUrl,
    coverColor: { r: 1, g: 1, b: 1 }
  }
  const outB = await applyImageOps(base, [insertPng])
  const outBDoc = await PDFDocument.load(outB)
  const outBPages = outBDoc.getPages()
  assertEq(outBPages.length, basePages.length, '页数不变（3）')
  assertEq(
    JSON.stringify(outBPages.map((p) => p.getMediaBox())),
    JSON.stringify(baseMediaBoxes),
    '每页 MediaBox 不变'
  )
  assertEq(bytesEqual(pageStreamBytes(outBDoc, 0), baseStream1), true, '第 1 页内容流字节完全一致（' + baseStream1.length + ' 字节）')
  assertEq(bytesEqual(pageStreamBytes(outBDoc, 2), baseStream3), true, '第 3 页内容流字节完全一致（' + baseStream3.length + ' 字节）')
  assertEq(pageStreamBytes(outBDoc, 1).length > 0, true, '第 2 页确实产生了新内容流')

  const outBImages = imageObjects(outB)
  let imageDrift = 0
  for (const [key, img] of baseImages) {
    const after = outBImages.get(key)
    if (!after || after.body !== img.body) imageDrift++
  }
  assertEq(imageDrift, 0, '原有 ' + baseImages.size + ' 个图像 XObject 原始流字节完全一致')
  assertEq(outBImages.size, baseImages.size + 1, '图像 XObject 数量 2 → 3（新增 1 张）')

  const newImageKeys = [...outBImages.keys()].filter((k) => !baseImages.has(k))
  for (const k of newImageKeys) {
    const img = outBImages.get(k)!
    console.log('      新增图像对象 obj ' + k + '：/Width ' + img.width + ' /Height ' + img.height)
    assertEq(img.width, 28, '新增图像 /Width = 28（与源 PNG 像素宽一致）')
    assertEq(img.height, 18, '新增图像 /Height = 18（与源 PNG 像素高一致）')
  }

  console.log('\n[C] delete 真盖住：断言内容流里出现对应坐标的填充路径')
  const deleteOp: ImageOp = {
    kind: 'delete',
    page: 0,
    pdfRect: { x: 55, y: 265, width: 190, height: 110 },
    coverColor: { r: 0.93, g: 0.93, b: 0.93 }
  }
  const outC = await applyImageOps(base, [deleteOp])
  const outCDoc = await PDFDocument.load(outC)
  const opsC = appendedOpsText(outCDoc, baseDoc, 0)
  console.log('      第 1 页新增算子原文（逐行）:')
  for (const line of opsC.split('\n').filter((l) => l.trim() !== '')) console.log('        | ' + line)
  const parsedC = parsePageOps(opsC)
  assertEq(parsedC.fills.length, 1, '恰好 1 条填充路径')
  assertEq(parsedC.dos.length, 0, '不产生任何 Do（删除不画图）')
  const coverBox = cornersToBox(parsedC.fills[0].coords)
  console.log('      覆盖矩形包围盒: ' + JSON.stringify(coverBox))
  assertNear(coverBox.x, 55, 0.01, '覆盖矩形 x')
  assertNear(coverBox.y, 265, 0.01, '覆盖矩形 y')
  assertNear(coverBox.width, 190, 0.01, '覆盖矩形 width')
  assertNear(coverBox.height, 110, 0.01, '覆盖矩形 height')
  assertNear(parsedC.fills[0].color[0], 0.93, 0.001, '覆盖色 R')
  assertEq(parsedC.fills[0].color.length, 3, '覆盖色为 3 通道 RGB')

  console.log('\n[D] insert / replace / move 真画上去：读回 cm 矩阵验证绘制宽高')

  console.log('  [D1] insert 到第 2 页（纯文字页）')
  const opsD1 = appendedOpsText(outBDoc, baseDoc, 1)
  console.log('      新增算子原文:')
  for (const line of opsD1.split('\n').filter((l) => l.trim() !== '')) console.log('        | ' + line)
  const parsedD1 = parsePageOps(opsD1)
  assertEq(parsedD1.dos.length, 1, 'Do 出现 1 次')
  assertEq(parsedD1.fills.length, 0, 'insert 不画覆盖矩形')
  console.log('      图像包围盒: ' + JSON.stringify(parsedD1.dos[0].box))
  assertNear(parsedD1.dos[0].box.x, 60, 0.01, 'insert 图像 x')
  assertNear(parsedD1.dos[0].box.y, 60, 0.01, 'insert 图像 y')
  assertNear(parsedD1.dos[0].box.width, 84, 0.01, 'insert 图像 width = pdfRect.width')
  assertNear(parsedD1.dos[0].box.height, 54, 0.01, 'insert 图像 height = pdfRect.height')

  console.log('  [D2] replace 第 1 页原 JPEG 位置')
  const replaceOp: ImageOp = {
    kind: 'replace',
    page: 0,
    pdfRect: { x: 50, y: 260, width: 200, height: 120 },
    dataUrl: pngUrl,
    coverColor: { r: 1, g: 1, b: 1 }
  }
  const outD2 = await applyImageOps(base, [replaceOp])
  const outD2Doc = await PDFDocument.load(outD2)
  const parsedD2 = parsePageOps(appendedOpsText(outD2Doc, baseDoc, 0))
  console.log('      覆盖路径 ' + parsedD2.fills.length + ' 条 / Do ' + parsedD2.dos.length + ' 次')
  console.log('      覆盖包围盒: ' + JSON.stringify(cornersToBox(parsedD2.fills[0].coords)))
  console.log('      图像包围盒: ' + JSON.stringify(parsedD2.dos[0].box))
  assertEq(parsedD2.fills.length, 1, 'replace 先画 1 条覆盖矩形')
  assertEq(parsedD2.dos.length, 1, 'replace 再画 1 次图像')
  assertNear(cornersToBox(parsedD2.fills[0].coords).x, 50, 0.01, '覆盖矩形 x = 原位置 x')
  assertNear(parsedD2.dos[0].box.width, 200, 0.01, '新图 width = pdfRect.width')
  assertNear(parsedD2.dos[0].box.height, 120, 0.01, '新图 height = pdfRect.height')

  console.log('  [D3] move 第 3 页 100,100,140,90 → 220,40,80,60')
  const moveOp: ImageOp = {
    kind: 'move',
    page: 2,
    pdfRect: { x: 100, y: 100, width: 140, height: 90 },
    targetRect: { x: 220, y: 40, width: 80, height: 60 },
    dataUrl: pngUrl,
    coverColor: { r: 1, g: 1, b: 1 }
  }
  const outD3 = await applyImageOps(base, [moveOp])
  const outD3Doc = await PDFDocument.load(outD3)
  const parsedD3 = parsePageOps(appendedOpsText(outD3Doc, baseDoc, 2))
  const coverD3 = cornersToBox(parsedD3.fills[0].coords)
  console.log('      覆盖包围盒: ' + JSON.stringify(coverD3))
  console.log('      图像包围盒: ' + JSON.stringify(parsedD3.dos[0].box))
  assertEq(parsedD3.fills.length, 1, 'move 先盖住原位置')
  assertEq(parsedD3.dos.length, 1, 'move 再在目标位置画 1 次')
  assertNear(coverD3.x, 100, 0.01, '覆盖矩形 x = 原 pdfRect.x')
  assertNear(coverD3.width, 140, 0.01, '覆盖矩形 width = 原 pdfRect.width')
  assertNear(parsedD3.dos[0].box.x, 220, 0.01, '图像 x = targetRect.x')
  assertNear(parsedD3.dos[0].box.y, 40, 0.01, '图像 y = targetRect.y')
  assertNear(parsedD3.dos[0].box.width, 80, 0.01, '图像 width = targetRect.width')
  assertNear(parsedD3.dos[0].box.height, 60, 0.01, '图像 height = targetRect.height')

  console.log('  [D4] 数组顺序 = 绘制顺序（后画的在上层）')
  const multi: ImageOp[] = [
    { kind: 'insert', page: 1, pdfRect: { x: 10, y: 10, width: 50, height: 50 }, dataUrl: pngUrl, coverColor: { r: 1, g: 1, b: 1 } },
    { kind: 'insert', page: 1, pdfRect: { x: 30, y: 30, width: 50, height: 50 }, dataUrl: jpegUrl, coverColor: { r: 1, g: 1, b: 1 } }
  ]
  const outD4 = await applyImageOps(base, multi)
  const outD4Doc = await PDFDocument.load(outD4)
  const parsedD4 = parsePageOps(appendedOpsText(outD4Doc, baseDoc, 1))
  assertEq(parsedD4.dos.length, 2, 'Do 出现 2 次')
  assertNear(parsedD4.dos[0].box.x, 10, 0.01, '第 1 次 Do 落在 (10,10)')
  assertNear(parsedD4.dos[1].box.x, 30, 0.01, '第 2 次 Do 落在 (30,30)（后画 ⇒ 上层）')

  console.log('\n[E] 旋转补偿：rotate=90 时图像包围盒必须仍落在 pdfRect 内')
  const rectE = { x: 100, y: 100, width: 120, height: 80 }
  const rotateOp: ImageOp = {
    kind: 'insert',
    page: 1,
    pdfRect: rectE,
    dataUrl: pngUrl,
    coverColor: { r: 1, g: 1, b: 1 },
    rotate: 90
  }
  const outE = await applyImageOps(base, [rotateOp])
  const outEDoc = await PDFDocument.load(outE)
  const parsedE = parsePageOps(appendedOpsText(outEDoc, baseDoc, 1))
  const cornersE = parsedE.dos[0].corners
  console.log('      pdfRect = ' + JSON.stringify(rectE))
  console.log('      旋转后四角坐标:')
  for (const c of cornersE) console.log('        (' + c[0].toFixed(3) + ', ' + c[1].toFixed(3) + ')')
  console.log('      包围盒 = ' + JSON.stringify(parsedE.dos[0].box))
  const inside = cornersE.every(
    (c) =>
      c[0] >= rectE.x - 1 &&
      c[0] <= rectE.x + rectE.width + 1 &&
      c[1] >= rectE.y - 1 &&
      c[1] <= rectE.y + rectE.height + 1
  )
  assert(inside, '四个角全部落在 pdfRect 内（容差 1pt）')
  assert(parsedE.dos[0].box.width <= rectE.width + 1, '包围盒宽 ' + parsedE.dos[0].box.width.toFixed(3) + ' ≤ 120 + 1')
  assert(parsedE.dos[0].box.height <= rectE.height + 1, '包围盒高 ' + parsedE.dos[0].box.height.toFixed(3) + ' ≤ 80 + 1')

  console.log('  [E2] rotate=180 时包围盒仍需铺满原框')
  const rectE2 = { x: 40, y: 50, width: 90, height: 70 }
  const outE2 = await applyImageOps(base, [
    { kind: 'insert', page: 1, pdfRect: rectE2, dataUrl: pngUrl, coverColor: { r: 1, g: 1, b: 1 }, rotate: 180 }
  ])
  const parsedE2 = parsePageOps(appendedOpsText(await PDFDocument.load(outE2), baseDoc, 1))
  console.log('      包围盒 = ' + JSON.stringify(parsedE2.dos[0].box))
  assertNear(parsedE2.dos[0].box.x, 40, 0.01, '180° 包围盒 x')
  assertNear(parsedE2.dos[0].box.y, 50, 0.01, '180° 包围盒 y')
  assertNear(parsedE2.dos[0].box.width, 90, 0.01, '180° 包围盒 width')
  assertNear(parsedE2.dos[0].box.height, 70, 0.01, '180° 包围盒 height')

  console.log('\n[F] 边界防御：非法输入必须抛可读 Error')
  await assertRejects(() => applyImageOps(base, null as unknown as ImageOp[]), /ops 必须是数组/, 'ops 不是数组')
  await assertRejects(
    () => applyImageOps(base, [{ ...deleteOp, pdfRect: { x: 0, y: 0, width: 0, height: 10 } }]),
    /width\/height 必须为正数/,
    'pdfRect.width = 0'
  )
  await assertRejects(
    () => applyImageOps(base, [{ ...deleteOp, pdfRect: { x: 0, y: 0, width: 10, height: -5 } }]),
    /width\/height 必须为正数/,
    'pdfRect.height < 0'
  )
  await assertRejects(
    () => applyImageOps(base, [{ ...deleteOp, page: 9 }]),
    /page 越界/,
    'page 越界（9）'
  )
  await assertRejects(
    () => applyImageOps(base, [{ ...deleteOp, coverColor: undefined as unknown as { r: number; g: number; b: number } }]),
    /coverColor 缺失/,
    'delete 缺 coverColor（不得白色兜底）'
  )
  await assertRejects(
    () => applyImageOps(base, [{ ...deleteOp, coverColor: { r: Number.NaN, g: 0, b: 0 } }]),
    /coverColor\.r 必须是有限数字/,
    'coverColor.r = NaN'
  )
  await assertRejects(
    () =>
      applyImageOps(base, [
        { ...deleteOp, kind: 'move', dataUrl: pngUrl, targetRect: { x: 1, y: 1, width: 10, height: 10 }, coverColor: { r: 0, g: 0, b: Number.POSITIVE_INFINITY } }
      ]),
    /coverColor\.b 必须是有限数字/,
    'coverColor.b = Infinity'
  )
  await assertRejects(
    () => applyImageOps(base, [{ kind: 'insert', page: 1, pdfRect: { x: 1, y: 1, width: 10, height: 10 }, coverColor: { r: 1, g: 1, b: 1 } }]),
    /缺少 dataUrl/,
    'insert 缺 dataUrl'
  )
  await assertRejects(
    () =>
      applyImageOps(base, [
        { kind: 'replace', page: 1, pdfRect: { x: 1, y: 1, width: 10, height: 10 }, coverColor: { r: 1, g: 1, b: 1 } }
      ]),
    /缺少 dataUrl/,
    'replace 缺 dataUrl'
  )
  await assertRejects(
    () =>
      applyImageOps(base, [
        { kind: 'move', page: 1, pdfRect: { x: 1, y: 1, width: 10, height: 10 }, dataUrl: pngUrl, coverColor: { r: 1, g: 1, b: 1 } }
      ]),
    /缺少 targetRect/,
    'move 缺 targetRect'
  )
  await assertRejects(
    () =>
      applyImageOps(base, [
        { kind: 'insert', page: 1, pdfRect: { x: 1, y: 1, width: 10, height: 10 }, dataUrl: pngUrl, coverColor: { r: 1, g: 1, b: 1 }, rotate: Number.NaN }
      ]),
    /rotate 必须是有限数字/,
    'rotate = NaN'
  )
  await assertRejects(
    () =>
      applyImageOps(base, [
        { kind: 'insert', page: 1, pdfRect: { x: 1, y: 1, width: 10, height: 10 }, dataUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', coverColor: { r: 1, g: 1, b: 1 } }
      ]),
    /不支持的图片格式/,
    '不支持的 MIME（image/gif）'
  )
  await assertRejects(
    () =>
      applyImageOps(base, [
        { kind: 'insert', page: 1, pdfRect: { x: 1, y: 1, width: 10, height: 10 }, dataUrl: 'not-a-data-url', coverColor: { r: 1, g: 1, b: 1 } }
      ]),
    /不是合法的 data: URL/,
    'dataUrl 不是 data: 开头'
  )

  console.log('\n[G] 合法性：全部输出都能被 pdf-lib 重新 load，页数与页面尺寸不变')
  for (const [label, bytes] of [
    ['outA(空操作)', outA],
    ['outB(insert)', outB],
    ['outC(delete)', outC],
    ['outD2(replace)', outD2],
    ['outD3(move)', outD3],
    ['outE(rotate90)', outE]
  ] as Array<[string, Uint8Array]>) {
    const doc = await PDFDocument.load(bytes)
    const boxes = doc.getPages().map((p) => JSON.stringify(p.getMediaBox()))
    assertEq(doc.getPageCount(), 3, label + ' 重新 load 后页数 = 3')
    assertEq(boxes.join('|'), baseMediaBoxes.map((b) => JSON.stringify(b)).join('|'), label + ' 每页 MediaBox 不变')
  }

  console.log('\n通过 ' + passed + '/' + (passed + failed))
  if (failed > 0) {
    console.error('失败 ' + failed + ' 项')
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('未捕获错误:', e)
  process.exitCode = 1
})
