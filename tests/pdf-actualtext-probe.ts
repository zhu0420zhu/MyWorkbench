/**
 * ActualText 探针：验证「删掉显示算子之后，/ActualText 里的旧内容是否还能被提取器拿到」。
 *
 * 为什么需要它
 * ------------
 * pdfTextLayerScrub 的做法是从内容流里摘掉 Tj/TJ/'/" 这些**显示算子**。
 * 但 PDF 有一种机制叫 ActualText：`<</Span <</ActualText (真正的文本)>>>>BDC … Tj(屏幕上的字) … EMC`。
 * 它的用途正是「显示 A、提取 B」。如果删掉了 Tj 却把带 ActualText 的 BDC/EMC 留在流里，
 * 提取器**可能依然返回旧内容** —— 那就是本轮最忌讳的「看起来清干净了，其实没有」。
 *
 * 运行（managed node 22）：
 *   "C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" \
 *     --experimental-strip-types tests/pdf-actualtext-probe.ts
 *
 * 环境说明同 tests/pdf-text-scrub.ts：用 @napi-rs/canvas 顶替 DOM，pdf.js 走 legacy build，
 * 用 tests/loader.mjs 把仓库里「无扩展名」的 TS 相对导入补上 .ts。
 */
import { register } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createCanvas, Path2D, ImageData, DOMMatrix } from '@napi-rs/canvas'
import { PDFDocument, PDFDict, PDFName, StandardFonts } from 'pdf-lib'
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
const WORK = join(HERE, 'pdf-audit', 'scratch', 'actualtext-work')

const VISIBLE = 'VISIBLE-OLD-123'
const SECRET = 'SECRET-ALIAS-999'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log('  [PASS] ' + name + (detail ? '  ' + detail : ''))
  } else {
    fail++
    console.log('  [FAIL] ' + name + (detail ? '  ' + detail : ''))
  }
}
function info(s: string): void {
  console.log('       ' + s)
}

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

async function extract(bytes: Uint8Array): Promise<string> {
  return withPdfjs(bytes, async (pdf) => {
    let out = ''
    for (let i = 1; i <= pdf.numPages; i++) {
      const p = await pdf.getPage(i)
      const tc = await p.getTextContent()
      out += tc.items.map((it) => String(it.str ?? '')).join('')
    }
    return out
  })
}

async function firstItemGeom(bytes: Uint8Array): Promise<{ str: string; x: number; baseline: number; width: number; fontSize: number } | null> {
  return withPdfjs(bytes, async (pdf) => {
    const page = await pdf.getPage(1)
    const vp = page.getViewport({ scale: 1 })
    const tc = await page.getTextContent()
    for (const raw of tc.items) {
      const str = typeof raw.str === 'string' ? raw.str : ''
      if (str === '') continue
      const tr = Array.isArray(raw.transform) ? (raw.transform as number[]) : [1, 0, 0, 1, 0, 0]
      const t = (pdfjs.Util as unknown as { transform: (a: number[], b: number[]) => number[] }).transform(vp.transform, tr)
      const p = vp.convertToPdfPoint(t[4], t[5])
      return {
        str,
        x: p[0],
        baseline: p[1],
        width: typeof raw.width === 'number' && Number.isFinite(raw.width) ? raw.width : 0,
        fontSize: Math.hypot(tr[2], tr[3]) || 12
      }
    }
    return null
  })
}

/* ---------------- 造一份带 ActualText 的 PDF ---------------- */

async function buildActualTextPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([595, 842])
  const font = await doc.embedFont(StandardFonts.Helvetica)

  // 把字体挂到页面资源上（手写内容流，所以得自己注册）
  let res = page.node.Resources()
  if (!res) {
    res = doc.context.obj({}) as PDFDict
    page.node.set(PDFName.of('Resources'), res)
  }
  let fontDict = res.lookupMaybe(PDFName.of('Font'), PDFDict)
  if (!fontDict) {
    fontDict = doc.context.obj({}) as PDFDict
    res.set(PDFName.of('Font'), fontDict)
  }
  fontDict.set(PDFName.of(font.name), font.ref)

  const content = [
    'BT',
    `/${font.name} 12 Tf`,
    '1 0 0 1 72 700 Tm',
    `/Span << /ActualText (${SECRET}) >> BDC`,
    `(${VISIBLE}) Tj`,
    'EMC',
    'ET'
  ].join('\n')

  const stream = doc.context.stream(content)
  page.node.set(PDFName.of('Contents'), doc.context.register(stream))

  return doc.save({ useObjectStreams: false })
}

/* ---------------- 主流程 ---------------- */

async function main(): Promise<void> {
  await mkdir(WORK, { recursive: true })

  const before = await buildActualTextPdf()
  await writeFile(join(WORK, 'before.pdf'), before)

  const textBefore = await extract(before)
  console.log('[1] 清理前 pdf.js 提取结果')
  info(JSON.stringify(textBefore))
  const sawVisibleBefore = textBefore.includes(VISIBLE)
  const sawSecretBefore = textBefore.includes(SECRET)
  info(`含可见文字 ${VISIBLE} = ${sawVisibleBefore}`)
  info(`含 ActualText ${SECRET} = ${sawSecretBefore}`)
  console.log('')

  if (!sawVisibleBefore) {
    console.log('[前置失败] 造出来的 PDF 连可见文字都提取不到，探针本身不成立，停止。')
    process.exitCode = 1
    return
  }

  const geom = await firstItemGeom(before)
  if (!geom) {
    console.log('[前置失败] 取不到文本项几何，停止。')
    process.exitCode = 1
    return
  }
  info(`目标几何：str=${JSON.stringify(geom.str)} x=${geom.x.toFixed(2)} baseline=${geom.baseline.toFixed(2)} w=${geom.width.toFixed(2)} fs=${geom.fontSize.toFixed(2)}`)

  // 跑清理（与 replacePdfText 里 scrub 分支传的 target 结构一致）
  const { scrubPdfTextLayer } = await import('../src/renderer/src/utils/pdfTextLayerScrub')
  const doc2 = await PDFDocument.load(before, { ignoreEncryption: true })
  const stats = scrubPdfTextLayer(doc2, [
    {
      page: 0,
      rect: { x: geom.x, y: geom.baseline - geom.fontSize * 0.2, width: geom.width, height: geom.fontSize },
      baseline: geom.baseline,
      fontSize: geom.fontSize
    }
  ])
  const after = await doc2.save({ useObjectStreams: false })
  await writeFile(join(WORK, 'after.pdf'), after)

  console.log('[2] 清理统计')
  info(JSON.stringify(stats))
  console.log('')

  const textAfter = await extract(after)
  console.log('[3] 清理后 pdf.js 提取结果')
  info(JSON.stringify(textAfter))
  const sawVisibleAfter = textAfter.includes(VISIBLE)
  const sawSecretAfter = textAfter.includes(SECRET)
  info(`含可见文字 ${VISIBLE} = ${sawVisibleAfter}`)
  info(`含 ActualText ${SECRET} = ${sawSecretAfter}`)
  console.log('')

  // 内容流里 BDC/EMC 与 ActualText 是否还留着
  const pageNode = doc2.getPage(0).node
  const contents = pageNode.Contents()
  let rawText = ''
  try {
    const { decodePDFRawStream } = await import('pdf-lib')
    const s = contents as { contents?: Uint8Array }
    if (s && s.contents) rawText = new TextDecoder('latin1').decode(decodePDFRawStream(s as never).decode())
  } catch {
    /* 忽略：读不出就用提取结果下结论 */
  }
  if (rawText) {
    info('清理后内容流 = ' + JSON.stringify(rawText))
  }
  console.log('')

  console.log('[4] 结论性断言')
  ok('清理前能提取到可见文字（素材有效）', sawVisibleBefore)
  ok('清理后可见文字不再被提取', !sawVisibleAfter)
  if (sawSecretBefore) {
    ok('pdf.js 确实采用 ActualText（因此本探针有意义）', true, `清理前就能提取到 ${SECRET}`)
    ok('★ 清理后 ActualText 也不再被提取（旧内容真消失）', !sawSecretAfter, sawSecretAfter ? `仍然提出 ${SECRET} —— 存在"假清净"风险` : '')
  } else {
    info('pdf.js 未采用 ActualText（清理前就提不到），本机制在本链路上不构成"假清净"风险')
    ok('★ 清理后也没有出现 ActualText 内容', !sawSecretAfter)
  }
  ok('清理统计显示有命中', stats.targetsMatched > 0, JSON.stringify({ matched: stats.targetsMatched, skipped: stats.targetsSkipped }))

  console.log('')
  console.log(`通过 ${pass}，失败 ${fail}`)
  if (fail > 0) process.exitCode = 1
}

void main()
