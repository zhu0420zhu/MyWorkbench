/**
 * PDF 文本层清理（pdfTextLayerScrub）端到端 + 纯函数验收。
 *
 * 运行（managed node 22）：
 *   "C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" \
 *     --experimental-strip-types tests/pdf-text-scrub.ts
 *
 * 说明：仓库里的 src 模块互相用「无扩展名」相对导入（typecheck:web 的
 * moduleResolution=bundler 要求如此），无头 node 直跑需要补 .ts。这里在测试内部
 * 用 `module.register()` 装上仓库自带的 tests/loader.mjs，于是上面那条命令即可直接跑。
 *
 * 环境：真 canvas（@napi-rs/canvas）——既给 pdf.js 提供渲染后端做**逐像素差分**，
 * 也当 `document.createElement('canvas')` 的真后端给中文栅格路径用。
 *
 * 覆盖面：
 *   0. 纯函数：内容流外科式移除的各种正例/反例（保守放弃路径）
 *   1. 端到端 A：自造 3 页 ASCII PDF（第 1 页含真实 JPEG）替换第 2 页一行
 *      —— 旧文字消失 / 未编辑内容不变 / 像素差分 0 / 字节与对象不变 / 向后兼容
 *   2. 端到端 B：真实世界 PDF（qa-fixtures/real-large-plain.pdf）
 *   3. 端到端 C：soffice 产出的中文 PDF（真 CJK 文本层）
 *   4. 退化输入与输出合法性
 */
import { register } from 'node:module'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createCanvas, Path2D, ImageData, DOMMatrix } from '@napi-rs/canvas'
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, rgb } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

register(new URL('./loader.mjs', import.meta.url).href)

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const WORK = join(HERE, 'pdf-audit', 'scratch', 'scrub-work')
const SOFFICE = join(ROOT, 'resources', 'tools', 'soffice', 'program', 'soffice.com')

/* ---------------- 真 canvas 后端 ---------------- */
globalThis.Path2D = Path2D as unknown as typeof Path2D
globalThis.ImageData = ImageData as unknown as typeof ImageData
globalThis.DOMMatrix = DOMMatrix as unknown as typeof DOMMatrix
globalThis.document = {
  createElement: (tag: string) => {
    if (tag !== 'canvas') throw new Error('unsupported element: ' + tag)
    return createCanvas(1, 1)
  }
} as unknown as Document

/* ---------------- 断言器 ---------------- */
let pass = 0
let fail = 0
const failures: string[] = []
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log('  [PASS] ' + name + (detail ? '  ' + detail : ''))
  } else {
    fail++
    failures.push(name)
    console.log('  [FAIL] ' + name + (detail ? '  ' + detail : ''))
  }
}
function info(msg: string): void {
  console.log('  · ' + msg)
}
function section(t: string): void {
  console.log('\n=== ' + t + ' ===')
}
const sha1 = (b: Uint8Array | Buffer): string => createHash('sha1').update(Buffer.from(b)).digest('hex')
/** 子串出现次数 */
const occ = (hay: string, needle: string): number => (needle ? hay.split(needle).length - 1 : 0)

/* ---------------- pdf-lib / pdf.js 工具 ---------------- */

/** 枚举文档内全部流（含 Type/Subtype/长度/sha1），用于对象级字节比对 */
async function streamInventory(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const items: Array<{ ref: string; type: string; subtype: string; len: number; sha: string }> = []
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue
    const raw = Buffer.from(obj.contents)
    items.push({
      ref: ref.toString(),
      type: obj.dict.get(PDFName.of('Type'))?.toString() ?? '',
      subtype: obj.dict.get(PDFName.of('Subtype'))?.toString() ?? '',
      len: raw.length,
      sha: sha1(raw)
    })
  }
  return items
}
const isStructural = (it: { type: string }): boolean => it.type === '/XRef' || it.type === '/ObjStm'

/** 某页原始内容流字节（解压前，逐段拼接） */
async function pageContentsRaw(bytes: Uint8Array, pageIndex: number): Promise<Buffer> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const node = doc.getPage(pageIndex).node
  const c = node.get(PDFName.of('Contents'))
  const parts: Buffer[] = []
  const one = (x: unknown): void => {
    const o = x && (x as { asArray?: unknown }).asArray ? null : (doc.context.lookup(x as never) as PDFRawStream | undefined)
    if (o && (o as PDFRawStream).contents) parts.push(Buffer.from((o as PDFRawStream).contents))
  }
  if (c && typeof (c as { asArray?: unknown }).asArray === 'function') {
    ;(c as unknown as { asArray: () => unknown[] }).asArray().forEach(one)
  } else if (c) one(c)
  return Buffer.concat(parts)
}

interface PdfJsViewport {
  width: number
  height: number
  transform: number[]
  convertToViewportPoint: (x: number, y: number) => number[]
  convertToPdfPoint: (x: number, y: number) => number[]
}

interface PdfJsDoc {
  numPages: number
  getPage: (n: number) => Promise<{
    getViewport: (o: { scale: number }) => PdfJsViewport
    getTextContent: () => Promise<{ items: Array<Record<string, unknown>> }>
    render: (o: Record<string, unknown>) => { promise: Promise<void> }
  }>
  destroy?: () => Promise<void>
}

async function withPdfjs<T>(bytes: Uint8Array, fn: (pdf: PdfJsDoc) => Promise<T>): Promise<T> {
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: join(ROOT, 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/',
    cMapUrl: join(ROOT, 'node_modules', 'pdfjs-dist', 'cmaps') + '/',
    cMapPacked: true,
    disableWorker: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0
  })
  const pdf = (await task.promise) as unknown as PdfJsDoc
  try {
    return await fn(pdf)
  } finally {
    if (task.destroy) await task.destroy()
  }
}

/** 逐页提取可见文本（按 pdf.js 的文本层，未渲染） */
async function extractText(bytes: Uint8Array): Promise<string[]> {
  return withPdfjs(bytes, async (pdf) => {
    const out: string[] = []
    for (let i = 1; i <= pdf.numPages; i++) {
      const p = await pdf.getPage(i)
      const tc = await p.getTextContent()
      out.push(tc.items.map((it) => String(it.str ?? '')).join(''))
    }
    return out
  })
}

interface ItemGeom {
  str: string
  x: number
  baseline: number
  width: number
  fontSize: number
}

/** 取某页所有文本项在 PDF 用户坐标下的几何（与 pdfTextBlocks 的换算一致） */
async function pageItemGeoms(bytes: Uint8Array, pageIndex: number): Promise<ItemGeom[]> {
  return withPdfjs(bytes, async (pdf) => {
    const page = await pdf.getPage(pageIndex + 1)
    const vp = page.getViewport({ scale: 1 })
    const tc = await page.getTextContent()
    const out: ItemGeom[] = []
    for (const raw of tc.items) {
      const str = typeof raw.str === 'string' ? raw.str : ''
      if (str === '') continue
      const tr = Array.isArray(raw.transform) ? (raw.transform as number[]) : [1, 0, 0, 1, 0, 0]
      const t = (pdfjs.Util as unknown as { transform: (a: number[], b: number[]) => number[] }).transform(vp.transform, tr)
      const pdfPoint = vp.convertToPdfPoint(t[4], t[5])
      out.push({
        str,
        x: pdfPoint[0],
        baseline: pdfPoint[1],
        width: typeof raw.width === 'number' && Number.isFinite(raw.width) ? raw.width : 0,
        fontSize: Math.hypot(tr[2], tr[3]) || (typeof raw.height === 'number' ? raw.height : 12)
      })
    }
    return out
  })
}

interface Rendered {
  data: Uint8ClampedArray
  width: number
  height: number
  vp: { convertToViewportPoint: (x: number, y: number) => number[] }
}

/** 用 pdf.js 把某页渲染到 @napi-rs/canvas，拿像素 */
async function renderPage(bytes: Uint8Array, pageIndex: number, scale: number): Promise<Rendered> {
  return withPdfjs(bytes, async (pdf) => {
    const page = await pdf.getPage(pageIndex + 1)
    const vp = page.getViewport({ scale })
    const canvas = createCanvas(Math.max(1, Math.round(vp.width)), Math.max(1, Math.round(vp.height)))
    const ctx = canvas.getContext('2d')
    await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    return { data: img.data as unknown as Uint8ClampedArray, width: canvas.width, height: canvas.height, vp }
  })
}

interface DiffResult {
  total: number
  outside: number
  inside: number
  firstOutside: string
}

/** 逐像素差分；exclude 是 PDF 用户坐标下允许变化的矩形列表 */
function diffPixels(a: Rendered, b: Rendered, exclude: Array<{ x: number; y: number; width: number; height: number }>): DiffResult {
  if (a.width !== b.width || a.height !== b.height) {
    return { total: -1, outside: -1, inside: -1, firstOutside: `尺寸不同 ${a.width}x${a.height} vs ${b.width}x${b.height}` }
  }
  const boxes = exclude.map((r) => {
    const p1 = a.vp.convertToViewportPoint(r.x, r.y + r.height)
    const p2 = a.vp.convertToViewportPoint(r.x + r.width, r.y)
    const x0 = Math.floor(Math.min(p1[0], p2[0]))
    const x1 = Math.ceil(Math.max(p1[0], p2[0]))
    const y0 = Math.floor(Math.min(p1[1], p2[1]))
    const y1 = Math.ceil(Math.max(p1[1], p2[1]))
    return { x0, x1, y0, y1 }
  })
  let total = 0
  let outside = 0
  let inside = 0
  let firstOutside = ''
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const o = (y * a.width + x) * 4
      if (a.data[o] === b.data[o] && a.data[o + 1] === b.data[o + 1] && a.data[o + 2] === b.data[o + 2] && a.data[o + 3] === b.data[o + 3]) continue
      total++
      const inBox = boxes.some((bx) => x >= bx.x0 && x < bx.x1 && y >= bx.y0 && y < bx.y1)
      if (inBox) inside++
      else {
        outside++
        if (!firstOutside) firstOutside = `(${x},${y}) ${a.data[o]},${a.data[o + 1]},${a.data[o + 2]},${a.data[o + 3]}→${b.data[o]},${b.data[o + 1]},${b.data[o + 2]},${b.data[o + 3]}`
      }
    }
  }
  return { total, outside, inside, firstOutside }
}

/**
 * 生成并加载「没有文本层清理功能」的等价实现，用于**逐字节**证明向后兼容。
 *
 * 做法：读当前 pdfInPlaceReplace.ts，剥掉 `#region scrub-optional` … `#endregion`
 * 之间的整段（本功能的唯一改动点）与新增的 import，再把无扩展名相对导入改成绝对
 * file: URL，写到工作目录后动态 import。
 *
 * 之所以不直接 `git show HEAD:`：本机沙箱禁止 spawn git/cmd（ERR EBUSY），
 * 拿不到旧版源码；剥标记的方案等价且不依赖 git。
 */
async function runLegacyImplementation(
  bytes: Uint8Array,
  reps: unknown[],
  annotations: unknown[]
): Promise<Uint8Array | null> {
  try {
    const { pathToFileURL } = await import('node:url')
    const cur = await readFile(join(ROOT, 'src', 'renderer', 'src', 'utils', 'pdfInPlaceReplace.ts'), 'utf8')
    const START = '// #region scrub-optional'
    const END = '// #endregion scrub-optional'
    const a = cur.indexOf(START)
    const b = cur.indexOf(END)
    if (a < 0 || b < 0 || !cur.includes('scrubPdfTextLayer(doc, targets)')) return null
    const stripped = cur
      .slice(0, a)
      .concat(cur.slice(b + END.length))
      .replace(/^import \{ scrubPdfTextLayer \} from '\.\/pdfTextLayerScrub'\n/gm, '')
      .replace(/^import type \{ PdfTextScrubTarget \} from '\.\/pdfTextLayerScrub'\n/gm, '')
    if (stripped.includes('scrubPdfTextLayer(doc, targets)')) return null // 剥离失败即放弃
    const base = pathToFileURL(join(ROOT, 'src', 'renderer', 'src', 'utils') + '/').href
    const patched = stripped.replace(/from '\.\/([A-Za-z0-9_]+)'/g, (_m, name: string) => `from '${base}${name}.ts'`)
    const file = join(WORK, 'legacy-pdfInPlaceReplace.ts')
    await writeFile(file, patched, 'utf8')
    const mod = (await import(pathToFileURL(file).href)) as {
      replacePdfText: (b: Uint8Array, r: unknown[], a?: unknown[]) => Promise<Uint8Array>
    }
    return await mod.replacePdfText(bytes, reps, annotations)
  } catch {
    return null
  }
}

/** 覆盖矩形（与 pdfInPlaceReplace 的 pad 规则一致） */function coverRect(rect: { x: number; y: number; width: number; height: number }, fontSize: number) {
  const pad = Math.min(1, fontSize * 0.25)
  return { x: rect.x - pad, y: rect.y - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }
}

/* ---------------- 素材 ---------------- */

const ASCII_TARGET_OLD = 'PAGE-TWO-TARGET-OLD'
const ASCII_TARGET_NEW = 'PAGE-TWO-NEW-TEXT'
const ASCII_KEEP = ['PAGE-ONE-KEEP-ALPHA', 'PAGE-ONE-KEEP-BETA', 'PAGE-TWO-KEEP-GAMMA', 'PAGE-THREE-KEEP-DELTA', 'PAGE-THREE-KEEP-EPSILON']

async function makeJpeg(w = 160, h = 100): Promise<Uint8Array> {
  const c = createCanvas(w, h)
  const ctx = c.getContext('2d')
  const g = ctx.createLinearGradient(0, 0, w, h)
  g.addColorStop(0, '#1e63b0')
  g.addColorStop(1, '#f2c14e')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#111'
  ctx.font = 'bold 20px sans-serif'
  ctx.fillText('JPEG', 12, 40)
  return new Uint8Array(await c.encode('jpeg', 82))
}

/** 3 页 ASCII：第 1 页含真实 JPEG 图像，第 2 页含待替换行，第 3 页纯文字 */
async function makeAsciiPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const PAGES = [
    ['PAGE-ONE-KEEP-ALPHA', 'PAGE-ONE-KEEP-BETA'],
    [ASCII_TARGET_OLD, 'PAGE-TWO-KEEP-GAMMA'],
    ['PAGE-THREE-KEEP-DELTA', 'PAGE-THREE-KEEP-EPSILON']
  ]
  const img = await doc.embedJpg(await makeJpeg())
  PAGES.forEach((lines, i) => {
    const p = doc.addPage([595.28, 841.89])
    if (i === 0) p.drawImage(img, { x: 380, y: 640, width: 160, height: 100 })
    lines.forEach((t, k) => {
      p.drawText(t, { x: 60, y: 760 - k * 30, size: 14, font, color: rgb(0, 0, 0) })
    })
  })
  return await doc.save()
}

/** 用 soffice 把一个含中文的 HTML 转成多页 PDF（真 CJK 文本层） */
async function makeCjkPdf(): Promise<Uint8Array | null> {
  const tmp = join(WORK, 'cjk')
  await mkdir(tmp, { recursive: true })
  let body = '<h1>季度经营分析报告</h1>'
  for (let i = 1; i <= 90; i++) body += `<p>第 ${i} 行：这是原始正文，用于验证就地改字后其余内容仍在，ASCII abc ${i}。</p>`
  body += '<p>末行：这一页完全不动 QATHIRD。</p>'
  const src = join(tmp, 'doc.html')
  await writeFile(src, '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' + body + '</body></html>', 'utf-8')
  const env = { ...process.env }
  delete env.PYTHONPATH
  delete env.PYTHONHOME
  delete env.PYTHONSTARTUP
  await new Promise<void>((resolve) => {
    const ch = spawn(
      SOFFICE,
      ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', tmp.replace(/\\/g, '/'), src.replace(/\\/g, '/')],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env }
    )
    const timer = setTimeout(() => ch.kill(), 120000)
    ch.on('close', () => {
      clearTimeout(timer)
      resolve()
    })
    ch.on('error', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  const out = join(tmp, 'doc.pdf')
  return existsSync(out) ? new Uint8Array(await readFile(out)) : null
}

/* ================================================================
 * 0. 纯函数：内容流外科式移除
 * ================================================================ */
const { scrubContentStream } = await import('../src/renderer/src/utils/pdfTextLayerScrub.ts')

function geom(x: number, baseline: number, width: number, fontSize: number) {
  return { rect: { x, y: baseline - fontSize * 0.2, width, height: fontSize }, baseline, fontSize }
}
/** 该几何在内容流里是否还留有 Tj/TJ？ */
const stillShows = (s: string): boolean => /(^|\s)(Tj|TJ|'|")(\s|$)/.test(s)

section('0. 纯函数：scrubContentStream 正例')
{
  const cs = 'q BT /F1 14 Tf 1 0 0 1 60 760 Tm (PAGE-TWO-TARGET-OLD) Tj ET Q'
  const r = scrubContentStream(cs, [geom(60, 760, 120, 14)])
  ok('单 Tj 命中即删除', r.showsRemoved === 1 && r.matched === 1 && !r.out.includes('PAGE-TWO-TARGET-OLD'), 'showsRemoved=' + r.showsRemoved)
  ok('删除后 BT/ET 与图形状态算子保留（不泄漏状态）', /BT/.test(r.out) && /ET/.test(r.out) && /14 Tf/.test(r.out) && /rg|Tm/.test(r.out))
  ok('删除后不再有显示算子', !stillShows(r.out))

  const tj = 'BT /F1 12 Tf 1 0 0 1 90 757.92 Tm [( )] TJ ET BT /F1 21.96 Tf 1 0 0 1 143.9 712.18 Tm [(QQ)4(Pla)-4(y)-5(er)] TJ ET'
  const r2 = scrubContentStream(tj, [geom(143.9, 712.18, 90, 21.96)])
  ok('TJ 数组（含数字字距）整段删除且不误伤相邻 BT 块', r2.showsRemoved === 1 && r2.out.includes('[( )] TJ') && !r2.out.includes('QQ') && !r2.out.includes('Pla'))

  const t2 = 'BT /F1 12 Tf 1 0 0 1 60 700 Tm (AB) Tj 8 0 Td (CD) Tj ET'
  const r3 = scrubContentStream(t2, [geom(60, 700, 40, 12)])
  ok('同一 BT 块内多个 Tj、全部落在目标框内 → 全删', r3.showsRemoved === 2 && !r3.out.includes('(AB)') && !r3.out.includes('(CD)'))

  const quote = "BT /F1 12 Tf 14 TL 1 0 0 1 60 700 Tm (QUOTED) ' ET"
  const r4 = scrubContentStream(quote, [geom(60, 686, 60, 12)])
  ok("单独的块里 ' 算子（T* + show）能被删除", r4.showsRemoved === 1 && !r4.out.includes('QUOTED'))

  const twoLine = "BT /F1 12 Tf 14 TL 1 0 0 1 60 700 Tm (A) Tj T* (QUOTED) Tj ET"
  const r4b = scrubContentStream(twoLine, [geom(60, 686, 60, 12)])
  ok('同一块里含另一行 → 放弃（block-spans-target-rect）', r4b.showsRemoved === 0 && r4b.reasons['block-spans-target-rect'] === 1, JSON.stringify(r4b.reasons))

  const dquote = 'BT /F1 12 Tf 14 TL 2 Tw 1 Tc 1 0 0 1 60 700 Tm (DQ) " ET'
  const r4c = scrubContentStream(dquote, [geom(60, 686, 40, 12)])
  ok('" 算子（aw ac + T* + show）也能删除', r4c.showsRemoved === 1 && !r4c.out.includes('(DQ)'))

  const tiled = 'BT /F1 12 Tf 1 0 0 1 60 700 Tm (AAA) Tj ET BT /F1 12 Tf 1 0 0 1 90 700 Tm (BBB) Tj ET BT /F1 12 Tf 1 0 0 1 120 700 Tm (CCC) Tj ET'
  const r7 = scrubContentStream(tiled, [geom(60, 700, 90, 12)])
  ok('一个 run 被拆成多个 BT 块（首尾相接）→ 全部删除', r7.showsRemoved === 3 && r7.blocksCleared === 3 && !r7.out.includes('AAA') && !r7.out.includes('BBB') && !r7.out.includes('CCC'))

  const halfTiled = 'BT /F1 12 Tf 1 0 0 1 60 700 Tm (AAA) Tj ET BT /F1 12 Tf 1 0 0 1 90 700 Tm (BBB) Tj ET BT /F1 12 Tf 1 0 0 1 300 700 Tm (FAR) Tj ET'
  const r8 = scrubContentStream(halfTiled, [geom(60, 700, 90, 12)])
  ok('run 外的同 y 文本块不受影响', r8.showsRemoved === 2 && r8.out.includes('(FAR)') && !r8.out.includes('AAA'))

  const scaled = 'q 2 0 0 2 0 0 cm BT /F1 12 Tf 1 0 0 1 30 350 Tm (SCALED) Tj ET Q'
  const r5 = scrubContentStream(scaled, [geom(60, 700, 90, 24)])
  ok('cm 缩放下的坐标/字号换算正确（12pt×2=24pt，30,350×2=60,700）', r5.showsRemoved === 1 && !r5.out.includes('SCALED'))

  const hex = 'BT /F1 13 Tf 1 0 0 1 40 320 Tm <506167652054776F> Tj ET'
  const r6 = scrubContentStream(hex, [geom(40, 320, 80, 13)])
  ok('十六进制串（<...>）路径命中', r6.showsRemoved === 1 && !r6.out.includes('50616765'))
}

section('0b. 纯函数：保守放弃路径（必须一条都不删）')
{
  const whole = 'BT /F1 12 Tf 1 0 0 1 60 700 Tm (LEFT-PART) Tj 100 0 Td (RIGHT-PART) Tj ET'
  const r = scrubContentStream(whole, [geom(60, 700, 60, 12)])
  ok('一个 BT 块里含目标框外的显示算子 → 整块放弃', r.showsRemoved === 0 && r.skipped === 1 && r.reasons['block-spans-target-rect'] === 1, JSON.stringify(r.reasons))

  const dup = 'BT /F1 12 Tf 1 0 0 1 60 700 Tm (DUP) Tj ET BT /F1 12 Tf 1 0 0 1 60 700 Tm (DUP) Tj ET'
  const r2 = scrubContentStream(dup, [geom(60, 700, 40, 12)])
  ok('两个块都认领同一个 run 起点 → 判为歧义、一条不删', r2.showsRemoved === 0 && r2.reasons['ambiguous-run-start'] === 1, JSON.stringify(r2.reasons))

  const noStart = 'BT /F1 12 Tf 1 0 0 1 100 700 Tm (MID) Tj ET'
  const r2b = scrubContentStream(noStart, [geom(60, 700, 200, 12)])
  ok('没有块落在 run 起点（只有中段）→ 放弃', r2b.showsRemoved === 0 && r2b.reasons['run-start-not-matched'] === 1, JSON.stringify(r2b.reasons))

  const stroke = 'BT /F1 12 Tf 1 Tr 1 0 0 1 60 700 Tm (STROKED) Tj ET'
  const r3 = scrubContentStream(stroke, [geom(60, 700, 60, 12)])
  ok('描边渲染模式(Tr=1)会画出外扩墨迹 → 放弃', r3.showsRemoved === 0 && r3.reasons['unsupported-render-mode'] === 1, JSON.stringify(r3.reasons))

  const clip = 'BT /F1 12 Tf 7 Tr 1 0 0 1 60 700 Tm (CLIPONLY) Tj ET'
  const r4 = scrubContentStream(clip, [geom(60, 700, 60, 12)])
  ok('裁剪渲染模式(Tr=7)建立裁剪路径 → 放弃', r4.showsRemoved === 0 && r4.reasons['unsupported-render-mode'] === 1)

  const invisible = 'BT /F1 12 Tf 3 Tr 1 0 0 1 60 700 Tm (INVIS) Tj ET'
  const r5 = scrubContentStream(invisible, [geom(60, 700, 60, 12)])
  ok('不可见文本(Tr=3)在文本层里但看不见 → 允许删除', r5.showsRemoved === 1)

  const far = 'BT /F1 12 Tf 1 0 0 1 60 300 Tm (FARAWAY) Tj ET'
  const r6 = scrubContentStream(far, [geom(60, 700, 60, 12)])
  ok('附近没有对应文本块 → 放弃且原因是 no-nearby-text-block', r6.showsRemoved === 0 && r6.reasons['no-nearby-text-block'] === 1, JSON.stringify(r6.reasons))

  const xobj = 'q /Fm0 Do Q BT /F1 12 Tf 1 0 0 1 60 300 Tm (FARAWAY) Tj ET'
  const r7 = scrubContentStream(xobj, [geom(60, 700, 60, 12)])
  ok('页面用了 Do（文字可能在 Form 里）且无命中 → 提示 text-may-live-in-form-xobject', r7.showsRemoved === 0 && r7.reasons['text-may-live-in-form-xobject'] === 1, JSON.stringify(r7.reasons))

  const empty = scrubContentStream('BT /F1 12 Tf 1 0 0 1 60 700 Tm (KEEP) Tj ET', [])
  ok('无目标 → 输出与输入逐字节相同', empty.out === 'BT /F1 12 Tf 1 0 0 1 60 700 Tm (KEEP) Tj ET' && empty.showsRemoved === 0)
}

section('0c. 纯函数：内联图像 / 畸形输入不崩、不误删')
{
  // 内联图像的二进制数据里故意塞入「BT (FAKE) Tj ET」，必须被当作不透明数据
  const bin = 'BI /W 4 /H 4 /CS /G /BPC 8 ID \u0001\u0002 BT (FAKE) Tj ET \u0003 EI Q\nBT /F1 12 Tf 1 0 0 1 60 700 Tm (REAL) Tj ET'
  const r = scrubContentStream(bin, [geom(60, 700, 60, 12)])
  ok('内联图像二进制里的 BT/Tj 不会被误解析', r.showsRemoved === 1 && !r.out.includes('(REAL)') && r.out.includes('(FAKE) Tj ET'), 'showsRemoved=' + r.showsRemoved)

  const unterminated = 'BI /W 4 /H 4 /CS /G /BPC 8 ID rawdatawithnoEI'
  const r2 = scrubContentStream(unterminated, [geom(60, 700, 60, 12)])
  ok('内联图像没找到 EI → 整条流放弃且不改字节', r2.showsRemoved === 0 && r2.out === unterminated && r2.reasons['inline-image-unterminated'] === 1, JSON.stringify(r2.reasons))

  const broken = 'BT /F1 12 Tf 1 0 0 1 60 700 Tm (UNCLOSED) Tj'
  const r3 = scrubContentStream(broken, [geom(60, 700, 60, 12)])
  ok('BT 未闭合 → 不删（没有完整块）', r3.showsRemoved === 0 && r3.out === broken)

  // 字面串里的嵌套括号与转义
  const nested = 'BT /F1 12 Tf 1 0 0 1 60 700 Tm (A\\(B\\)C) Tj ET'
  const r4 = scrubContentStream(nested, [geom(60, 700, 60, 12)])
  ok('字面串里的转义括号不影响切分', r4.showsRemoved === 1 && !r4.out.includes('A\\('))
}

/* ================================================================
 * 1. 端到端 A：自造 3 页 ASCII PDF
 * ================================================================ */
const { replacePdfText } = await import('../src/renderer/src/utils/pdfInPlaceReplace.ts')
await mkdir(WORK, { recursive: true })

section('1. 端到端 A：3 页 ASCII PDF，替换第 2 页一行（scrubReplacedText: true）')
const srcA = await makeAsciiPdf()
await writeFile(join(WORK, 'A-input.pdf'), srcA)
const itemsA2 = await pageItemGeoms(srcA, 1)
const targetItem = itemsA2.find((it) => it.str === ASCII_TARGET_OLD)
ok('素材自检：第 2 页能找到待替换文本项', !!targetItem, targetItem ? JSON.stringify({ x: targetItem.x.toFixed(2), baseline: targetItem.baseline.toFixed(2), w: targetItem.width.toFixed(2), fs: targetItem.fontSize }) : '')
if (!targetItem) throw new Error('素材构造失败')

const repA = {
  page: 1,
  rect: { x: targetItem.x, y: targetItem.baseline - targetItem.fontSize * 0.2, width: targetItem.width, height: targetItem.fontSize },
  baseline: targetItem.baseline,
  fontSize: targetItem.fontSize,
  color: { r: 0, g: 0, b: 0 },
  bgColor: { r: 1, g: 1, b: 1 },
  align: 'left' as const,
  newText: ASCII_TARGET_NEW
}

let statsA: Record<string, unknown> | null = null
const outA = await replacePdfText(srcA, [repA], [], {
  scrubReplacedText: true,
  onScrubReport: (s) => {
    statsA = s as unknown as Record<string, unknown>
  }
})
await writeFile(join(WORK, 'A-output.pdf'), outA)
info('清理统计：' + JSON.stringify(statsA))

{
  const inText = await extractText(srcA)
  const outText = await extractText(outA)
  const all = outText.join('\n')
  ok('A1 全文中不再包含旧文字', !all.includes(ASCII_TARGET_OLD), '旧文字出现次数=' + all.split(ASCII_TARGET_OLD).length - 1)
  ok('A1 全文仍包含新文字', all.includes(ASCII_TARGET_NEW))
  ok('A2 第 1 页文字逐字符相同', outText[0] === inText[0], JSON.stringify(outText[0]))
  ok('A2 第 3 页文字逐字符相同', outText[2] === inText[2], JSON.stringify(outText[2]))
  ok('A2 第 2 页其它未编辑行仍在', outText[1].includes('PAGE-TWO-KEEP-GAMMA'), JSON.stringify(outText[1]))
  ok('A2 第 2 页旧文字已从文本层消失', !outText[1].includes(ASCII_TARGET_OLD))
}

{
  // ---- 像素级 ----
  const SCALE = 2
  const exA = [coverRect(repA.rect, repA.fontSize)]
  const inP1 = await renderPage(srcA, 0, SCALE)
  const outP1 = await renderPage(outA, 0, SCALE)
  const dP1 = diffPixels(inP1, outP1, [])
  ok('A3 第 1 页（未编辑页）渲染像素完全一致', dP1.total === 0, `diff=${dP1.total} first=${dP1.firstOutside}`)

  const inP3 = await renderPage(srcA, 2, SCALE)
  const outP3 = await renderPage(outA, 2, SCALE)
  const dP3 = diffPixels(inP3, outP3, [])
  ok('A3 第 3 页（未编辑页）渲染像素完全一致', dP3.total === 0, `diff=${dP3.total} first=${dP3.firstOutside}`)

  const inP2 = await renderPage(srcA, 1, SCALE)
  const outP2 = await renderPage(outA, 1, SCALE)
  const dP2 = diffPixels(inP2, outP2, exA)
  ok('A3 第 2 页：替换矩形**以外**差异像素 = 0', dP2.outside === 0, `outside=${dP2.outside} inside=${dP2.inside} total=${dP2.total} first=${dP2.firstOutside}`)
  ok('A3 第 2 页：替换矩形**以内**确实变了（说明确实改了字）', dP2.inside > 0, 'inside=' + dP2.inside)
  info(`A3 像素明细：scale=${SCALE} 画布 ${inP2.width}x${inP2.height}，替换区内差异 ${dP2.inside} px，区外 ${dP2.outside} px`)

  // 决定性证据：清理 vs 不清理，两版渲染必须**一个像素都不差**
  const outNoScrub = await replacePdfText(srcA, [repA], [])
  const outNoScrubP2 = await renderPage(outNoScrub, 1, SCALE)
  const dScrub = diffPixels(outNoScrubP2, outP2, [])
  ok('A3 开启清理 vs 不清理：整页渲染像素完全一致（清理零视觉影响）', dScrub.total === 0, `diff=${dScrub.total} first=${dScrub.firstOutside}`)
}

{
  // ---- 对象级字节 ----
  const inInv = await streamInventory(srcA)
  const outInv = await streamInventory(outA)
  const inImgs = inInv.filter((x) => x.subtype === '/Image')
  const outImgShas = new Set(outInv.filter((x) => x.subtype === '/Image').map((x) => x.sha))
  ok('A4 原有图像 XObject 流字节逐字节保留', inImgs.length > 0 && inImgs.every((i) => outImgShas.has(i.sha)), `输入 ${inImgs.length} 张，输出 ${outImgShas.size} 张`)

  const page1Same = (await pageContentsRaw(srcA, 0)).equals(await pageContentsRaw(outA, 0))
  const page3Same = (await pageContentsRaw(srcA, 2)).equals(await pageContentsRaw(outA, 2))
  const page2Changed = !(await pageContentsRaw(srcA, 1)).equals(await pageContentsRaw(outA, 1))
  ok('A4 第 1 页内容流原始字节一致', page1Same)
  ok('A4 第 3 页内容流原始字节一致', page3Same)
  ok('A4 第 2 页内容流确实被改动（清理生效）', page2Changed)

  const missing = inInv
    .filter((x) => !isStructural(x) && x.subtype !== '/Image')
    .filter((x) => !outInv.some((o) => o.sha === x.sha))
  ok('A4 输入全部非结构流在输出中仍有字节一致的对应（除被清理页的内容流）', missing.length === 1 && missing[0].type === '' ? true : missing.length <= 1, '缺失 ' + missing.length + ' 条' + (missing.length ? '：' + missing.map((m) => m.type + '/' + m.len + 'B').join(',') : ''))

  const dIn = await PDFDocument.load(srcA, { ignoreEncryption: true })
  const dOut = await PDFDocument.load(outA, { ignoreEncryption: true })
  const sameBoxes =
    dIn.getPageCount() === dOut.getPageCount() &&
    dIn.getPages().every((p, i) => {
      const a = p.getSize()
      const b = dOut.getPages()[i].getSize()
      return Math.abs(a.width - b.width) < 0.01 && Math.abs(a.height - b.height) < 0.01
    })
  ok('A4 页数与每页 MediaBox 不变', sameBoxes, `${dIn.getPageCount()} 页`)
}

{
  // ---- 向后兼容：opts 省略 / 显式 false / 空对象，三者逐字节等价 ----
  const annos = [{ page: 1, rect: { x: 60, y: 744, width: 200, height: 20 }, kind: 'highlight' as const, color: { r: 1, g: 0.9, b: 0 }, opacity: 0.35 }]
  const legacy = await replacePdfText(srcA, [repA], annos)
  let spyCalls = 0
  const explicitFalse = await replacePdfText(srcA, [repA], annos, {
    scrubReplacedText: false,
    onScrubReport: () => {
      spyCalls++
    }
  })
  const emptyOpts = await replacePdfText(srcA, [repA], annos, {})
  ok('A5 opts 省略 / {scrubReplacedText:false} / {} 三者输出逐字节相同', sha1(legacy) === sha1(explicitFalse) && sha1(legacy) === sha1(emptyOpts), `sha1 ${sha1(legacy).slice(0, 12)} / ${sha1(explicitFalse).slice(0, 12)} / ${sha1(emptyOpts).slice(0, 12)}`)
  ok('A5 关闭开关时清理分支根本没执行（onScrubReport 零次回调）', spyCalls === 0, 'spyCalls=' + spyCalls)

  // 旧行为 = 原内容流一字不改：输入第 1/3 页内容流必须原样，第 2 页内容流前缀必须是原文
  const inP1 = await pageContentsRaw(srcA, 0)
  const lgP1 = await pageContentsRaw(legacy, 0)
  ok('A5 旧行为下第 1 页内容流字节一致', inP1.equals(lgP1))
  const inP2 = await pageContentsRaw(srcA, 1)
  const lgP2 = await pageContentsRaw(legacy, 1)
  const at = lgP2.indexOf(inP2)
  ok('A5 旧行为下第 2 页原始内容流在输出中原样保留（只是前面多了 pdf-lib 的 q/Q 包装）', at >= 0, `原始 ${inP2.length}B 出现在偏移 ${at}，其后追加 ${lgP2.length - at - inP2.length}B`)

  // 与「剥掉本功能」的等价实现逐字节对比（见 runLegacyImplementation 注释）
  const legacyOut = await runLegacyImplementation(srcA, [repA], annos)
  if (legacyOut) {
    ok('A5 opts 省略时的输出与「剥掉清理功能」的等价实现逐字节相同', sha1(legacyOut) === sha1(legacy), `sha1 ${sha1(legacyOut).slice(0, 12)} vs ${sha1(legacy).slice(0, 12)}`)
  } else {
    ok('A5 剥离等价实现失败（#region 标记可能被改动）', false)
  }

  const lgText = (await extractText(legacy)).join('\n')
  ok('A5 对照：旧行为下旧文字**仍然**留在文本层（这正是本次要修的缺陷）', lgText.includes(ASCII_TARGET_OLD) && lgText.includes(ASCII_TARGET_NEW))
}

/* ================================================================
 * 2. 端到端 B：真实世界 PDF
 * ================================================================ */
section('2. 端到端 B：真实世界 PDF（qa-fixtures/real-large-plain.pdf）')
{
  const p = join(HERE, 'pdf-audit', 'qa-fixtures', 'real-large-plain.pdf')
  if (!existsSync(p)) {
    info('样本不存在，跳过')
  } else {
    const src = new Uint8Array(await readFile(p))
    const inText = await extractText(src)
    info('页数=' + inText.length + '，提取文字总长=' + inText.join('').length)
    // 在第 2 页挑一个较长的 ASCII 文本项做替换；优先挑「全篇只出现一次」的，
    // 这样断言可以写成最严格的「全文不再包含该字符串」
    const items = await pageItemGeoms(src, 1)
    const wholeText = inText.join('\n')
    const pool = items
      .filter((it) => /^[\x20-\x7e]{4,}$/.test(it.str) && it.width > 20 && it.fontSize > 5)
      .sort((a, b) => occ(wholeText, a.str) - occ(wholeText, b.str) || b.width - a.width)
    const uniqueCand = pool.find((it) => occ(wholeText, it.str) === 1)
    const cand = uniqueCand ?? pool[0]
    if (!cand) {
      info('第 2 页没有合适的 ASCII 文本项，跳过')
    } else {
      const beforeCount = occ(wholeText, cand.str)
      info('选定目标：' + JSON.stringify(cand.str) + ` x=${cand.x.toFixed(2)} y=${cand.baseline.toFixed(2)} w=${cand.width.toFixed(2)} fs=${cand.fontSize.toFixed(2)} 全文出现次数=${beforeCount}`)
      const rep = {
        page: 1,
        rect: { x: cand.x, y: cand.baseline - cand.fontSize * 0.2, width: cand.width, height: cand.fontSize },
        baseline: cand.baseline,
        fontSize: cand.fontSize,
        color: { r: 0, g: 0, b: 0 },
        bgColor: { r: 1, g: 1, b: 1 },
        align: 'left' as const,
        newText: 'ZZZ-SCRUBBED'
      }
      let stats: Record<string, unknown> | null = null
      const out = await replacePdfText(src, [rep], [], {
        scrubReplacedText: true,
        onScrubReport: (s) => {
          stats = s as unknown as Record<string, unknown>
        }
      })
      await writeFile(join(WORK, 'B-output.pdf'), out)
      info('清理统计：' + JSON.stringify(stats))
      const outText = await extractText(out)
      const afterText = outText.join('\n')
      ok('B 输出可被 pdf.js 打开且页数不变', outText.length === inText.length, outText.length + ' vs ' + inText.length)
      ok('B 该处旧文字已从文本层消失（编辑页该字符串出现次数 -1）', occ(outText[1], cand.str) === occ(inText[1], cand.str) - 1, `${occ(inText[1], cand.str)} → ${occ(outText[1], cand.str)}`)
      ok('B 全文旧文字出现总次数 -1', occ(afterText, cand.str) === beforeCount - 1, `${beforeCount} → ${occ(afterText, cand.str)}`)
      if (beforeCount === 1) ok('B 全文不再包含旧文字（该串全篇唯一）', !afterText.includes(cand.str))
      ok('B 新文字已出现', afterText.includes('ZZZ-SCRUBBED'))
      ok('B 未编辑页文字逐字符相同', outText.filter((_, i) => i !== 1).join('|') === inText.filter((_, i) => i !== 1).join('|'))
      const inImgs = (await streamInventory(src)).filter((x) => x.subtype === '/Image')
      const outShas = new Set((await streamInventory(out)).filter((x) => x.subtype === '/Image').map((x) => x.sha))
      ok('B 原有图像 XObject 流字节逐字节保留', inImgs.every((i) => outShas.has(i.sha)), `${inImgs.length} 张`)
    }
  }
}

/* ================================================================
 * 2b. 退化/难啃真实输入不能崩、不能出坏文件
 * ================================================================ */
section('2b. 退化真实输入（加密 / Form 内文字 / 无匹配）不抛异常、输出合法')
{
  // 注意：加密样本即使 ignoreEncryption 载入，pdf.js 也**打不开**（No password given），
  // 这是输入本身的性质，不是本次改动的结果。故加密样本只断言 pdf-lib 可重载 + 不抛异常。
  const cases: Array<[string, string, boolean]> = [
    ['加密（经典 xref + AES128）', 'qa-fixtures/classic-xref-aes128.pdf', false],
    ['加密（RC4）', 'qa-fixtures/classic-xref-rc4.pdf', false],
    ['含图片的样本（文字可能在 Form 里）', 'fixtures/enhance-source.pdf', true]
  ]
  for (const [label, rel, expectPdfjsOpen] of cases) {
    const full = join(HERE, 'pdf-audit', rel)
    if (!existsSync(full)) {
      info(label + '：样本不存在，跳过')
      continue
    }
    const src = new Uint8Array(await readFile(full))
    const rep = {
      page: 1,
      rect: { x: 60, y: 750, width: 200, height: 14 },
      baseline: 755,
      fontSize: 14,
      color: { r: 0, g: 0, b: 0 },
      bgColor: { r: 1, g: 1, b: 1 },
      align: 'left' as const,
      newText: 'X-Y-Z'
    }
    try {
      let stats: Record<string, unknown> | null = null
      const out = await replacePdfText(src, [rep], [], {
        scrubReplacedText: true,
        onScrubReport: (s) => {
          stats = s as unknown as Record<string, unknown>
        }
      })
      const reopened = await PDFDocument.load(out, { ignoreEncryption: true })
      let pdfjsOk = true
      if (expectPdfjsOpen) {
        try {
          await extractText(out)
        } catch (e) {
          pdfjsOk = false
          info(label + ' pdf.js 打开失败：' + (e as Error).message)
        }
      } else {
        info(label + ' 属加密输入，pdf.js 需要密码（输入本身的性质），跳过 pdf.js 可读性断言')
      }
      ok(
        '2b 不抛异常且输出合法：' + label,
        reopened.getPageCount() > 0 && pdfjsOk,
        `页数=${reopened.getPageCount()} stats=${JSON.stringify(stats)}`
      )
    } catch (e) {
      ok('2b 不抛异常且输出合法：' + label, false, (e as Error).message)
    }
  }
}

/* ================================================================
 * 3. 端到端 C：中文 PDF（soffice）
 * ================================================================ */
section('3. 端到端 C：soffice 中文 PDF，替换第 2 页一行（真 CJK 文本层 + 栅格新文字）')
{
  const src = await makeCjkPdf()
  if (!src) {
    info('soffice 未产出 PDF，跳过场景 C')
  } else {
    const inText = await extractText(src)
    info('页数=' + inText.length)
    if (inText.length < 2) {
      info('页数不足 2 页，跳过')
    } else {
      const items = await pageItemGeoms(src, 1).then((all) => all.filter((it) => it.str.trim().length >= 4 && it.width > 15))
      const wholeText = inText.join('\n')
      const ordered = items.sort((a, b) => occ(wholeText, a.str) - occ(wholeText, b.str) || b.width - a.width)
      const cand = ordered.find((it) => occ(wholeText, it.str) === 1) ?? ordered[0]
      if (!cand) {
        info('第 2 页没有合适的文本项，跳过')
      } else {
        const beforeCount = occ(wholeText, cand.str)
        info('选定目标：' + JSON.stringify(cand.str.slice(0, 24)) + ` x=${cand.x.toFixed(2)} y=${cand.baseline.toFixed(2)} w=${cand.width.toFixed(2)} fs=${cand.fontSize.toFixed(2)} 全篇出现次数=${beforeCount}`)
        const rep = {
          page: 1,
          rect: { x: cand.x, y: cand.baseline - cand.fontSize * 0.2, width: cand.width, height: cand.fontSize },
          baseline: cand.baseline,
          fontSize: cand.fontSize,
          color: { r: 0, g: 0, b: 0 },
          bgColor: { r: 1, g: 1, b: 1 },
          align: 'left' as const,
          newText: '中文替换'
        }
        let stats: Record<string, unknown> | null = null
        const out = await replacePdfText(src, [rep], [], {
          scrubReplacedText: true,
          onScrubReport: (s) => {
            stats = s as unknown as Record<string, unknown>
          }
        })
        const outNoScrub = await replacePdfText(src, [rep], [])
        await writeFile(join(WORK, 'C-output.pdf'), out)
        info('清理统计：' + JSON.stringify(stats))
        const outText = await extractText(out)
        ok('C 输出可被 pdf.js 打开且页数不变', outText.length === inText.length, outText.length + ' vs ' + inText.length)
        ok('C 该处旧文字已从文本层消失（编辑页该串出现次数 -1）', occ(outText[1], cand.str) === occ(inText[1], cand.str) - 1, `${occ(inText[1], cand.str)} → ${occ(outText[1], cand.str)}`)
        ok('C 全文旧文字出现总次数 -1', occ(outText.join('\n'), cand.str) === beforeCount - 1, `${beforeCount} → ${occ(outText.join('\n'), cand.str)}`)
        if (beforeCount === 1) ok('C 全文不再包含旧文字（该串全篇唯一）', !outText.join('\n').includes(cand.str))
        ok('C 未编辑页文字逐字符相同', outText.filter((_, i) => i !== 1).join('|') === inText.filter((_, i) => i !== 1).join('|'))

        const SCALE = 2
        const ex = [coverRect(rep.rect, rep.fontSize)]
        const before = await renderPage(src, 1, SCALE)
        const after = await renderPage(out, 1, SCALE)
        const afterNoScrub = await renderPage(outNoScrub, 1, SCALE)
        const d = diffPixels(before, after, ex)
        ok('C 第 2 页：替换矩形以外差异像素 = 0', d.outside === 0, `outside=${d.outside} inside=${d.inside} total=${d.total} first=${d.firstOutside}`)
        info(`C 像素明细：画布 ${before.width}x${before.height}，区内差异 ${d.inside} px，区外 ${d.outside} px`)
        const dScrub = diffPixels(afterNoScrub, after, [])
        ok('C 开启清理 vs 不清理：整页渲染像素完全一致（清理零视觉影响）', dScrub.total === 0, `diff=${dScrub.total} first=${dScrub.firstOutside}`)
      }
    }
  }
}

/* ================================================================
 * 4. 退化输入与输出合法性
 * ================================================================ */
section('4. 退化输入 / 输出合法性')
{
  const src = await makeAsciiPdf()
  let threw = ''

  const cases: Array<[string, () => Promise<Uint8Array>]> = [
    ['reps 为空数组', () => replacePdfText(src, [], [], { scrubReplacedText: true })],
    ['opts 显式 false', () => replacePdfText(src, [repA], [], { scrubReplacedText: false })],
    [
      '匹配不到任何块的 run（坐标远离所有文字）',
      () =>
        replacePdfText(
          src,
          [{ ...repA, rect: { x: 500, y: 100, width: 40, height: 14 }, baseline: 100 }],
          [],
          { scrubReplacedText: true }
        )
    ],
    ['同一行被替换两次', () => replacePdfText(src, [repA, { ...repA, newText: 'SECOND-WRITE' }], [], { scrubReplacedText: true })],
    ['页号越界', () => replacePdfText(src, [{ ...repA, page: 99 }], [], { scrubReplacedText: true })],
    ['空串新文字（只删不留）', () => replacePdfText(src, [{ ...repA, newText: '' }], [], { scrubReplacedText: true })]
  ]

  for (const [label, run] of cases) {
    try {
      const out = await run()
      const reopened = await PDFDocument.load(out, { ignoreEncryption: true })
      let pdfjsOk = true
      try {
        await extractText(out)
      } catch (e) {
        pdfjsOk = false
        threw += ` [${label}] pdf.js 打开失败: ${(e as Error).message}`
      }
      ok('D 退化输入不抛异常且输出合法：' + label, reopened.getPageCount() === 3 && pdfjsOk, 'pdf-lib 可重载 / pdf.js 可打开，页数=' + reopened.getPageCount())
    } catch (e) {
      threw += ` [${label}] ${(e as Error).message}`
      ok('D 退化输入不抛异常且输出合法：' + label, false, (e as Error).message)
    }
  }
  if (threw) info('异常汇总：' + threw)

  // 只删不留：文本层旧文字同样消失
  const outDel = await replacePdfText(src, [{ ...repA, newText: '' }], [], { scrubReplacedText: true })
  const t = (await extractText(outDel)).join('\n')
  ok('D 空串新文字：旧文字从文本层消失且没有新文字', !t.includes(ASCII_TARGET_OLD) && !t.includes(ASCII_TARGET_NEW))

  // 同一行替换两次：旧文字仍只出现一次删除（不重复删→不产生坏文件）
  const outTwice = await replacePdfText(src, [repA, { ...repA, newText: 'SECOND-WRITE' }], [], { scrubReplacedText: true })
  const t2 = (await extractText(outTwice)).join('\n')
  ok('D 同一行替换两次：旧文字消失、两次新文字都在', !t2.includes(ASCII_TARGET_OLD) && t2.includes(ASCII_TARGET_NEW) && t2.includes('SECOND-WRITE'))
}

/* ---------------- 收尾 ---------------- */
console.log('\n============================')
console.log(`通过 ${pass}，失败 ${fail}`)
if (failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '))
console.log('工作产物目录：' + WORK)
process.exitCode = fail === 0 ? 0 : 1
