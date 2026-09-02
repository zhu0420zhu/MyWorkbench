/**
 * 导出成书：把若干篇笔记 / 写作草稿按顺序拼成一本书，输出 EPUB / DOCX / PDF / HTML / Markdown / TXT
 *
 * 复用已接入的 Pandoc 转换链（convert/converters.ts 的 PandocConverter），
 * 本模块只负责：按序拼装 Markdown → 写临时稿 → 调 Pandoc 落到用户选择的路径。
 *
 * Markdown 与 TXT 不需要 Pandoc，直接落盘，因此即使未安装 Pandoc 也能导出。
 */
import { app, BrowserWindow, dialog } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { PandocConverter } from './convert/converters'
import { getNote, getAllNotesWithContent } from './notes'
import { listProjects, collectChapters, readChapterContent } from './novel/store'
import { countWords } from './snapshots'
import { buildEpubCss, buildCoverHtml, normalizeCoverOptions } from './bookTypesetCore'

import type {
  BookFormat,
  BookSourceRef,
  BookSourceItem,
  BookExportInput,
  BookExportResult,
  BookCoverOptions,
  BookCoverResult
} from '../shared/types'

export type {
  BookFormat,
  BookSourceItem,
  BookExportInput,
  BookExportResult,
  BookCoverOptions,
  BookCoverResult
}


const FILTERS: Record<BookFormat, Array<{ name: string; extensions: string[] }>> = {
  epub: [{ name: 'EPUB 电子书', extensions: ['epub'] }],
  docx: [{ name: 'Word 文档', extensions: ['docx'] }],
  pdf: [{ name: 'PDF 文档', extensions: ['pdf'] }],
  html: [{ name: '网页', extensions: ['html', 'htm'] }],
  md: [{ name: 'Markdown', extensions: ['md'] }],
  txt: [{ name: '纯文本', extensions: ['txt'] }]
}

/** 写作草稿目录（与 writing:save-draft 一致） */
function draftsDir(): string {
  return join(app.getPath('userData'), 'writing-drafts')
}

function safeFileName(name: string): string {
  return (name || '未命名').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
}

/** 列出可导出来源：笔记 + 写作草稿 + 作品章节 */
export async function listBookSources(): Promise<BookSourceItem[]> {
  const out: BookSourceItem[] = []

  // 作品章节：按 作品 → 卷 → 章 的顺序，id 用 "<projectId>/<chapterId>" 编码
  try {
    for (const p of await listProjects()) {
      const chapters = await collectChapters(p.id)
      for (const c of chapters) {
        out.push({
          kind: 'chapter',
          id: `${p.id}/${c.id}`,
          title: `《${p.title}》${c.title}`,
          words: countWords(c.content ?? ''),
          updatedAt: p.updatedAt
        })
      }
    }
  } catch {
    /* 作品读取失败不影响其余来源 */
  }

  try {
    // 一次取出正文以便统计字数（笔记量级通常几十到几百，读 md 文件开销可接受）
    for (const n of await getAllNotesWithContent()) {
      out.push({
        kind: 'note',
        id: n.id,
        title: n.title || '未命名笔记',
        words: countWords(n.content ?? ''),
        updatedAt: n.updatedAt ?? 0
      })
    }
  } catch {
    /* 笔记读取失败不影响草稿 */
  }

  try {
    const files = await fs.readdir(draftsDir())
    for (const f of files) {
      if (!f.toLowerCase().endsWith('.md')) continue
      const full = join(draftsDir(), f)
      const st = await fs.stat(full)
      let words = 0
      try {
        words = countWords(await fs.readFile(full, 'utf-8'))
      } catch {
        /* 字数统计失败不影响列出 */
      }
      out.push({
        kind: 'draft',
        id: f.replace(/\.md$/i, ''),
        title: f.replace(/\.md$/i, ''),
        words,
        updatedAt: st.mtimeMs
      })
    }
  } catch {
    /* 草稿目录不存在时忽略 */
  }

  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

async function readSource(ref: BookSourceRef): Promise<{ title: string; content: string } | null> {
  if (ref.kind === 'note') {
    const n = await getNote(ref.id)
    return n ? { title: n.title || '未命名', content: n.content ?? '' } : null
  }
  if (ref.kind === 'chapter') {
    // id 编码为 "<projectId>/<chapterId>"
    const sep = ref.id.indexOf('/')
    if (sep <= 0) return null
    return readChapterContent(ref.id.slice(0, sep), ref.id.slice(sep + 1))
  }
  try {
    const content = await fs.readFile(join(draftsDir(), `${safeFileName(ref.id)}.md`), 'utf-8')
    return { title: ref.id, content }
  } catch {
    return null
  }
}

/**
 * 拼装成一本 Markdown：每篇作为一级标题章节。
 * 经 Pandoc 的格式带 YAML 元数据头（含 lang: zh-CN，影响 EPUB 断行与阅读器选字体）；
 * 纯文本导出改用可读的明文标题头，避免把 YAML 分隔线原样写进 TXT。
 */
function buildManuscript(
  chapters: Array<{ title: string; content: string }>,
  bookTitle: string,
  author?: string,
  opts: { frontMatter?: boolean } = {}
): string {
  const title = (bookTitle ?? '').trim()
  const by = (author ?? '').trim()
  const body = chapters.map((c) => `# ${c.title}\n\n${c.content.trim()}`).join('\n\n')

  if (opts.frontMatter === false) {
    const plain: string[] = []
    if (title) plain.push(title)
    if (by) plain.push(`作者：${by}`)
    if (plain.length > 0) plain.push('')
    return `${plain.join('\n')}${plain.length > 0 ? '\n' : ''}${body}\n`
  }

  const head: string[] = ['---']
  if (title) head.push(`title: "${title.replace(/"/g, "'")}"`)
  if (by) head.push(`author: "${by.replace(/"/g, "'")}"`)
  head.push('lang: zh-CN', '---', '')
  return `${head.join('\n')}${body}\n`
}

/** Pandoc 是否可用（决定 EPUB/DOCX/PDF/HTML 能否导出） */
export function pandocAvailable(): boolean {
  try {
    return new PandocConverter().isAvailable()
  } catch {
    return false
  }
}

export async function exportBook(
  win: BrowserWindow | null,
  input: BookExportInput
): Promise<BookExportResult> {
  const format = input.format
  if (!input.items || input.items.length === 0) {
    return { ok: false, error: '请先选择要导出的内容' }
  }

  const chapters: Array<{ title: string; content: string }> = []
  for (const ref of input.items) {
    const src = await readSource(ref)
    if (src) chapters.push(src)
  }
  if (chapters.length === 0) {
    return { ok: false, error: '选中的内容都读取失败' }
  }

  const manuscript = buildManuscript(chapters, input.bookTitle, input.author, {
    frontMatter: format !== 'txt'
  })
  const words = countWords(manuscript)
  const defaultName = `${safeFileName(input.bookTitle || '未命名作品')}.${format}`

  const options = {
    title: '导出成书',
    defaultPath: defaultName,
    filters: FILTERS[format]
  }
  // 未持有宿主窗口时退回无父窗口版本（保存框仍能弹出，只是不居中于应用）
  const picked = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options)
  if (picked.canceled || !picked.filePath) return { ok: false, error: '已取消' }

  const target = picked.filePath
  const needsPandoc = format !== 'md' && format !== 'txt'
  if (needsPandoc && !pandocAvailable()) {
    return {
      ok: false,
      error: `导出 ${format.toUpperCase()} 需要 Pandoc。请先安装 Pandoc，或改导出 Markdown / TXT。`
    }
  }

  // 纯文本 / Markdown 直接落盘，不经过 Pandoc
  if (!needsPandoc) {
    await fs.writeFile(target, manuscript, 'utf-8')
    return { ok: true, path: target, words }
  }

  const stamp = Date.now()
  const tmp = join(app.getPath('temp'), `lingmo-book-${stamp}.md`)
  // 中文排版样式：EPUB / HTML 生效（默认开启，可由 typeset:false 关闭）
  const wantTypeset = input.typeset !== false && (format === 'epub' || format === 'html')
  const cssPath = wantTypeset ? join(app.getPath('temp'), `lingmo-book-${stamp}.css`) : ''
  // 封面仅 EPUB 支持（Pandoc 的 --epub-cover-image 只作用于 EPUB）
  const cover = format === 'epub' ? await resolveCoverPath(input.coverImage) : ''

  try {
    await fs.writeFile(tmp, manuscript, 'utf-8')
    if (cssPath) await fs.writeFile(cssPath, buildEpubCss(), 'utf-8')

    const res = await new PandocConverter().convertTo(tmp, target, {
      title: input.bookTitle,
      author: input.author,
      toc: input.toc,
      lang: 'zh-CN',
      css: cssPath || undefined,
      coverImage: cover || undefined,
      standalone: format === 'html' ? true : undefined,
      tocDepth: input.toc ? 2 : undefined
    })
    if (!res.success) {
      const isPdf = format === 'pdf'
      return {
        ok: false,
        error:
          (res.error || 'Pandoc 转换失败') +
          (isPdf ? '（PDF 需要本机安装 LaTeX 引擎，如 TeX Live / MiKTeX，或改导出 EPUB）' : '')
      }
    }
    return { ok: true, path: target, words }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    if (cssPath) await fs.rm(cssPath, { force: true }).catch(() => undefined)
  }
}

/* ------------------------------------------------------------------ */
/* 封面：选择现有图片 / 用内置模板生成                                  */
/* ------------------------------------------------------------------ */

const COVER_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif']

/** 封面存放目录（userData 下，随应用数据一起保留） */
function coversDir(): string {
  return join(app.getPath('userData'), 'book-covers')
}

/** 校验封面路径可读，不可读则视为未设置（避免 Pandoc 因缺图整本导出失败） */
async function resolveCoverPath(path?: string): Promise<string> {
  if (!path || !path.trim()) return ''
  try {
    await fs.access(path)
    return path
  } catch {
    return ''
  }
}

function mimeOf(path: string): string {
  const ext = (path.split('.').pop() ?? 'png').toLowerCase()
  return ext === 'jpg' ? 'jpeg' : ext
}

async function toDataUrl(path: string): Promise<string | undefined> {
  try {
    const buf = await fs.readFile(path)
    return `data:image/${mimeOf(path)};base64,${buf.toString('base64')}`
  } catch {
    return undefined
  }
}

/** 让用户从磁盘挑一张封面图 */
export async function pickCoverImage(win: BrowserWindow | null): Promise<BookCoverResult> {
  const options = {
    title: '选择封面图片',
    filters: [{ name: '图片', extensions: COVER_EXTS }],
    properties: ['openFile'] as Array<'openFile'>
  }
  const res = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options)
  if (res.canceled || res.filePaths.length === 0) return { ok: false, error: '已取消' }
  const path = res.filePaths[0]
  return { ok: true, path, dataUrl: await toDataUrl(path) }
}

/**
 * 用内置模板生成封面 PNG。
 *
 * 实现：把纯 CSS 绘制的封面 HTML 加载进一个离屏隐藏窗口，等字体就绪后 capturePage 截图。
 * 复用应用自带的 Chromium，无需 ImageMagick / 无需联网、离线可用。
 */
export async function generateCover(opts: BookCoverOptions): Promise<BookCoverResult> {
  const conf = normalizeCoverOptions(opts)
  const html = buildCoverHtml(opts)
  const stamp = Date.now()
  const htmlTmp = join(app.getPath('temp'), `lingmo-cover-${stamp}.html`)
  let hidden: BrowserWindow | null = null

  try {
    await fs.mkdir(coversDir(), { recursive: true })
    await fs.writeFile(htmlTmp, html, 'utf-8')

    hidden = new BrowserWindow({
      width: conf.width,
      height: conf.height,
      show: false,
      frame: false,
      transparent: false,
      skipTaskbar: true,
      webPreferences: {
        offscreen: true,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false
      }
    })

    await hidden.loadFile(htmlTmp)
    // 等 CJK 字体解析完成，否则截图可能命中回退字形
    await hidden.webContents
      .executeJavaScript('document.fonts && document.fonts.ready ? document.fonts.ready.then(() => 1) : 1')
      .catch(() => undefined)
    await delay(220)

    let image = await hidden.webContents.capturePage()
    if (image.isEmpty()) {
      // 极少数环境下首帧未合成，重试一次
      await delay(320)
      image = await hidden.webContents.capturePage()
    }
    if (image.isEmpty()) return { ok: false, error: '封面渲染失败（截图为空），请重试或改用选择图片' }

    const size = image.getSize()
    const exact =
      size.width === conf.width && size.height === conf.height
        ? image
        : image.resize({ width: conf.width, height: conf.height, quality: 'best' })

    const out = join(coversDir(), `cover-${stamp}.png`)
    const png = exact.toPNG()
    await fs.writeFile(out, png)
    return { ok: true, path: out, dataUrl: `data:image/png;base64,${png.toString('base64')}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    if (hidden && !hidden.isDestroyed()) hidden.destroy()
    await fs.rm(htmlTmp, { force: true }).catch(() => undefined)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
