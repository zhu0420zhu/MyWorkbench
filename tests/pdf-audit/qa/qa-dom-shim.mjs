/**
 * Node 无头环境的 DOM/Canvas shim。
 * 只为让 pdfText.renderTextToPng 等「浏览器 API 调用」在 Node 下可用：
 *   document.createElement('canvas')  → @napi-rs/canvas（Skia 后端，含 toBlob）
 *   OffscreenCanvas / ImageData        → 同上
 * 必须在其它模块「调用」这些 API 之前 import。
 */
import { createCanvas, ImageData as NapiImageData } from '@napi-rs/canvas'

if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement(tag) {
      if (String(tag).toLowerCase() === 'canvas') return createCanvas(1, 1)
      return {}
    },
    createElementNS(_ns, tag) {
      return this.createElement(tag)
    }
  }
}
if (typeof globalThis.ImageData === 'undefined') globalThis.ImageData = NapiImageData
if (typeof globalThis.OffscreenCanvas === 'undefined') {
  globalThis.OffscreenCanvas = class OffscreenCanvas {
    constructor(w, h) {
      return createCanvas(Math.max(1, w | 0), Math.max(1, h | 0))
    }
  }
}
