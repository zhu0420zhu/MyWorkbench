/* ============================================================
 * 手术式文档编辑 · XML 文本工具
 * - escapeXmlText / unescapeXml / stripTags：基础转义三件套
 * - TextChunk + replaceChunkText：把「单元文本替换」映射回
 *   文本块（run/字符数据段）区间的通用算法，DOCX/ODT/ODS/EPUB 共用。
 *   思路：求新旧文本的公共前后缀，只把中间变化区间写回首个受影响块，
 *   其余受影响块清空，未受影响块一字不动（保留原实体写法）。
 * ============================================================ */

const XML_ESCAPES: Array<[RegExp, string]> = [
  [/&/g, '&amp;'],
  [/</g, '&lt;'],
  [/>/g, '&gt;'],
  [/"/g, '&quot;'],
  [/'/g, '&apos;']
]

/** 转义 XML 文本节点内容（& < > " ' 及 XML 1.0 非法控制字符） */
export function escapeXmlText(s: string): string {
  let out = s
  for (const [re, to] of XML_ESCAPES) out = out.replace(re, to)
  // XML 1.0 不允许的控制字符（除 \t \n \r）：直接丢弃（数值引用同样非法）
  return out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

/** 反转义 XML 实体（5 个命名实体 + 数字/十六进制引用） */
export function unescapeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return ''
  if (cp >= 0xd800 && cp <= 0xdfff) return ''
  return String.fromCodePoint(cp)
}

/** EPUB/XHTML 常见命名实体（escapeXmlText 不认识 &nbsp; 等，须先解码再回写） */
const HTML_NAMED_ENTITIES: Record<string, string> = {
  nbsp: '\u00a0',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  laquo: '\u00ab',
  raquo: '\u00bb',
  middot: '\u00b7',
  bull: '\u2022',
  dagger: '\u2020',
  Dagger: '\u2021',
  permil: '\u2030',
  prime: '\u2032',
  Prime: '\u2033',
  larr: '\u2190',
  rarr: '\u2192',
  uarr: '\u2191',
  darr: '\u2193',
  deg: '\u00b0',
  plusmn: '\u00b1',
  times: '\u00d7',
  divide: '\u00f7',
  frac12: '\u00bd',
  frac14: '\u00bc',
  frac34: '\u00be',
  sup1: '\u00b9',
  sup2: '\u00b2',
  sup3: '\u00b3',
  micro: '\u00b5',
  para: '\u00b6',
  sect: '\u00a7',
  shy: '\u00ad',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  curren: '\u00a4'
}

/** 反转义 XML/HTML 实体（在 unescapeXml 基础上扩常见命名实体，供 EPUB 用） */
export function unescapeXmlExtended(s: string): string {
  return unescapeXml(
    s.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name: string) => HTML_NAMED_ENTITIES[name] ?? m)
  )
}

/** 去掉所有标签取纯文本（可选：用扩展实体解码） */
export function stripTags(xml: string, extended = false): string {
  const textOnly = xml.replace(/<[^>]+>/g, '')
  return extended ? unescapeXmlExtended(textOnly) : unescapeXml(textOnly)
}

/* ---------------- 通用「文本块区间替换」 ---------------- */

/** 一个可替换的文本块（如 DOCX 的 w:t、ODF 的字符数据段、XHTML 的文本段） */
export interface TextChunk {
  /** 内容前的 XML（如 `<w:t xml:space="preserve">`；字符数据段为 ''） */
  head: string
  /** 内容本身的原始写法（未反转义） */
  raw: string
  /** 反转义后的文本 */
  text: string
  /** 内容后的 XML（如 `</w:t>`；字符数据段为 ''） */
  tail: string
  /** 完整片段 = head + raw + tail */
  xml: string
}

export interface ChunkRebuildOptions {
  /**
   * 内容变化时调整开始标签（如给 w:t 补 xml:space="preserve"）。
   * 入参：(原 head，新内容反转义前文本)。返回新 head。
   */
  adjustHead?: (head: string, newContent: string) => string
}

/**
 * 把「单元当前文本 → newText」映射回块区间。
 * 返回与 chunks 等长的新片段数组（未变化的块返回其原 xml，字节级保真）；
 * newText 与当前文本相同 → 返回 null（调用方按 skipped 处理）。
 * - 公共前后缀之外为变化区间：首个受影响块保留前缀+写入新中段，
 *   其余受影响块清空，未受影响块一字不动。
 * 调用方拿到数组后按各自格式把块按顺序拼回容器 XML（块之间还有标签）。
 */
export function replaceChunkText(
  chunks: TextChunk[],
  newText: string,
  opts?: ChunkRebuildOptions
): string[] | null {
  const oldText = chunks.map((c) => c.text).join('')
  if (oldText === newText) return null

  // 纯尾部追加（含旧文本为空的纯插入）：新中段挂到最后一个块尾部
  const appendMode = newText.startsWith(oldText)
  let prefix = 0
  let suffix = 0
  if (appendMode) {
    prefix = oldText.length
  } else {
    // 公共前后缀（suffix 受 prefix 约束，避免区间重叠）
    const minLen = Math.min(oldText.length, newText.length)
    while (prefix < minLen && oldText[prefix] === newText[prefix]) prefix++
    const suffixMax = minLen - prefix
    while (
      suffix < suffixMax &&
      oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
    ) {
      suffix++
    }
  }
  const pS = prefix
  let pE = oldText.length - suffix
  let newMiddle = appendMode
    ? newText.slice(oldText.length)
    : newText.slice(prefix, newText.length - suffix)
  if (!appendMode && pS === pE && oldText.length > 0) {
    // 变化区间为空（中部插入，如「金额→总金额」）：放弃 suffix，
    // 差异收敛到 [prefix, oldLen)，保证区间非空
    suffix = 0
    pE = oldText.length
    newMiddle = newText.slice(prefix)
  }

  const out: string[] = []
  let pos = 0
  let firstDone = false
  for (const c of chunks) {
    const cs = pos
    const ce = pos + c.text.length
    pos = ce
    // 与变化区间 [pS, pE) 无交集 → 原样
    if (ce <= pS || cs >= pE) {
      out.push(c.xml)
      continue
    }
    const keepPrefix = c.text.slice(0, Math.max(0, Math.min(c.text.length, pS - cs)))
    const keepSuffix = c.text.slice(Math.max(0, Math.min(c.text.length, pE - cs)))
    const middle = firstDone ? '' : newMiddle
    firstDone = true
    const newContent = keepPrefix + middle + keepSuffix
    if (newContent === c.text) {
      // 内容等值（实体写法可能不同）→ 保留原样，字节级保真
      out.push(c.xml)
      continue
    }
    const escaped = escapeXmlText(newContent)
    const head = opts?.adjustHead ? opts.adjustHead(c.head, newContent) : c.head
    out.push(head + escaped + c.tail)
  }
  if (appendMode) {
    // 追加到最后一个块尾部
    const i = chunks.length - 1
    const c = chunks[i]
    const head = opts?.adjustHead ? opts.adjustHead(c.head, c.text + newMiddle) : c.head
    out[i] = head + c.raw + escapeXmlText(newMiddle) + c.tail
  }
  return out
}

/**
 * DOCX w:t / XLSX t 共用：新内容含首尾空白时补 xml:space="preserve"
 * （对齐 Word/Excel 自身行为），已有该属性则不动。
 */
export function withXmlSpacePreserve(head: string, newContent: string): string {
  if (!/^\s|\s$/.test(newContent)) return head
  const m = head.match(/^<([A-Za-z0-9:]+)(\s[^>]*)?>$/)
  if (!m) return head
  const attrs = m[2] ?? ''
  if (/xml:space\s*=/.test(attrs)) return head
  return `<${m[1]}${attrs} xml:space="preserve">`
}

/* ---------------- 容器内部 XML 的切块与回填（ODF/EPUB 用） ---------------- */

export interface InnerScan {
  /** 字符数据段块（head/tail 为 ''，xml === raw） */
  chunks: TextChunk[]
  /** chunks[i] 在容器内部 XML 中的 [start, end) */
  spans: Array<{ start: number; end: number }>
}

/** 把容器内部 XML 切成「标签 + 字符数据段」，字符数据段作为可替换块 */
export function scanInnerText(inner: string, extended = false): InnerScan {
  const chunks: TextChunk[] = []
  const spans: Array<{ start: number; end: number }> = []
  const pushChunk = (start: number, end: number) => {
    const raw = inner.slice(start, end)
    chunks.push({
      head: '',
      raw,
      text: extended ? unescapeXmlExtended(raw) : unescapeXml(raw),
      tail: '',
      xml: raw
    })
    spans.push({ start, end })
  }
  let last = 0
  for (const m of inner.matchAll(/<[^>]+>/g)) {
    const s = m.index ?? 0
    if (s > last) pushChunk(last, s)
    last = s + m[0].length
  }
  if (last < inner.length) pushChunk(last, inner.length)
  return { chunks, spans }
}

/** 用 replaceChunkText 的逐块结果回填容器内部 XML（标签保持不动） */
export function spliceInnerText(inner: string, scan: InnerScan, parts: string[]): string {
  let out = ''
  let last = 0
  for (let i = 0; i < scan.spans.length; i++) {
    out += inner.slice(last, scan.spans[i].start) + parts[i]
    last = scan.spans[i].end
  }
  out += inner.slice(last)
  return out
}
