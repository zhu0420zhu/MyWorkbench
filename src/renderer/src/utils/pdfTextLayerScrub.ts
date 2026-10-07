/**
 * PDF 文本层清理：把「已经被覆盖矩形盖住」的原文字，从页面内容流里**真正删掉**。
 *
 * 为什么需要它
 * ------------
 * 本项目的「保版式改字」是**覆盖重绘**：原内容流一个字节不改，只在页面末尾追加
 * 「背景色矩形 + 新文字」。好处是版式绝对不变，代价是**旧文字仍留在文本层里**——
 * 可被选中、可被复制、可被检索，合同/公文场景下改过的金额依然能被搜出来。
 *
 * 本模块在覆盖重绘之前跑一遍，把目标文字对应的**文本显示算子**从原内容流里摘掉。
 * 因为那些位置稍后会被不透明的覆盖矩形盖住，删掉原文字**不会改变任何可见像素**；
 * 而文本层里再也没有它了。
 *
 * 为什么只删「显示算子」而不是整块 BT…ET
 * ------------------------------------
 * BT 块里除了 Tj 还有可能夹着 `rg`（设填充色）、`cm`、`q/Q` 等；整块删掉可能把
 * 图形状态泄漏给后续内容。所以这里**只删除 `Tj / TJ / ' / "` 及其操作数**，
 * 其余算子原样保留。留下的 `Tf/Tm/Td/T*` 都是文本状态、不绘制任何东西，
 * 对视觉与文本提取都无影响。
 *
 * 为什么不用可选内容组（OCG）隐藏
 * ------------------------------
 * 已实测（tests/pdf-audit/scratch/ocg-probe.mjs，见报告）：把文字包进默认为 OFF 的
 * OCG 后，pdf.js 的 `getTextContent()` **依然返回**这段文字（返回
 * "VISIBLE-AAAHIDDEN-BBB"）。也就是说 OCG 只影响 canvas 绘制，不影响文本提取，
 * 不能解决本问题，故采用外科式移除。
 *
 * ActualText（2026-09-30 实测，见 tests/pdf-actualtext-probe.ts）
 * -------------------------------------------------------------
 * PDF 有一种机制叫 ActualText：`<</Span <</ActualText (真正的文本)>>>>BDC … Tj(屏幕上的字) … EMC`，
 * 用途正是「显示 A、提取 B」。若只删掉 Tj 而把带 ActualText 的 BDC/EMC 留在流里，
 * 提取器**可能**依然返回旧内容 —— 那就是「看起来清干净了，其实没有」。
 *
 * 实测结论（造一份带 ActualText 的 PDF，跑本模块清理后再用 pdf.js 提取）：
 *   - 清理前：pdf.js 返回可见文字 `"VISIBLE-OLD-123"`，**不含** ActualText 里的 `SECRET-ALIAS-999`
 *     → 说明 pdf.js 在这条链路上**不采用** ActualText 替代可见文字。
 *   - 清理后：pdf.js 返回 `""`，既没有可见文字，也没有冒出 ActualText
 *     → **在 pdf.js 这条链路上，"假清净"风险不成立，本模块是有效的。**
 *   - 但清理后的内容流确实仍残留 `/Span << /ActualText (SECRET-ALIAS-999) >> BDC  EMC`（Tj 没了，壳还在）
 *     → **本模块保证的是"pdf.js 提取不到"，不等于"任何工具都提取不到"。**
 *       Acrobat / pdftotext 等其他提取器是否采用 ActualText 未实测，属已知边界。
 *       对外文案不能写成"旧文字彻底消失"，只能说"在本应用的文本提取里已不可见"。
 *
 * 保守原则（本模块的第一优先级）
 * ----------------------------
 * 只有在能**无歧义**地把一批显示算子对到目标文字行时才删，判据是：
 *   - 基线 y 与字号必须在容差内命中目标行（容差刻意很紧，见下面的常量注释）；
 *   - 显示算子的起点必须落在目标矩形内 —— 右边界**不留正容差**，因为算子的墨迹
 *     从起点往右长，起点紧贴 run 右边缘的那个字符（典型是紧跟其后的标点）墨迹整个
 *     在覆盖矩形之外，删掉就会改像素（实测踩到过，见报告）；
 *   - 一个 run 被拆成多个 BT 块是常态（soffice 的中文 PDF 一行十几个块、Word 也类似），
 *     因此「多个块命中」不算歧义，会一起删干净；真正的歧义只看「谁落在这个 run 的
 *     起点」——同时有两个块认领起点时放弃；
 *   - 只要有一个块「一半在目标矩形内、一半在外」（同一块含多行、或多个 run 共享同一
 *     块），整条目标放弃：这种块删不得，部分删又会让旧文字残留；
 *   - 渲染模式必须是「填充(0)」或「不可见(3)」。1/2 描边会画出外扩墨迹，4–7 会建立
 *     裁剪路径，删掉都会改变视觉，一律放弃；
 *   - 目标矩形内出现上述不安全渲染模式时，整条目标放弃。
 * 放弃的条目会逐条计入统计并原样保留（旧文字继续留在文本层），由调用方决定是否提示用户。
 */
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
  decodePDFRawStream
} from 'pdf-lib'
import type { PDFPage, PDFRef } from 'pdf-lib'

/* ------------------------------------------------------------------ *
 * 对外类型
 * ------------------------------------------------------------------ */

/** 需要从文本层抹掉的文字行（几何来自 pdf.js 提取的 PdfTextRun） */
export interface PdfTextScrubTarget {
  /** 0 基页号；越界条目忽略 */
  page: number
  /** 原文字外接框（PDF 用户坐标，左下原点，pt） */
  rect: { x: number; y: number; width: number; height: number }
  /** 原文字基线 y（PDF 用户坐标） */
  baseline: number
  /** 原字号（pt） */
  fontSize: number
}

/** 纯内容流层面的清理目标（不含页号，便于无头单测） */
export interface ScrubGeometry {
  rect: { x: number; y: number; width: number; height: number }
  baseline: number
  fontSize: number
}

export interface PdfTextScrubStats {
  /** 扫描过的页数（= 含目标的页数） */
  pagesScanned: number
  /** 内容流被改写的页数（仅当该页确有显示算子被删） */
  pagesRewritten: number
  /** 实际从内容流里删掉的 BT 块中的显示算子个数 */
  showsRemoved: number
  /** 被完全清空（全部显示算子已删）的 BT 块个数 */
  blocksCleared: number
  /** 成功清理的目标条目数 */
  targetsMatched: number
  /** 放弃清理的目标条目数（旧文字仍在文本层） */
  targetsSkipped: number
  /** 放弃原因分类计数 */
  reasons: Record<string, number>
  /** 因内容流读不出（加密/不支持的 Filter/结构异常）而整页跳过的页数 */
  pagesUnsupported: number
}

/** 单条内容流的清理结果 */
export interface ScrubContentResult {
  out: string
  showsRemoved: number
  blocksCleared: number
  matched: number
  skipped: number
  reasons: Record<string, number>
  /** 该内容流里 `Do`（引用 XObject）算子的个数：>0 时文字可能藏在 Form 里 */
  doCount: number
  /** 清掉的空 ActualText BDC/EMC 壳个数 */
  shellsRemoved?: number
}

/* ------------------------------------------------------------------ *
 * 容差参数（集中在此便于调参）
 * ------------------------------------------------------------------ */

/** 基线匹配容差（pt，绝对值）。
 *  刻意不用「字号比例」：容差一旦放宽，落进来的就是相邻基线，而相邻基线的字形墨迹
 *  会超出覆盖矩形，删掉就会改像素。相邻行/上标本来就该匹配不上。 */
const Y_TOL_PT = 1
/** 横向可删盒的左边界相对目标框的外扩量（pt）：必须 ≤ 覆盖矩形的 pad（≥1pt），
 *  否则被删字形的墨迹会从覆盖矩形左侧漏出去。 */
const X_LEFT_SLACK_PT = 0.5
/** 字号匹配容差（相对目标字号的比值） */
const SIZE_TOL_RATIO = 0.12
/** 「谁落在这个 run 的起点」的识别容差：max(绝对下限, 字号 × 比例) */
const X_CLAIM_ABS_PT = 1
const X_CLAIM_SIZE_RATIO = 0.3
/** 判定「附近根本没有文本块」的距离上限（倍字号）：超过这个距离就不算「差点命中」 */
const NEARBY_DIST_SIZE_RATIO = 3

/** 放弃原因 */
const R_NO_BLOCK = 'no-nearby-text-block'
const R_BLOCK_SPAN = 'block-spans-target-rect'
const R_AMBIG_START = 'ambiguous-run-start'
const R_XSTART = 'run-start-not-matched'
const R_BASELINE = 'baseline-mismatch'
const R_SIZE = 'font-size-mismatch'
const R_X = 'x-out-of-target-rect'
const R_RENDER_MODE = 'unsupported-render-mode'
const R_XOBJECT = 'text-may-live-in-form-xobject'
const R_UNSUPPORTED_STREAM = 'content-stream-unsupported'
const R_PARSE = 'content-stream-parse-error'
const R_INLINE_IMAGE = 'inline-image-unterminated'

/* ------------------------------------------------------------------ *
 * 矩阵工具（PDF 六元组 [a b c d e f]，列向量约定）
 * ------------------------------------------------------------------ */

type Mat = [number, number, number, number, number, number]

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0]

/** m ∘ n（先施加 n，再施加 m） */
function matMul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5]
  ]
}

function matTranslate(tx: number, ty: number): Mat {
  return [1, 0, 0, 1, tx, ty]
}

/** 矩阵作用于点 */
function matApply(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/* ------------------------------------------------------------------ *
 * 词法分析：内容流 → token 序列
 * ------------------------------------------------------------------ */

type Tok =
  | { k: 'num'; v: number; s: number; e: number }
  | { k: 'str'; v: string; s: number; e: number }
  | { k: 'name'; v: string; s: number; e: number }
  | { k: 'arr'; items: Tok[]; s: number; e: number }
  | { k: 'op'; v: string; s: number; e: number }
  | { k: 'inline'; s: number; e: number }

const DELIMITER_CHARS = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%'])

function isWs(c: string): boolean {
  return c === '\u0000' || c === '\t' || c === '\n' || c === '\f' || c === '\r' || c === ' '
}

function isDelimiter(c: string): boolean {
  return DELIMITER_CHARS.has(c)
}

function isRegular(c: string): boolean {
  return !isWs(c) && !isDelimiter(c)
}

function isHexDigit(c: string): boolean {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

class ContentParseError extends Error {}

/** 内容流解析器：一次性把整条流切成 token 序列 */
function tokenize(src: string): Tok[] {
  const n = src.length
  let i = 0
  const toks: Tok[] = []

  /** 跳过空白与 `%` 注释 */
  function skipTrivia(): void {
    while (i < n) {
      const c = src[i]
      if (isWs(c)) {
        i++
        continue
      }
      if (c === '%') {
        while (i < n && src[i] !== '\n' && src[i] !== '\r') i++
        continue
      }
      break
    }
  }

  /** 字面串 `( ... )`，返回解码后的 latin1 字符串 */
  function readLiteralString(): string {
    i++ // 吃掉 '('
    let depth = 0
    let out = ''
    while (i < n) {
      const c = src[i++]
      if (c === '\\') {
        const d = src[i]
        if (d === undefined) break
        if (d === 'n') (out += '\n'), i++
        else if (d === 'r') (out += '\r'), i++
        else if (d === 't') (out += '\t'), i++
        else if (d === 'b') (out += '\b'), i++
        else if (d === 'f') (out += '\f'), i++
        else if (d === '(' || d === ')' || d === '\\') (out += d), i++
        else if (d === '\r') {
          i++
          if (src[i] === '\n') i++
        } else if (d === '\n') i++
        else if (d >= '0' && d <= '7') {
          let oct = ''
          while (oct.length < 3 && src[i] >= '0' && src[i] <= '7') oct += src[i++]
          out += String.fromCharCode(parseInt(oct, 8) & 0xff)
        } else (out += d), i++
        continue
      }
      if (c === '(') {
        depth++
        out += c
        continue
      }
      if (c === ')') {
        if (depth === 0) break
        depth--
        out += c
        continue
      }
      out += c
    }
    return out
  }

  /** 十六进制串 `< ... >` */
  function readHexString(): string {
    i++ // 吃掉 '<'
    let hex = ''
    while (i < n && src[i] !== '>') {
      const c = src[i++]
      if (isHexDigit(c)) hex += c
    }
    if (i < n) i++ // 吃掉 '>'
    if (hex.length % 2 === 1) hex += '0'
    let out = ''
    for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16))
    return out
  }

  /** 名字 `/Name`（含 `#xx` 转义） */
  function readName(): string {
    i++ // 吃掉 '/'
    let out = ''
    while (i < n && isRegular(src[i])) {
      const c = src[i++]
      if (c === '#' && isHexDigit(src[i]) && isHexDigit(src[i + 1])) {
        out += String.fromCharCode(parseInt(src.slice(i, i + 2), 16))
        i += 2
      } else out += c
    }
    return out
  }

  /** 内联图像 `BI <dict> ID <binary> EI`：整段当一个不透明 token 跳过 */
  function readInlineImage(biStart: number): Tok {
    // 找 `ID` 关键字（独立成词）
    let j = i
    let idAt = -1
    while (j < n - 1) {
      if (src[j] === 'I' && src[j + 1] === 'D') {
        const before = j === 0 ? ' ' : src[j - 1]
        const after = j + 2 >= n ? ' ' : src[j + 2]
        if (isWs(before) && (isWs(after) || isDelimiter(after))) {
          idAt = j
          break
        }
      }
      j++
    }
    if (idAt < 0) throw new ContentParseError(R_INLINE_IMAGE)
    j = idAt + 2
    // ID 之后紧跟一个空白字节，之后是二进制数据
    if (j < n && isWs(src[j])) j++
    // 找独立成词的 `EI`
    let eiEnd = -1
    while (j < n - 1) {
      if (src[j] === 'E' && src[j + 1] === 'I') {
        const before = j === 0 ? ' ' : src[j - 1]
        const after = j + 2 >= n ? ' ' : src[j + 2]
        if (isWs(before) && (j + 2 >= n || isWs(after) || isDelimiter(after))) {
          eiEnd = j + 2
          break
        }
      }
      j++
    }
    if (eiEnd < 0) throw new ContentParseError(R_INLINE_IMAGE)
    i = eiEnd
    return { k: 'inline', s: biStart, e: eiEnd }
  }

  /** 读一个 token；`allowInline` 只在顶层为真 */
  function readToken(allowInline: boolean): Tok | null {
    skipTrivia()
    if (i >= n) return null
    const start = i
    const c = src[i]

    if (c === '(') return { k: 'str', v: readLiteralString(), s: start, e: i }

    if (c === '<') {
      if (src[i + 1] === '<') {
        // 字典：整体跳过（内容流里字典只出现在 BDC/DP 的操作数位置，不含显示算子）
        i += 2
        for (;;) {
          skipTrivia()
          if (i >= n) break
          if (src[i] === '>' && src[i + 1] === '>') {
            i += 2
            break
          }
          if (src[i] === '>') {
            i++
            continue
          }
          if (readToken(false) === null) break
        }
        return { k: 'inline', s: start, e: i }
      }
      return { k: 'str', v: readHexString(), s: start, e: i }
    }

    if (c === '[') {
      i++
      const items: Tok[] = []
      for (;;) {
        skipTrivia()
        if (i >= n) break
        if (src[i] === ']') {
          i++
          break
        }
        const t = readToken(false)
        if (t === null) break
        items.push(t)
      }
      return { k: 'arr', items, s: start, e: i }
    }

    if (c === '/') return { k: 'name', v: readName(), s: start, e: i }

    if (c === '+' || c === '-' || c === '.' || (c >= '0' && c <= '9')) {
      const from = i
      NUMBER_RE.lastIndex = from
      const m = NUMBER_RE.exec(src)
      if (m && m.index === from) {
        i = NUMBER_RE.lastIndex
        const v = Number(m[0])
        if (Number.isFinite(v)) return { k: 'num', v, s: start, e: i }
      }
      // 形态不合法：退化成单字符算子，保证不死循环
      i = from + 1
      return { k: 'op', v: src.slice(from, i), s: start, e: i }
    }

    if (isRegular(c)) {
      let j = i
      while (j < n && isRegular(src[j])) j++
      const word = src.slice(i, j)
      i = j
      if (word === 'BI' && allowInline) {
        const inlineTok = readInlineImage(start)
        return inlineTok
      }
      return { k: 'op', v: word, s: start, e: i }
    }

    // 孤立的定界符（`]` `>` `)` 之类）：跳过一字节，容错
    i++
    return { k: 'op', v: c, s: start, e: i }
  }

  while (i < n) {
    const t = readToken(true)
    if (t === null) break
    toks.push(t)
  }
  return toks
}

const NUMBER_RE = /[+-]?(?:\d+\.?\d*|\.\d+)/y

/* ------------------------------------------------------------------ *
 * 语法分析：找出每个文本显示算子及其几何
 * ------------------------------------------------------------------ */

interface ShowOp {
  /** 设备无关的用户空间左上起点 x（基线起点） */
  x: number
  /** 用户空间基线 y */
  y: number
  /** 用户空间有效字号 */
  size: number
  /** 该显示算子（含操作数）在源串里的区间，删除即抹掉这段文字 */
  from: number
  to: number
  /** 渲染模式是否允许删除（填充 0 / 不可见 3） */
  deletable: boolean
}

interface TextBlock {
  shows: ShowOp[]
  /** 该块里 `Do` 的个数 */
  doCount: number
}

interface ScanResult {
  blocks: TextBlock[]
  doCount: number
}

/** 从 token 序列里切出全部 BT…ET 块，并算出每个显示算子的用户空间几何 */
function scanTextBlocks(toks: Tok[]): ScanResult {
  const blocks: TextBlock[] = []
  const ctmStack: Mat[] = []
  let ctm: Mat = IDENTITY.slice() as Mat

  let inText = false
  let tm: Mat = IDENTITY.slice() as Mat
  let tlm: Mat = IDENTITY.slice() as Mat
  let tfs = 0
  let tl = 0
  let ts = 0
  let tr = 0
  let btShows: ShowOp[] = []
  let btDo = 0
  let totalDo = 0

  const stack: Tok[] = []

  const takeNum = (idx: number): number | null => {
    const t = stack[idx]
    return t && t.k === 'num' ? t.v : null
  }
  const takeMat = (): Mat | null => {
    if (stack.length < 6) return null
    const m: number[] = []
    for (let k = stack.length - 6; k < stack.length; k++) {
      const t = stack[k]
      if (t.k !== 'num') return null
      m.push(t.v)
    }
    return m as Mat
  }
  /** 记录一次文字显示：`n` 个操作数 + 1 个算子全部落在 [from, to) */
  function recordShow(opFrom: number, to: number): void {
    if (!inText) return
    const p = matApply(tm, 0, ts)
    const [x, y] = matApply(ctm, p[0], p[1])
    const xScale = Math.hypot(tm[0], tm[1]) * Math.hypot(ctm[0], ctm[1])
    btShows.push({
      x,
      y,
      size: tfs * xScale,
      from: opFrom,
      to,
      deletable: tr === 0 || tr === 3
    })
  }

  for (const tok of toks) {
    if (tok.k !== 'op') {
      stack.push(tok)
      continue
    }
    switch (tok.v) {
      case 'q':
        ctmStack.push(ctm.slice() as Mat)
        break
      case 'Q':
        if (ctmStack.length) ctm = ctmStack.pop() as Mat
        break
      case 'cm': {
        const m = takeMat()
        if (m) ctm = matMul(m, ctm)
        break
      }
      case 'BT':
        inText = true
        tm = IDENTITY.slice() as Mat
        tlm = IDENTITY.slice() as Mat
        btShows = []
        btDo = 0
        break
      case 'ET':
        if (inText && btShows.length > 0) blocks.push({ shows: btShows, doCount: btDo })
        inText = false
        btShows = []
        break
      case 'Do':
        totalDo++
        if (inText) btDo++
        break
      case 'Tf': {
        const size = takeNum(stack.length - 1)
        if (size !== null) tfs = size
        break
      }
      case 'Tm': {
        const m = takeMat()
        if (m) {
          tm = m
          tlm = m.slice() as Mat
        }
        break
      }
      case 'Td':
      case 'TD': {
        if (stack.length >= 2) {
          const tx = takeNum(stack.length - 2)
          const ty = takeNum(stack.length - 1)
          if (tx !== null && ty !== null) {
            tlm = matMul(matTranslate(tx, ty), tlm)
            tm = tlm.slice() as Mat
            if (tok.v === 'TD') tl = -ty
          }
        }
        break
      }
      case 'TL': {
        const l = takeNum(stack.length - 1)
        if (l !== null) tl = l
        break
      }
      case 'Ts': {
        const r = takeNum(stack.length - 1)
        if (r !== null) ts = r
        break
      }
      case 'Tr': {
        const r = takeNum(stack.length - 1)
        if (r !== null) tr = r
        break
      }
      case 'T*': {
        tlm = matMul(matTranslate(0, -tl), tlm)
        tm = tlm.slice() as Mat
        break
      }
      case 'Tj': {
        const t = stack[stack.length - 1]
        recordShow(t ? t.s : tok.s, tok.e)
        break
      }
      case 'TJ': {
        const t = stack[stack.length - 1]
        recordShow(t ? t.s : tok.s, tok.e)
        break
      }
      case "'": {
        tlm = matMul(matTranslate(0, -tl), tlm)
        tm = tlm.slice() as Mat
        const t = stack[stack.length - 1]
        recordShow(t ? t.s : tok.s, tok.e)
        break
      }
      case '"': {
        tlm = matMul(matTranslate(0, -tl), tlm)
        tm = tlm.slice() as Mat
        const t = stack[stack.length - 1]
        recordShow(t ? t.s : tok.s, tok.e)
        break
      }
      default:
        break
    }
    stack.length = 0
  }

  return { blocks, doCount: totalDo }
}

/* ------------------------------------------------------------------ *
 * 匹配
 * ------------------------------------------------------------------ */

/** 一个 BT 块相对目标行的可删性评估 */
interface ScrubBlockEval {
  /** 该块是否有显示算子落在目标矩形内（几何命中） */
  anyInside: boolean
  /** 该块**全部**显示算子都落在目标矩形内且渲染模式可安全删除 */
  allInside: boolean
  /** 目标矩形内有渲染模式不安全的显示算子（描边/裁剪） */
  unsafeInside: boolean
  /** 该块有显示算子落在目标矩形起点处（用于判定「谁是这个 run 的第一段」） */
  startClaim: boolean
  /** 该块与目标的最近距离（|Δy| + |Δx|，用于诊断） */
  distance: number
  /** 该块的失败原因（allInside 为 true 时无意义） */
  reason: string
}

interface Tolerance {
  left: number
  right: number
  yTol: number
  sizeTol: number
  xTol: number
}

/**
 * 可删盒：只有「显示算子起点」落在盒内的块才允许删。
 *
 * 右边界**不留正容差**：显示算子的墨迹从起点往右长，起点紧贴在 run 右边缘的那个
 * 算子（典型的是紧跟在目标后面、刚好差 0.02pt 的标点）墨迹整个在覆盖矩形之外，
 * 删掉就会改像素。留正容差实测会让它混进来（见报告里的 C 场景 24px 反例）。
 */
function toleranceFor(target: ScrubGeometry): Tolerance {
  const fs = target.fontSize
  return {
    left: target.rect.x - X_LEFT_SLACK_PT,
    right: target.rect.x + target.rect.width,
    yTol: Y_TOL_PT,
    sizeTol: Math.max(0.5, fs * SIZE_TOL_RATIO),
    xTol: Math.max(X_CLAIM_ABS_PT, fs * X_CLAIM_SIZE_RATIO)
  }
}

/**
 * 评估一个 BT 块相对目标行的可删性。
 *
 * 注意这里**没有**「整块必须只有一行」之外的歧义判定：一个 run 常常被拆成多个
 * BT 块（soffice 的中文 PDF 一行就是十几个 BT 块，Word 输出也类似），因此
 * 「多个块都命中」是常态而不是歧义。真正的歧义由 `startClaim`（谁落在这个 run
 * 的起点）来判定；而「同一块含多行 / 多个 run 共享同一块」则表现为
 * `anyInside && !allInside` —— 这种块删不得，整个目标放弃。
 */
function evalBlock(block: TextBlock, target: ScrubGeometry, tol: Tolerance): ScrubBlockEval {
  let anyInside = false
  let allInside = true
  let unsafeInside = false
  let startClaim = false
  let distance = Number.POSITIVE_INFINITY
  let worst: { reason: string; distance: number } | null = null

  for (const s of block.shows) {
    const d = Math.abs(s.y - target.baseline) + Math.abs(s.x - target.rect.x)
    if (d < distance) distance = d
    if (Math.abs(s.x - target.rect.x) <= tol.xTol) startClaim = true

    const sizeOk = Math.abs(s.size - target.fontSize) <= tol.sizeTol
    const yOk = Math.abs(s.y - target.baseline) <= tol.yTol
    const xOk = s.x >= tol.left && s.x < tol.right
    const geomInside = sizeOk && yOk && xOk

    if (geomInside) {
      anyInside = true
      if (!s.deletable) {
        unsafeInside = true
        allInside = false
        if (!worst || d < worst.distance) worst = { reason: R_RENDER_MODE, distance: d }
      }
    } else {
      allInside = false
      const reason = !sizeOk ? R_SIZE : !yOk ? R_BASELINE : R_X
      if (!worst || d < worst.distance) worst = { reason, distance: d }
    }
  }

  const reason = unsafeInside ? R_RENDER_MODE : anyInside && !allInside ? R_BLOCK_SPAN : (worst?.reason ?? R_NO_BLOCK)
  return { anyInside, allInside, unsafeInside, startClaim, distance, reason }
}

/* ------------------------------------------------------------------ *
 * 纯函数入口：内容流字符串 → 清理后的内容流字符串
 * ------------------------------------------------------------------ */

interface ScrubRange {
  s: number
  e: number
}

/** 合并重叠/相邻的删除区间 */
function mergeRanges(ranges: ScrubRange[]): ScrubRange[] {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => a.s - b.s)
  const out: ScrubRange[] = [sorted[0]]
  for (let k = 1; k < sorted.length; k++) {
    const last = out[out.length - 1]
    if (sorted[k].s <= last.e) last.e = Math.max(last.e, sorted[k].e)
    else out.push(sorted[k])
  }
  return out
}

/**
 * 从一条内容流里摘掉与目标几何唯一匹配的文字显示算子。
 *
 * 只在**唯一命中**时删除；歧义、渲染模式不安全、几何不符一律放弃并计数。
 */
/**
 * 去掉「空的 ActualText 壳」：`/Span << /ActualText (...) >> BDC  EMC`。
 * 旧 Tj 被删后 BDC/EMC 常残留，个别提取器可能仍读 ActualText —— 清壳更干净。
 * 只删内部不含任何显示算子（Tj/TJ/'/"）的 BDC…EMC 对，保守不误伤。
 */
function stripEmptyActualTextShells(content: string): { out: string; shellsRemoved: number } {
  let out = ''
  let i = 0
  let shellsRemoved = 0
  const n = content.length

  /** 从 `>>` 之后的位置回扫配对 `<<` 的起点（跳过自身这对 `>>`） */
  const findDictStart = (afterDict: number): number => {
    let depth = 0
    let k = afterDict - 2
    while (k > 0) {
      k--
      if (k >= 1 && content[k] === '>' && content[k - 1] === '>') {
        depth++
        k--
        continue
      }
      if (k >= 1 && content[k] === '<' && content[k - 1] === '<') {
        if (depth === 0) return k - 1
        depth--
        k--
      }
    }
    return -1
  }

  while (i < n) {
    const bdc = content.indexOf('BDC', i)
    if (bdc < 0) {
      out += content.slice(i)
      break
    }
    const before = bdc > 0 ? content[bdc - 1] : ' '
    if (!/\s/.test(before)) {
      out += content.slice(i, bdc + 3)
      i = bdc + 3
      continue
    }
    const emc = content.indexOf('EMC', bdc + 3)
    if (emc < 0) {
      out += content.slice(i)
      break
    }
    const after = emc + 3 < n ? content[emc + 3] : ' '
    if (emc + 3 !== n && !/\s/.test(after)) {
      out += content.slice(i, emc + 3)
      i = emc + 3
      continue
    }
    const inner = content.slice(bdc + 3, emc)
    if (/(?:^|[\s>])(?:Tj|TJ|'|")(?![A-Za-z])/.test(inner)) {
      out += content.slice(i, emc + 3)
      i = emc + 3
      continue
    }
    const headWindow = content.slice(Math.max(0, bdc - 120), bdc + 3)
    if (!/ActualText/i.test(headWindow)) {
      out += content.slice(i, emc + 3)
      i = emc + 3
      continue
    }

    // 回扫 BDC 的操作数：/Name <<...>>（可重复）
    let j = bdc
    while (j > i && /\s/.test(content[j - 1])) j--
    for (;;) {
      if (j >= 2 && content[j - 1] === '>' && content[j - 2] === '>') {
        const ds = findDictStart(j)
        if (ds < 0) break
        j = ds
        while (j > i && /\s/.test(content[j - 1])) j--
        continue
      }
      let k = j
      while (k > i && /[A-Za-z0-9]/.test(content[k - 1])) k--
      if (k < j && k > 0 && content[k - 1] === '/') {
        j = k - 1
        while (j > i && /\s/.test(content[j - 1])) j--
        continue
      }
      break
    }

    out += content.slice(i, j)
    i = emc + 3
    shellsRemoved++
  }
  return { out, shellsRemoved }
}
export function scrubContentStream(content: string, targets: ScrubGeometry[]): ScrubContentResult {
  const reasons: Record<string, number> = {}
  const bump = (r: string): void => {
    reasons[r] = (reasons[r] ?? 0) + 1
  }

  if (targets.length === 0 || content.length === 0) {
    return { out: content, showsRemoved: 0, blocksCleared: 0, matched: 0, skipped: 0, reasons, doCount: 0 }
  }

  let scan: ScanResult
  try {
    scan = scanTextBlocks(tokenize(content))
  } catch (err) {
    const reason = err instanceof ContentParseError ? err.message : R_PARSE
    for (let k = 0; k < targets.length; k++) bump(reason)
    return {
      out: content,
      showsRemoved: 0,
      blocksCleared: 0,
      matched: 0,
      skipped: targets.length,
      reasons,
      doCount: 0
    }
  }

  const claimed = new Set<number>()
  const ranges: ScrubRange[] = []
  let matched = 0
  let skipped = 0

  for (const target of targets) {
    const tol = toleranceFor(target)
    const evals = scan.blocks.map((b) => evalBlock(b, target, tol))
    const candidates: number[] = []
    for (let b = 0; b < evals.length; b++) {
      if (evals[b].allInside) candidates.push(b)
    }

    // 1) 目标矩形内有渲染模式不安全的算子（描边/裁剪）：删了会改变裁剪或墨迹范围
    if (evals.some((e) => e.unsafeInside)) {
      bump(R_RENDER_MODE)
      skipped++
      continue
    }
    // 2) 存在「一半在目标矩形内、一半在外」的块（同一块含多行 / 多个 run 共享一块）：
    //    整块删不得、部分删又会让旧文字残留，一律放弃
    if (evals.some((e) => e.anyInside && !e.allInside)) {
      bump(R_BLOCK_SPAN)
      skipped++
      continue
    }
    // 3) 没有任何块全部落在目标矩形内
    if (candidates.length === 0) {
      let best: ScrubBlockEval | null = null
      for (const e of evals) {
        if (!best || e.distance < best.distance) best = e
      }
      const fs = Math.max(1, target.fontSize)
      if (best && Number.isFinite(best.distance) && best.distance <= fs * NEARBY_DIST_SIZE_RATIO) {
        bump(best.reason)
      } else if (scan.doCount > 0) {
        bump(R_XOBJECT)
      } else {
        bump(R_NO_BLOCK)
      }
      skipped++
      continue
    }
    // 4) 谁落在 run 起点：必须恰好一个块认领，否则说明这一段可能不是完整的 run
    const claimants = candidates.filter((b) => evals[b].startClaim)
    if (claimants.length === 0) {
      bump(R_XSTART)
      skipped++
      continue
    }
    if (claimants.length > 1) {
      bump(R_AMBIG_START)
      skipped++
      continue
    }

    for (const b of candidates) {
      claimed.add(b)
      for (const s of scan.blocks[b].shows) ranges.push({ s: s.from, e: s.to })
    }
    matched++
  }

  const merged = mergeRanges(ranges)
  let out = content
  if (merged.length > 0) {
    let acc = ''
    let cursor = 0
    for (const r of merged) {
      acc += content.slice(cursor, r.s)
      cursor = r.e
    }
    acc += content.slice(cursor)
    out = acc
  }

  let showsRemoved = 0
  let blocksCleared = 0
  for (const b of claimed) {
    showsRemoved += scan.blocks[b].shows.length
    blocksCleared++
  }

  // 清掉空的 ActualText BDC/EMC 壳（Tj 已删，壳仍可能被其它提取器读到）
  const shell = stripEmptyActualTextShells(out)
  out = shell.out

  return {
    out,
    showsRemoved,
    blocksCleared,
    matched,
    skipped,
    reasons,
    doCount: scan.doCount,
    shellsRemoved: shell.shellsRemoved
  }
}

/* ------------------------------------------------------------------ *
 * pdf-lib 驱动：把清理结果写回文档
 * ------------------------------------------------------------------ */

function bytesToLatin1(bytes: Uint8Array): string {
  let out = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return out
}

function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

/** 取出某页全部内容流并解压拼接；任何一环失败返回 null（该页放弃清理） */
function readPageContent(doc: PDFDocument, page: PDFPage): string | null {
  const contents = page.node.Contents()
  if (contents === undefined) return null

  const streams: PDFRawStream[] = []
  const collect = (raw: unknown): boolean => {
    const resolved = doc.context.lookup(raw as PDFRef)
    if (resolved instanceof PDFRawStream) {
      streams.push(resolved)
      return true
    }
    return false
  }

  if (contents instanceof PDFArray) {
    const size = contents.size()
    for (let k = 0; k < size; k++) {
      if (!collect(contents.get(k))) return null
    }
  } else if (!collect(contents)) {
    return null
  }
  if (streams.length === 0) return null

  const parts: Uint8Array[] = []
  for (const s of streams) {
    try {
      parts.push(decodePDFRawStream(s).decode())
    } catch {
      return null
    }
    parts.push(latin1ToBytes('\n'))
  }
  let total = 0
  for (const p of parts) total += p.length
  const flat = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    flat.set(p, off)
    off += p.length
  }
  return bytesToLatin1(flat)
}

/** 用清理后的内容流替换该页的 Contents（会顺带把数组形式的 Contents 折叠成单流） */
function writePageContent(doc: PDFDocument, page: PDFPage, content: string): void {
  const ref = doc.context.register(doc.context.flateStream(latin1ToBytes(content)))
  page.node.set(PDFName.of('Contents'), ref)
}

/**
 * 就地清理 `doc` 里若干页的文本层，返回统计。**必须在覆盖重绘之前调用**——
 * 否则追加的新文字也会落进扫描范围，可能被误判成待删的原文字。
 */
export function scrubPdfTextLayer(doc: PDFDocument, targets: PdfTextScrubTarget[]): PdfTextScrubStats {
  const stats: PdfTextScrubStats = {
    pagesScanned: 0,
    pagesRewritten: 0,
    showsRemoved: 0,
    blocksCleared: 0,
    targetsMatched: 0,
    targetsSkipped: 0,
    reasons: {},
    pagesUnsupported: 0
  }
  const bump = (r: string): void => {
    stats.reasons[r] = (stats.reasons[r] ?? 0) + 1
  }

  const pages = doc.getPages()
  const byPage = new Map<number, ScrubGeometry[]>()
  for (const t of targets) {
    if (!Number.isFinite(t.page) || t.page < 0 || t.page >= pages.length) continue
    const geometry: ScrubGeometry = { rect: t.rect, baseline: t.baseline, fontSize: t.fontSize }
    const list = byPage.get(t.page)
    if (list) list.push(geometry)
    else byPage.set(t.page, [geometry])
  }

  for (const [pageIndex, geometries] of byPage) {
    stats.pagesScanned++
    const page = pages[pageIndex]
    let content: string | null = null
    try {
      content = readPageContent(doc, page)
    } catch {
      content = null
    }
    if (content === null) {
      stats.pagesUnsupported++
      for (let k = 0; k < geometries.length; k++) bump(R_UNSUPPORTED_STREAM)
      stats.targetsSkipped += geometries.length
      continue
    }

    let result: ScrubContentResult
    try {
      result = scrubContentStream(content, geometries)
    } catch {
      for (let k = 0; k < geometries.length; k++) bump(R_PARSE)
      stats.targetsSkipped += geometries.length
      continue
    }

    stats.targetsMatched += result.matched
    stats.targetsSkipped += result.skipped
    for (const [reason, count] of Object.entries(result.reasons)) {
      stats.reasons[reason] = (stats.reasons[reason] ?? 0) + count
    }

    if (result.showsRemoved > 0) {
      writePageContent(doc, page, result.out)
      stats.pagesRewritten++
      stats.showsRemoved += result.showsRemoved
      stats.blocksCleared += result.blocksCleared
    }
  }

  return stats
}
