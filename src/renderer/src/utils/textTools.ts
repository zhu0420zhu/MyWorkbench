/* 灵墨工作台 · 文本工具函数库（纯函数，可直接被 node 测试） */
import { pinyin } from 'pinyin-pro'

/* ---------- 行拆分/合并 ---------- */
export function splitLines(input: string): string[] {
  return input.split(/\r?\n/)
}

export function joinLines(lines: string[]): string {
  return lines.join('\n')
}

/* ---------- 去重 ---------- */
export interface DedupeOptions {
  ignoreCase?: boolean
  keepLast?: boolean
}

export function dedupeLines(input: string, opts: DedupeOptions = {}): string {
  const lines = splitLines(input)
  const seen = new Set<string>()
  const result: string[] = []
  const key = (l: string): string => (opts.ignoreCase ? l.toLowerCase() : l)
  if (opts.keepLast) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const k = key(lines[i])
      if (!seen.has(k)) {
        seen.add(k)
        result.unshift(lines[i])
      }
    }
  } else {
    for (const line of lines) {
      const k = key(line)
      if (!seen.has(k)) {
        seen.add(k)
        result.push(line)
      }
    }
  }
  return joinLines(result)
}

/** 统计每行出现次数（去重 + 计数）；onlyDuplicated=true 时仅保留次数>1 的行 */
export function countDuplicates(input: string, ignoreCase = false, onlyDuplicated = false): string {
  const lines = splitLines(input)
  const map = new Map<string, number>()
  for (const line of lines) {
    const k = ignoreCase ? line.toLowerCase() : line
    map.set(k, (map.get(k) ?? 0) + 1)
  }
  const keyOf = new Map<string, string>()
  for (const line of lines) {
    const k = ignoreCase ? line.toLowerCase() : line
    if (!keyOf.has(k)) keyOf.set(k, line)
  }
  const rows = [...map.entries()]
    .filter(([, n]) => (onlyDuplicated ? n > 1 : true))
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n}\t${keyOf.get(k) ?? k}`)
  return rows.join('\n')
}

/* ---------- 排序 ---------- */
export interface SortOptions {
  desc?: boolean
  ignoreCase?: boolean
}

export function sortLines(input: string, opts: SortOptions = {}): string {
  const lines = splitLines(input)
  const compare = (a: string, b: string): number => {
    const x = opts.ignoreCase ? a.toLowerCase() : a
    const y = opts.ignoreCase ? b.toLowerCase() : b
    return x < y ? -1 : x > y ? 1 : 0
  }
  lines.sort(compare)
  if (opts.desc) lines.reverse()
  return joinLines(lines)
}

/* ---------- 行操作 ---------- */
export function reverseLines(input: string): string {
  return splitLines(input).reverse().join('\n')
}

export function reverseChars(input: string): string {
  return [...input].reverse().join('')
}

export function removeEmptyLines(input: string, keepWhitespaceOnly = false): string {
  const lines = splitLines(input)
  const out = lines.filter((l) => (keepWhitespaceOnly ? l.trim() !== '' : l !== ''))
  return joinLines(out)
}

export function trimLines(input: string, all = false): string {
  return joinLines(splitLines(input).map((l) => (all ? l.replace(/\s+/g, '') : l.trim())))
}

export function addLineNumbers(input: string, sep = '. '): string {
  return splitLines(input)
    .map((l, i) => `${i + 1}${sep}${l}`)
    .join('\n')
}

/* ---------- 大小写 ---------- */
export type CaseMode = 'upper' | 'lower' | 'title' | 'sentence'

export function changeCase(input: string, mode: CaseMode): string {
  switch (mode) {
    case 'upper':
      return input.toUpperCase()
    case 'lower':
      return input.toLowerCase()
    case 'title':
      return input.replace(/\b\w/g, (c) => c.toUpperCase())
    case 'sentence':
      return input.replace(/(^\s*\w|[.!?。！？]\s*\w)/g, (c) => c.toUpperCase())
  }
}

/* ---------- 引号 ---------- */
export type QuoteChar = '"' | "'" | '`'

export function wrapQuotes(input: string, quote: QuoteChar = '"', escape = false): string {
  return joinLines(
    splitLines(input).map((l) => {
      let s = l
      if (escape) s = s.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), `\\${quote}`)
      return `${quote}${s}${quote}`
    })
  )
}

export function unwrapQuotes(input: string): string {
  return joinLines(
    splitLines(input).map((l) => {
      const trimmed = l.trim()
      if (trimmed.length >= 2) {
        const first = trimmed[0]
        const last = trimmed[trimmed.length - 1]
        if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`')) {
          return l.slice(1, -1)
        }
      }
      return l
    })
  )
}

/* ---------- 编解码 ---------- */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function base64Encode(input: string): string {
  return bytesToBase64(new TextEncoder().encode(input))
}

export function base64Decode(input: string): string {
  return new TextDecoder().decode(base64ToBytes(input.trim()))
}

export function urlEncode(input: string): string {
  return encodeURIComponent(input)
}

export function urlDecode(input: string): string {
  return decodeURIComponent(input.trim())
}

/* ---------- JSON ---------- */
export function formatJson(input: string, compact = false): { ok: true; value: string } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(input)
    return { ok: true, value: JSON.stringify(parsed, null, compact ? 0 : 2) }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/* ---------- 正则 ---------- */
export function regexReplace(
  input: string,
  pattern: string,
  flags: string,
  replacement: string
): { ok: true; value: string } | { ok: false; error: string } {
  try {
    const re = new RegExp(pattern, flags)
    return { ok: true, value: input.replace(re, replacement) }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/* ---------- 关键词高亮（返回 HTML，调用方需转义输入文本） ---------- */
export function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function highlightKeywords(input: string, keywords: string[]): string {
  const escaped = escapeHtml(input)
  const valid = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))]
  if (valid.length === 0) return escaped
  const pattern = valid
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  try {
    const re = new RegExp(`(${pattern})`, 'gi')
    return escaped.replace(re, '<mark>$1</mark>')
  } catch {
    return escaped
  }
}

/* ---------- 行级差异对比（LCS） ---------- */
export interface DiffLine {
  type: 'same' | 'add' | 'remove'
  text: string
}

export function diffLines(a: string, b: string): DiffLine[] {
  const la = splitLines(a)
  const lb = splitLines(b)
  const n = la.length
  const m = lb.length
  // LCS DP
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = la[i] === lb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (la[i] === lb[j]) {
      result.push({ type: 'same', text: la[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'remove', text: la[i] })
      i++
    } else {
      result.push({ type: 'add', text: lb[j] })
      j++
    }
  }
  while (i < n) {
    result.push({ type: 'remove', text: la[i] })
    i++
  }
  while (j < m) {
    result.push({ type: 'add', text: lb[j] })
    j++
  }
  return result
}

/* ---------- 统计 ---------- */
export function countStats(input: string): { lines: number; chars: number; words: number } {
  const lines = input === '' ? 0 : splitLines(input).length
  const chars = [...input].length
  const words = input.trim() === '' ? 0 : input.trim().split(/\s+/).length
  return { lines, chars, words }
}

/* ---------- 符号添加 ---------- */
export interface AddSymbolsOptions {
  /** 要添加的符号列表（按顺序处理） */
  symbols: string[]
  /**
   * 添加位置：
   * - before：行首
   * - after ：行尾（默认）
   * - both  ：行首行尾同时（如 `"内容"`、`,内容,`）
   */
  position?: 'before' | 'after' | 'both'
  /**
   * 组合方式：
   * - each：每个符号独立成行（行 × 符号 顺序组合）
   * - all ：所有符号按顺序追加到同一行
   * 默认 each
   */
  combine?: 'each' | 'all'
}

/** 英文模式预设符号 */
export const SYMBOL_PRESETS_EN = [',', '%', '.', ';', ':', '!', '?', '@', '#']

/** 中文模式预设符号 */
export const SYMBOL_PRESETS_ZH = ['，', '。', '、', '；', '：', '！', '？']

/** 动态效果标识：%index%(行号) %date%(yyyymmdd) %time%(HHMMSS) %rand%(3位随机数) */
export function resolveEffects(s: string, index?: number): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const date = '' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate())
  const time = '' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds())
  return s
    .replace(/%index%/g, String((index ?? 0) + 1))
    .replace(/%date%/g, date)
    .replace(/%time%/g, time)
    .replace(/%rand%/g, String(Math.floor(Math.random() * 900 + 100)))
}

export function addSymbols(input: string, opts: AddSymbolsOptions): string {
  if (input === '') return ''
  const symbols = opts.symbols
  const position = opts.position ?? 'after'
  const combine = opts.combine ?? 'each'
  const lines = splitLines(input)
  if (symbols.length === 0) return joinLines(lines)
  if (combine === 'all') {
    // 所有符号按顺序依次添加
    const joined = symbols.join('')
    const prefix = position === 'before' || position === 'both' ? resolveEffects(joined) : ''
    const suffix = position === 'after' || position === 'both' ? resolveEffects(joined) : ''
    return joinLines(lines.map((l) => prefix + l + suffix))
  }
  // each：每行一组，符号按顺序逐行输出（行 × 符号 组合），支持 %index% 等效果标识
  const out: string[] = []
  lines.forEach((line, li) => {
    for (const sym of symbols) {
      const eff = resolveEffects(sym, li)
      if (position === 'before') out.push(eff + line)
      else if (position === 'both') out.push(eff + line + eff)
      else out.push(line + eff)
    }
  })
  return joinLines(out)
}

/** 引号与符号同时添加：引号作为符号列表首项参与批量添加 */
export interface AddQuotesAndSymbolsOptions {
  quote: QuoteChar
  symbols?: string[]
  position?: 'before' | 'after' | 'both'
  combine?: 'each' | 'all'
}

export function addQuotesAndSymbols(input: string, opts: AddQuotesAndSymbolsOptions): string {
  const symbols = [opts.quote, ...(opts.symbols ?? [])]
  return addSymbols(input, { symbols, position: opts.position, combine: opts.combine })
}

/* ---------- 拼音首字母 ---------- */
/**
 * 提取中文段落每个汉字拼音的首字母（小写，空格分隔）。
 * 例：firstLetterPinyin('赵钱孙李') → 'z q s l'
 * 英文/数字按连续片段原样保留；标点忽略。
 */
export function firstLetterPinyin(input: string): string {
  if (!input.trim()) return ''
  const arr = pinyin(input, {
    pattern: 'first',
    toneType: 'none',
    type: 'array',
    nonZh: 'consecutive'
  })
  return arr.join(' ')
}
