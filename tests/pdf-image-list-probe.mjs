/**
 * `src/renderer/src/utils/pdfImageList.ts` 的无头运行时验收。
 *
 * 为什么要这么绕（下次改这里前先读这段）：
 *   · `pdfImageList` 生产环境跑在渲染进程，依赖 pdf.js worker 与 DOM canvas。
 *     Node 下两者都没有，所以这里用桩补齐，才能**真实驱动**这份代码，而不是只靠读代码判断。
 *   · `globalThis.Worker` 那个「假类」是为兼容 pdf.js `GlobalWorkerOptions.workerPort`
 *     setter 的类型校验（`val instanceof Worker`）而保留的兜底；本探针最终用 defineProperty
 *     把 workerPort 钉成「只读 null」，不经过该 setter，但保留假类可避免其它 pdf.js 路径
 *     在 Node 下因 `Worker` 未定义而意外抛错。
 *   · workerPort 必须在 import pdfImageList **之后**钉死：pdfRender.ts 的 ensureWorker()
 *     是惰性的（首次 openPdfDocument 才跑），它会执行 `workerPort = new PdfWorker()`
 *     （`?worker` 被 loader 换成了空壳类）。只做普通赋值 `workerPort = null` 会被它覆盖回去，
 *     于是 pdf.js 拿空壳当 worker 端口 → `new MessageHandler(comObj)` →
 *     `comObj.addEventListener is not a function`。必须用 defineProperty 覆盖成
 *     「get 恒返回 null / set 吞掉」，pdf.js 才会走 Node 可用的 fake worker。
 *   · workerSrc 必须指向 **legacy** worker 文件（见下方赋值处的说明）。
 *   · `document.createElement('canvas')` / `ImageData` 用 `@napi-rs/canvas` 顶替
 *     （它是 pdfjs-dist 的传递依赖，未新增任何 npm 包）。
 *
 * 覆盖点：
 *   A 普通图片（PNG/JPEG）+ 旋转 + <8pt 过滤
 *   B `paintImageXObjectRepeat` 展开（pdf.js 会把 ≥3 组「同图同尺寸连续绘制」合并成一个算子）
 *   C `paintInlineImageXObjectGroup` 展开（pdf.js 会把 ≥10 张连续内联图打包成一张合并图）
 *   D 惰性 dataUrl：`getPlacedImageDataUrl` 能取回像素，且尺寸与枚举结果一致
 *   E 枚举的内存/耗时：惰性（现状） vs 逐张取回（= 旧「急切」行为）
 *
 * 运行（**必须带 loader**，直接 `node tests/pdf-image-list-probe.mjs` 会报 ERR_MODULE_NOT_FOUND）：
 *
 *   npm run probe:pdf-image-list
 *
 * 等价的手写命令：
 *
 *   NODE_OPTIONS="" "C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" \
 *     --expose-gc --experimental-strip-types --experimental-loader=./tests/loader.mjs \
 *     tests/pdf-image-list-probe.mjs
 *
 * 为什么非要 loader：pdfImageList.ts 里写的是无扩展名的 TS 相对导入（`./pdfRender`），
 * Node 的 ESM 解析器不接受"无扩展名 + 实际是 .ts"，会直接 ERR_MODULE_NOT_FOUND。
 * `tests/loader.mjs` 就是干这个的（顺便把 `electron` 与 `?worker` 换成桩）。
 * `--expose-gc` 只影响 [E] 段的堆数字，去掉也能跑，只是堆增量会飘。
 *
 * 已知无害警告：运行时会打印
 *   `Warning: UnknownErrorException: Ensure that the 'standardFontDataUrl' API parameter is provided.`
 * 这是 pdf.js 在 Node 下没有内置标准字体路径导致的，只影响"用标准字体渲染文字"的路径，
 * 本探针不解码文字层，可以忽略；**不是故障，不要当 bug 修**。
 */
import { PDFDocument, PDFName, PDFRawStream, degrees } from 'pdf-lib'
import { createCanvas, Image as NapiImage, ImageData as NapiImageData } from '@napi-rs/canvas'

/* ------------------------------------------------------------------ *
 * 0) 环境桩（必须在 import pdfImageList 之前装好）
 * ------------------------------------------------------------------ */

class FakeWorker {}
Object.defineProperty(FakeWorker, Symbol.hasInstance, { value: () => true })
globalThis.Worker = FakeWorker

globalThis.ImageData = NapiImageData
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error('未预期的元素类型: ' + tag)
    const c = createCanvas(1, 1)
    if (typeof c.toDataURL !== 'function') c.toDataURL = () => ''
    return c
  }
}

const { listPdfImages, getPlacedImageDataUrl } = await import(
  '../src/renderer/src/utils/pdfImageList.ts'
)

// import 之后把 workerPort **钉死为 null**，让 pdf.js 走 Node 可用的 fake worker。
// 为什么不能只是 `pdfjs.GlobalWorkerOptions.workerPort = null`：
//   pdfRender.ts 的 ensureWorker() 是**惰性**的（首次 openPdfDocument / listPdfImages 才跑），
//   它仍然会执行 `GlobalWorkerOptions.workerPort = new PdfWorker()`，而 `PdfWorker` 是被
//   loader 换成空壳的 `?worker` 类。于是这一句会把我们刚设的 null 覆盖回去，pdf.js 便拿
//   空壳当 worker 端口 → `new MessageHandler(comObj)` → `comObj.addEventListener is not a function`。
//   用 defineProperty 定义「只读返回 null + 吞掉写入」的属性，才能压住 ensureWorker 的赋值。
// workerSrc 刻意指向 **legacy** worker：主 build 的 worker 在 Node 22 下会用到 `Promise.try`
// （Node 24+ 才有的 API）而直接崩在 MessageHandler 里；legacy worker 与主 build 协议同版本，可混用。
const pdfjs = await import('pdfjs-dist')
Object.defineProperty(pdfjs.GlobalWorkerOptions, 'workerPort', {
  configurable: true,
  get: () => null,
  set: () => {} // 吞掉 pdfRender.ensureWorker() 的赋值，强制 pdf.js 走 fake worker
})
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  '../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
  import.meta.url
).href

/* ------------------------------------------------------------------ *
 * 断言工具
 * ------------------------------------------------------------------ */

let passed = 0
let failed = 0

function assert(cond, msg) {
  if (cond) {
    passed++
    console.log('  \u2713 ' + msg)
  } else {
    failed++
    console.error('  \u2717 FAIL: ' + msg)
  }
}

function assertEq(actual, expected, msg) {
  if (actual === expected) {
    passed++
    console.log('  \u2713 ' + msg)
  } else {
    failed++
    console.error('  \u2717 FAIL: ' + msg + '\n      期望: ' + expected + '\n      实际: ' + actual)
  }
}

function assertNear(actual, expected, tol, msg) {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tol
  if (ok) {
    passed++
    console.log('  \u2713 ' + msg + '（' + Number(actual).toFixed(3) + ' \u2248 ' + expected + '）')
  } else {
    failed++
    console.error('  \u2717 FAIL: ' + msg + '\n      期望: ' + expected + ' \u00b1 ' + tol + '\n      实际: ' + actual)
  }
}

/* ------------------------------------------------------------------ *
 * 素材
 * ------------------------------------------------------------------ */

function makePng(w, h, rgbTriple) {
  const c = createCanvas(w, h)
  const ctx = c.getContext('2d')
  ctx.fillStyle = `rgb(${rgbTriple[0]}, ${rgbTriple[1]}, ${rgbTriple[2]})`
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(Math.floor(w / 4), Math.floor(h / 4), Math.floor(w / 2), Math.floor(h / 2))
  return new Uint8Array(c.toBuffer('image/png'))
}

function makeJpeg(w, h, rgbTriple) {
  const c = createCanvas(w, h)
  const ctx = c.getContext('2d')
  // 加点噪声，避免纯色被 JPEG 压到极小、失去代表性
  for (let y = 0; y < h; y += 4) {
    ctx.fillStyle = `rgb(${(rgbTriple[0] + y) % 256}, ${(rgbTriple[1] + y * 2) % 256}, ${(rgbTriple[2] + y * 3) % 256})`
    ctx.fillRect(0, y, w, 4)
  }
  return new Uint8Array(c.toBuffer('image/jpeg', 90))
}

/** 读回一张 data URL 的像素尺寸（用 napi-canvas 解码，证明 dataUrl 真的可用） */
function decodeDataUrlSize(url) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url)
  if (!m) return null
  const buf = Buffer.from(m[2], 'base64')
  const img = new NapiImage()
  img.src = buf
  return { mime: m[1], width: img.width, height: img.height, bytes: buf.length }
}

/* ------------------------------------------------------------------ *
 * A 普通图片 + 旋转 + 小图过滤
 * ------------------------------------------------------------------ */

async function caseA() {
  console.log('\n[A] 普通图片 / 旋转 / <8pt 过滤')
  const doc = await PDFDocument.create()
  const png = await doc.embedPng(makePng(50, 30, [192, 57, 43]))
  const jpg = await doc.embedJpg(makeJpeg(40, 24, [41, 128, 185]))
  const p1 = doc.addPage([600, 400])
  p1.drawImage(png, { x: 100, y: 200, width: 120, height: 80 })
  p1.drawImage(jpg, { x: 350, y: 250, width: 60, height: 40, rotate: degrees(90) })
  const p2 = doc.addPage([500, 500])
  const font = await doc.embedFont('Helvetica')
  p2.drawText('text only page', { x: 40, y: 400, size: 18, font })
  const p3 = doc.addPage([400, 300])
  p3.drawImage(png, { x: 20, y: 20, width: 40, height: 30 })
  p3.drawImage(png, { x: 200, y: 200, width: 5, height: 5 }) // < 8pt → 过滤
  const bytes = await doc.save({ useObjectStreams: false })

  const scan = await listPdfImages(bytes)
  console.log('      images=' + scan.images.length + ' totalPages=' + scan.totalPages + ' ' + JSON.stringify({ unsupported: scan.unsupportedOps, masks: scan.skippedMasks, small: scan.skippedSmall }))
  for (const it of scan.images) {
    console.log('      ' + it.key + ' objId=' + it.objId + ' pdfRect=' + JSON.stringify(round(it.pdfRect)) + ' px=' + it.pixelWidth + 'x' + it.pixelHeight + ' rotated=' + it.rotated)
  }
  assertEq(scan.totalPages, 3, 'totalPages = 3')
  assertEq(scan.images.length, 3, '共 3 张（第 3 页的 5×5pt 被过滤）')
  assertEq(scan.skippedSmall, 1, 'skippedSmall = 1（5×5pt）')
  assertEq(scan.unsupportedOps.repeat, 0, 'unsupportedOps.repeat = 0')
  assertEq(scan.unsupportedOps.inlineGroup, 0, 'unsupportedOps.inlineGroup = 0')

  const a = scan.images[0]
  assertNear(a.pdfRect.x, 100, 0.01, '第 1 页 PNG x')
  assertNear(a.pdfRect.y, 200, 0.01, '第 1 页 PNG y')
  assertNear(a.pdfRect.width, 120, 0.01, '第 1 页 PNG width')
  assertNear(a.pdfRect.height, 80, 0.01, '第 1 页 PNG height')
  assertEq(a.pixelWidth + 'x' + a.pixelHeight, '50x30', '第 1 页 PNG 像素尺寸 50x30')
  assertEq(a.rotated, false, '第 1 页 PNG rotated=false')

  const b = scan.images[1]
  assertNear(b.pdfRect.x, 310, 0.01, '第 1 页 JPEG(旋转90°) x = 350-40')
  assertNear(b.pdfRect.y, 250, 0.01, '第 1 页 JPEG(旋转90°) y')
  assertNear(b.pdfRect.width, 40, 0.01, '第 1 页 JPEG(旋转90°) width')
  assertNear(b.pdfRect.height, 60, 0.01, '第 1 页 JPEG(旋转90°) height')
  assertEq(b.pixelWidth + 'x' + b.pixelHeight, '40x24', '第 1 页 JPEG 像素尺寸 40x24')
  assertEq(b.rotated, true, '第 1 页 JPEG rotated=true')

  assertEq(scan.images[2].page, 2, '第 3 页图片 page=2')
  assertEq(scan.images[2].drawIndex, 0, '第 3 页图片 drawIndex=0')
  return bytes
}

/* ------------------------------------------------------------------ *
 * B paintImageXObjectRepeat 展开
 * ------------------------------------------------------------------ */

async function caseB() {
  console.log('\n[B] paintImageXObjectRepeat 展开（≥3 组同图同尺寸连续绘制会被 pdf.js 合并）')
  const doc = await PDFDocument.create()
  const png = await doc.embedPng(makePng(24, 16, [39, 174, 96]))
  const page = doc.addPage([600, 400])
  // 6 张同尺寸、连续绘制 → 触发 pdf.js 的 repeat 优化
  const xs = [40, 120, 200, 280, 360, 440]
  for (const x of xs) page.drawImage(png, { x, y: 120, width: 60, height: 40 })
  const bytes = await doc.save({ useObjectStreams: false })

  const scan = await listPdfImages(bytes)
  console.log('      images=' + scan.images.length + ' ' + JSON.stringify({ unsupported: scan.unsupportedOps }))
  for (const it of scan.images) {
    console.log('      ' + it.key + ' pdfRect=' + JSON.stringify(round(it.pdfRect)) + ' px=' + it.pixelWidth + 'x' + it.pixelHeight)
  }
  assertEq(scan.images.length, 6, '6 张全部列出（repeat 被完整展开）')
  assertEq(scan.unsupportedOps.repeat, 0, 'unsupportedOps.repeat = 0（无漏图）')
  let okX = true
  for (let i = 0; i < 6; i++) {
    const r = scan.images[i].pdfRect
    if (Math.abs(r.x - xs[i]) > 0.01 || Math.abs(r.y - 120) > 0.01 || Math.abs(r.width - 60) > 0.01 || Math.abs(r.height - 40) > 0.01) {
      okX = false
    }
  }
  assert(okX, '6 张的 pdfRect 与绘制位置一一对应（' + JSON.stringify(scan.images.map((i) => round(i.pdfRect))) + '）')
  assertEq(scan.images.map((i) => i.pixelWidth + 'x' + i.pixelHeight).join(','), '24x16,24x16,24x16,24x16,24x16,24x16', '6 张像素尺寸都是 24x16')
  return bytes
}

/* ------------------------------------------------------------------ *
 * C paintInlineImageXObjectGroup 展开
 * ------------------------------------------------------------------ */

/** 直接拼一段带内联图片的内容流（pdf-lib 不会生成内联图，只能手搓） */
function buildInlineImageOps(count, imgW, imgH, drawSize) {
  const ascii = (s) => Array.from(s, (ch) => ch.charCodeAt(0))
  const chunks = []
  for (let k = 0; k < count; k++) {
    const x = 20 + (k % 6) * 60
    const y = 200 - Math.floor(k / 6) * 60
    chunks.push([...ascii(`q\n${drawSize} 0 0 ${drawSize} ${x} ${y} cm\nBI\n/W ${imgW}\n/H ${imgH}\n/CS /RGB\n/BPC 8\nID\n`)])
    const px = new Uint8Array(imgW * imgH * 3)
    for (let i = 0; i < imgW * imgH; i++) {
      px[i * 3] = (i * 7 + k * 40) % 256
      px[i * 3 + 1] = (i * 13 + k * 15) % 256
      px[i * 3 + 2] = (i * 29 + k * 90) % 256
    }
    chunks.push(px)
    chunks.push([...ascii('\nEI\nQ\n')])
  }
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

async function caseC() {
  console.log('\n[C] paintInlineImageXObjectGroup 展开（≥10 张连续内联图会被 pdf.js 打包合并）')
  const COUNT = 12
  const IMG_W = 8
  const IMG_H = 6
  const DRAW = 12 // pt（≥8 才不会被过滤）
  const doc = await PDFDocument.create()
  const page = doc.addPage([400, 300])
  const content = buildInlineImageOps(COUNT, IMG_W, IMG_H, DRAW)
  const raw = PDFRawStream.of(doc.context.obj({ Length: content.length }), content)
  const ref = doc.context.register(raw)
  page.node.set(PDFName.of('Contents'), ref)
  const bytes = await doc.save({ useObjectStreams: false })
  console.log('      构造 PDF ' + bytes.length + ' 字节；内联图 ' + COUNT + ' 张，' + IMG_W + 'x' + IMG_H + 'px，绘制 ' + DRAW + 'x' + DRAW + 'pt')

  const scan = await listPdfImages(bytes)
  console.log('      images=' + scan.images.length + ' ' + JSON.stringify({ unsupported: scan.unsupportedOps, small: scan.skippedSmall }))
  for (const it of scan.images) {
    console.log('      ' + it.key + ' objId=' + it.objId + ' pdfRect=' + JSON.stringify(round(it.pdfRect)) + ' px=' + it.pixelWidth + 'x' + it.pixelHeight)
  }
  assertEq(scan.images.length, COUNT, '内联图片组 ' + COUNT + ' 张全部列出')
  assertEq(scan.unsupportedOps.inlineGroup, 0, 'unsupportedOps.inlineGroup = 0（无漏图）')

  let geomOk = true
  for (let k = 0; k < COUNT; k++) {
    const r = scan.images[k].pdfRect
    const ex = 20 + (k % 6) * 60
    const ey = 200 - Math.floor(k / 6) * 60
    if (Math.abs(r.x - ex) > 0.01 || Math.abs(r.y - ey) > 0.01 || Math.abs(r.width - DRAW) > 0.01 || Math.abs(r.height - DRAW) > 0.01) geomOk = false
  }
  assert(geomOk, '每张内联图的 pdfRect 与 BI 的 cm 一致（12×12pt 落在各自网格点）')
  assertEq(
    scan.images.map((i) => i.pixelWidth + 'x' + i.pixelHeight).join(','),
    Array(COUNT).fill(IMG_W + 'x' + IMG_H).join(','),
    '像素尺寸都取自子图（' + IMG_W + 'x' + IMG_H + '），不是合并图尺寸'
  )

  // 惰性像素：取第 4 张，解码验证尺寸
  const target = scan.images[3]
  const url = await getPlacedImageDataUrl(bytes, target)
  const size = decodeDataUrlSize(url)
  console.log('      getPlacedImageDataUrl(' + target.key + ') → ' + (size ? size.mime + ' ' + size.width + 'x' + size.height + ' ' + size.bytes + '字节' : '解码失败'))
  assert(!!size, '内联子图能取回可解码的 data URL')
  if (size) {
    assertEq(size.width + 'x' + size.height, IMG_W + 'x' + IMG_H, '取回的内联子图像素尺寸 = ' + IMG_W + 'x' + IMG_H)
  }
  return bytes
}

/* ------------------------------------------------------------------ *
 * D 惰性 dataUrl（xobject 的 PNG / JPEG）
 * ------------------------------------------------------------------ */

async function caseD(bytes) {
  console.log('\n[D] 惰性 dataUrl：getPlacedImageDataUrl 逐张取回')
  const scan = await listPdfImages(bytes)
  const pngImg = scan.images[0]
  const jpgImg = scan.images[1]
  const u1 = await getPlacedImageDataUrl(bytes, pngImg)
  const u2 = await getPlacedImageDataUrl(bytes, jpgImg)
  const s1 = decodeDataUrlSize(u1)
  const s2 = decodeDataUrlSize(u2)
  console.log('      PNG 来源: ' + (s1 ? s1.mime + ' ' + s1.width + 'x' + s1.height : '失败'))
  console.log('      JPEG(旋转) 来源: ' + (s2 ? s2.mime + ' ' + s2.width + 'x' + s2.height : '失败'))
  assertEq(s1 && s1.width + 'x' + s1.height, '50x30', 'xobject PNG 取回 50x30')
  assertEq(s1 && s1.mime, 'image/png', 'xobject PNG 是 image/png')
  assertEq(s2 && s2.width + 'x' + s2.height, '40x24', 'xobject JPEG 取回 40x24')

  // 旋转图的像素本身仍是正的（旋转只体现在 CTM，不影响像素）
  assertEq(jpgImg.rotated, true, '被取样那张 JPEG 确实是旋转绘制')

  // 越界/错误 page 必须报错而不是静默
  let threw = ''
  try {
    await getPlacedImageDataUrl(bytes, { ...pngImg, page: 99 })
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e)
  }
  assert(threw !== '', '对越界页取样会抛错：' + threw)
}

/* ------------------------------------------------------------------ *
 * E 内存 / 耗时：惰性 vs 逐张取回（旧「急切」行为的等价复现）
 * ------------------------------------------------------------------ */

async function caseE() {
  console.log('\n[E] 枚举的内存与耗时（惰性 vs 逐张取回 = 旧急切行为的等价复现）')
  const PAGES = 12
  const PER_PAGE = 3
  const doc = await PDFDocument.create()
  const jpg = await doc.embedJpg(makeJpeg(900, 700, [80, 120, 160]))
  const png = await doc.embedPng(makePng(600, 400, [200, 80, 60]))
  for (let p = 0; p < PAGES; p++) {
    const page = doc.addPage([600, 800])
    for (let k = 0; k < PER_PAGE; k++) {
      const useJpg = (p + k) % 2 === 0
      const img = useJpg ? jpg : png
      page.drawImage(img, {
        x: 30,
        y: 60 + k * 240,
        width: useJpg ? 260 : 240,
        height: useJpg ? 200 : 160,
        rotate: k === 2 ? degrees(3) : undefined
      })
    }
  }
  const bytes = await doc.save({ useObjectStreams: false })
  console.log('      测试 PDF: ' + PAGES + ' 页 × ' + PER_PAGE + ' 图 = ' + PAGES * PER_PAGE + ' 张，' + bytes.length + ' 字节')

  const gc = () => {
    if (typeof global.gc === 'function') {
      global.gc()
      global.gc()
      global.gc()
    }
  }
  const heapMB = () => Math.round((process.memoryUsage().heapUsed / 1048576) * 100) / 100

  // 惰性：只收集标量（page/drawIndex/objId/pdfRect/pixelWidth/pixelHeight/rotated）
  gc()
  const h0 = heapMB()
  const t0 = Date.now()
  const scan = await listPdfImages(bytes)
  const lazyMs = Date.now() - t0
  gc()
  const h1 = heapMB()
  const scanBytes = Buffer.byteLength(JSON.stringify(scan.images))
  console.log('      惰性枚举: ' + scan.images.length + ' 张，耗时 ' + lazyMs + 'ms，结果常驻 ' + scanBytes + 'B，heapUsed ' + h0 + 'MB → ' + h1 + 'MB（Δ ' + (Math.round((h1 - h0) * 100) / 100) + 'MB）')
  assertEq(scan.images.length, PAGES * PER_PAGE, '惰性枚举列出全部 ' + PAGES * PER_PAGE + ' 张')

  // 急切等价物：把 36 张图的像素全部解码成 data URL 并保留在数组里（= 旧行为会干的事）
  gc()
  const h2 = heapMB()
  const t1 = Date.now()
  const urls = []
  for (const it of scan.images) urls.push(await getPlacedImageDataUrl(bytes, it))
  const eagerMs = Date.now() - t1
  const urlChars = urls.reduce((n, u) => n + u.length, 0)
  gc()
  const h3 = heapMB()
  console.log('      逐张取回(等效急切): 耗时 ' + eagerMs + 'ms，data URL 合计 ' + Math.round(urlChars / 1024) + 'KB，heapUsed ' + h2 + 'MB → ' + h3 + 'MB（Δ ' + (Math.round((h3 - h2) * 100) / 100) + 'MB）')
  assert(urls.every((u) => u.startsWith('data:image/')), '逐张取回全部得到可用 data URL')

  // 判据一（耗时）：惰性枚举不做任何解码/渲染，应远快于逐张取回
  assert(lazyMs * 5 < eagerMs, '惰性枚举耗时 < 逐张取回的 1/5：' + lazyMs + 'ms < ' + Math.round(eagerMs / 5) + 'ms')
  // 判据二（常驻体积）：惰性结果只持有标量，与急切持有的 base64 不是一个量级
  assert(scanBytes * 10 < urlChars, '惰性结果常驻 ' + scanBytes + 'B，< 急切持有的 data URL ' + urlChars + 'B 的 1/10')
  urls.length = 0
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

function round(r) {
  return { x: Math.round(r.x * 100) / 100, y: Math.round(r.y * 100) / 100, width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100 }
}

async function main() {
  const bytesA = await caseA()
  await caseB()
  const bytesC = await caseC()
  void bytesC
  await caseD(bytesA)
  await caseE()

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
