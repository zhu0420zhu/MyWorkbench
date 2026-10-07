/**
 * 「新文字比原文长」溢出探针：量化改字时新文字画出覆盖矩形之外到底会发生什么。
 *
 * 背景（纠正一个未经测量的推断）
 * ----------------------------
 * 主理人曾推断「新文字比原文长时会溢出覆盖框，旧墨水露出来和新文字叠在一起」。
 * 但读 `pdfInPlaceReplace.ts` 的绘制顺序会发现：覆盖矩形是**先画**（且带 pad 外扩），
 * 新文字**后画**在它上面。所以旧墨水按理是被盖住的，溢出部分只是新文字画到了
 * 覆盖框右边 —— 那里通常是空白页边，也可能是相邻的文字片段。
 * **推断不算数，这里用像素把它量清楚。**
 *
 * 测什么
 * ------
 * 两页对照：
 *   第 1 页：单行文字，右侧是空白页边（典型：整行即一个 run）
 *   第 2 页：同一行右侧还有一段相邻文字（模拟 pdf.js 把一行切成多个 run 的情况）
 * 各把该 run 替换成**长得多**的新文字，然后渲染前后逐像素比对，报三组数字：
 *   ① 旧墨水中落在覆盖矩形**之外**的像素数（>0 就说明真的露出旧字了）
 *   ② 溢出区在替换**前**的非白像素数（0=落在空白页边，>0=压到了原有内容上）
 *   ③ 溢出区前后差异像素数（溢出的规模）
 *
 * 运行（managed node 22）：
 *   "C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" \
 *     --experimental-strip-types tests/pdf-overflow-probe.ts
 */
import { register } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createCanvas, Path2D, ImageData, DOMMatrix } from '@napi-rs/canvas'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

register(new URL('./loader.mjs', import.meta.url).href)

globalThis.Path2D = Path2D as unknown as typeof Path2D
globalThis.ImageData = ImageData as unknown as typeof ImageData
globalThis.DOMMatrix = DOMMatrix as unknown as typeof DOMMatrix
globalThis.document = {
  createElement: (tag: string) => {
    if (tag !== 'canvas') throw new Error('unsupported element: ' + tag)
    return createCanvas(1, 1)
  }
} as unknown as Document

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, 'pdf-audit', 'scratch', 'overflow-work')
const SCALE = 2
const OLD_TEXT = 'TOTAL: 100'
const NEW_TEXT = 'TOTAL: 100000000'

/* ---------------- pdf.js 封装 ---------------- */

async function withPdfjs<T>(bytes: Uint8Array, fn: (pdf: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>) => Promise<T>): Promise<T> {
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, verbosity: 0 })
  const pdf = await task.promise
  try {
    return await fn(pdf)
  } finally {
    await task.destroy()
  }
}

async function renderPage(bytes: Uint8Array, pageIndex: number): Promise<{ data: Uint8ClampedArray; width: number; height: number; vp: { convertToViewportPoint: (x: number, y: number) => number[] } }> {
  return withPdfjs(bytes, async (pdf) => {
    const page = await pdf.getPage(pageIndex + 1)
    const vp = page.getViewport({ scale: SCALE })
    const canvas = createCanvas(Math.round(vp.width), Math.round(vp.height))
    const ctx = canvas.getContext('2d')
    await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    return { data: img.data as unknown as Uint8ClampedArray, width: canvas.width, height: canvas.height, vp }
  })
}

async function itemGeoms(bytes: Uint8Array, pageIndex: number): Promise<Array<{ str: string; x: number; baseline: number; width: number; fontSize: number }>> {
  return withPdfjs(bytes, async (pdf) => {
    const page = await pdf.getPage(pageIndex + 1)
    const vp = page.getViewport({ scale: 1 })
    const tc = await page.getTextContent()
    const out: Array<{ str: string; x: number; baseline: number; width: number; fontSize: number }> = []
    for (const raw of tc.items) {
      const str = typeof raw.str === 'string' ? raw.str : ''
      if (str === '') continue
      const tr = Array.isArray(raw.transform) ? (raw.transform as number[]) : [1, 0, 0, 1, 0, 0]
      const t = (pdfjs.Util as unknown as { transform: (a: number[], b: number[]) => number[] }).transform(vp.transform, tr)
      const p = vp.convertToPdfPoint(t[4], t[5])
      out.push({
        str,
        x: p[0],
        baseline: p[1],
        width: typeof raw.width === 'number' && Number.isFinite(raw.width) ? raw.width : 0,
        fontSize: Math.hypot(tr[2], tr[3]) || 12
      })
    }
    return out
  })
}

/* ---------------- 像素工具 ---------------- */

function isInk(data: Uint8ClampedArray, width: number, x: number, y: number): boolean {
  const i = (y * width + x) * 4
  return data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245
}

function differs(a: Uint8ClampedArray, b: Uint8ClampedArray, width: number, x: number, y: number): boolean {
  const i = (y * width + x) * 4
  return a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]
}

/** 统计某横带内、按 x 分段的非白像素与差异像素 */
function scanBand(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  width: number,
  yTop: number,
  yBottom: number,
  xFrom: number,
  xTo: number
): { inkBefore: number; diff: number; rightmostDiff: number } {
  let inkBefore = 0
  let diff = 0
  let rightmostDiff = -1
  for (let y = yTop; y <= yBottom; y++) {
    for (let x = xFrom; x <= xTo; x++) {
      if (isInk(before, width, x, y)) inkBefore++
      if (differs(before, after, width, x, y)) {
        diff++
        if (x > rightmostDiff) rightmostDiff = x
      }
    }
  }
  return { inkBefore, diff, rightmostDiff }
}

/* ---------------- 主流程 ---------------- */

async function main(): Promise<void> {
  await mkdir(WORK, { recursive: true })

  const { replacePdfText } = await import('../src/renderer/src/utils/pdfInPlaceReplace')

  // 第 1 页：单行（右侧空白）  第 2 页：同一行右侧还有一段相邻文字
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p1 = doc.addPage([595, 842])
  p1.drawText(OLD_TEXT, { x: 72, y: 700, size: 12, font })
  const p2 = doc.addPage([595, 842])
  p2.drawText(OLD_TEXT, { x: 72, y: 700, size: 12, font })
  p2.drawText('USD-NEIGHBOR', { x: 250, y: 700, size: 12, font })
  const before = await doc.save({ useObjectStreams: false })
  await writeFile(join(WORK, 'before.pdf'), before)

  for (const pageIndex of [0, 1]) {
    const label = pageIndex === 0 ? '第 1 页（右侧空白页边）' : '第 2 页（右侧有相邻文字）'
    console.log(`\n===== ${label} =====`)

    const geoms = await itemGeoms(before, pageIndex)
    console.log('  pdf.js 文本项：' + JSON.stringify(geoms.map((g) => ({ str: g.str, x: +g.x.toFixed(2), w: +g.width.toFixed(2) }))))

    const target = geoms[0]
    if (!target) {
      console.log('  [跳过] 取不到文本项')
      continue
    }

    const out = await replacePdfText(before, [
      {
        page: pageIndex,
        rect: { x: target.x, y: target.baseline - target.fontSize * 0.2, width: target.width, height: target.fontSize },
        baseline: target.baseline,
        fontSize: target.fontSize,
        color: { r: 0, g: 0, b: 0 },
        bgColor: { r: 1, g: 1, b: 1 },
        align: 'left',
        newText: NEW_TEXT
      }
    ])
    await writeFile(join(WORK, `after-p${pageIndex + 1}.pdf`), out)

    const rb = await renderPage(before, pageIndex)
    const ra = await renderPage(out, pageIndex)
    if (rb.width !== ra.width || rb.height !== ra.height) {
      console.log('  [跳过] 渲染尺寸不一致')
      continue
    }

    // 覆盖矩形（含 pad，与 pdfInPlaceReplace 的 COVER_PAD_PT=1 一致）
    const pad = 1
    const coverL = rb.vp.convertToViewportPoint(target.x - pad, target.baseline + target.fontSize + pad)[0]
    const coverR = rb.vp.convertToViewportPoint(target.x + target.width + pad, target.baseline + target.fontSize + pad)[0]
    const bandTop = rb.vp.convertToViewportPoint(0, target.baseline + target.fontSize + 4)[1]
    const bandBot = rb.vp.convertToViewportPoint(0, target.baseline - 5)[1]

    const xL = Math.max(0, Math.floor(Math.min(coverL, coverR)))
    const xR = Math.min(rb.width - 1, Math.ceil(Math.max(coverL, coverR)))
    const yT = Math.max(0, Math.floor(Math.min(bandTop, bandBot)))
    const yB = Math.min(rb.height - 1, Math.ceil(Math.max(bandTop, bandBot)))

    // ① 覆盖矩形右侧（一直到页边）：替换前的非白像素 = 溢出区是否本来就压着内容
    const right = scanBand(rb.data, ra.data, rb.width, yT, yB, xR + 1, rb.width - 1)
    // ② 覆盖矩形左侧一小段：验证旧字左侧没有漏网墨迹
    const left = scanBand(rb.data, ra.data, rb.width, yT, yB, Math.max(0, xL - 40), xL - 1)
    // ③ 覆盖矩形内部
    const inside = scanBand(rb.data, ra.data, rb.width, yT, yB, xL, xR)

    console.log(`  覆盖矩形 x∈[${xL},${xR}] px，文字带 y∈[${yT},${yB}] px`)
    console.log(`  ① 覆盖框右侧（溢出区）替换前非白像素 = ${right.inkBefore}  ${right.inkBefore === 0 ? '→ 落在空白页边' : '→ 压在原有内容上'}`)
    console.log(`     溢出区前后差异像素 = ${right.diff}，最右差异 x = ${right.rightmostDiff}`)
    console.log(`  ② 覆盖框左侧替换前非白像素 = ${left.inkBefore}（旧字左侧漏网墨迹）`)
    console.log(`  ③ 覆盖框内部：替换前墨迹 ${inside.inkBefore} px，前后差异 ${inside.diff} px`)
    console.log(`  判定：旧墨水露出 = ${left.inkBefore > 0 || (right.inkBefore > 0 && right.diff > 0) ? '需人工看图确认' : '未发现（覆盖框内旧字已盖住，左右两侧无漏网墨迹）'}`)
  }

  console.log('\n说明：本探针只产出数字，不做断言；结论由人看图与数字得出。')
}

void main()
