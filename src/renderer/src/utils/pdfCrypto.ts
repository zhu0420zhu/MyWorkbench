/**
 * PDF 标准安全处理器（Standard Security Handler）的密码学原语。
 *
 * 实现依据：ISO 32000-1 §7.6.3（对应 PDF 参考手册第 3 章）。
 * 覆盖 V=1/2（RC4 40/128-bit）与 V=4（RC4 或 AES-128），即 R=2/3/4。
 *
 * 两个实现要点：
 *   1. **MD5 必须自备** —— Web Crypto 的 subtle.digest 不支持 MD5，
 *      而 PDF 的密钥派生（算法 2/3/4/5）全程依赖 MD5。
 *   2. **RC4 必须自备** —— Web Crypto 同样不提供 RC4。
 *      AES-CBC 则走 Web Crypto（硬件加速、且无需自己实现分组密码）。
 *
 * 本模块只做算法，不碰 PDF 文档结构；文档级遍历见 pdfSecurity.ts。
 */

/* ==================== MD5 ==================== */

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
]

/** K[i] = floor(2^32 * abs(sin(i+1))) */
const MD5_K = (() => {
  const k = new Uint32Array(64)
  for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0
  return k
})()

const rotl = (x: number, c: number) => ((x << c) | (x >>> (32 - c))) >>> 0

/** MD5 摘要。返回 16 字节。 */
export function md5(input: Uint8Array): Uint8Array {
  const bitLen = input.length * 8
  // padding: 0x80 后补零到 56 mod 64，再接 8 字节小端长度
  const padded = new Uint8Array((((input.length + 8) >> 6) + 1) << 6)
  padded.set(input)
  padded[input.length] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 8, bitLen >>> 0, true)
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 4294967296), true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  const M = new Uint32Array(16)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true)
    let A = a0
    let B = b0
    let C = c0
    let D = d0
    for (let i = 0; i < 64; i++) {
      let F: number
      let g: number
      if (i < 16) {
        F = (B & C) | (~B & D)
        g = i
      } else if (i < 32) {
        F = (D & B) | (~D & C)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        F = B ^ C ^ D
        g = (3 * i + 5) % 16
      } else {
        F = C ^ (B | ~D)
        g = (7 * i) % 16
      }
      F = (F + A + MD5_K[i] + M[g]) >>> 0
      A = D
      D = C
      C = B
      B = (B + rotl(F, MD5_S[i])) >>> 0
    }
    a0 = (a0 + A) >>> 0
    b0 = (b0 + B) >>> 0
    c0 = (c0 + C) >>> 0
    d0 = (d0 + D) >>> 0
  }

  const out = new Uint8Array(16)
  const odv = new DataView(out.buffer)
  odv.setUint32(0, a0, true)
  odv.setUint32(4, b0, true)
  odv.setUint32(8, c0, true)
  odv.setUint32(12, d0, true)
  return out
}

/** 把若干字节段拼接后取 MD5 */
function md5cat(...parts: Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const buf = new Uint8Array(n)
  let off = 0
  for (const p of parts) {
    buf.set(p, off)
    off += p.length
  }
  return md5(buf)
}

/* ==================== RC4 ==================== */

/** RC4 流密码。PDF 的 V=1/2 与 V=4 且 CFM=V2 时使用。 */
export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const S = new Uint8Array(256)
  for (let i = 0; i < 256; i++) S[i] = i
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 0xff
    const t = S[i]
    S[i] = S[j]
    S[j] = t
  }
  const out = new Uint8Array(data.length)
  let i = 0
  j = 0
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff
    j = (j + S[i]) & 0xff
    const t = S[i]
    S[i] = S[j]
    S[j] = t
    out[k] = data[k] ^ S[(S[i] + S[j]) & 0xff]
  }
  return out
}

/* ==================== AES-CBC（走 Web Crypto） ==================== */

function getSubtle(): SubtleCrypto {
  const c = globalThis.crypto
  if (!c?.subtle) throw new Error('当前环境不支持 Web Crypto，无法处理 AES 加密的 PDF')
  return c.subtle
}

/** AES-CBC 解密。data = IV(16) || ciphertext（PDF 的 AESV2/V3 格式） */
export async function aesCbcDecryptPdf(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 16) throw new Error('AES 数据过短，缺少 IV')
  const iv = data.subarray(0, 16)
  const ct = data.subarray(16)
  // 类型断言仅为满足新版 TS 的 BufferSource 泛型约束，不改变任何算法语义
  const ck = await getSubtle().importKey('raw', key as BufferSource, { name: 'AES-CBC' }, false, [
    'decrypt'
  ])
  const pt = await getSubtle().decrypt(
    { name: 'AES-CBC', iv: iv as BufferSource },
    ck,
    ct as BufferSource
  )
  return new Uint8Array(pt)
}

/** AES-CBC 加密。返回 IV(16) || ciphertext，即 PDF 的 AESV2 存储格式 */
export async function aesCbcEncryptPdf(key: Uint8Array, data: Uint8Array, iv?: Uint8Array): Promise<Uint8Array> {
  const useIv = iv ?? crypto.getRandomValues(new Uint8Array(16))
  if (useIv.length !== 16) throw new Error('AES IV 必须为 16 字节')
  const ck = await getSubtle().importKey('raw', key as BufferSource, { name: 'AES-CBC' }, false, [
    'encrypt'
  ])
  const ct = new Uint8Array(
    await getSubtle().encrypt({ name: 'AES-CBC', iv: useIv as BufferSource }, ck, data as BufferSource)
  )
  const out = new Uint8Array(16 + ct.length)
  out.set(useIv, 0)
  out.set(ct, 16)
  return out
}

/* ==================== PDF 标准安全处理器 ==================== */

/** ISO 32000-1 表 21 规定的 32 字节口令填充串（算法 2 第 1 步） */
export const PAD_BYTES = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a
])

/** 把口令按算法 2 的规则填充成 32 字节（超长则截断） */
export function padPassword(pwd: Uint8Array): Uint8Array {
  const out = new Uint8Array(32)
  const n = Math.min(32, pwd.length)
  out.set(pwd.subarray(0, n), 0)
  if (n < 32) out.set(PAD_BYTES.subarray(0, 32 - n), n)
  return out
}

const asciiBytes = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}
export const passwordBytes = asciiBytes

/**
 * 算法 2：由【用户口令】计算文档加密密钥。
 * 返回长度为 keyLen（= Length/8，2..16）的字节数组。
 *
 * @param encryptMetadata R=4 时的 /EncryptMetadata，为 false 时需混入 0xFFFFFFFF
 */
export function computeEncryptionKey(
  userPwd: Uint8Array,
  o: Uint8Array,
  p: number,
  id0: Uint8Array,
  revision: number,
  keyLen: number,
  encryptMetadata = true
): Uint8Array {
  const padded = padPassword(userPwd)
  const pBytes = new Uint8Array(4)
  new DataView(pBytes.buffer).setInt32(0, p | 0, true)
  const parts: Uint8Array[] = [padded, o.subarray(0, 32), pBytes, id0]
  if (revision >= 4 && !encryptMetadata) parts.push(new Uint8Array([0xff, 0xff, 0xff, 0xff]))

  let hash = md5cat(...parts)
  if (revision >= 3) {
    for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, keyLen))
  }
  return hash.subarray(0, keyLen)
}

/**
 * 算法 3：由口令计算 /O 值。
 * ownerPwd 为空时按规范退回使用 userPwd。
 */
export function computeOwnerKey(
  ownerPwd: Uint8Array,
  userPwd: Uint8Array,
  revision: number,
  keyLen: number
): Uint8Array {
  const op = padPassword(ownerPwd.length ? ownerPwd : userPwd)
  let hash = md5(op)
  if (revision >= 3) {
    for (let i = 0; i < 50; i++) hash = md5(hash)
  }
  const rc4Key = hash.subarray(0, keyLen)
  let data = padPassword(userPwd)
  if (revision === 2) return rc4(rc4Key, data)
  // R>=3：先用密钥加密一次，再用「密钥 XOR i」迭代 19 次
  data = rc4(rc4Key, data)
  for (let i = 1; i <= 19; i++) {
    const k = new Uint8Array(keyLen)
    for (let j = 0; j < keyLen; j++) k[j] = rc4Key[j] ^ i
    data = rc4(k, data)
  }
  return data
}

/**
 * 算法 4/5：计算 /U 值（32 字节）。
 * R=2 用算法 4，R>=3 用算法 5。
 */
export function computeUserKey(
  encryptionKey: Uint8Array,
  id0: Uint8Array,
  revision: number
): Uint8Array {
  if (revision === 2) return rc4(encryptionKey, PAD_BYTES)
  const hash = md5cat(PAD_BYTES, id0)
  let data = rc4(encryptionKey, hash)
  for (let i = 1; i <= 19; i++) {
    const k = new Uint8Array(encryptionKey.length)
    for (let j = 0; j < encryptionKey.length; j++) k[j] = encryptionKey[j] ^ i
    data = rc4(k, data)
  }
  // 算法 5 规定 /U 为 32 字节，后 16 字节为任意值，这里补零
  const out = new Uint8Array(32)
  out.set(data.subarray(0, 16), 0)
  return out
}

/**
 * 校验用户口令是否正确（对照 /U）。
 * R=2 比较全部 32 字节；R>=3 只比较前 16 字节（后 16 字节为任意填充）。
 */
export function verifyUserPassword(
  userPwd: Uint8Array,
  o: Uint8Array,
  u: Uint8Array,
  p: number,
  id0: Uint8Array,
  revision: number,
  keyLen: number,
  encryptMetadata = true
): Uint8Array | null {
  const key = computeEncryptionKey(userPwd, o, p, id0, revision, keyLen, encryptMetadata)
  const expect = computeUserKey(key, id0, revision)
  const cmpLen = revision === 2 ? 32 : 16
  for (let i = 0; i < cmpLen; i++) {
    if (expect[i] !== u[i]) return null
  }
  return key
}

/**
 * 算法 1：由文档加密密钥派生【单个对象】的密钥。
 *
 * 注意：即便是 AES（V4）也仍然用 RC4 时代的这套派生方式，
 * 只是最后多混入 "sAlT" 四个字节。
 */
export function objectKey(
  encryptionKey: Uint8Array,
  objNum: number,
  genNum: number,
  aes: boolean
): Uint8Array {
  const extra = new Uint8Array(aes ? 9 : 5)
  extra[0] = objNum & 0xff
  extra[1] = (objNum >> 8) & 0xff
  extra[2] = (objNum >> 16) & 0xff
  extra[3] = genNum & 0xff
  extra[4] = (genNum >> 8) & 0xff
  if (aes) {
    extra[5] = 0x73 // s
    extra[6] = 0x41 // A
    extra[7] = 0x6c // l
    extra[8] = 0x54 // T
  }
  const hash = md5cat(encryptionKey, extra)
  return hash.subarray(0, Math.min(encryptionKey.length + 5, 16))
}

/** 单个对象的加解密统一入口（加解密对称） */
export async function cryptObject(
  key: Uint8Array,
  data: Uint8Array,
  aes: boolean
): Promise<Uint8Array> {
  return aes ? await aesCbcDecryptPdf(key, data) : rc4(key, data)
}
