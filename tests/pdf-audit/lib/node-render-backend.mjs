/**
 * 无头验收用的渲染后端与浏览器环境。
 *
 * 生产代码在浏览器里用 Chromium canvas（utils/pdfRender.renderPdfPages）；
 * 验收脚本在 Node 下没有 DOM，这里用 pdf.js + @napi-rs/canvas 提供语义等价的后端，
 * 使「图像化压缩」「面板内 OCR」这条链路能被**真实驱动**，而不是只能靠肉眼判断。
 * 另含 installBrowserShims()：装齐 ppocr.ts 需要的 window / document / Image。
 *
 * 注意：@napi-rs/canvas 是 pdfjs-dist 的传递依赖，未新增任何 npm 包。
 */
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import * as ort from 'onnxruntime-web'
import { createCanvas, Image as NapiImage } from '@napi-rs/canvas'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const PDFJS_ROOT = join(ROOT, 'node_modules', 'pdfjs-dist')

export const PDFJS_KW = {
  isEvalSupported: false,
  disableFontFace: true,
  standardFontDataUrl: join(PDFJS_ROOT, 'standard_fonts') + '/',
  cMapUrl: join(PDFJS_ROOT, 'cmaps') + '/',
  cMapPacked: true
}

/** pdf.js 打开（可带口令）+ 逐页取文本；不传口令时加密文件会抛 PasswordException */
export async function openWithPdfjs(bytes, password) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), password, ...PDFJS_KW })
  const doc = await task.promise
  let text = ''
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    text += content.items.map((it) => ('str' in it ? it.str : '')).join('')
  }
  const pages = doc.numPages
  await task.destroy()
  return { pages, text }
}

/** 渲染一页并数非白像素（判断页面是否真的有东西） */
export async function renderInkCount(bytes, pageIndex = 0) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), ...PDFJS_KW })
  const doc = await task.promise
  const page = await doc.getPage(pageIndex + 1)
  const vp = page.getViewport({ scale: 1 })
  const canvas = createCanvas(Math.round(vp.width), Math.round(vp.height))
  const ctx = canvas.getContext('2d')
  await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  let ink = 0
  for (let i = 0; i < data.length; i += 4) if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) ink++
  await task.destroy()
  return { ink, total: canvas.width * canvas.height, w: canvas.width, h: canvas.height }
}

/**
 * 与 utils/pdfRender.renderPdfPages 同语义的渲染函数（可直接注入 rasterCompressPdf）。
 * 差别只在 canvas 实现与 JPEG 编码 API（浏览器 toBlob 0~1 / node toBuffer 0~100）。
 */
export async function nodeRender(data, pageIndices, opts = {}) {
  const task = pdfjs.getDocument({ data: new Uint8Array(data), ...PDFJS_KW })
  const doc = await task.promise
  const out = []
  const scale = opts.scale ?? 2
  for (const idx of pageIndices) {
    if (idx < 0 || idx >= doc.numPages) continue
    const page = await doc.getPage(idx + 1)
    const base = page.getViewport({ scale })
    let sx = base.width
    let sy = base.height
    if (opts.maxSide && Math.max(sx, sy) > opts.maxSide) {
      const k = opts.maxSide / Math.max(sx, sy)
      sx *= k
      sy *= k
    }
    const canvas = createCanvas(Math.round(sx), Math.round(sy))
    const ctx = canvas.getContext('2d')
    const vp = page.getViewport({ scale: (scale * canvas.width) / base.width })
    await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise
    canvas.toBlob = (cb, _type, quality) => {
      try {
        cb(new Blob([canvas.toBuffer('image/jpeg', Math.round((quality ?? 0.9) * 100))], { type: 'image/jpeg' }))
      } catch {
        cb(null)
      }
    }
    out.push({ pageIndex: idx, canvas })
  }
  await task.destroy()
  return out
}

/** 生成一张高熵 JPEG（确定性伪随机，保证可复现） */
export function noiseJpeg(w, h, quality) {
  const c = createCanvas(w, h)
  const ctx = c.getContext('2d')
  const img = ctx.createImageData(w, h)
  let s = 12345
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 30 + Math.floor(rnd() * 210)
    img.data[i] = v
    img.data[i + 1] = Math.max(0, 220 - Math.floor(v * 0.7))
    img.data[i + 2] = Math.floor(v * 0.8)
    img.data[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return c.toBuffer('image/jpeg', quality)
}

/* ================= 无头 OCR 环境 ================= */

/** 只装 document.createElement('canvas')：matteWhite（白底合成）等仅依赖 document 的路径用 */
export function installCanvasShim() {
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return createCanvas(1, 1)
      throw new Error('createElement 不支持: ' + tag)
    }
  }
}

/**
 * 装齐 ppocr.ts 需要的浏览器 API（须在调用 recognizeImage 之前执行）：
 *   - window.api.ocr.*：模型 / wasm / 字典改为直接读 node_modules 与 resources/
 *     （生产走 Electron IPC 读同样这些文件）。注意 wasm 必须给**非 jsep** 的
 *     ort-wasm-simd-threaded.wasm —— node 下的 onnxruntime-web 构建配的是
 *     non-jsep 胶水，喂 jsep 二进制会 LinkError。
 *   - document.createElement('canvas') → @napi-rs/canvas
 *   - Image：napi Image 的 src 只认 Buffer，数据 URL 需转码；decode() 必须用
 *     **原生实现**（napi 异步解码完成后 drawImage 才有像素）。
 *   - ort.env.wasm.numThreads = 1：node 下不开 worker 线程。
 */
export function installBrowserShims() {
  ort.env.wasm.numThreads = 1
  globalThis.window = {
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    api: {
      ocr: {
        wasm: async () =>
          new Uint8Array(await readFile(join(ROOT, 'node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.wasm'))),
        model: async (name) =>
          new Uint8Array(await readFile(join(ROOT, 'node_modules', 'paddle-ocr-onnx-models', 'models', name))),
        dict: async () => await readFile(join(ROOT, 'resources', 'ppocr_keys_v1.txt'), 'utf8')
      }
    }
  }
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return createCanvas(1, 1)
      throw new Error('createElement 不支持: ' + tag)
    }
  }
  globalThis.Image = class extends NapiImage {
    set src(v) {
      super.src =
        typeof v === 'string' && v.startsWith('data:')
          ? Buffer.from(v.slice(v.indexOf(',') + 1), 'base64')
          : v
    }
    get naturalWidth() {
      return this.width
    }
    get naturalHeight() {
      return this.height
    }
  }
}
