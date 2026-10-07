/**
 * 复现「另存为 PDF 后是空白」。
 *
 * 忠实复刻 docsIpc 的 docs:save-as-format(format==='pdf') 分支：
 *   1. 渲染层给 content（HTML 或纯文本）
 *   2. 主进程 htmlWrap() 包成完整文档
 *   3. htmlToPdfBytes() → soffice --convert-to pdf
 *   4. fs.writeFile(Buffer.from(bytes))
 * 然后**用 pdf.js 提取输出 PDF 的文字**，判断是否空白。
 *
 * 运行：
 *   NODE_OPTIONS="" "<managed node 22>" --experimental-strip-types tests/pdf-export-blank-repro.mjs
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const WORK = join(HERE, 'pdf-audit', 'work')
const SOFFICE = join(ROOT, 'resources', 'tools', 'soffice', 'program', 'soffice.com')
const CONVERT_TIMEOUT_MS = 120000

/** 与 src/main/pdf/sofficeOrient.ts 的 cleanSofficeEnv 等价：清掉 PYTHONPATH / PYTHONHOME */
const CLEAN_ENV = { ...process.env }
delete CLEAN_ENV.PYTHONPATH
delete CLEAN_ENV.PYTHONHOME
delete CLEAN_ENV.PYTHONSTARTUP

const toSofficePath = (p) => p.replace(/\\/g, '/')

/** 与 src/main/docsIpc.ts 的 htmlWrap 逐字符一致 */
const htmlWrap = (inner, baseName = '文档') =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${baseName}</title></head><body class="docs-word-body">${inner}</body></html>`

function runSoffice(args) {
  return new Promise((resolve) => {
    let done = false
    let stderr = ''
    const child = spawn(SOFFICE, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: CLEAN_ENV
    })
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      resolve({ ok: false, stderr: 'timeout' })
    }, CONVERT_TIMEOUT_MS)
    child.stdout?.on('data', () => undefined)
    child.stderr?.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, stderr: err.message })
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: code === 0, stderr })
    })
  })
}

/** 与 htmlToPdfBytes 等价（去掉 electron 依赖） */
async function htmlToPdfBytes(html, baseName = '文档') {
  const tmpDir = join(WORK, `blank-repro-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const outDir = join(tmpDir, 'out')
  await fs.mkdir(outDir, { recursive: true })
  const srcPath = join(tmpDir, 'doc.html')
  const raw = html ?? ''
  const doc = /^\s*(<!doctype|<html)/i.test(raw) ? raw : htmlWrap(raw, baseName)
  await fs.writeFile(srcPath, doc, 'utf-8')
  const r = await runSoffice([
    '--headless',
    '--norestore',
    '--convert-to',
    'pdf',
    '--outdir',
    toSofficePath(outDir),
    toSofficePath(srcPath)
  ])
  const outPath = join(outDir, 'doc.pdf')
  let buf = null
  try {
    buf = await fs.readFile(outPath)
  } catch {
    buf = null
  }
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  if (!r.ok) return { ok: false, error: r.stderr.slice(-300) }
  if (!buf || buf.byteLength < 5 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return { ok: false, error: 'no valid pdf: ' + r.stderr.slice(-300) }
  }
  return { ok: true, bytes: new Uint8Array(buf) }
}

async function extractText(bytes) {
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: join(ROOT, 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/',
    cMapUrl: join(ROOT, 'node_modules', 'pdfjs-dist', 'cmaps') + '/',
    cMapPacked: true,
    useSystemFonts: false,
    isEvalSupported: false
  })
  const pdf = await task.promise
  const pages = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i)
    const tc = await p.getTextContent()
    pages.push(tc.items.map((it) => it.str).join(''))
  }
  // pdfjs v6 的 PDFDocumentProxy 没有 destroy()，销毁要落在 loadingTask 上
  await task.destroy()
  return pages
}

/* ------------------------------------------------------------------ */

const CN = '这是正文内容，用来判断导出的 PDF 是否真的有字。'

/** 用例：name → 渲染层实际会传的 content */
const CASES = [
  {
    name: 'A. 富文本 HTML（rich 模式 getRichDomHtml 的典型产物）',
    inner: `<h1>测试标题</h1><p>${CN}</p><p>第二段：ASCII abc 123</p>`
  },
  {
    name: 'B. PDF 文本层提取 HTML（pdfBytesToHtml 的产物形状）',
    inner: `<h1>年度报告</h1><p>${CN}</p><ul><li>要点一</li><li>要点二</li></ul>`
  },
  {
    name: 'C. 环境里的真实 htmlWrap 包裹结果（content 为纯文本、含换行）',
    inner: null
  },
  {
    name: 'D. 空内容（另存为时 content="" —— 看是否静默产出空白）',
    inner: ''
  },
  {
    name: 'E. 只有空白字符',
    inner: '   \n\t  '
  }
]

let pass = 0
let fail = 0

console.log('soffice =', SOFFICE)
await fs.mkdir(WORK, { recursive: true })

for (const c of CASES) {
  let content
  let wrapped
  if (c.name.startsWith('C.')) {
    // C 模拟 source:'text' + format:'pdf'：渲染层传的是纯文本，主进程照样 htmlWrap
    content = `${CN}\n第二行\n第三行`
    wrapped = htmlWrap(content, '文档')
  } else {
    content = c.inner
    wrapped = htmlWrap(content, '文档')
  }
  const r = await htmlToPdfBytes(wrapped, '文档')
  if (!r.ok) {
    console.log(`\n${c.name}\n   ❌ 转换失败：${r.error}`)
    fail++
    continue
  }
  let pages
  try {
    pages = await extractText(r.bytes)
  } catch (e) {
    console.log(`\n${c.name}\n   ❌ 产出无法被 pdf.js 打开：${e.message}`)
    fail++
    continue
  }
  const text = pages.join('')
  const blank = text.trim().length === 0
  console.log(`\n${c.name}`)
  console.log(`   字节=${r.bytes.byteLength} 页数=${pages.length} 提取文字长度=${text.trim().length}`)
  console.log(`   提取内容=${JSON.stringify(text.slice(0, 80))}`)
  console.log(`   → ${blank ? '⚠️ 空白 PDF（复现成功）' : '✅ 有内容'}`)
  if (blank) fail++
  else pass++
}

console.log(`\n===== 有内容 ${pass} / 空白 ${fail} =====`)
