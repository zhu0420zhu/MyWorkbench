/**
 * PDF 文档层安全处理器：交叉引用解析、对象枚举、解密、加密、重建输出。
 *
 * 依赖关系：
 *   - pdfObjects.ts  提供对象词法 / 解析 / 序列化
 *   - pdfCrypto.ts   提供密钥派生与分组密码原语（已验证，勿改算法）
 *
 * 关键实测结论（来自 tests/pdf-audit/recon-decrypt.mjs，实现直接采信）：
 *   F1  xref 流【未加密】—— 可直接 inflate 自举
 *   F4  PNG 预测器每行带 1 字节类型前缀，行跨距 = 1 + sum(W)
 *   F5  keyLen 取 /CF/<StmF>/Length（字节，R≥4）
 *   F6  对象流【整体】加密：解密后内部对象连同字符串即为明文（勿二次解密）
 */

import {
  PDFDocument
} from 'pdf-lib'
import {
  md5,
  rc4,
  padPassword,
  passwordBytes,
  computeEncryptionKey,
  computeOwnerKey,
  computeUserKey,
  verifyUserPassword,
  objectKey,
  aesCbcDecryptPdf,
  aesCbcEncryptPdf
} from './pdfCrypto'
import {
  type PdfDict,
  type PdfObject,
  type PdfStream,
  asArray,
  asDict,
  asName,
  asNumber,
  asStream,
  asBytes,
  latin1FromBytes,
  latin1ToBytes,
  parseIndirectObject,
  parseValueAt,
  pdfNumber,
  pdfRef,
  serializeValue
} from './pdfObjects'

/* ==================== 错误类型 ==================== */

export type PdfSecurityErrorCode =
  | 'NOT_ENCRYPTED'
  | 'PASSWORD_INCORRECT'
  | 'UNSUPPORTED_CRYPTO'
  | 'MALFORMED'

/** 带机器可判定 code 的安全处理错误：便于 UI 给出「可行动」的提示 */
export class PdfSecurityError extends Error {
  readonly code: PdfSecurityErrorCode
  constructor(code: PdfSecurityErrorCode, message: string) {
    super(message)
    this.name = 'PdfSecurityError'
    this.code = code
  }
}

export const isPdfSecurityError = (e: unknown): e is PdfSecurityError =>
  e instanceof PdfSecurityError

/* ==================== 交叉引用 ==================== */

interface XrefEntry {
  /** 0 空闲 / 1 独立对象 / 2 对象流内对象 */
  type: number
  gen: number
  offset: number
  objStmNum: number
  objStmIdx: number
}

interface XrefChain {
  entries: Map<number, XrefEntry>
  trailer: PdfDict
  /** 交叉引用流自身的对象号集合（输出时须剔除，它只是索引机制） */
  xrefStreamNums: Set<number>
  /**
   * 是否走了「恢复模式」（startxref / xref 不可用，退回全长扫描）。
   * 恢复模式下结构不可全信：若又找不到 /Encrypt，不能断言「未加密」——
   * 因为损坏的加密文件（丢了尾部 trailer）也会呈现同样特征。
   */
  recovered: boolean
}

/** 合规 PDF 的 `%PDF-` 文件头须出现在前 1024 字节内 */
function hasPdfHeader(src: string): boolean {
  return src.slice(0, 1024).includes('%PDF-')
}

const WS_RE = /\s+/y
const SEG_RE = /(\d+)\s+(\d+)/y
const ENT_RE = /(\d+)\s+(\d+)\s+([nf])/y

function skipWsAt(src: string, p: number): number {
  WS_RE.lastIndex = p
  const m = WS_RE.exec(src)
  return m ? WS_RE.lastIndex : p
}

/** 跳过一个行尾（含其前的水平空白），保证逐「行」推进而不做定长切分 */
function skipEol(src: string, p: number): number {
  while (p < src.length) {
    const c = src.charCodeAt(p)
    if (c === 0x20 || c === 0x09 || c === 0x0d) p++
    else break
  }
  if (src.charCodeAt(p) === 0x0a) p++
  return p
}

function findStartxref(src: string): number {
  const tail = src.slice(Math.max(0, src.length - 4096))
  let last = -1
  for (const m of tail.matchAll(/startxref\s+(\d+)/g)) last = parseInt(m[1], 10)
  if (last >= 0) return last
  for (const m of src.matchAll(/startxref\s+(\d+)/g)) last = parseInt(m[1], 10)
  return last
}

function readField(row: Uint8Array, widths: number[], idx: number): number {
  let off = 0
  for (let i = 0; i < idx; i++) off += widths[i] ?? 0
  const w = widths[idx] ?? 0
  let v = 0
  for (let i = 0; i < w; i++) v = v * 256 + row[off + i]
  return v
}

/** 合并更早的 trailer：只在缺失时补键（新版本优先） */
function mergeTrailer(into: PdfDict, older: PdfDict): void {
  for (const [k, v] of older.map) if (!into.map.has(k)) into.map.set(k, v)
}

async function readXrefSection(
  src: string,
  offset: number,
  entries: Map<number, XrefEntry>,
  xrefStreamNums: Set<number>
): Promise<PdfDict | null> {
  const p0 = skipWsAt(src, offset)
  if (src.startsWith('xref', p0)) {
    let p = p0 + 4
    for (;;) {
      p = skipWsAt(src, p)
      if (src.startsWith('trailer', p)) {
        const r = parseValueAt(src, p + 7)
        return r.value.kind === 'dict' ? r.value : null
      }
      SEG_RE.lastIndex = p
      const hm = SEG_RE.exec(src)
      if (!hm) return null
      const start = parseInt(hm[1], 10)
      const count = parseInt(hm[2], 10)
      // 子段头 `start count` 之后是本段条目，必须跳过其后的换行
      p = skipWsAt(src, SEG_RE.lastIndex)
      for (let i = 0; i < count; i++) {
        ENT_RE.lastIndex = p
        const em = ENT_RE.exec(src)
        if (!em) break
        p = ENT_RE.lastIndex
        const num = start + i
        if (!entries.has(num)) {
          if (em[3] === 'n') {
            entries.set(num, { type: 1, gen: +em[2], offset: +em[1], objStmNum: 0, objStmIdx: 0 })
          } else {
            entries.set(num, { type: 0, gen: +em[2], offset: 0, objStmNum: 0, objStmIdx: 0 })
          }
        }
        p = skipEol(src, p)
      }
    }
  }
  return readXrefStream(src, offset, entries, xrefStreamNums)
}

async function readXrefStream(
  src: string,
  offset: number,
  entries: Map<number, XrefEntry>,
  xrefStreamNums: Set<number>
): Promise<PdfDict | null> {
  let parsed: ReturnType<typeof parseIndirectObject>
  try {
    parsed = parseIndirectObject(src, offset)
  } catch {
    return null
  }
  const st = asStream(parsed.value)
  if (!st) return null
  if (asName(st.dict.map.get('Type')) !== 'XRef') return null
  xrefStreamNums.add(parsed.num)

  const size = asNumber(st.dict.map.get('Size')) ?? 0
  const W = asArray(st.dict.map.get('W'))
  if (!W) return null
  const widths = W.items.map((it) => {
    const n = asNumber(it)
    return n !== null && n > 0 && n <= 8 ? n : 0
  })
  const cols = widths.reduce((a, b) => a + b, 0)
  if (cols <= 0) return null

  const indexObj = asArray(st.dict.map.get('Index'))
  const index = indexObj ? indexObj.items.map((it) => asNumber(it) ?? 0) : [0, size]

  const decoded = await decodeStreamData(st, cols)
  const rowCount = Math.floor(decoded.length / cols)
  let row = 0
  for (let k = 0; k + 1 < index.length; k += 2) {
    for (let j = 0; j < index[k + 1] && row < rowCount; j++, row++) {
      const r = decoded.subarray(row * cols, row * cols + cols)
      const type = widths[0] === 0 ? 1 : readField(r, widths, 0)
      const f2 = readField(r, widths, 1)
      const f3 = readField(r, widths, 2)
      const num = index[k] + j
      if (entries.has(num)) continue
      if (type === 1) {
        entries.set(num, { type: 1, gen: f3, offset: f2, objStmNum: 0, objStmIdx: 0 })
      } else if (type === 2) {
        entries.set(num, { type: 2, gen: 0, offset: 0, objStmNum: f2, objStmIdx: f3 })
      } else {
        entries.set(num, { type: 0, gen: 0, offset: 0, objStmNum: 0, objStmIdx: 0 })
      }
    }
  }
  return st.dict
}

async function readXrefChain(src: string): Promise<XrefChain> {
  const entries = new Map<number, XrefEntry>()
  const xrefStreamNums = new Set<number>()
  const visited = new Set<number>()
  let trailer: PdfDict | null = null

  let start = findStartxref(src)
  while (start >= 0 && !visited.has(start)) {
    visited.add(start)
    const sec = await readXrefSection(src, start, entries, xrefStreamNums)
    if (!sec) break
    if (!trailer) trailer = sec
    else mergeTrailer(trailer, sec)

    // 混合引用文件（Hybrid）：经典表里挂着的 /XRefStm 也要读
    const xrefStm = asNumber(sec.map.get('XRefStm'))
    if (xrefStm !== null && xrefStm >= 0 && !visited.has(xrefStm)) {
      visited.add(xrefStm)
      const sec2 = await readXrefSection(src, xrefStm, entries, xrefStreamNums)
      if (sec2) {
        if (!trailer) trailer = sec2
        else mergeTrailer(trailer, sec2)
      }
    }

    const prev = asNumber(sec.map.get('Prev'))
    start = prev !== null ? prev : -1
  }

  let recovered = false
  if (!trailer || entries.size === 0) {
    // 恢复模式：文件尾部 / xref 均不可用，退回全表扫描 `N G obj`
    const rec = recoverScan(src, entries)
    if (!rec) {
      throw new PdfSecurityError('MALFORMED', '无法解析该 PDF 的交叉引用表，文件可能已损坏')
    }
    trailer = rec
    recovered = true
  }
  return { entries, trailer, xrefStreamNums, recovered }
}

/** 全长扫描 `N G obj` 的恢复模式：容忍 startxref 丢失 / xref 损坏 */
function recoverScan(src: string, entries: Map<number, XrefEntry>): PdfDict | null {
  const re = /(\d+)\s+(\d+)\s+obj\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (m.index > 0 && /[0-9]/.test(src[m.index - 1])) continue
    const num = parseInt(m[1], 10)
    const gen = parseInt(m[2], 10)
    if (num <= 0) continue
    entries.set(num, { type: 1, gen, offset: m.index, objStmNum: 0, objStmIdx: 0 })
  }
  if (entries.size === 0) return null

  const map = new Map<string, PdfObject>()
  let maxNum = 0
  for (const [num, e] of entries) {
    if (num > maxNum) maxNum = num
    if (e.type !== 1) continue
    try {
      const p = parseIndirectObject(src, e.offset)
      if (p.num !== num) continue
      const d = asDict(p.value) ?? asStream(p.value)?.dict ?? null
      if (d && asName(d.map.get('Type')) === 'Catalog') map.set('Root', pdfRef(num, e.gen))
    } catch {
      /* 单个对象坏了不影响整体恢复 */
    }
  }
  map.set('Size', pdfNumber(maxNum + 1))

  // /Encrypt 与 /ID 在原文里是明文（F2），即便 xref 丢失也能正则命中，
  // 从而让「xref 损坏的加密文件」在恢复模式下仍可被解密。
  const em = /\/Encrypt\s+(\d+)\s+(\d+)\s+R/.exec(src)
  if (em) map.set('Encrypt', pdfRef(parseInt(em[1], 10), parseInt(em[2], 10)))
  const idm = /\/ID\s*\[\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\]/.exec(src)
  if (idm) {
    const hex = (h: string): PdfObject => ({
      kind: 'string',
      bytes: Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16))),
      hex: true
    })
    map.set('ID', { kind: 'array', items: [hex(idm[1]), hex(idm[2])] })
  }
  return { kind: 'dict', map }
}

/* ==================== 流解码（Flate + PNG 预测器） ==================== */

function filterNames(o: PdfObject | undefined): string[] {
  if (!o) return []
  if (o.kind === 'name') return [o.name]
  if (o.kind === 'array') {
    return o.items.map((it) => asName(it) ?? '').filter((s) => s.length > 0)
  }
  return []
}

/** Flate 解压。PDF 的 FlateDecode 是 zlib 封装（含 2 字节头 + 4 字节 Adler 校验）。 */
async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream
  if (typeof DS !== 'function') {
    throw new PdfSecurityError(
      'MALFORMED',
      '当前运行环境不支持 zlib 解压，无法解析对象流 / 交叉引用流'
    )
  }
  const ds = new DS('deflate')
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(ds)
  const buf = await new Response(stream).arrayBuffer()
  return new Uint8Array(buf)
}

/**
 * PNG 预测器反演（Predictor 10~15）。
 *
 * 两个必须记住的坑（实测，见 recon-decrypt.mjs）：
 *   1. 行跨距 = 1 + columns（每行首字节是过滤器类型），不是 columns；
 *      少数实现不写前缀，故先按「含前缀」判断，不整除再退化。
 *   2. Up(2) 的基准必须是【已还原的上一行】；用原始上一行是经典错误。
 */
function undoPredictor(data: Uint8Array, predictor: number, columns: number): Uint8Array {
  if (predictor <= 1) return data
  if (predictor === 2) {
    // TIFF 预测器：按列做水平累加（8 位样本）。PDF 里罕见，仅作兜底。
    const rows = Math.floor(data.length / columns)
    const out = new Uint8Array(data.length)
    for (let r = 0; r < rows; r++) {
      const base = r * columns
      let prev = 0
      for (let c = 0; c < columns; c++) {
        const v = (data[base + c] + prev) & 0xff
        out[base + c] = v
        prev = v
      }
    }
    return out
  }

  const stride = columns + 1
  const prefixed = data.length % stride === 0
  if (!prefixed && data.length % columns !== 0) return data // 无法整除：原样返回，交由上层报错而非静默毁数据
  const rowLen = prefixed ? stride : columns
  const rowCount = Math.floor(data.length / rowLen)
  const out = new Uint8Array(rowCount * columns)
  let prev = new Uint8Array(columns)
  for (let r = 0; r < rowCount; r++) {
    const off = r * rowLen
    const ft = prefixed ? data[off] : 2
    const srcOff = off + (prefixed ? 1 : 0)
    const cur = new Uint8Array(columns)
    for (let c = 0; c < columns; c++) {
      const raw = data[srcOff + c]
      const a = c > 0 ? cur[c - 1] : 0
      const b = prev[c]
      const cc = c > 0 ? prev[c - 1] : 0
      let v: number
      switch (ft) {
        case 0:
          v = raw
          break
        case 1:
          v = raw + a
          break
        case 2:
          v = raw + b
          break
        case 3:
          v = raw + ((a + b) >> 1)
          break
        case 4: {
          const p = a + b - cc
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - cc)
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc
          v = raw + pr
          break
        }
        default:
          v = raw
      }
      cur[c] = v & 0xff
    }
    out.set(cur, r * columns)
    prev = cur
  }
  return out
}

/** 解开流的 /Filter（Flate）+ /DecodeParms（预测器）。columnsHint 供无 Columns 时兜底。 */
async function decodeStreamData(st: PdfStream, columnsHint?: number): Promise<Uint8Array> {
  let data = st.raw
  const filters = filterNames(st.dict.map.get('Filter'))
  if (filters.length > 1) {
    throw new PdfSecurityError('MALFORMED', `暂不支持的过滤器链：${filters.join(' → ')}`)
  }
  if (filters.length === 1) {
    if (filters[0] === 'FlateDecode' || filters[0] === 'Fl') data = await inflateZlib(data)
    else if (filters[0] === 'None') {
      /* 无压缩 */
    } else {
      throw new PdfSecurityError('MALFORMED', `暂不支持的流过滤器：${filters[0]}`)
    }
  }

  const parms = st.dict.map.get('DecodeParms')
  const arrFirst = asArray(parms)?.items[0]
  const parmsDict = asDict(parms) ?? (arrFirst ? asDict(arrFirst) : null)
  const predictor = parmsDict ? asNumber(parmsDict.map.get('Predictor')) ?? 1 : 1
  const parmsCols = parmsDict ? asNumber(parmsDict.map.get('Columns')) : null
  const columns = parmsCols !== null && parmsCols > 0 ? parmsCols : columnsHint ?? 1
  if (predictor > 1) data = undoPredictor(data, predictor, columns)
  return data
}

/* ==================== /Encrypt 参数 ==================== */

interface EncryptionParams {
  filter: string | null
  v: number
  r: number
  keyLen: number
  p: number
  o: Uint8Array
  u: Uint8Array
  id0: Uint8Array | null
  encryptMetadata: boolean
  cfm: string
  aes: boolean
  supported: boolean
  algorithm: string
  reason?: string
}

function resolveEncryptDict(
  src: string,
  chain: XrefChain
): { dict: PdfDict; num: number } | null {
  const enc = chain.trailer.map.get('Encrypt')
  if (!enc) return null
  if (enc.kind === 'dict') return { dict: enc, num: -1 }
  if (enc.kind !== 'ref') return null

  const rec = chain.entries.get(enc.num)
  if (rec && rec.type === 1) {
    try {
      const p = parseIndirectObject(src, rec.offset)
      const d = asDict(p.value)
      if (d) return { dict: d, num: enc.num }
    } catch {
      /* 落到全文兜底 */
    }
  }
  const re = new RegExp(`(?<![0-9])${enc.num}\\s+${enc.gen}\\s+obj`)
  const m = re.exec(src)
  if (m) {
    try {
      const p = parseIndirectObject(src, m.index)
      const d = asDict(p.value)
      if (d) return { dict: d, num: enc.num }
    } catch {
      /* ignore */
    }
  }
  return null
}

function trailerId0(trailer: PdfDict): Uint8Array | null {
  const id = asArray(trailer.map.get('ID'))
  if (!id || id.items.length === 0) return null
  return asBytes(id.items[0])
}

function parseEncryptionParams(dict: PdfDict, id0: Uint8Array | null): EncryptionParams {
  const filter = asName(dict.map.get('Filter'))
  const v = asNumber(dict.map.get('V')) ?? 0
  const r = asNumber(dict.map.get('R')) ?? 0
  const topLen = asNumber(dict.map.get('Length'))
  const p = asNumber(dict.map.get('P')) ?? -1
  const o = asBytes(dict.map.get('O')) ?? new Uint8Array(32)
  const u = asBytes(dict.map.get('U')) ?? new Uint8Array(32)
  const metaObj = dict.map.get('EncryptMetadata')
  const encryptMetadata = !(metaObj && metaObj.kind === 'bool' && metaObj.value === false)

  const cf = asDict(dict.map.get('CF'))
  const stmF = asName(dict.map.get('StmF')) ?? 'Identity'

  let cfm = 'V2' // 默认即 RC4
  let cfLen: number | null = null
  if (v >= 4 && cf && stmF !== 'Identity') {
    const f = asDict(cf.map.get(stmF))
    if (f) {
      const raw = asName(f.map.get('CFM'))
      if (raw) cfm = raw
      cfLen = asNumber(f.map.get('Length'))
    }
  }
  if (v < 4) cfm = 'V2'
  const aes = cfm === 'AESV2'

  // keyLen：R=2 固定 5 字节；R=3 取顶层 /Length（位）；R≥4 取 /CF 的 /Length（字节，见 F5）
  let keyLen: number
  if (r === 2) keyLen = 5
  else if (r === 3) keyLen = Math.max(5, Math.min(16, Math.floor((topLen ?? 128) / 8)))
  else keyLen = Math.max(5, Math.min(16, cfLen ?? Math.floor((topLen ?? 128) / 8)))

  let supported = true
  let algorithm: string
  let reason: string | undefined
  if (filter && filter !== 'Standard') {
    supported = false
    algorithm = 'Public-Key'
    reason = '该文件使用公钥加密（/Filter ' + filter + '），当前版本暂不支持'
  } else if (v >= 5 || r >= 5 || cfm === 'AESV3' || cfm === 'AESV4') {
    supported = false
    algorithm = 'AES-256'
    reason = '该文件使用 AES-256 加密，当前版本暂不支持'
  } else if (cfm !== 'V2' && cfm !== 'AESV2') {
    supported = false
    algorithm = cfm
    reason = '不支持的加密算法：' + cfm
  } else {
    algorithm = aes ? 'AES-128' : r === 2 ? 'RC4 40-bit' : 'RC4 128-bit'
  }

  return {
    filter,
    v,
    r,
    keyLen,
    p,
    o,
    u,
    id0,
    encryptMetadata,
    cfm,
    aes,
    supported,
    algorithm,
    reason
  }
}

/* ==================== 密钥派生 ==================== */

/**
 * 算法 3 的逆：用【所有者口令】还原出「用户口令的填充串」。
 * 这是「用所有者口令打开文件」的关键 —— 规范里 /O 就是对用户填充串的可逆加密。
 */
function recoverUserPadding(
  ownerPwd: Uint8Array,
  o: Uint8Array,
  revision: number,
  keyLen: number
): Uint8Array {
  let h = md5(padPassword(ownerPwd))
  if (revision >= 3) for (let i = 0; i < 50; i++) h = md5(h)
  const rc4Key = h.subarray(0, keyLen)
  if (revision === 2) return rc4(rc4Key, o)
  let data = o
  for (let i = 19; i >= 1; i--) {
    const k = new Uint8Array(keyLen)
    for (let j = 0; j < keyLen; j++) k[j] = rc4Key[j] ^ i
    data = rc4(k, data)
  }
  return rc4(rc4Key, data)
}

/**
 * 由口令求文档加密密钥。
 * 单口令框策略：先当用户口令试；失败再走「所有者口令路径」，二者都失败才报错。
 */
function deriveFileKey(params: EncryptionParams, password: string): Uint8Array {
  const pwd = passwordBytes(password)
  const id0 = params.id0 ?? new Uint8Array(0)

  const direct = verifyUserPassword(
    pwd,
    params.o,
    params.u,
    params.p,
    id0,
    params.r,
    params.keyLen,
    params.encryptMetadata
  )
  if (direct) return direct

  const userPad = recoverUserPadding(pwd, params.o, params.r, params.keyLen)
  const viaOwner = verifyUserPassword(
    userPad,
    params.o,
    params.u,
    params.p,
    id0,
    params.r,
    params.keyLen,
    params.encryptMetadata
  )
  if (viaOwner) return viaOwner

  throw new PdfSecurityError('PASSWORD_INCORRECT', '口令不正确，请确认后重试')
}

/* ==================== 单对象加解密 ==================== */

interface ObjEntry {
  gen: number
  obj: PdfObject
}

async function cryptBytes(
  params: EncryptionParams,
  fileKey: Uint8Array,
  num: number,
  gen: number,
  data: Uint8Array,
  encrypt: boolean
): Promise<Uint8Array> {
  const key = objectKey(fileKey, num, gen, params.aes)
  if (params.aes) {
    return encrypt ? aesCbcEncryptPdf(key, data) : aesCbcDecryptPdf(key, data)
  }
  return rc4(key, data)
}

async function transformValue(
  v: PdfObject,
  params: EncryptionParams,
  fileKey: Uint8Array,
  num: number,
  gen: number,
  encrypt: boolean
): Promise<PdfObject> {
  switch (v.kind) {
    case 'string':
      return { kind: 'string', bytes: await cryptBytes(params, fileKey, num, gen, v.bytes, encrypt), hex: true }
    case 'array': {
      const items: PdfObject[] = []
      for (const it of v.items) items.push(await transformValue(it, params, fileKey, num, gen, encrypt))
      return { kind: 'array', items }
    }
    case 'dict': {
      const map = new Map<string, PdfObject>()
      for (const [k, val] of v.map) map.set(k, await transformValue(val, params, fileKey, num, gen, encrypt))
      return { kind: 'dict', map }
    }
    default:
      return v
  }
}

/**
 * 解密单个对象（字符串 + 流）。
 * 注意：EncryptMetadata=false 时，/Type /Metadata 的流本身不加密，必须跳过，否则会被解坏。
 */
async function decryptObject(
  obj: PdfObject,
  params: EncryptionParams,
  fileKey: Uint8Array,
  num: number,
  gen: number
): Promise<PdfObject> {
  if (obj.kind === 'stream') {
    const dict = (await transformValue(obj.dict, params, fileKey, num, gen, false)) as PdfDict
    const isMetadata = asName(dict.map.get('Type')) === 'Metadata'
    let raw = obj.raw
    if (!(isMetadata && !params.encryptMetadata)) {
      raw = await cryptBytes(params, fileKey, num, gen, obj.raw, false)
    }
    return { kind: 'stream', dict, raw }
  }
  return transformValue(obj, params, fileKey, num, gen, false)
}

/** 加密单个对象（字符串 + 流），对象密钥带 sAlT（AES 分支） */
async function encryptObject(
  obj: PdfObject,
  params: EncryptionParams,
  fileKey: Uint8Array,
  num: number,
  gen: number
): Promise<PdfObject> {
  if (obj.kind === 'stream') {
    const dict = (await transformValue(obj.dict, params, fileKey, num, gen, true)) as PdfDict
    const raw = await cryptBytes(params, fileKey, num, gen, obj.raw, true)
    return { kind: 'stream', dict, raw }
  }
  return transformValue(obj, params, fileKey, num, gen, true)
}

/* ==================== 对象枚举 ==================== */

const isXrefStreamObj = (o: PdfObject): boolean =>
  o.kind === 'stream' && asName(o.dict.map.get('Type')) === 'XRef'
const isObjStmObj = (o: PdfObject): boolean =>
  o.kind === 'stream' && asName(o.dict.map.get('Type')) === 'ObjStm'

/** 枚举文档全部对象：展开对象流、解密顶层对象（对象流内已明文，勿二次解密 —— 坑 2） */
async function collectDecryptedObjects(
  src: string,
  chain: XrefChain,
  params: EncryptionParams,
  fileKey: Uint8Array,
  encryptObjNum: number
): Promise<Map<number, ObjEntry>> {
  const result = new Map<number, ObjEntry>()
  const parsedType1 = new Map<number, ObjEntry>()
  const type1: Array<[number, XrefEntry]> = []
  const type2: Array<[number, XrefEntry]> = []

  for (const [num, e] of chain.entries) {
    if (e.type === 1) type1.push([num, e])
    else if (e.type === 2) type2.push([num, e])
  }

  for (const [num, e] of type1) {
    if (chain.xrefStreamNums.has(num)) continue
    try {
      const parsed = parseIndirectObject(src, e.offset)
      parsedType1.set(num, { gen: parsed.gen, obj: parsed.value })
    } catch {
      /* 坏对象跳过，不影响其它 */
    }
  }

  // 对象流：整体用【对象流自身的对象号】解密，内部对象连同字符串已是明文。
  // 除了 xref 明确标注 type=2 的，还要把顶层对象里所有 /Type /ObjStm 一并展开 ——
  // 这样在「恢复模式」（xref 丢失、只有 N G obj 扫描结果）下也能完整还原。
  const objStmNums = new Set<number>()
  for (const [, e] of type2) objStmNums.add(e.objStmNum)
  for (const [num, rec] of parsedType1) if (isObjStmObj(rec.obj)) objStmNums.add(num)

  for (const sn of objStmNums) {
    const rec = parsedType1.get(sn)
    if (!rec || rec.obj.kind !== 'stream') continue
    let plain: Uint8Array
    try {
      plain = await cryptBytes(params, fileKey, sn, rec.gen, rec.obj.raw, false)
    } catch {
      continue
    }
    // 用解密后的明文替换流，再走通用解码（Flate + 预测器）
    const rebuilt: PdfStream = { kind: 'stream', dict: rec.obj.dict, raw: plain }
    let body: Uint8Array
    try {
      body = await decodeStreamData(rebuilt)
    } catch {
      continue
    }
    const text = latin1FromBytes(body)
    const first = asNumber(rec.obj.dict.map.get('First')) ?? 0
    const n = asNumber(rec.obj.dict.map.get('N')) ?? 0
    const header = text
      .slice(0, first)
      .trim()
      .split(/\s+/)
      .map(Number)
    for (let i = 0; i < n && i * 2 + 1 < header.length; i++) {
      const onum = header[i * 2]
      const ooff = header[i * 2 + 1]
      if (!Number.isFinite(onum) || !Number.isFinite(ooff)) continue
      try {
        const p = parseValueAt(text, first + ooff)
        if (!result.has(onum)) result.set(onum, { gen: 0, obj: p.value })
      } catch {
        /* skip */
      }
    }
  }

  // 顶层对象（覆盖对象流内同号对象；剔除 xref 流、对象流、/Encrypt）
  const needDecrypt: number[] = []
  for (const [num, rec] of parsedType1) {
    if (num === encryptObjNum) continue
    if (isXrefStreamObj(rec.obj) || isObjStmObj(rec.obj)) continue
    result.set(num, rec)
    needDecrypt.push(num)
  }

  for (const num of needDecrypt) {
    const rec = result.get(num)
    if (!rec) continue
    rec.obj = await decryptObject(rec.obj, params, fileKey, num, rec.gen)
  }
  return result
}

/* ==================== 文件重建 ==================== */

const pad10 = (n: number): string => String(n).padStart(10, '0')
const pad5 = (n: number): string => String(n).padStart(5, '0')

/** 写经典 xref 表 + trailer：兼容性最好，任意阅读器都能打开 */
function writeClassicPdf(
  objects: Map<number, ObjEntry>,
  trailerMap: Map<string, PdfObject>,
  size: number
): Uint8Array {
  const chunks: string[] = []
  let offset = 0
  const push = (s: string): void => {
    chunks.push(s)
    offset += s.length // latin1 下，1 字符 = 1 字节
  }

  push('%PDF-1.7\n')
  // 二进制标记注释：告知传输层这是二进制文件
  push('%\u00e2\u00e3\u00cf\u00d3\n')

  const xref: string[] = []
  xref[0] = '0000000000 65535 f\r\n'
  for (let num = 1; num < size; num++) {
    const rec = objects.get(num)
    if (rec) {
      xref[num] = `${pad10(offset)} ${pad5(rec.gen)} n\r\n`
      push(`${num} ${rec.gen} obj\n${serializeValue(rec.obj)}\nendobj\n`)
    } else {
      xref[num] = '0000000000 65535 f\r\n'
    }
  }

  const xrefOffset = offset
  push('xref\n')
  push(`0 ${size}\n`)
  for (let i = 0; i < size; i++) push(xref[i] ?? '0000000000 65535 f\r\n')
  push('trailer\n')
  push(serializeValue({ kind: 'dict', map: trailerMap }))
  push(`\nstartxref\n${xrefOffset}\n%%EOF\n`)

  return latin1ToBytes(chunks.join(''))
}

/** 从 xref 流字典派生的 trailer 会夹带流自身键，重建时必须剔除 */
const STREAM_ONLY_KEYS = ['Prev', 'XRefStm', 'Type', 'W', 'Index', 'Length', 'Filter', 'DecodeParms']

/* ==================== 对外：解密 ==================== */

/** 读数解码后的对象里，把可能的顶层对象都写回去（保持对象号，供引用解析） */
function collectAllTopLevel(
  src: string,
  chain: XrefChain
): Map<number, ObjEntry> {
  const out = new Map<number, ObjEntry>()
  for (const [num, e] of chain.entries) {
    if (e.type !== 1) continue
    if (chain.xrefStreamNums.has(num)) continue
    try {
      const p = parseIndirectObject(src, e.offset)
      out.set(num, { gen: p.gen, obj: p.value })
    } catch {
      /* skip */
    }
  }
  return out
}

/**
 * 解密 PDF。
 * 产出：干净的、可被任意阅读器打开的无密码副本
 *   —— 所有对象展开为顶层对象，写经典 xref 表 + trailer，移除 /Encrypt，保留 /Root /Info /ID。
 *   —— 流只解密不解压：解密后仍是 Flate(明文)，/Filter 原样保留（体积不涨）；
 *      AES 会缩短数据，序列化时按实际字节重写 /Length。
 */
export async function decryptPdf(data: Uint8Array, password: string): Promise<Uint8Array> {
  const src = latin1FromBytes(data)
  if (!hasPdfHeader(src)) {
    throw new PdfSecurityError('MALFORMED', '不是有效的 PDF 文件（缺少 %PDF- 文件头）')
  }
  const chain = await readXrefChain(src)

  const resolved = resolveEncryptDict(src, chain)
  if (!resolved) {
    // 关键区分：结构不可信（恢复模式）时不得断言「未加密」——
    // 截断的加密文件会丢掉尾部 trailer（/Encrypt 引用所在），特征与真正未加密一致。
    if (chain.recovered) {
      throw new PdfSecurityError(
        'MALFORMED',
        'PDF 结构损坏（交叉引用表不可用），无法确认是否加密'
      )
    }
    throw new PdfSecurityError('NOT_ENCRYPTED', '该文件未加密，无需解密')
  }
  const params = parseEncryptionParams(resolved.dict, trailerId0(chain.trailer))
  if (!params.supported) {
    throw new PdfSecurityError('UNSUPPORTED_CRYPTO', params.reason ?? '不支持的加密方式')
  }

  const fileKey = deriveFileKey(params, password)
  const objects = await collectDecryptedObjects(
    src,
    chain,
    params,
    fileKey,
    resolved.num
  )

  // 计算输出 /Size
  let maxNum = 0
  for (const num of objects.keys()) if (num > maxNum) maxNum = num
  const sizeFromTrailer = asNumber(chain.trailer.map.get('Size')) ?? 0
  const size = Math.max(maxNum + 1, sizeFromTrailer, 1)

  const outTrailer = new Map(chain.trailer.map)
  for (const k of STREAM_ONLY_KEYS) outTrailer.delete(k)
  outTrailer.delete('Encrypt')
  outTrailer.set('Size', pdfNumber(size))

  return writeClassicPdf(objects, outTrailer, size)
}

/* ==================== 对外：加密（AES-128 / V=4 / R=4） ==================== */

export interface EncryptOptions {
  userPassword: string
  /** 所有者口令（可选）。为空时按规范退回用户口令。 */
  ownerPassword?: string
}

/** 默认权限位：允许打印与无障碍，禁止改内容 / 注释 / 表单 / 提取 */
const DEFAULT_PERMISSIONS = -3904

/**
 * 加密 PDF（AES-128 / V=4 / R=4）。
 * 输入先用 pdf-lib 规范化（经典 xref、无对象流），再由本模块逐对象加密并写出 /Encrypt。
 * 注：pdf-lib 没有写 /Encrypt 的能力，字节流完全由本模块生成。
 */
export async function encryptPdf(data: Uint8Array, opts: EncryptOptions): Promise<Uint8Array> {
  if (await isPdfEncrypted(data)) {
    throw new PdfSecurityError('MALFORMED', '输入文件已加密，请先解密为无密码副本再重新加密')
  }

  const doc = await PDFDocument.load(data, { ignoreEncryption: true })
  const normalized = await doc.save({ useObjectStreams: false })
  const src = latin1FromBytes(normalized)
  const chain = await readXrefChain(src)

  const keyLen = 16
  const R = 4
  const V = 4
  const P = DEFAULT_PERMISSIONS
  const id0 = crypto.getRandomValues(new Uint8Array(16))

  const userPwd = passwordBytes(opts.userPassword ?? '')
  const ownerPwd = passwordBytes(
    opts.ownerPassword && opts.ownerPassword.length ? opts.ownerPassword : opts.userPassword ?? ''
  )
  const O = computeOwnerKey(ownerPwd, userPwd, R, keyLen)
  const fileKey = computeEncryptionKey(userPwd, O, P, id0, R, keyLen, true)
  const U = computeUserKey(fileKey, id0, R)

  const params: EncryptionParams = {
    filter: 'Standard',
    v: V,
    r: R,
    keyLen,
    p: P,
    o: O,
    u: U,
    id0,
    encryptMetadata: true,
    cfm: 'AESV2',
    aes: true,
    supported: true,
    algorithm: 'AES-128'
  }

  // 枚举顶层对象（规范化的结果是经典结构，无对象流 / xref 流）
  const objects = collectAllTopLevel(src, chain)
  let maxNum = 0
  for (const num of objects.keys()) if (num > maxNum) maxNum = num

  // /Encrypt 字典作为新增对象写入
  const sizeFromTrailer = asNumber(chain.trailer.map.get('Size')) ?? 0
  const encNum = Math.max(maxNum + 1, sizeFromTrailer)
  const size = encNum + 1

  for (const [num, rec] of objects) {
    rec.obj = await encryptObject(rec.obj, params, fileKey, num, rec.gen)
  }

  const encDict: PdfDict = {
    kind: 'dict',
    map: new Map<string, PdfObject>([
      ['Filter', { kind: 'name', name: 'Standard' }],
      ['V', pdfNumber(V)],
      ['R', pdfNumber(R)],
      ['Length', pdfNumber(keyLen * 8)],
      [
        'CF',
        {
          kind: 'dict',
          map: new Map<string, PdfObject>([
            [
              'StdCF',
              {
                kind: 'dict',
                map: new Map<string, PdfObject>([
                  ['CFM', { kind: 'name', name: 'AESV2' }],
                  ['Length', pdfNumber(keyLen)],
                  ['AuthEvent', { kind: 'name', name: 'DocOpen' }]
                ])
              }
            ]
          ])
        }
      ],
      ['StmF', { kind: 'name', name: 'StdCF' }],
      ['StrF', { kind: 'name', name: 'StdCF' }],
      ['O', { kind: 'string', bytes: O, hex: true }],
      ['U', { kind: 'string', bytes: U, hex: true }],
      ['P', pdfNumber(P)],
      ['EncryptMetadata', { kind: 'bool', value: true }]
    ])
  }
  objects.set(encNum, { gen: 0, obj: encDict })

  const outTrailer = new Map(chain.trailer.map)
  for (const k of STREAM_ONLY_KEYS) outTrailer.delete(k)
  outTrailer.delete('Encrypt')
  outTrailer.set('Size', pdfNumber(size))
  outTrailer.set('Encrypt', pdfRef(encNum, 0))
  // 加密文件必须带 /ID，且加密算式中用到 id0
  outTrailer.set('ID', {
    kind: 'array',
    items: [
      { kind: 'string', bytes: id0, hex: true },
      { kind: 'string', bytes: id0, hex: true }
    ]
  })
  // 目录对象必须存在（规范化输出一定有 /Root）
  if (!outTrailer.has('Root') && !chain.trailer.map.get('Root')) {
    throw new PdfSecurityError('MALFORMED', 'PDF 缺少 /Root，无法加密')
  }

  return writeClassicPdf(objects, outTrailer, size)
}

/* ==================== 对外：状态探测 ==================== */

export interface PdfSecurityInfo {
  encrypted: boolean
  supported: boolean
  algorithm: string
  revision: number | null
  keyBytes: number | null
  reason?: string
}

export async function isPdfEncrypted(data: Uint8Array): Promise<boolean> {
  const src = latin1FromBytes(data)
  try {
    const chain = await readXrefChain(src)
    return chain.trailer.map.has('Encrypt')
  } catch {
    return /\/Encrypt\s*(\d+\s+\d+\s+R|<<)/.test(src)
  }
}

/** 供 UI 如实展示能力边界：能不能解、是什么算法 */
export async function describePdfSecurity(data: Uint8Array): Promise<PdfSecurityInfo> {
  const src = latin1FromBytes(data)
  if (!hasPdfHeader(src)) {
    return {
      encrypted: false,
      supported: false,
      algorithm: '未知',
      revision: null,
      keyBytes: null,
      reason: '不是有效的 PDF 文件（缺少 %PDF- 文件头）'
    }
  }
  let chain: XrefChain
  try {
    chain = await readXrefChain(src)
  } catch {
    return {
      encrypted: false,
      supported: false,
      algorithm: '未知',
      revision: null,
      keyBytes: null,
      reason: '无法解析该 PDF 的结构，文件可能已损坏'
    }
  }
  const resolved = resolveEncryptDict(src, chain)
  if (!resolved) {
    // 恢复模式下结构不可信：不能断言「未加密」
    if (chain.recovered) {
      return {
        encrypted: false,
        supported: false,
        algorithm: '未知',
        revision: null,
        keyBytes: null,
        reason: 'PDF 结构损坏，无法确认加密状态'
      }
    }
    return { encrypted: false, supported: true, algorithm: '未加密', revision: null, keyBytes: null }
  }
  const params = parseEncryptionParams(resolved.dict, trailerId0(chain.trailer))
  return {
    encrypted: true,
    supported: params.supported,
    algorithm: params.algorithm,
    revision: params.r,
    keyBytes: params.keyLen,
    reason: params.reason
  }
}
