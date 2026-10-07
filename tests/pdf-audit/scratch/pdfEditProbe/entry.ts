/* 探针入口：直接调用项目真实实现 pdfBytesToHtml（不是复刻）
 * 用 esbuild 打包成浏览器 ESM 后由 Electron 渲染进程加载。 */
import * as pdfjs from 'pdfjs-dist'
import { pdfBytesToHtml } from '../../../../src/renderer/src/utils/pdfToHtml.ts'

const workerUrl = new URL('/pdf.worker.min.mjs', location.origin).href
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

;(window as unknown as { __run: (b64: string) => Promise<unknown> }).__run = async (b64: string) => {
  const out: Record<string, unknown> = { workerSrc: workerUrl, pdfjsVersion: pdfjs.version }
  const t0 = Date.now()
  try {
    const r = await pdfBytesToHtml(b64ToBytes(b64), { maxPages: 200 })
    out.ok = true
    out.pages = r.pages
    out.chars = r.chars
    out.needOcr = r.needOcr
    out.note = r.note ?? null
    out.htmlLen = r.html.length
    out.html = r.html
  } catch (e) {
    out.ok = false
    out.error = String((e as Error)?.stack || (e as Error)?.message || e)
  }
  out.ms = Date.now() - t0
  return out
}
