/**
 * PDF 对象层：词法分析 + 递归下降解析 + 无损序列化。
 *
 * 为什么自备这一层，而不复用 pdf-lib：
 *   加密 / 解密需要「对象级」的精确控制 —— 我们要拿到每个对象的【原始字节】
 *   （尤其是流的密文字节）、就地改写字符串，并按对象号重新拼装整个文件。
 *   pdf-lib 把对象抽象成高层模型，「读不懂就丢」的密文在它那里是黑盒，
 *   无法承担这个任务（现有解密 bug 正是这么来的）。
 *
 * 字符模型：
 *   PDF 是字节语言。本模块用 latin1（每字符 = 1 字节）的 JS 字符串承载解析，
 *   避免 UTF-8 对高位字节的二次编码破坏；二进制流数据一律用 Uint8Array 单独保存，
 *   仅在序列化落盘前才拼回 latin1 字符串（latin1 与字节一一对应，拼接无损）。
 */

/* ==================== 对象模型 ==================== */

export interface PdfNull {
  kind: 'null'
}
export interface PdfBool {
  kind: 'bool'
  value: boolean
}
export interface PdfNumber {
  kind: 'number'
  value: number
}
export interface PdfString {
  kind: 'string'
  bytes: Uint8Array
  /** 仅作记录：源文件里是否为十六进制写法（序列化时会重新择优，不强制沿用） */
  hex?: boolean
}
export interface PdfName {
  kind: 'name'
  name: string
}
export interface PdfArray {
  kind: 'array'
  items: PdfObject[]
}
export interface PdfDict {
  kind: 'dict'
  map: Map<string, PdfObject>
}
export interface PdfRef {
  kind: 'ref'
  num: number
  gen: number
}
export interface PdfStream {
  kind: 'stream'
  dict: PdfDict
  /** 流的原始字节（可能是密文、也可能仍是被 Flate 压缩的明文） */
  raw: Uint8Array
}

export type PdfObject =
  | PdfNull
  | PdfBool
  | PdfNumber
  | PdfString
  | PdfName
  | PdfArray
  | PdfDict
  | PdfRef
  | PdfStream

export const PDF_NULL: PdfNull = { kind: 'null' }
export const pdfBool = (value: boolean): PdfBool => ({ kind: 'bool', value })
export const pdfNumber = (value: number): PdfNumber => ({ kind: 'number', value })
export const pdfName = (name: string): PdfName => ({ kind: 'name', name })
export const pdfRef = (num: number, gen = 0): PdfRef => ({ kind: 'ref', num, gen })
export const pdfString = (bytes: Uint8Array): PdfString => ({ kind: 'string', bytes })
export const pdfArray = (items: PdfObject[]): PdfArray => ({ kind: 'array', items })
export const pdfDict = (entries: Array<[string, PdfObject]> = []): PdfDict => ({
  kind: 'dict',
  map: new Map(entries)
})

/* ==================== 类型判定 / 取值 ==================== */

export const asName = (o: PdfObject | undefined): string | null =>
  o && o.kind === 'name' ? o.name : null
export const asNumber = (o: PdfObject | undefined): number | null =>
  o && o.kind === 'number' && Number.isFinite(o.value) ? o.value : null
export const asBool = (o: PdfObject | undefined): boolean | null =>
  o && o.kind === 'bool' ? o.value : null
export const asDict = (o: PdfObject | undefined): PdfDict | null =>
  o && o.kind === 'dict' ? o : null
export const asArray = (o: PdfObject | undefined): PdfArray | null =>
  o && o.kind === 'array' ? o : null
export const asRef = (o: PdfObject | undefined): PdfRef | null =>
  o && o.kind === 'ref' ? o : null
export const asStream = (o: PdfObject | undefined): PdfStream | null =>
  o && o.kind === 'stream' ? o : null
export const asBytes = (o: PdfObject | undefined): Uint8Array | null =>
  o && o.kind === 'string' ? o.bytes : null

/* ==================== 字节 / 字符串互转 ==================== */

/** latin1 字符串 → 字节（每字符低 8 位即一字节） */
export function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

/** 字节 → latin1 字符串。分块避免 String.fromCharCode 参数过多。 */
export function latin1FromBytes(b: Uint8Array): string {
  const CHUNK = 0x8000
  let out = ''
  for (let i = 0; i < b.length; i += CHUNK) {
    out += String.fromCharCode(...b.subarray(i, Math.min(i + CHUNK, b.length)))
  }
  return out
}

/* ==================== 词法基础 ==================== */

const isWhitespaceByte = (c: number): boolean =>
  c === 0x00 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20

const isDelimiterByte = (c: number): boolean =>
  c === 0x28 || // (
  c === 0x29 || // )
  c === 0x3c || // <
  c === 0x3e || // >
  c === 0x5b || // [
  c === 0x5d || // ]
  c === 0x7b || // {
  c === 0x7d || // }
  c === 0x2f || // /
  c === 0x25 || // %
  c === 0x23 //    #（名称中的转义引导符，单独处理）

const isRegularByte = (c: number): boolean => !isWhitespaceByte(c) && !isDelimiterByte(c)

// 粘性正则：直接从 pos 处匹配，避免对超大字符串反复 slice 造成 O(n^2)
const NUM_RE = /[+-]?(?:\d+\.?\d*|\.\d+)/y
const INT_RE = /[+-]?\d+/y
/** 间接引用「<gen> R」，用于在第一段数字后判断是不是 N G R 三元组 */
const REF_RE = /(\d+)[\s\x00]+R(?![0-9A-Za-z])/y

/* ==================== 递归下降解析器 ==================== */

class Parser {
  src: string
  pos: number
  // 不使用 TS 参数属性（constructor 里 readonly x）：Node 的类型剥离模式不支持
  constructor(src: string, pos = 0) {
    this.src = src
    this.pos = pos
  }

  /** 跳过空白与注释（% 到行尾） */
  skipWs(): void {
    const s = this.src
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos)
      if (isWhitespaceByte(c)) {
        this.pos++
        continue
      }
      if (c === 0x25) {
        // 注释：读到行尾（不含换行符本身，交给下一轮空白处理）
        while (this.pos < s.length) {
          const cc = s.charCodeAt(this.pos)
          if (cc === 0x0a || cc === 0x0d) break
          this.pos++
        }
        continue
      }
      break
    }
  }

  /** 读一段「规则字符」关键字（obj / endobj / true / R …） */
  readKeyword(): string {
    const start = this.pos
    while (this.pos < this.src.length && isRegularByte(this.src.charCodeAt(this.pos))) {
      this.pos++
    }
    return this.src.slice(start, this.pos)
  }

  readInteger(): number {
    INT_RE.lastIndex = this.pos
    const m = INT_RE.exec(this.src)
    if (!m) throw new Error(`位置 ${this.pos} 处不是整数`)
    this.pos = INT_RE.lastIndex
    return parseInt(m[0], 10)
  }

  readNumber(): number {
    NUM_RE.lastIndex = this.pos
    const m = NUM_RE.exec(this.src)
    if (!m) throw new Error(`位置 ${this.pos} 处不是数字`)
    this.pos = NUM_RE.lastIndex
    return parseFloat(m[0])
  }

  parseValue(): PdfObject {
    this.skipWs()
    if (this.pos >= this.src.length) return PDF_NULL
    const c = this.src.charCodeAt(this.pos)
    if (c === 0x2f) return this.parseName()
    if (c === 0x28) return this.parseLiteralString()
    if (c === 0x3c) {
      if (this.src.charCodeAt(this.pos + 1) === 0x3c) return this.parseDict()
      return this.parseHexString()
    }
    if (c === 0x5b) return this.parseArray()
    if (c === 0x2b || c === 0x2d || c === 0x2e || (c >= 0x30 && c <= 0x39)) {
      return this.parseNumberOrRef()
    }
    const kw = this.readKeyword()
    if (kw === 'true') return pdfBool(true)
    if (kw === 'false') return pdfBool(false)
    // null 或任何未预期关键字：按 null 处理，保证单个坏对象不拖垮整份文件
    return PDF_NULL
  }

  parseName(): PdfName {
    this.pos++ // 吃掉 '/'
    const s = this.src
    let name = ''
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos)
      if (c === 0x23) {
        // '#' 引导两字节十六进制转义
        const h = s.slice(this.pos + 1, this.pos + 3)
        if (/^[0-9A-Fa-f]{2}$/.test(h)) {
          name += String.fromCharCode(parseInt(h, 16))
          this.pos += 3
          continue
        }
        break
      }
      if (!isRegularByte(c)) break
      name += s[this.pos]
      this.pos++
    }
    return { kind: 'name', name }
  }

  parseLiteralString(): PdfString {
    this.pos++ // '('
    const s = this.src
    const bytes: number[] = []
    let depth = 1
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos)
      if (c === 0x5c) {
        // 反斜杠转义
        this.pos++
        const e = s.charCodeAt(this.pos)
        if (e === 0x6e) {
          bytes.push(0x0a)
          this.pos++
        } else if (e === 0x72) {
          bytes.push(0x0d)
          this.pos++
        } else if (e === 0x74) {
          bytes.push(0x09)
          this.pos++
        } else if (e === 0x62) {
          bytes.push(0x08)
          this.pos++
        } else if (e === 0x66) {
          bytes.push(0x0c)
          this.pos++
        } else if (e === 0x28 || e === 0x29 || e === 0x5c) {
          bytes.push(e)
          this.pos++
        } else if (e >= 0x30 && e <= 0x37) {
          // 八进制，最多三位
          let oct = ''
          let k = 0
          while (
            k < 3 &&
            this.pos < s.length &&
            s.charCodeAt(this.pos) >= 0x30 &&
            s.charCodeAt(this.pos) <= 0x37
          ) {
            oct += s[this.pos]
            this.pos++
            k++
          }
          bytes.push(parseInt(oct, 8) & 0xff)
        } else if (e === 0x0a || e === 0x0d) {
          // 反斜杠后直接换行 = 续行，不产出字符
          if (e === 0x0d && s.charCodeAt(this.pos + 1) === 0x0a) this.pos++
          this.pos++
        } else {
          bytes.push(e & 0xff)
          this.pos++
        }
        continue
      }
      if (c === 0x28) {
        depth++
        bytes.push(c)
        this.pos++
        continue
      }
      if (c === 0x29) {
        depth--
        this.pos++
        if (depth === 0) break
        bytes.push(c)
        continue
      }
      bytes.push(c & 0xff)
      this.pos++
    }
    return { kind: 'string', bytes: new Uint8Array(bytes), hex: false }
  }

  parseHexString(): PdfString {
    this.pos++ // '<'
    const s = this.src
    let hex = ''
    while (this.pos < s.length && s.charCodeAt(this.pos) !== 0x3e) {
      const ch = s[this.pos]
      if (hex.length < 1e7 && /[0-9A-Fa-f]/.test(ch)) hex += ch
      this.pos++
    }
    this.pos++ // '>'
    if (hex.length % 2 === 1) hex += '0' // 奇数位补 0（规范允许）
    const bytes = new Uint8Array(hex.length >> 1)
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
    return { kind: 'string', bytes, hex: true }
  }

  parseArray(): PdfArray {
    this.pos++ // '['
    const items: PdfObject[] = []
    for (;;) {
      this.skipWs()
      if (this.pos >= this.src.length) break
      if (this.src.charCodeAt(this.pos) === 0x5d) {
        this.pos++
        break
      }
      const before = this.pos
      items.push(this.parseValue())
      if (this.pos === before) this.pos++ // 防止解析停滞导致死循环
    }
    return { kind: 'array', items }
  }

  parseDict(): PdfDict {
    this.pos += 2 // '<<'
    const map = new Map<string, PdfObject>()
    for (;;) {
      this.skipWs()
      if (this.pos >= this.src.length) break
      const c = this.src.charCodeAt(this.pos)
      if (c === 0x3e && this.src.charCodeAt(this.pos + 1) === 0x3e) {
        this.pos += 2
        break
      }
      if (c !== 0x2f) {
        // 字典里出现了非键（异常）：尽力跳过，别整体失败
        const before = this.pos
        this.parseValue()
        if (this.pos === before) this.pos++
        continue
      }
      const key = this.parseName().name
      const value = this.parseValue()
      map.set(key, value)
    }
    return { kind: 'dict', map }
  }

  parseNumberOrRef(): PdfObject {
    const n1 = this.readNumber()
    if (!Number.isInteger(n1)) return pdfNumber(n1)
    const save = this.pos
    this.skipWs()
    REF_RE.lastIndex = this.pos
    const m = REF_RE.exec(this.src)
    if (m) {
      this.pos = REF_RE.lastIndex
      return pdfRef(n1, parseInt(m[1], 10))
    }
    this.pos = save
    return pdfNumber(n1)
  }
}

/** 从指定位置解析一个 PDF 值，返回值与结束偏移 */
export function parseValueAt(src: string, pos: number): { value: PdfObject; end: number } {
  const p = new Parser(src, pos)
  const value = p.parseValue()
  return { value, end: p.pos }
}

/* ==================== 间接对象（含流） ==================== */

export interface ParsedIndirect {
  num: number
  gen: number
  value: PdfObject
  /** 对象结束（endobj 之后）的偏移，供调用方继续扫描 */
  end: number
}

/**
 * 解析 `N G obj … endobj`。
 *
 * 流字节的定位策略（重要）：
 *   优先信任字典里的 /Length（若其值使数据正好落在 `endstream` 前），
 *   否则回退到「直接搜索下一个 endstream」。
 *   这样既能处理 /Length 为间接引用（解析器此刻无法解引用）的情况，
 *   又不至于在 /Length 正确时被数据里偶发的 "endstream" 误伤。
 */
export function parseIndirectObject(src: string, offset: number): ParsedIndirect {
  const p = new Parser(src, offset)
  p.skipWs()
  const num = p.readInteger()
  p.skipWs()
  const gen = p.readInteger()
  p.skipWs()
  const kw = p.readKeyword()
  if (kw !== 'obj') {
    throw new Error(`偏移 ${offset} 处不是对象头（读到 "${kw}"）`)
  }
  const value = p.parseValue()

  // 是否为流？跳过空白后在当前位置查 'stream'
  let q = p.pos
  while (q < src.length && isWhitespaceByte(src.charCodeAt(q))) q++
  if (src.startsWith('stream', q)) {
    const dict: PdfDict = value.kind === 'dict' ? value : { kind: 'dict', map: new Map() }
    q += 6 // 'stream'
    if (src.charCodeAt(q) === 0x0d) q++
    if (src.charCodeAt(q) === 0x0a) q++
    const dataStart = q
    let dataEnd = -1
    const lenObj = dict.map.get('Length')
    if (lenObj && lenObj.kind === 'number' && Number.isFinite(lenObj.value) && lenObj.value >= 0) {
      const cand = dataStart + lenObj.value
      let r = cand
      while (r < src.length && isWhitespaceByte(src.charCodeAt(r))) r++
      if (src.startsWith('endstream', r)) dataEnd = cand
    }
    if (dataEnd < 0) {
      const es = src.indexOf('endstream', dataStart)
      if (es < 0) throw new Error(`对象 ${num} 的流缺少 endstream`)
      dataEnd = es
      if (src.charCodeAt(dataEnd - 1) === 0x0a) dataEnd--
      if (src.charCodeAt(dataEnd - 1) === 0x0d) dataEnd--
    }
    const raw = latin1ToBytes(src.slice(dataStart, dataEnd))
    const endObj = src.indexOf('endobj', dataEnd)
    return {
      num,
      gen,
      value: { kind: 'stream', dict, raw },
      end: endObj < 0 ? src.length : endObj + 6
    }
  }

  const endObj = src.indexOf('endobj', p.pos)
  return { num, gen, value, end: endObj < 0 ? p.pos : endObj + 6 }
}

/* ==================== 序列化（无损） ==================== */

/** PDF 数字文本形式：整数直出；小数避免指数记法（阅读器不认 1e-7） */
export function formatPdfNumber(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (Number.isInteger(n)) return String(n)
  let s = String(n)
  if (s.includes('e') || s.includes('E')) {
    s = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
  }
  return s
}

/** 名称序列化：非规则字符与分隔符用 #XX 转义 */
export function serializeName(name: string): string {
  let out = '/'
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i) & 0xff
    if (c >= 0x21 && c <= 0x7e && !isDelimiterByte(c)) out += String.fromCharCode(c)
    else out += '#' + c.toString(16).padStart(2, '0')
  }
  return out
}

/** 字符串序列化：可打印且不含特殊字符时用字面量，否则用十六进制（都无损） */
function serializeStringBytes(bytes: Uint8Array): string {
  let literalSafe = true
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]
    if (c < 0x20 || c > 0x7e || c === 0x28 || c === 0x29 || c === 0x5c) {
      literalSafe = false
      break
    }
  }
  if (literalSafe) return '(' + latin1FromBytes(bytes) + ')'
  let out = '<'
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
  return out + '>'
}

export function serializeDict(d: PdfDict): string {
  let out = '<<'
  for (const [k, v] of d.map) {
    out += ' ' + serializeName(k) + ' ' + serializeValue(v)
  }
  out += ' >>'
  return out
}

export function serializeStream(s: PdfStream): string {
  // 流的 /Length 必须以【实际写出的字节数】为准：
  //   AES 解密/加密都会改变数据长度，沿用旧 /Length 会让阅读器读错。
  const map = new Map(s.dict.map)
  map.set('Length', pdfNumber(s.raw.length))
  return serializeDict({ kind: 'dict', map }) + '\nstream\n' + latin1FromBytes(s.raw) + '\nendstream'
}

export function serializeValue(obj: PdfObject): string {
  switch (obj.kind) {
    case 'null':
      return 'null'
    case 'bool':
      return obj.value ? 'true' : 'false'
    case 'number':
      return formatPdfNumber(obj.value)
    case 'string':
      return serializeStringBytes(obj.bytes)
    case 'name':
      return serializeName(obj.name)
    case 'ref':
      return `${obj.num} ${obj.gen} R`
    case 'array':
      return '[' + obj.items.map(serializeValue).join(' ') + ']'
    case 'dict':
      return serializeDict(obj)
    case 'stream':
      return serializeStream(obj)
  }
}
