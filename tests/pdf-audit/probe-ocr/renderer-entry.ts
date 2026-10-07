/**
 * 无头 Electron 探针 · 渲染进程入口。
 *
 * 目的（#14）：P3#9 的 node 无头 E2E 走的是 onnxruntime-web **node 构建** + 非 jsep
 * wasm；Electron 渲染进程实际走 **jsep wasm**。本探针在真实 Chromium 里驱动
 * **生产模块**（pdfRender / ppocr / pdfOcrExtract 原文件，esbuild 打包）跑同一条链路，
 * 补上「四者组合 + OCR_RENDER_OPTS 在真实渲染进程」的验证缺口。
 *
 * 简化声明（已在报告中向 team-lead 备案）：
 *   - 绕过 `window.api.ocr.*` IPC：模型/wasm/字典直接用 node fs 读**同一路径的同一批
 *     文件**（main/ocr.ts readModel/readWasm/getDict 读的就是这些）。IPC 传输由
 *     TextTools 生产在用，不在本探针验证范围。
 *   - **不绕过** wasm 后端：ppocr 请求 `ort-wasm-simd-threaded.jsep.wasm`，探针按生产
 *     映射返回该文件 → ort 浏览器构建 + jsep 二进制，正是渲染进程真实路径。
 *   - `ort.env.wasm.numThreads = 1`：仅限探针环境（file:// 页面下 worker 生成策略与
 *     生产页面不同），避免把探针环境差异误判为产品缺陷；单线程不影响「jsep 可用」
 *     这一验证目标。
 */
import * as ort from 'onnxruntime-web'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { renderPdfPages } from '../../../src/renderer/src/utils/pdfRender'
import { recognizeImage } from '../../../src/renderer/src/utils/ppocr'
import { ocrExtractPages, matteWhite, OCR_RENDER_OPTS } from '../../../src/renderer/src/utils/pdfOcrExtract'
import { pagesToMarkdown } from '../../../src/renderer/src/utils/pdfMarkdown'

interface ProbeConfig {
  root: string
  workerUrl: string
}
declare global {
  interface Window {
    __CFG?: ProbeConfig
    __PDF_WORKER_URL__?: string
    __runProbe?: () => Promise<unknown>
  }
}

const CFG = window.__CFG
if (!CFG || !CFG.root) throw new Error('探针配置缺失：window.__CFG 未注入（由 run.mjs 生成的 index.html 提供）')

/* ── 生产 IPC 的文件级替身：同路径同文件，绕过 IPC 传输（见文件头声明） ── */
const nodeRequire = (window as unknown as { require?: (id: string) => unknown }).require
if (typeof nodeRequire !== 'function') throw new Error('探针需要 nodeIntegration: true（window.require 缺失）')
const fs = nodeRequire('node:fs') as typeof import('node:fs')
const nodePath = nodeRequire('node:path') as typeof import('node:path')

;(window as unknown as { api: unknown }).api = {
  ocr: {
    wasm: async (name: string) =>
      new Uint8Array(fs.readFileSync(nodePath.join(CFG.root, 'node_modules', 'onnxruntime-web', 'dist', name))),
    model: async (name: string) =>
      new Uint8Array(fs.readFileSync(nodePath.join(CFG.root, 'node_modules', 'paddle-ocr-onnx-models', 'models', name))),
    dict: async () => fs.readFileSync(nodePath.join(CFG.root, 'resources', 'ppocr_keys_v1.txt'), 'utf8')
  }
}

/* 探针环境单线程：file:// 页面下 worker 生成策略与生产不同，避免环境差异误判（见文件头） */
ort.env.wasm.numThreads = 1

/* 与 node 无头 E2E 同口径的已知文本素材与关键词 */
const SOURCE_WORDS = [
  'Quarterly', 'Report', '2026', 'Total', 'Revenue', '12345678', 'USD',
  'Shanghai', 'Lingmo', 'Workbench', 'Annual', 'Audit', 'Summary',
  'Growth', 'Rate', '36', 'Percent', 'Prepared', 'Engineering', 'Team'
]
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, '')

async function buildSamplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p1 = doc.addPage([595, 842])
  p1.drawText('Quarterly Report 2026', { x: 60, y: 760, size: 20, font, color: rgb(0, 0, 0) })
  p1.drawText('Total Revenue 12345678 USD', { x: 60, y: 720, size: 14, font, color: rgb(0, 0, 0) })
  p1.drawText('Shanghai Lingmo Workbench', { x: 60, y: 692, size: 14, font, color: rgb(0, 0, 0) })
  const p2 = doc.addPage([595, 842])
  p2.drawText('Annual Audit Summary', { x: 60, y: 760, size: 20, font, color: rgb(0, 0, 0) })
  p2.drawText('Growth Rate 36 Percent', { x: 60, y: 720, size: 14, font, color: rgb(0, 0, 0) })
  p2.drawText('Prepared by Engineering Team', { x: 60, y: 692, size: 14, font, color: rgb(0, 0, 0) })
  return doc.save()
}

/** 数透明像素（alpha < 255）与非白墨迹像素 */
function canvasStats(ctx: CanvasRenderingContext2D, w: number, h: number): { transparent: number; ink: number } {
  const d = ctx.getImageData(0, 0, w, h).data
  let transparent = 0
  let ink = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 255) transparent++
    else if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) ink++
  }
  return { transparent, ink }
}

window.__runProbe = async () => {
  const bytes = await buildSamplePdf()

  /* 1. matteWhite 不变式：交给 OCR 的画布必须不透明、白底、墨迹不丢失。
   *    实测 pdfjs 6.3.289 默认已填充不透明白（transparentBefore == 0）——
   *    matteWhite 是不依赖该默认值的防线，不是对当前版本的修复。 */
  const [page1] = await renderPdfPages(bytes, [0], OCR_RENDER_OPTS)
  if (!page1) throw new Error('第 1 页渲染失败')
  const rawCtx = page1.canvas.getContext('2d') as CanvasRenderingContext2D
  const before = canvasStats(rawCtx, page1.canvas.width, page1.canvas.height)
  const matted = matteWhite(page1.canvas)
  const mattedCtx = matted.getContext('2d') as CanvasRenderingContext2D
  const after = canvasStats(mattedCtx, matted.width, matted.height)

  /* 2. OCR：渲染 → toDataURL → recognizeImage（jsep wasm + 生产模型文件） */
  const progress: Array<{ page: number; total: number; stage: string }> = []
  const t0 = performance.now()
  const res = await ocrExtractPages(
    bytes,
    [0, 1],
    { render: renderPdfPages, recognize: recognizeImage },
    (p) => progress.push(p)
  )
  const elapsedMs = Math.round(performance.now() - t0)

  const allText = res.pages.map((p) => p.lines.join('')).map(norm).join('')
  const hits = SOURCE_WORDS.filter((w) => allText.includes(norm(w)))
  const misses = SOURCE_WORDS.filter((w) => !allText.includes(norm(w)))

  /* 3. markdown（与提取面板同一条输出路径） */
  const md = pagesToMarkdown(res.pages, 'probe-ocr-sample.pdf')

  return {
    env: {
      chromium: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? navigator.userAgent,
      render: OCR_RENDER_OPTS
    },
    matte: {
      size: `${matted.width}x${matted.height}`,
      transparentBefore: before.transparent,
      transparentAfter: after.transparent,
      inkBefore: before.ink,
      inkAfter: after.ink
    },
    ocr: {
      elapsedMs,
      lineCount: res.lineCount,
      avgScore: Number(res.avgScore.toFixed(3)),
      pages: res.pages.map((p) => ({ pageIndex: p.pageIndex, lines: p.lines })),
      hitRate: Number((hits.length / SOURCE_WORDS.length).toFixed(3)),
      hits: hits.length,
      keywords: SOURCE_WORDS.length,
      misses
    },
    progress: {
      pages: [...new Set(progress.map((p) => p.page))],
      stages: [...new Set(progress.map((p) => p.stage))]
    },
    markdown: {
      hasPage1: md.includes('## 第 1 页'),
      hasPage2: md.includes('## 第 2 页'),
      head: md.split('\n').slice(0, 6)
    }
  }
}
