/**
 * 成书排版纯逻辑：EPUB 中文排版样式表 + 封面 HTML 模板。
 *
 * 本文件**不引入 electron**，可被 `node --experimental-strip-types` 直接无头测试。
 * 落盘、截图、弹窗等 IO 一律放在 bookExport.ts。
 */
import type { BookCoverOptions, BookCoverTemplate } from '../shared/types'

/* ------------------------------------------------------------------ */
/* EPUB / HTML 中文排版样式                                            */
/* ------------------------------------------------------------------ */

export interface EpubCssOptions {
  /** 正文行高，默认 1.8（中文长文舒适区 1.7~1.9） */
  lineHeight?: number
  /** 首行缩进字符数，默认 2（中文出版惯例两字符） */
  indent?: number
  /** 是否用衬线（宋体系）正文，默认 true；false 则用黑体系 */
  serif?: boolean
  /** 每章是否强制另起一页，默认 true */
  chapterPageBreak?: boolean
}

const SERIF_STACK =
  '"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", "SimSun", "STSong", serif'
const SANS_STACK =
  '"Noto Sans CJK SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", "Heiti SC", sans-serif'

/**
 * 生成中文电子书排版样式表。
 * 关键点：两端对齐 + 按表意文字断行、首行缩进、段间不留空行、
 * 章标题另起一页、`<em>` 用着重号（中文强调惯例，而非斜体）。
 */
export function buildEpubCss(options: EpubCssOptions = {}): string {
  const lineHeight = clampNumber(options.lineHeight ?? 1.8, 1.2, 2.6)
  const indent = clampNumber(options.indent ?? 2, 0, 4)
  const body = options.serif === false ? SANS_STACK : SERIF_STACK
  const heading = options.serif === false ? SANS_STACK : SERIF_STACK
  const pageBreak = options.chapterPageBreak === false ? 'auto' : 'always'

  return `@charset "UTF-8";
/* 灵墨工作台 · 中文电子书排版样式 */

html {
  -epub-hyphens: none;
  hyphens: none;
}

body {
  font-family: ${body};
  font-size: 1em;
  line-height: ${lineHeight};
  margin: 0 1.2em;
  color: #1a1a1a;
  text-align: justify;
  text-justify: inter-ideograph;
  -epub-text-align-last: start;
  word-break: normal;
  overflow-wrap: break-word;
  widows: 2;
  orphans: 2;
}

/* 正文段落：首行缩进、段间不留空行（中文书籍惯例） */
p {
  margin: 0;
  text-indent: ${indent}em;
  line-height: ${lineHeight};
}

/* 标题：不缩进、居中，章标题另起一页 */
h1, h2, h3, h4, h5, h6 {
  font-family: ${heading};
  text-indent: 0;
  text-align: center;
  line-height: 1.45;
  font-weight: 600;
  page-break-after: avoid;
  break-after: avoid;
}

h1 {
  font-size: 1.5em;
  margin: 2.2em 0 1.6em;
  letter-spacing: 0.12em;
  page-break-before: ${pageBreak};
  break-before: ${pageBreak};
}

h2 { font-size: 1.24em; margin: 1.8em 0 1em; letter-spacing: 0.06em; }
h3 { font-size: 1.1em; margin: 1.5em 0 0.8em; text-align: left; }
h4, h5, h6 { font-size: 1em; margin: 1.2em 0 0.6em; text-align: left; }

/* 中文强调用着重号，而非斜体 */
em {
  font-style: normal;
  -epub-text-emphasis-style: dot;
  text-emphasis-style: dot;
  text-emphasis-position: under right;
}

strong { font-weight: 700; }

/* 引文 / 信件 / 诗词：整段缩进、取消首行缩进 */
blockquote {
  margin: 1.2em 2em;
  padding: 0;
  color: #444;
  font-size: 0.95em;
}
blockquote p { text-indent: 0; }

/* 分隔符：场景切换的星线 */
hr {
  border: 0;
  border-top: 1px solid #c8c8c8;
  margin: 1.8em 28%;
  height: 0;
}

ul, ol { margin: 0.8em 0 0.8em 2em; padding: 0; }
li { text-indent: 0; margin: 0.2em 0; }

img {
  max-width: 100%;
  height: auto;
}

/* Pandoc 生成的封面页 */
#cover-image, div#cover-image {
  text-align: center;
  page-break-after: always;
  margin: 0;
  padding: 0;
}
#cover-image img, img.cover {
  max-width: 100%;
  max-height: 100%;
}

code, pre {
  font-family: "Consolas", "Menlo", "Courier New", monospace;
  font-size: 0.9em;
}
pre { text-indent: 0; white-space: pre-wrap; margin: 1em 0; }

table {
  border-collapse: collapse;
  margin: 1.2em auto;
  font-size: 0.92em;
}
th, td {
  border: 1px solid #ccc;
  padding: 0.3em 0.6em;
  text-indent: 0;
  text-align: left;
}

a { color: inherit; text-decoration: none; }

/* Pandoc 目录 */
nav#toc ol, nav#toc ul { list-style: none; margin-left: 0; }
nav#toc li { margin: 0.5em 0; }
`
}

/* ------------------------------------------------------------------ */
/* 封面模板                                                            */
/* ------------------------------------------------------------------ */

const DEFAULT_ACCENT = '#1f3a5f'
const TEMPLATES: BookCoverTemplate[] = ['classic', 'minimal', 'gradient', 'ink']

export const COVER_TEMPLATE_LABELS: Record<BookCoverTemplate, string> = {
  classic: '典雅深色',
  minimal: '极简留白',
  gradient: '渐变现代',
  ink: '水墨中式'
}

export interface NormalizedCover {
  title: string
  author: string
  subtitle: string
  template: BookCoverTemplate
  accent: string
  width: number
  height: number
}

/** 规范化封面参数：兜底默认值、夹紧尺寸、校验色值 */
export function normalizeCoverOptions(opts: BookCoverOptions): NormalizedCover {
  const template = TEMPLATES.includes(opts.template as BookCoverTemplate)
    ? (opts.template as BookCoverTemplate)
    : 'classic'
  return {
    title: (opts.title ?? '').trim() || '未命名作品',
    author: (opts.author ?? '').trim(),
    subtitle: (opts.subtitle ?? '').trim(),
    template,
    accent: normalizeHexColor(opts.accent) ?? DEFAULT_ACCENT,
    width: Math.round(clampNumber(opts.width ?? 1200, 400, 2400)),
    height: Math.round(clampNumber(opts.height ?? 1600, 400, 3200))
  }
}

/** 校验 / 规范化 #RGB 或 #RRGGBB，非法返回 null */
export function normalizeHexColor(input?: string): string | null {
  if (!input) return null
  const v = input.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase()
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    const [, r, g, b] = v.toLowerCase()
    return `#${r}${r}${g}${g}${b}${b}`
  }
  return null
}

/** 书名字号：按字符数自适应，避免长书名溢出 */
export function coverTitleFontSize(title: string, width: number): number {
  const len = [...title].length
  const ratio = len <= 2 ? 0.26 : len <= 4 ? 0.2 : len <= 6 ? 0.15 : len <= 9 ? 0.115 : len <= 14 ? 0.085 : 0.062
  return Math.max(18, Math.round(width * ratio))
}

/** 混色：把十六进制色朝白/黑方向调整。amount>0 变亮，<0 变暗 */
export function shadeHexColor(hex: string, amount: number): string {
  const base = normalizeHexColor(hex) ?? DEFAULT_ACCENT
  const t = amount < 0 ? 0 : 255
  const p = Math.min(1, Math.abs(amount))
  const parts = [1, 3, 5].map((i) => {
    const c = parseInt(base.slice(i, i + 2), 16)
    return Math.round((t - c) * p + c)
  })
  return `#${parts.map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 生成封面 HTML（离线自包含：不引外链字体 / 图片，纯 CSS 绘制）。
 * 由主进程用隐藏窗口加载后截图，得到 PNG 封面。
 */
export function buildCoverHtml(opts: BookCoverOptions): string {
  const c = normalizeCoverOptions(opts)
  const titleSize = coverTitleFontSize(c.title, c.width)
  const title = escapeHtml(c.title)
  const author = escapeHtml(c.author)
  const subtitle = escapeHtml(c.subtitle)
  const accent = c.accent
  const dark = shadeHexColor(accent, -0.45)
  const light = shadeHexColor(accent, 0.55)

  const scene = renderTemplate(c.template, {
    title,
    author,
    subtitle,
    titleSize,
    accent,
    dark,
    light,
    width: c.width,
    height: c.height
  })

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${c.width}px; height: ${c.height}px; overflow: hidden; }
body {
  font-family: ${SERIF_STACK};
  -webkit-font-smoothing: antialiased;
}
.cover { position: relative; width: ${c.width}px; height: ${c.height}px; overflow: hidden; }
.title { font-size: ${titleSize}px; line-height: 1.18; font-weight: 700; letter-spacing: 0.06em; }
.author { font-family: ${SANS_STACK}; }
.subtitle { font-family: ${SANS_STACK}; }
${scene.css}
</style></head><body>${scene.html}</body></html>
`
}

interface SceneVars {
  title: string
  author: string
  subtitle: string
  titleSize: number
  accent: string
  dark: string
  light: string
  width: number
  height: number
}

function renderTemplate(
  template: BookCoverTemplate,
  v: SceneVars
): { html: string; css: string } {
  const pad = Math.round(v.width * 0.1)
  const authorSize = Math.max(14, Math.round(v.width * 0.042))
  const subSize = Math.max(12, Math.round(v.width * 0.032))

  if (template === 'minimal') {
    return {
      css: `
.cover { background: #f7f5f0; display: flex; flex-direction: column; justify-content: center; padding: ${pad}px; }
.rule { width: ${Math.round(v.width * 0.16)}px; height: 4px; background: ${v.accent}; margin-bottom: ${Math.round(v.height * 0.05)}px; }
.title { color: #16181d; }
.subtitle { margin-top: ${Math.round(v.height * 0.03)}px; font-size: ${subSize}px; color: ${v.accent}; letter-spacing: 0.3em; }
.author { position: absolute; left: ${pad}px; bottom: ${pad}px; font-size: ${authorSize}px; color: #4a4f57; letter-spacing: 0.1em; }
.edge { position: absolute; right: 0; top: 0; width: ${Math.round(v.width * 0.035)}px; height: 100%; background: ${v.accent}; }`,
      html: `<div class="cover"><div class="edge"></div><div class="rule"></div><div class="title">${v.title}</div>${
        v.subtitle ? `<div class="subtitle">${v.subtitle}</div>` : ''
      }${v.author ? `<div class="author">${v.author}</div>` : ''}</div>`
    }
  }

  if (template === 'gradient') {
    return {
      css: `
.cover { background: linear-gradient(150deg, ${v.light} 0%, ${v.accent} 48%, ${v.dark} 100%); display: flex; flex-direction: column; justify-content: flex-end; padding: ${pad}px; }
.glow { position: absolute; width: ${Math.round(v.width * 1.1)}px; height: ${Math.round(v.width * 1.1)}px; border-radius: 50%; top: ${-Math.round(v.width * 0.45)}px; right: ${-Math.round(v.width * 0.35)}px; background: radial-gradient(circle, rgba(255,255,255,0.34) 0%, rgba(255,255,255,0) 70%); }
.title { color: #fff; text-shadow: 0 4px 24px rgba(0,0,0,0.28); position: relative; }
.subtitle { margin-top: ${Math.round(v.height * 0.022)}px; font-size: ${subSize}px; color: rgba(255,255,255,0.82); letter-spacing: 0.28em; position: relative; }
.author { margin-top: ${Math.round(v.height * 0.05)}px; font-size: ${authorSize}px; color: rgba(255,255,255,0.92); letter-spacing: 0.12em; position: relative; }
.bar { position: relative; width: ${Math.round(v.width * 0.2)}px; height: 3px; background: rgba(255,255,255,0.7); margin-bottom: ${Math.round(v.height * 0.035)}px; }`,
      html: `<div class="cover"><div class="glow"></div><div class="bar"></div><div class="title">${v.title}</div>${
        v.subtitle ? `<div class="subtitle">${v.subtitle}</div>` : ''
      }${v.author ? `<div class="author">${v.author}</div>` : ''}</div>`
    }
  }

  if (template === 'ink') {
    const seal = Math.round(v.width * 0.12)
    return {
      css: `
.cover { background: #efe9dd; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: ${pad}px; }
.ink1 { position: absolute; width: ${Math.round(v.width * 0.9)}px; height: ${Math.round(v.width * 0.9)}px; border-radius: 50%; left: ${-Math.round(v.width * 0.25)}px; bottom: ${-Math.round(v.width * 0.3)}px; background: radial-gradient(circle at 40% 40%, rgba(30,36,44,0.42) 0%, rgba(30,36,44,0.16) 45%, rgba(30,36,44,0) 72%); }
.ink2 { position: absolute; width: ${Math.round(v.width * 0.6)}px; height: ${Math.round(v.width * 0.6)}px; border-radius: 50%; right: ${-Math.round(v.width * 0.18)}px; top: ${Math.round(v.height * 0.06)}px; background: radial-gradient(circle at 55% 45%, rgba(30,36,44,0.3) 0%, rgba(30,36,44,0.1) 50%, rgba(30,36,44,0) 75%); }
.frame { position: absolute; inset: ${Math.round(v.width * 0.055)}px; border: 1px solid rgba(30,36,44,0.35); }
.title { color: #1b1f26; position: relative; writing-mode: vertical-rl; letter-spacing: 0.22em; max-height: ${Math.round(v.height * 0.62)}px; }
.subtitle { position: relative; margin-top: ${Math.round(v.height * 0.03)}px; font-size: ${subSize}px; color: #5a5348; letter-spacing: 0.34em; }
.author { position: absolute; bottom: ${pad}px; font-size: ${authorSize}px; color: #3a3630; letter-spacing: 0.18em; }
.seal { position: absolute; right: ${Math.round(v.width * 0.11)}px; bottom: ${Math.round(v.height * 0.11)}px; width: ${seal}px; height: ${seal}px; background: ${v.accent}; opacity: 0.85; border-radius: ${Math.round(seal * 0.08)}px; }`,
      html: `<div class="cover"><div class="ink1"></div><div class="ink2"></div><div class="frame"></div><div class="title">${v.title}</div>${
        v.subtitle ? `<div class="subtitle">${v.subtitle}</div>` : ''
      }<div class="seal"></div>${v.author ? `<div class="author">${v.author}</div>` : ''}</div>`
    }
  }

  // classic：深底 + 双细线框 + 居中书名
  return {
    css: `
.cover { background: ${v.dark}; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: ${pad}px; }
.wash { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(255,255,255,0.09) 0%, rgba(0,0,0,0.28) 100%); }
.frame { position: absolute; inset: ${Math.round(v.width * 0.05)}px; border: 2px solid ${v.light}; opacity: 0.75; }
.frame2 { position: absolute; inset: ${Math.round(v.width * 0.065)}px; border: 1px solid ${v.light}; opacity: 0.45; }
.title { color: #f6f2ea; position: relative; text-align: center; }
.divider { position: relative; width: ${Math.round(v.width * 0.26)}px; height: 1px; background: ${v.light}; opacity: 0.8; margin: ${Math.round(v.height * 0.035)}px 0; }
.subtitle { position: relative; font-size: ${subSize}px; color: ${v.light}; letter-spacing: 0.36em; }
.author { position: absolute; bottom: ${Math.round(v.height * 0.1)}px; font-size: ${authorSize}px; color: rgba(246,242,234,0.88); letter-spacing: 0.16em; }`,
    html: `<div class="cover"><div class="wash"></div><div class="frame"></div><div class="frame2"></div><div class="title">${v.title}</div><div class="divider"></div>${
      v.subtitle ? `<div class="subtitle">${v.subtitle}</div>` : ''
    }${v.author ? `<div class="author">${v.author}</div>` : ''}</div>`
  }
}

function clampNumber(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}
