/* ============================================================
 * 文档查看器 IPC：打开 / 读取 / 编辑主流格式 + 打印
 * Office（DOCX 等）经 Pandoc 转 HTML，并 --extract-media
 * 把文中图片内联为 data URL，表格保留 HTML 结构便于渲染与富文本编辑。
 * ============================================================ */

import { BrowserWindow, dialog, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { basename, extname, join } from 'path'
import { app } from 'electron'
import { PandocConverter } from './convert/converters.ts'
import { pptToPdfBytes } from './ppt/pptConvert.ts'
import { spreadsheetToPdfBytes } from './docs/spreadsheetPreview.ts'
import { runFfmpeg } from './media/ffmpeg.ts'
import { htmlToPdfBytes } from './docs/htmlToPdf.ts'
import { isEffectivelyEmptyContent } from './docs/emptyContent.ts'
import { allowPath } from './pathAcl'
import type { DocKind, DocOpenResult } from '../shared/types.ts'

export type { DocKind, DocOpenResult }

/** 暴露 PandocConverter 受保护方法，供文档预览自定义命令 */
class DocsPandoc extends PandocConverter {
  exec(cmd: string[]): Promise<[boolean, string]> {
    return this.runCommand(cmd, 180)
  }
  tool(name: string): string {
    return this.getToolPath(name)
  }
}

/** HTML 文本转义（仅用于纯文本源转 HTML） */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 纯文本源 → HTML：转义后逐行包 <p>，空行用 <p><br></p> 保留换行 */
function textToHtmlParagraphs(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (line.trim() === '' ? '<p><br></p>' : `<p>${escapeHtml(line)}</p>`))
    .join('')
}

/** 「另存为」遇到实质为空的内容时的统一错误文案（这类导出若放行只会产出空白文件） */
const EMPTY_CONTENT_ERROR = '没有可导出的内容（编辑区是空的），已取消'

/**
 * 把保存对话框返回的路径的扩展名对齐到用户选定的 format。
 *
 * 关键前提：**format 始终来自用户在下拉里的选择，路径只是落点**，
 * 绝不允许反过来用「路径的扩展名」去推断导出格式（否则用户把文件名改成 xx.pdf
 * 就会让 Pandoc 按 .pdf 去写、或产出「名字是 .pdf、里面是 docx」的文件）。
 * 已有扩展名 → 替换；没有扩展名 → 追加；已经是目标扩展名 → 原样。
 */
function normalizeOutExt(filePath: string, format: string): string {
  const want = `.${format}`
  const cur = extname(filePath)
  if (!cur) return filePath + want
  if (cur.toLowerCase() === want) return filePath
  return filePath.slice(0, filePath.length - cur.length) + want
}

const TEXT_EXTS = new Set([
  '.md', '.markdown', '.mdx', '.txt', '.log', '.rst', '.org', '.tex', '.csv', '.tsv',
  '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml', '.svg',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.css', '.scss', '.less', '.html', '.htm',
  '.py', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.php', '.rb', '.sql', '.sh',
  '.bat', '.ps1', '.vue', '.svelte', '.astro', '.gitignore', '.env'
])

const CODE_EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.css', '.scss', '.less', '.py', '.java',
  '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.php', '.rb', '.sql', '.sh', '.bat', '.ps1',
  '.vue', '.svelte', '.xml', '.yaml', '.yml', '.toml', '.ini'
])

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.tif', '.tiff'])
const PDF_EXTS = new Set(['.pdf'])
const OFFICE_EXTS = new Set(['.docx', '.odt', '.rtf', '.epub', '.doc'])
/** 表格：LibreOffice calc 系滤镜转 PDF 后预览（.et 无滤镜，走 C 级拦截提示） */
const SPREADSHEET_EXTS = new Set(['.xlsx', '.xls', '.ods'])
/** 演示文稿：经 LibreOffice 转 PDF 后预览（sourceKind='slides'，DocsViewer 显示 PPT 工具） */
const SLIDES_EXTS = new Set(['.pptx', '.ppt', '.odp'])

/**
 * C 级格式：内嵌转换引擎（LibreOffice 26.2.5.2）无对应滤镜，openDocPath 直接拦截并给替代建议。
 * 实测结论见 tests/pdf-audit/scratch/format-probe/报告-格式滤镜能力实测.md。
 * 这些扩展名仍在 PICK_FILTERS 里，让用户能选中并得到明确提示，而不是「所有文件」都选不了。
 */
const UNSUPPORTED_HINTS: Record<string, string> = {
  '.et': '暂不支持直接打开 .et（内嵌转换引擎无该格式滤镜）。建议先用 WPS Office 另存为 .xlsx 后再打开',
  '.wps': '暂不支持直接打开 .wps（内嵌引擎会把它当作 MS Works 解析）。建议先用 WPS Office 另存为 .docx 后再打开',
  '.dps': '暂不支持直接打开 .dps（内嵌转换引擎无该格式滤镜）。建议先用 WPS Office 另存为 .pptx 后再打开',
  '.ofd': '暂不支持直接打开 .ofd（内嵌转换引擎无该格式滤镜）。建议用专用 OFD 阅读器查看，或先转成 PDF 再打开',
  '.mobi': '暂不支持直接打开 .mobi（内嵌转换引擎无该格式滤镜）。建议先用 Calibre 把它转成 .epub 后再打开',
  '.azw3': '暂不支持直接打开 .azw3（内嵌转换引擎无该格式滤镜）。建议先用 Calibre 把它转成 .epub 后再打开'
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf'
}

export function classifyDoc(ext: string): DocKind {
  const e = ext.toLowerCase()
  if (e === '.md' || e === '.markdown' || e === '.mdx') return 'markdown'
  if (PDF_EXTS.has(e)) return 'pdf'
  if (IMAGE_EXTS.has(e) || e === '.svg') return 'image'
  if (SPREADSHEET_EXTS.has(e)) return 'spreadsheet'
  if (OFFICE_EXTS.has(e)) return 'office'
  if (e === '.html' || e === '.htm') return 'html'
  if (e === '.json' || e === '.jsonl') return 'json'
  if (e === '.csv' || e === '.tsv') return 'csv'
  if (CODE_EXTS.has(e)) return 'code'
  if (TEXT_EXTS.has(e)) return 'text'
  return 'binary'
}

const PICK_FILTERS = [
  {
    name: '文档',
    extensions: [
      'md', 'markdown', 'txt', 'pdf', 'docx', 'doc', 'odt', 'rtf', 'epub', 'html', 'htm',
      'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'rst', 'org', 'tex', 'log',
      'xlsx', 'xls', 'ods', 'et', 'ofd', 'mobi', 'azw3', 'wps', 'dps',
      'pptx', 'ppt', 'odp'
    ]
  },
  { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'tif', 'tiff'] },
  { name: '代码', extensions: ['js', 'ts', 'tsx', 'jsx', 'css', 'py', 'java', 'go', 'rs', 'sql', 'sh'] },
  { name: '所有文件', extensions: ['*'] }
]

/** 把 HTML 里引用的本地图片转成 data URL（解决 DOCX 内嵌图裂图） */
async function inlineLocalImages(html: string, baseDir: string): Promise<string> {
  const re = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi
  const parts: string[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    parts.push(html.slice(last, m.index))
    const full = m[0]
    const src = m[1]
    if (/^(https?:|data:|blob:)/i.test(src)) {
      parts.push(full)
    } else {
      const rel = decodeURIComponent(src.replace(/^file:\/\/\//i, '').replace(/^\.\//, ''))
      const abs = rel.startsWith(baseDir) ? rel : join(baseDir, rel)
      try {
        const buf = await fs.readFile(abs)
        const ext = extname(abs).toLowerCase()
        const mime = MIME[ext] || 'image/png'
        const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
        parts.push(full.replace(src, dataUrl))
      } catch {
        // 尝试 media 目录下同名文件
        try {
          const alt = join(baseDir, 'media', rel)
          const buf = await fs.readFile(alt)
          const ext = extname(alt).toLowerCase()
          const mime = MIME[ext] || 'image/png'
          parts.push(full.replace(src, `data:${mime};base64,${buf.toString('base64')}`))
        } catch {
          parts.push(full)
        }
      }
    }
    last = m.index + full.length
  }
  parts.push(html.slice(last))
  return parts.join('')
}

/** 为 Word 式预览补齐表格/图片样式钩子 */
function enhanceOfficeHtml(html: string): string {
  // 去掉 pandoc 默认完整文档壳中的外部依赖，保留 body 内容
  let body = html
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)
  if (bodyMatch) body = bodyMatch[1]
  // 图片最大宽度
  body = body.replace(/<img\b/gi, '<img class="docs-doc-img" style="max-width:100%;height:auto;margin:8px 0;"')
  // 表格统一 class，便于 CSS
  body = body.replace(/<table\b/gi, '<table class="docs-table docs-word-table"')
  return `<div class="docs-word-body">${body}</div>`
}

async function pandocPreview(filePath: string): Promise<{ html?: string; note?: string; rawHtml?: string }> {
  const converter = new DocsPandoc()
  if (!converter.isAvailable()) {
    return { note: '未检测到 Pandoc，无法预览 DOCX/EPUB。可安装 Pandoc，或先转成 Markdown/PDF。' }
  }
  const mediaRoot = join(app.getPath('temp'), `lingmo-docs-${Date.now()}`)
  const outFile = join(mediaRoot, 'preview.html')
  try {
    await fs.mkdir(mediaRoot, { recursive: true })
    const pandoc = converter.tool('pandoc')
    const cmd = [pandoc, filePath, '-t', 'html5', '--standalone', '--extract-media', mediaRoot, '-o', outFile]
    const [ok, err] = await converter.exec(cmd)
    if (!ok) return { note: err || 'Pandoc 转换失败' }
    let html = await fs.readFile(outFile, 'utf-8')
    html = await inlineLocalImages(html, mediaRoot)
    const rawHtml = enhanceOfficeHtml(html)
    return { html: rawHtml, rawHtml }
  } catch (err) {
    return { note: `Office 预览不可用：${(err as Error).message}` }
  } finally {
    void fs.rm(mediaRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** HTML 内容另存为 DOCX（Word 式编辑后导出） */
async function htmlToDocx(html: string, outPath: string): Promise<{ ok: boolean; error?: string }> {
  const converter = new DocsPandoc()
  if (!converter.isAvailable()) {
    return { ok: false, error: '未检测到 Pandoc，无法导出 DOCX' }
  }
  const tmpDir = join(app.getPath('temp'), `lingmo-rich-${Date.now()}`)
  try {
    await fs.mkdir(tmpDir, { recursive: true })
    const htmlPath = join(tmpDir, 'doc.html')
    // 包一层完整 HTML，pandoc 更稳
    const full = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>doc</title></head><body>${html}</body></html>`
    await fs.writeFile(htmlPath, full, 'utf-8')
    const pandoc = converter.tool('pandoc')
    const [ok, err] = await converter.exec([pandoc, htmlPath, '-o', outPath])
    return ok ? { ok: true } : { ok: false, error: err || '导出 DOCX 失败' }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  } finally {
    void fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export function registerDocsIpc(): void {
  ipcMain.handle('docs:pick', async (event): Promise<DocOpenResult> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts = {
      title: '打开文档',
      filters: PICK_FILTERS,
      properties: ['openFile' as const]
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false, error: 'cancelled' }
    }
    return openDocPath(result.filePaths[0])
  })

  ipcMain.handle('docs:open-path', async (_e, path: string): Promise<DocOpenResult> => {
    if (!path) return { ok: false, error: '路径为空' }
    return openDocPath(path)
  })

  ipcMain.handle('docs:save', async (_e, path: string, content: string): Promise<{ ok: boolean; error?: string }> => {
    if (!path) return { ok: false, error: '无保存路径' }
    try {
      await fs.writeFile(path, content ?? '', 'utf-8')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  /** Word 式富文本：保存 HTML 片段（可另存 .html） */
  ipcMain.handle(
    'docs:save-html-as',
    async (event, html: string, defaultName?: string): Promise<{ ok: boolean; path?: string; error?: string }> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const opts = {
        title: '导出 HTML',
        defaultPath: defaultName || '文档.html',
        filters: [{ name: 'HTML', extensions: ['html', 'htm'] }]
      }
      const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' }
      try {
        // 内容永远是 HTML：用户手打 .txt 之类的扩展名必须纠正，否则会落下「名字与内容不符」的文件。
        // 例外：.htm 与 .html 等价，用户写 .htm 就保持 .htm，不得改写。
        const curExt = extname(result.filePath).toLowerCase()
        const outPath = curExt === '.html' || curExt === '.htm' ? result.filePath : normalizeOutExt(result.filePath, 'html')
        const full = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${basename(outPath)}</title></head><body class="docs-word-body">${html}</body></html>`
        await fs.writeFile(outPath, full, 'utf-8')
        return { ok: true, path: outPath }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  /** Word 式富文本：导出 DOCX */
  ipcMain.handle(
    'docs:save-docx-as',
    async (event, html: string, defaultName?: string): Promise<{ ok: boolean; path?: string; error?: string }> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const opts = {
        title: '导出 Word 文档',
        defaultPath: defaultName || '文档.docx',
        filters: [{ name: 'Word', extensions: ['docx'] }]
      }
      const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' }
      // 内容是 DOCX：把用户手打的其它扩展名纠正为 .docx（写盘路径与返回值一致）
      const outPath = normalizeOutExt(result.filePath, 'docx')
      return htmlToDocx(html, outPath).then((r) => ({ ...r, path: r.ok ? outPath : undefined }))
    }
  )

  /** Word 式：保存回原文件（HTML 覆写；DOCX 经 Pandoc 覆写并留 .bak） */
  ipcMain.handle(
    'docs:save-office',
    async (_e, path: string, html: string): Promise<{ ok: boolean; error?: string; note?: string }> => {
      if (!path) return { ok: false, error: '无保存路径' }
      try {
        const ext = extname(path).toLowerCase()
        // 纵深防御：PDF 不能用富文本 HTML 覆写（否则会产出「名为 .pdf 实为 DOCX」的坏文件）。
        // PDF 的编辑结果必须走「导出 PDF」另存为新文件。
        if (ext === '.pdf') {
          return { ok: false, error: 'PDF 不能直接覆写保存，请用「保存/导出」生成新的 PDF 文件' }
        }
        const wrap = (inner: string) =>
          `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${basename(path)}</title></head><body class="docs-word-body">${inner}</body></html>`
        if (ext === '.html' || ext === '.htm') {
          await fs.writeFile(path, wrap(html ?? ''), 'utf-8')
          return { ok: true }
        }
        // DOCX/EPUB 等：先备份，再 HTML→原格式
        const bak = path + '.bak'
        try {
          await fs.copyFile(path, bak)
        } catch {
          /* 备份失败仍继续，但会在 note 提示 */
        }
        const converter = new DocsPandoc()
        if (!converter.isAvailable()) {
          // 无 Pandoc：改存同目录 HTML，避免改动丢失
          const htmlPath = path.replace(/\.[^.]+$/i, '') + '.edited.html'
          await fs.writeFile(htmlPath, wrap(html ?? ''), 'utf-8')
          return { ok: false, error: '未检测到 Pandoc，已将内容存为 ' + basename(htmlPath) }
        }
        const r = await htmlToDocx(html ?? '', path)
        if (!r.ok) return r
        return { ok: true, note: '原文件已更新（备份：' + basename(bak) + '）' }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'docs:save-as',
    async (event, content: string, defaultName?: string): Promise<{ ok: boolean; path?: string; error?: string }> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const opts = {
        title: '另存为',
        defaultPath: defaultName || '未命名.md',
        filters: [
          { name: 'Markdown', extensions: ['md', 'markdown'] },
          { name: '文本', extensions: ['txt', 'log'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      }
      const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' }
      try {
        await fs.writeFile(result.filePath, content ?? '', 'utf-8')
        return { ok: true, path: result.filePath }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  /** 多格式另存：用户选择目标格式后，文本直写 / Pandoc 转换；白名单外明确拒绝 */
  ipcMain.handle(
    'docs:save-as-format',
    async (
      event,
      payload: { source: 'text' | 'html'; content: string; defaultName?: string; format?: string }
    ): Promise<{ ok: boolean; path?: string; error?: string }> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const format = (payload?.format || '').toLowerCase().replace(/^\./, '')
      const ALLOWED = new Set(['md', 'markdown', 'txt', 'log', 'html', 'htm', 'docx', 'odt', 'rtf', 'epub', 'pdf'])
      if (!payload || !ALLOWED.has(format)) {
        return { ok: false, error: `不支持导出为 .${format || '?'} 格式（支持：md / txt / html / docx / odt / rtf / epub / pdf）` }
      }
      const srcName = payload.defaultName || '未命名'
      const baseName = srcName.replace(/\.[^.]+$/, '')
      const outName = `${baseName}.${format}`
      const ext = `.${format}`
      const filters = [{ name: outName, extensions: [format] }]

      /** 统一的文本写盘出口：落盘路径与返回路径都用规范化后的扩展名 */
      const writeOut = async (data: string): Promise<string> => {
        const opts = { title: '另存为', defaultPath: outName, filters }
        const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
        if (result.canceled || !result.filePath) throw new Error('cancelled')
        const outPath = normalizeOutExt(result.filePath, format)
        await fs.writeFile(outPath, data, 'utf-8')
        return outPath
      }

      try {
        const content = payload.content ?? ''

        const htmlWrap = (inner: string) =>
          `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${baseName}</title></head><body class="docs-word-body">${inner}</body></html>`

        // HTML 直写（富文本源选 HTML）
        if (payload.source === 'html' && (format === 'html' || format === 'htm')) {
          // 空内容守卫：不弹保存对话框，直接明确失败（否则会静默产出空白 HTML）
          if (isEffectivelyEmptyContent(payload.source, content)) {
            return { ok: false, error: EMPTY_CONTENT_ERROR }
          }
          const path = await writeOut(htmlWrap(content))
          return { ok: true, path }
        }

        // PDF：富文本 HTML 走内置 LibreOffice（不走 Pandoc，二进制写出）
        if (format === 'pdf') {
          // 空内容守卫：必须在 showSaveDialog 之前，否则会静默产出合法但完全空白的 PDF
          if (isEffectivelyEmptyContent(payload.source, content)) {
            return { ok: false, error: EMPTY_CONTENT_ERROR }
          }
          // text 源不能直接当 HTML 用（<、& 会破坏结构，换行会被折叠）：先转义再逐行包 <p>
          const inner = payload.source === 'text' ? textToHtmlParagraphs(content) : content
          const converted = await htmlToPdfBytes(htmlWrap(inner), { baseName })
          if (!converted.ok || !converted.bytes) {
            return { ok: false, error: converted.error || '导出 PDF 失败' }
          }
          const opts = {
            title: '导出 PDF',
            defaultPath: outName,
            filters: [{ name: 'PDF', extensions: ['pdf'] }]
          }
          const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
          if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' }
          const outPath = normalizeOutExt(result.filePath, format)
          // 二进制写入：绝不能用 'utf-8' 或传字符串，否则 PDF 会被破坏
          await fs.writeFile(outPath, Buffer.from(converted.bytes))
          return { ok: true, path: outPath }
        }

        const needsPandoc = ext === '.docx' || ext === '.odt' || ext === '.rtf' || ext === '.epub'
        const isHtmlTarget = ext === '.html' || ext === '.htm'

        // 文本源选 HTML：Markdown 用 Pandoc 渲染；其他纯文本直接包 <pre>
        if (payload.source === 'text' && isHtmlTarget) {
          // 空内容守卫：空的 Markdown/纯文本渲染出来同样是空 HTML，不弹保存对话框
          if (isEffectivelyEmptyContent(payload.source, content)) {
            return { ok: false, error: EMPTY_CONTENT_ERROR }
          }
          const srcExt = (payload.defaultName?.match(/\.[^.]+$/) || ['.txt'])[0].toLowerCase()
          const isMd = srcExt === '.md' || srcExt === '.markdown' || srcExt === '.mdx'
          if (isMd) {
            const converter = new DocsPandoc()
            if (!converter.isAvailable()) {
              return { ok: false, error: '未检测到 Pandoc，无法将 Markdown 转为 HTML；可直接另存为 .md 或 .txt' }
            }
            const tmpDir = join(app.getPath('temp'), `lingmo-docs-sav-${Date.now()}`)
            try {
              await fs.mkdir(tmpDir, { recursive: true })
              const srcPath = join(tmpDir, `doc${srcExt}`)
              await fs.writeFile(srcPath, payload.content ?? '', 'utf-8')
              const outTmp = join(tmpDir, `out.${format}`)
              const pandoc = converter.tool('pandoc')
              const [ok, err] = await converter.exec([pandoc, srcPath, '-t', 'html5', '-o', outTmp])
              if (!ok) return { ok: false, error: err || 'Pandoc 转换失败' }
              const path = await writeOut(await fs.readFile(outTmp, 'utf-8'))
              return { ok: true, path }
            } finally {
              void fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
            }
          }
          const pre = `<pre style="white-space:pre-wrap;font-family:inherit;">${(payload.content ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')}</pre>`
          const path = await writeOut(htmlWrap(pre))
          return { ok: true, path }
        }

        // DOCX/ODT/RTF/EPUB：走 Pandoc（按临时源文件扩展名推断输入格式；
        // 输出格式由用户选择的 format 经 -t 显式指定，不依赖输出路径的扩展名）
        if (needsPandoc) {
          // 空内容守卫：空内容经 Pandoc 同样会产出「能打开但完全空白」的文档，不弹保存对话框
          if (isEffectivelyEmptyContent(payload.source, content)) {
            return { ok: false, error: EMPTY_CONTENT_ERROR }
          }
          const converter = new DocsPandoc()
          if (!converter.isAvailable()) {
            return { ok: false, error: `未检测到 Pandoc，无法导出 ${ext.toUpperCase()}` }
          }
          const srcExt = payload.source === 'html' ? '.html' : (payload.defaultName?.match(/\.[^.]+$/) || ['.md'])[0].toLowerCase()
          const tmpDir = join(app.getPath('temp'), `lingmo-docs-sav-${Date.now()}`)
          try {
            await fs.mkdir(tmpDir, { recursive: true })
            const srcPath = join(tmpDir, `doc${srcExt}`)
            const body =
              payload.source === 'html'
                ? htmlWrap(payload.content ?? '')
                : payload.content ?? ''
            await fs.writeFile(srcPath, body, 'utf-8')
            const opts = { title: '另存为', defaultPath: outName, filters }
            const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
            if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' }
            const outPath = normalizeOutExt(result.filePath, format)
            const pandoc = converter.tool('pandoc')
            // 显式 -t <format>：用户若在保存对话框里把文件名改成别的扩展名，
            // 也不会让 Pandoc 换一个写入器（曾出现「名为 .pdf 实为 docx」/ pdflatex not found）
            const [ok, err] = await converter.exec([pandoc, srcPath, '-t', format, '-o', outPath])
            if (!ok) return { ok: false, error: err || `导出 ${ext.toUpperCase()} 失败` }
            return { ok: true, path: outPath }
          } finally {
            void fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
          }
        }

        // 其余文本直写（md/markdown/txt/log/…原格式）
        const path = await writeOut(payload.content ?? '')
        return { ok: true, path }
      } catch (err) {
        const msg = (err as Error).message
        if (msg === 'cancelled') return { ok: false, error: 'cancelled' }
        return { ok: false, error: msg }
      }
    }
  )

  ipcMain.handle('docs:print', async (event): Promise<{ ok: boolean; error?: string }> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { ok: false, error: '无窗口' }
    return new Promise((resolve) => {
      win.webContents.print(
        { silent: false, printBackground: true, color: true },
        (success, reason) => {
          if (success) resolve({ ok: true })
          else resolve({ ok: false, error: reason || '打印已取消或失败' })
        }
      )
    })
  })
}

export async function openDocPath(file: string): Promise<DocOpenResult> {
  try {
    const stat = await fs.stat(file)
    allowPath(file) // 登记到共享路径白名单：pdf:read / pdf:write 等跨模块 IPC 才能访问该文件
    const name = basename(file)
    const ext = extname(file).toLowerCase()

    // C 级格式：内嵌转换引擎无滤镜，如实拦截并给替代建议（扩展名仍在 PICK_FILTERS 里可选）
    const unsupportedHint = UNSUPPORTED_HINTS[ext]
    if (unsupportedHint) return { ok: false, error: unsupportedHint }

    const kind = classifyDoc(ext)
    const base: DocOpenResult = {
      ok: true,
      path: file,
      name,
      ext,
      kind,
      size: stat.size
    }

    if (kind === 'image' || kind === 'pdf') {
      // TIFF 浏览器不原生渲染：先用 ffmpeg 转成 PNG（多页时取第一帧）再走图片预览
      if (ext === '.tif' || ext === '.tiff') {
        const tmpDir = join(app.getPath('temp'), `lingmo-tiff-${Date.now()}`)
        try {
          await fs.mkdir(tmpDir, { recursive: true })
          const outPng = join(tmpDir, name.replace(/\.(tiff?|tif)$/i, '') + '.png')
          const r = await runFfmpeg(['-y', '-i', file, outPng], 120)
          // 三条件判定：退出码 0 + 产物存在 + 大小>0
          const pngSize = r.ok ? await fs.stat(outPng).then((s) => s.size).catch(() => 0) : 0
          if (!r.ok || pngSize === 0) {
            const detail = (r.stderr || '').slice(-200) || '转换无产物'
            return { ...base, error: `TIFF 转 PNG 预览失败：${detail}` }
          }
          const png = await fs.readFile(outPng)
          return {
            ...base,
            kind: 'image',
            base64: png.toString('base64'),
            mime: 'image/png',
            note: 'TIFF 已转换为 PNG 预览（多页时取第一页）'
          }
        } finally {
          void fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
        }
      }
      const buf = await fs.readFile(file)
      return {
        ...base,
        base64: buf.toString('base64'),
        mime: MIME[ext] ?? 'application/octet-stream'
      }
    }

    // 演示文稿：LibreOffice 转 PDF 后复用整条 PDF 预览管线（翻页/缩放/打印全部现成）
    if (SLIDES_EXTS.has(ext)) {
      if (stat.size > 200 * 1024 * 1024) {
        return { ...base, error: '文件过大（>200MB），转换耗时过长；请先在演示软件中拆分' }
      }
      const r = await pptToPdfBytes(file)
      if (!r.ok || !r.bytes) {
        return { ...base, error: r.error ?? 'PPT 转 PDF 失败' }
      }
      return {
        ...base,
        kind: 'pdf',
        base64: Buffer.from(r.bytes).toString('base64'),
        mime: 'application/pdf',
        sourceKind: 'slides',
        note: '演示文稿已转换为 PDF 预览；工具栏提供 PPT 专用操作'
      }
    }

    // 表格：LibreOffice calc 系滤镜转 PDF 后复用整条 PDF 预览管线
    if (kind === 'spreadsheet') {
      if (stat.size > 200 * 1024 * 1024) {
        return { ...base, error: '文件过大（>200MB），转换耗时过长；请先在表格软件中拆分' }
      }
      const r = await spreadsheetToPdfBytes(file)
      if (!r.ok || !r.bytes) {
        return { ...base, error: r.error ?? '表格转 PDF 失败' }
      }
      return {
        ...base,
        kind: 'pdf',
        base64: Buffer.from(r.bytes).toString('base64'),
        mime: 'application/pdf',
        sourceKind: 'spreadsheet',
        note: '表格已转换为 PDF 预览'
      }
    }

    if (kind === 'office') {
      const { html, note } = await pandocPreview(file)
      if (html) {
        // 保留 office 标记，前端开启 Word 式编辑
        return { ...base, html, kind: 'office', note }
      }
      return { ...base, error: note ?? '无法预览该 Office 文档' }
    }

    if (kind === 'binary') {
      return { ...base, error: `暂不支持预览 ${ext || '该类型'} 文件` }
    }

    if (stat.size > 8 * 1024 * 1024) {
      return { ...base, error: '文件过大（>8MB），请用外部编辑器打开' }
    }
    const text = await fs.readFile(file, 'utf-8')
    return { ...base, text }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
