/**
 * 解密实现前的侦察 —— 用已验证的 pdfCrypto.ts 去打真实加密文件，
 * 把「靠记忆」的规范细节变成实测事实。
 *
 * 已确认的结论（本脚本会持续复现它们，作为实现前的回归基线）：
 *   Q1 ✅ xref 流【未加密】，且 /Length 与实际流字节数一致 → 可自举
 *   Q2 ✅ /Encrypt 与 /ID 明文可读
 *   Q3 ✅ 我们的密钥派生在 pikepdf 真实文件上全部算对（含 EncryptMetadata 变量分支）
 *   Q5 ✅ keyLen 取 /StdCF /Length（字节）；R=2 固定 5；顶层 /Length 是「位」
 *
 * 本脚本重点回答 Q4：
 *   Q4. 对象流（ObjStm）的流数据用哪个对象号派生密钥？解出来是否直接是明文对象？
 *       对象流内的字符串是否【再】加密一次？
 *
 * 以及实测一个容易踩的坑：
 *   ⚠ PNG 预测器（Predictor 12）真实文件【每行带 1 字节预测器类型前缀】，
 *     所以行跨距 = 1 + sum(W)，不是 sum(W)。
 *     规范只在 Predictor 15 明确要求该前缀，但 qpdf/Acrobat/pdf.js 对 10~15 都这么写。
 */
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  md5,
  rc4,
  padPassword,
  verifyUserPassword,
  objectKey,
  aesCbcDecryptPdf,
  passwordBytes
} from '../../src/renderer/src/utils/pdfCrypto.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIR = join(HERE, 'fixtures', 'encrypted')
const USER_PWD = 'LingmoAuditPass123'
const OWNER_PWD = 'OwnerPass456'

const hex = (b, n = 32) => [...b.slice(0, n)].map((x) => x.toString(16).padStart(2, '0')).join(' ')

/* ---------- 极简对象解析（仅侦察用） ---------- */
function balancedDict(raw, start) {
  let depth = 0
  let i = start
  while (i < raw.length - 1) {
    if (raw[i] === '<' && raw[i + 1] === '<') {
      depth++
      i += 2
      continue
    }
    if (raw[i] === '>' && raw[i + 1] === '>') {
      depth--
      i += 2
      if (depth === 0) return { text: raw.slice(start, i), end: i }
      continue
    }
    i++
  }
  throw new Error('字典不闭合')
}
const intOf = (d, k) => {
  const m = d.match(new RegExp('/' + k + '\\s+(-?\\d+)'))
  return m ? parseInt(m[1], 10) : null
}
const nameOf = (d, k) => {
  const m = d.match(new RegExp('/' + k + '\\s*/([^\\s/\\]>)]+)'))
  return m ? m[1] : null
}
const intArrayOf = (d, k) => {
  const m = d.match(new RegExp('/' + k + '\\s*\\[([^\\]]*)\\]'))
  if (!m) return null
  return m[1].trim().split(/\s+/).filter(Boolean).map(Number)
}
const hexStringOf = (d, k) => {
  const m = d.match(new RegExp('/' + k + '\\s*<([0-9A-Fa-f\\s]*)>'))
  if (!m) return null
  const h = m[1].replace(/\s+/g, '')
  if (h.length % 2) return null
  return new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)))
}

/** 从字典结束处取出流原始字节（含 /Length 声明校验） */
function streamBytes(raw, dictEnd, declaredLength) {
  const sm = raw.slice(dictEnd, dictEnd + 40).match(/stream\r?\n/)
  if (!sm) return null
  const start = dictEnd + sm.index + sm[0].length
  const end = raw.indexOf('endstream', start)
  if (end < 0) return null
  let e = end
  if (raw[e - 1] === '\n') e--
  if (raw[e - 1] === '\r') e--
  return {
    start, end: e,
    bytes: Buffer.from(raw.slice(start, e), 'latin1'),
    lengthMatches: declaredLength === null || declaredLength === e - start
  }
}

/**
 * PNG 预测器反演。stride = 1 + columns（每行 1 字节过滤器类型前缀）。
 * Up(2) 的基准必须是【已还原的上一行】，用原始上一行是经典错误。
 */
function decodePngPredictor(data, columns) {
  const stride = columns + 1
  if (data.length % stride !== 0) {
    // 少数实现不写前缀字节，退化为无前缀
    if (data.length % columns === 0) {
      const rows = []
      let prev = new Uint8Array(columns)
      for (let o = 0; o < data.length; o += columns) {
        const cur = data.subarray(o, o + columns)
        const out = new Uint8Array(columns)
        for (let c = 0; c < columns; c++) out[c] = (cur[c] + prev[c]) & 0xff
        rows.push(out)
        prev = out
      }
      return { rows, prefixed: false }
    }
    throw new Error('预测器行跨距不整除：len=' + data.length + ' columns=' + columns)
  }
  const rows = []
  let prev = new Uint8Array(columns)
  for (let o = 0; o < data.length; o += stride) {
    const ft = data[o]
    const cur = data.subarray(o + 1, o + stride)
    const out = new Uint8Array(columns)
    for (let c = 0; c < columns; c++) {
      const a = c > 0 ? out[c - 1] : 0
      const b = prev[c]
      const cc = c > 0 ? prev[c - 1] : 0
      switch (ft) {
        case 0: out[c] = cur[c]; break
        case 1: out[c] = (cur[c] + a) & 0xff; break
        case 2: out[c] = (cur[c] + b) & 0xff; break
        case 3: out[c] = (cur[c] + ((a + b) >> 1)) & 0xff; break
        case 4: {
          const p = a + b - cc
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - cc)
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc
          out[c] = (cur[c] + pr) & 0xff
          break
        }
        default: throw new Error('未知 PNG 过滤器类型 ' + ft)
      }
    }
    rows.push(out)
    prev = out
  }
  return { rows, prefixed: true }
}

function readField(row, W, idx) {
  let o = 0
  for (let i = 0; i < idx; i++) o += W[i]
  let v = 0
  for (let i = 0; i < W[idx]; i++) v = v * 256 + row[o + i]
  return v
}

/* ---------- 主流程 ---------- */
console.log('='.repeat(78))
console.log('解密实现前置侦察（含 Q4：对象流）')
console.log('='.repeat(78))

const FILES = [
  'rc4-40-r2.pdf', 'rc4-128-r3.pdf', 'rc4-128-r4.pdf',
  'aes128-r4.pdf', 'aes128-r4-nometa.pdf', 'aes256-r6.pdf'
]

for (const f of FILES) {
  console.log('\n' + '═'.repeat(78))
  console.log('■ ' + f)
  console.log('═'.repeat(78))
  const raw = readFileSync(join(DIR, f)).toString('latin1')

  /* --- /Encrypt + /ID --- */
  const encM = raw.match(/\/Encrypt\s+(\d+)\s+(\d+)\s+R/)
  const idM = raw.match(/\/ID\s*\[\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\]/)
  if (!encM || !idM) {
    console.log('⚠ 缺 /Encrypt 或 /ID，跳过')
    continue
  }
  const encNum = +encM[1]
  const encObj = raw.match(new RegExp('(?<![0-9])' + encNum + '\\s+0\\s+obj'))
  const encDict = balancedDict(raw, raw.indexOf('<<', encObj.index + encObj[0].length)).text
  const flat = encDict.replace(/\s+/g, ' ')
  const V = intOf(encDict, 'V')
  const R = intOf(encDict, 'R')
  const topLen = intOf(encDict, 'Length')
  const P = intOf(encDict, 'P')
  const cfmM = flat.match(/\/CFM\s*\/(\w+)/)
  const stdCfm = cfmM ? cfmM[1] : null
  const stdCfLenM = flat.match(/\/StdCF\s*<<[^>]*\/Length\s+(\d+)/)
  const meta = !/\/EncryptMetadata\s+false/.test(encDict)
  const O = hexStringOf(encDict, 'O')
  const U = hexStringOf(encDict, 'U')
  const id0 = new Uint8Array(idM[1].match(/../g).map((x) => parseInt(x, 16)))

  const keyLen = R === 2 ? 5 : stdCfLenM ? +stdCfLenM[1] : Math.floor(topLen / 8)
  const aes = !!(stdCfm && stdCfm.startsWith('AES'))
  console.log('V=' + V + ' R=' + R + ' CFM=' + (stdCfm || '(无)') + ' keyLen=' + keyLen +
    ' EncryptMetadata=' + meta + '  → 算法: ' + (aes ? 'AES-CBC' : 'RC4'))

  /* --- Q3 密钥派生 --- */
  const fileKey = verifyUserPassword(passwordBytes(USER_PWD), O, U, P, id0, R, keyLen, meta)
  let key = fileKey
  let viaOwner = false
  if (!key) {
    let h = md5(padPassword(passwordBytes(OWNER_PWD)))
    for (let i = 0; i < 50; i++) h = md5(h)
    let data = O
    for (let i = 19; i >= 1; i--) {
      const k = new Uint8Array(keyLen)
      for (let j = 0; j < keyLen; j++) k[j] = h[j] ^ i
      data = rc4(k, data)
    }
    data = rc4(h.subarray(0, keyLen), data)
    key = verifyUserPassword(data, O, U, P, id0, R, keyLen, meta)
    viaOwner = !!key
  }
  console.log('Q3 密钥派生: ' + (key ? '✅ 通过（' + (viaOwner ? '所有者口令路径' : '用户口令路径') + '）'
    : '❌ 失败') + '  key=' + (key ? hex(key, 16) : '-'))
  if (!key) continue

  /* --- Q1/Q2 自举 --- */
  const sx = raw.slice(-2048).match(/startxref\s+(\d+)/)
  const off = +sx[1]
  const om = raw.slice(off, off + 40).match(/^(\d+)\s+(\d+)\s+obj/)
  const xrefNum = +om[1]
  const bs = raw.indexOf('<<', off + om[0].length)
  const xdict = balancedDict(raw, bs)
  const xLen = intOf(xdict.text, 'Length')
  const xst = streamBytes(raw, xdict.end, xLen)
  const xW = intArrayOf(xdict.text, 'W')
  const xIndex = intArrayOf(xdict.text, 'Index')
  const xPred = intOf(xdict.text, 'DecodeParms') !== null
  let xinf = null
  try {
    xinf = inflateSync(xst.bytes)
  } catch { /* 保持 null */ }
  console.log('Q1 xref 流: 对象 ' + xrefNum + ' 偏移 ' + off + '  /Length=' + xLen +
    ' 实际=' + xst.bytes.length + ' 自举=' + (xinf ? '✅ 明文可解压' : '❌ 被加密') +
    '  /W=[' + (xW || []).join(' ') + ']')

  const columns = xW.reduce((a, b) => a + b, 0)
  const dec = decodePngPredictor(new Uint8Array(xinf), columns)
  console.log('  PNG 预测器: 行跨距含前缀=' + dec.prefixed + '  行数=' + dec.rows.length +
    '  （/Size=' + intOf(xdict.text, 'Size') + '）')

  const entries = []
  const idx = xIndex && xIndex.length ? xIndex : [0, dec.rows.length]
  let row = 0
  for (let k = 0; k < idx.length; k += 2) {
    for (let j = 0; j < idx[k + 1] && row < dec.rows.length; j++, row++) {
      const r = dec.rows[row]
      const t = xW[0] === 0 ? 1 : readField(r, xW, 0)
      entries.push({ num: idx[k] + j, type: t, f2: readField(r, xW, 1), f3: readField(r, xW, 2) })
    }
  }
  const type1 = entries.filter((e) => e.type === 1)
  const type2 = entries.filter((e) => e.type === 2)
  const type0 = entries.filter((e) => e.type === 0)
  console.log('  xref 条目 ' + entries.length + ' 条: 类型0(空闲)=' + type0.length +
    ' 类型1(独立)=' + type1.length + ' 类型2(对象流内)=' + type2.length)
  console.log('  前 8 条: ' + JSON.stringify(entries.slice(0, 8)))

  /* --- Q4 对象流 --- */
  const objStmNums = [...new Set(type2.map((e) => e.f2))]
  console.log('Q4 对象流对象号: ' + JSON.stringify(objStmNums))
  for (const n of objStmNums) {
    const e = type1.find((x) => x.num === n)
    if (!e) {
      console.log('   ⚠ 对象流 ' + n + ' 没有类型1条目，无法定位')
      continue
    }
    const osOff = e.f2
    const oom = raw.slice(osOff, osOff + 40).match(/^(\d+)\s+(\d+)\s+obj/)
    if (!oom) {
      console.log('   ⚠ 偏移 ' + osOff + ' 不是对象头')
      continue
    }
    const obs = raw.indexOf('<<', osOff + oom[0].length)
    const od = balancedDict(raw, obs)
    const oLen = intOf(od.text, 'Length')
    const ost = streamBytes(raw, od.end, oLen)
    const oFilter = nameOf(od.text, 'Filter')
    const oPred = /Predictor/.test(od.text)
    const oCols = intOf(od.text, 'Columns')
    const n1 = intOf(od.text, 'N')
    const first = intOf(od.text, 'First')
    console.log('   对象流 ' + n + ' @' + osOff + ': /Type=' + nameOf(od.text, 'Type') +
      ' /N=' + n1 + ' /First=' + first + ' /Filter=' + oFilter + ' /Length=' + oLen +
      ' 实际=' + ost.bytes.length + (oPred ? ' 预测器 columns=' + oCols : ''))

    // 用对象号 n 派生密钥解密
    const okey = objectKey(key, n, 0, aes)
    let plain = null
    try {
      plain = aes ? await aesCbcDecryptPdf(okey, ost.bytes) : rc4(okey, ost.bytes)
    } catch (err) {
      console.log('   ❌ 解密抛错: ' + String(err.message).slice(0, 140))
      continue
    }
    console.log('   解密: ' + (aes ? 'AES' : 'RC4') + ' 用对象号 ' + n +
      ' → ' + plain.length + ' 字节（密文 ' + ost.bytes.length + '）' +
      (aes ? '  [AES: 密文 = IV16 + 明文 + 填充' + ((ost.bytes.length - 16 - plain.length) || 0) + ']' : ''))

    let inf = null
    try {
      inf = inflateSync(Buffer.from(plain))
    } catch { /* 可能未压缩 */ }
    let body = inf ? new Uint8Array(inf) : plain
    if (oPred && oCols) {
      const r2 = decodePngPredictor(body, oCols)
      body = Buffer.concat(r2.rows.map((r) => Buffer.from(r)))
      console.log('   预测器反演 → ' + body.length + ' 字节')
    } else {
      console.log('   解压: ' + (inf ? '✅ FlateDecode' : '（无压缩）') + ' → ' + body.length + ' 字节')
    }

    // 对象流结构：前 /First 字节是 "objnum offset" 对，其后是拼接的对象体
    const header = body.slice(0, first).toString('latin1')
    const headerNums = header.trim().split(/\s+/).map(Number)
    console.log('   对象流头部（前 ' + first + ' 字节）: ' + JSON.stringify(header.slice(0, 160)))
    console.log('   头部数字对: ' + JSON.stringify(headerNums.slice(0, 16)))
    const payload = body.slice(first).toString('latin1')
    console.log('   对象体区前 300 字节: ' + JSON.stringify(payload.slice(0, 300)))
    const hasPlainKeywords = /\/Type|\/Font|\/Pages|\/MediaBox|\/Root|\/Length/.test(payload)
    console.log('   ⭐ 对象体中含明文关键字: ' + (hasPlainKeywords ? '✅ 是 → 对象流整体解密后即为明文'
      : '❌ 否 → 字符串可能被再加密了一次'))
    // 逐个对象按 offset 切出来看看
    for (let i = 0; i + 1 < Math.min(headerNums.length, 8); i += 2) {
      const onum = headerNums[i]
      const ooff = headerNums[i + 1]
      const seg = payload.slice(ooff, ooff + 110)
      console.log('     对象 ' + onum + ' @+' + ooff + ': ' + JSON.stringify(seg.slice(0, 100)))
    }
  }
}

console.log('\n' + '═'.repeat(78))
console.log('侦察结束')
console.log('═'.repeat(78))
