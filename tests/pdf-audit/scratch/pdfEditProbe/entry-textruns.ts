/* 探针入口（textRuns）：直接调用项目真实实现 pdfBytesToTextRuns（不是复刻）。
 * eslint/typecheck 均不覆盖 tests/，这里刻意不做类型体操的原因：
 *   真相必须来自「项目真实模块」在真实 Chromium 里的运行结果。 */
import * as pdfjs from 'pdfjs-dist'
import { pdfBytesToTextRuns } from '../../../../src/renderer/src/utils/pdfTextBlocks.ts'

const workerUrl = new URL('/pdf.worker.min.mjs', location.origin).href
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

/** 客观核对：把 run 的 PDF 坐标框换算回设备像素，数一数框里到底有没有深色字形像素。
 * 这是判断「坐标换算方向/原点有没有搞反」的最硬证据——搞反了框会落在空白处。 */
async function pixelCheck(bytes: Uint8Array, pageIndex: number, rect: Rect, pageHeight: number) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(0) }).promise
  try {
    const page = await doc.getPage(pageIndex + 1)
    const vp = page.getViewport({ scale: 2 })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(vp.width)
    canvas.height = Math.round(vp.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    await page.render({ canvas, canvasContext: ctx, viewport: vp } as never).promise
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)

    const a = vp.convertToViewportPoint(rect.x, rect.y + rect.height)
    const b = vp.convertToViewportPoint(rect.x + rect.width, rect.y)
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0])))
    const x1 = Math.min(canvas.width, Math.ceil(Math.max(a[0], b[0])))
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1])))
    const y1 = Math.min(canvas.height, Math.ceil(Math.max(a[1], b[1])))

    let dark = 0
    let ink = 0
    let total = 0
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * canvas.width + x) * 4
        const lum = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]
        total++
        if (lum < 160) dark++
        // 浅色/淡化文字（enhance-source 那类低对比样本）用更宽的阈值也能体现「框里有东西」
        if (lum < 235) ink++
      }
    }
    const unrotated = page.getViewport({ scale: 1, rotation: 0 })
    const out = {
      deviceBox: [x0, y0, x1, y1],
      canvas: [canvas.width, canvas.height],
      pixels: total,
      darkPixels: dark,
      darkFraction: total > 0 ? dark / total : 0,
      inkPixels: ink,
      inkFraction: total > 0 ? ink / total : 0,
      // rect 是「未旋转」PDF 用户空间，因此要和未旋转的页高比；/Rotate≠0 时两者不同
      yInPageRange: rect.y >= -0.5 && rect.y + rect.height <= pageHeight + 0.5,
      yInUnrotatedPageRange: rect.y >= -0.5 && rect.y + rect.height <= unrotated.height + 0.5,
      unrotatedPage: [unrotated.width, unrotated.height],
      xNonNegative: rect.x >= -0.5
    }
    canvas.width = 0
    canvas.height = 0
    return out
  } finally {
    const disposable = doc as unknown as { destroy?: () => Promise<void> }
    if (typeof disposable.destroy === 'function') await disposable.destroy()
  }
}

/** 字体名诊断：不做任何「取真实名」的加工，只如实回报 commonObjs 在各阶段到底有什么，
 * 用来解释生产实现为什么落到回退值。 */
async function fontProbe(bytes: Uint8Array, pageIndex: number) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(0) }).promise
  try {
    const page = await doc.getPage(pageIndex + 1)
    const content = await page.getTextContent()
    const seen = new Map<string, number>()
    for (const item of content.items) {
      const rec = item as { fontName?: string }
      if (typeof rec.fontName !== 'string') continue
      seen.set(rec.fontName, (seen.get(rec.fontName) ?? 0) + 1)
    }

    const describe = (fontName: string): Record<string, unknown> => {
      const entry: Record<string, unknown> = { fontName, items: seen.get(fontName) ?? 0 }
      try {
        const raw = page.commonObjs.get(fontName) as { name?: unknown; fallbackName?: unknown }
        entry.syncOk = true
        entry.name = typeof raw?.name === 'string' ? raw.name : null
        entry.fallbackName = typeof raw?.fallbackName === 'string' ? raw.fallbackName : null
      } catch (e) {
        entry.syncOk = false
        entry.syncError = String((e as Error)?.message || e)
      }
      return entry
    }

    const beforeRender = [...seen.keys()].map(describe)

    // 渲染一次，看字体对象是否随后进入 commonObjs
    const renderVp = page.getViewport({ scale: 2 })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(renderVp.width)
    canvas.height = Math.round(renderVp.height)
    const ctx = canvas.getContext('2d')
    if (ctx) {
      await page.render({ canvas, canvasContext: ctx, viewport: renderVp } as never).promise
      canvas.width = 0
      canvas.height = 0
    }

    const afterRender = [...seen.keys()].map(describe)

    // 回调形式等待（pdf.js 对回调挂的是 promise.then）——这是生产实现用的方式
    const viaCallback: Record<string, unknown>[] = []
    for (const fontName of seen.keys()) {
      const rec: Record<string, unknown> = { fontName }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          rec.callback = 'timeout'
          resolve()
        }, 2000)
        try {
          const res = page.commonObjs.get(fontName, (data: unknown) => {
            clearTimeout(timer)
            const obj = data as { name?: unknown; fallbackName?: unknown }
            rec.callback = 'resolved'
            rec.name = typeof obj?.name === 'string' ? obj.name : null
            rec.fallbackName = typeof obj?.fallbackName === 'string' ? obj.fallbackName : null
            resolve()
          }) as unknown
          if (res !== null && res !== undefined) {
            clearTimeout(timer)
            const obj = res as { name?: unknown; fallbackName?: unknown }
            rec.callback = 'sync'
            rec.name = typeof obj?.name === 'string' ? obj.name : null
            rec.fallbackName = typeof obj?.fallbackName === 'string' ? obj.fallbackName : null
            resolve()
          }
        } catch (e) {
          clearTimeout(timer)
          rec.callback = 'throw'
          rec.error = String((e as Error)?.message || e)
          resolve()
        }
      })
      viaCallback.push(rec)
    }

    return { beforeRender, afterRender, viaCallback }
  } finally {
    const disposable = doc as unknown as { destroy?: () => Promise<void> }
    if (typeof disposable.destroy === 'function') await disposable.destroy()
  }
}

;(window as unknown as { __runTextRuns: (b64: string, maxPages?: number) => Promise<unknown> }).__runTextRuns =
  async (b64: string, maxPages = 2) => {
    const bytes = b64ToBytes(b64)
    const progress: string[] = []
    const out: Record<string, unknown> = { workerSrc: workerUrl, pdfjsVersion: pdfjs.version }
    const t0 = Date.now()
    try {
      const result = await pdfBytesToTextRuns(bytes, {
        maxPages,
        onProgress: (done, total) => progress.push(done + '/' + total)
      })
      out.ok = true
      out.totalPages = result.totalPages
      out.progressCalls = progress
      out.pageCount = result.pages.length
      out.pages = result.pages.map((p) => ({
        page: p.page,
        width: p.width,
        height: p.height,
        runCount: p.runs.length,
        runs: p.runs.slice(0, 20),
        alignCounts: p.runs.reduce<Record<string, number>>((acc, r) => {
          acc[r.align] = (acc[r.align] ?? 0) + 1
          return acc
        }, {}),
        fontFamilies: [...new Set(p.runs.map((r) => r.fontFamily))]
      }))
      out.fontProbe = await fontProbe(bytes, result.pages[0]?.page ?? 0)

      const page0 = result.pages[0]
      out.firstRunExact = page0 && page0.runs[0] ? JSON.stringify(page0.runs[0]) : null
      if (page0 && page0.runs.length > 0) {
        const checks = []
        for (const run of page0.runs.slice(0, 3)) {
          checks.push({
            id: run.id,
            text: run.text,
            pixel: await pixelCheck(bytes, page0.page, run.rect, page0.height)
          })
        }
        out.firstRunChecks = checks
      }
    } catch (e) {
      out.ok = false
      out.error = String((e as Error)?.stack || (e as Error)?.message || e)
    }
    out.ms = Date.now() - t0
    return out
  }
