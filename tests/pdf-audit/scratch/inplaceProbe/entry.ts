/* 就地改字探针入口（真实 Chromium 渲染进程）。
 * 直接调用项目真实实现 replacePdfText —— 不是复刻，也不是替身。
 * 与 pdfEditProbe 的区别：那个验证 pdfToHtml 的文本层，这个验证改字回写，
 * 因此另起一个目录，避免覆盖并行任务正在用的探针。 */
import { replacePdfText } from '../../../../src/renderer/src/utils/pdfInPlaceReplace.ts'
import { renderTextToPng } from '../../../../src/renderer/src/utils/pdfText.ts'

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

function bytesToB64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)))
  }
  return btoa(s)
}

interface Rep {
  page: number
  rect: { x: number; y: number; width: number; height: number }
  baseline: number
  fontSize: number
  color: { r: number; g: number; b: number }
  bgColor: { r: number; g: number; b: number }
  align: 'left' | 'center' | 'right'
  newText: string
}

;(window as unknown as Record<string, unknown>).__run = async (srcB64: string, reps: Rep[]) => {
  const out: Record<string, unknown> = {
    chromium: navigator.userAgent,
    canvasAvailable: typeof document.createElement('canvas').getContext === 'function'
  }
  const t0 = Date.now()
  try {
    const src = b64ToBytes(srcB64)

    // 先用真实 Chromium canvas 量一次栅格化指标（这是替身路径量不准的部分）
    const zh = reps.find((r) => /[^\x20-\x7e]/.test(r.newText))
    if (zh) {
      const raster = await renderTextToPng(zh.newText, { fontSize: zh.fontSize, color: zh.color, opacity: 1 })
      out.raster = {
        text: zh.newText,
        width: raster.width,
        height: raster.height,
        baselineFromBottom: raster.baselineFromBottom,
        pngBytes: raster.png.length
      }
    }

    const outBytes = await replacePdfText(src, reps)
    out.ok = true
    out.head = String.fromCharCode(...outBytes.subarray(0, 8))
    out.inBytes = src.length
    out.outBytes = outBytes.length
    out.outB64 = bytesToB64(outBytes)
  } catch (e) {
    out.ok = false
    out.error = String((e as Error)?.stack || (e as Error)?.message || e)
  }
  out.ms = Date.now() - t0
  return out
}
