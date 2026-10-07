/**
 * PNG 角色卡编解码（SillyTavern V2 格式）
 * 卡片 JSON 以 tEXt chunk（keyword="chara"）嵌入 PNG；无图卡用纯 JSON 文件。
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, Buffer.from(data)])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return new Uint8Array(Buffer.concat([len, body, crc]))
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 从 PNG 字节中取出 keyword="chara" 的 tEXt 文本 */
export function extractCharaFromPng(bytes: Uint8Array): string | null {
  if (bytes.length < 24) return null
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return null
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const len = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
    const dataStart = offset + 8
    const dataEnd = dataStart + len
    if (dataEnd > bytes.length) break
    if (type === 'tEXt') {
      // keyword\0text
      let nul = dataStart
      while (nul < dataEnd && bytes[nul] !== 0) nul++
      if (nul < dataEnd) {
        const keyword = Buffer.from(bytes.slice(dataStart, nul)).toString('latin1')
        const text = Buffer.from(bytes.slice(nul + 1, dataEnd)).toString('utf-8')
        if (keyword === 'chara') return text
      }
    }
    offset = dataEnd + 4 // skip CRC
  }
  return null
}

/**
 * 将角色卡 JSON 嵌入 PNG 的 tEXt chunk（保留原图字节）
 * 去重：插入前剔除所有既有的 keyword==='chara' tEXt chunk，避免反复保存导致
 * 卡片被复制 N 份、文件按卡片大小反复膨胀。其余 chunk 一律原样字节拷贝（不重算 CRC）。
 */
export function embedCharaInPng(bytes: Uint8Array, charaJson: string): Uint8Array {
  const src = Buffer.from(bytes)
  if (src.length < 8) throw new Error('embedCharaInPng: not a PNG (too short)')
  for (let i = 0; i < 8; i++) if (src[i] !== PNG_SIG[i]) throw new Error('embedCharaInPng: invalid PNG signature')

  const textData = Buffer.concat([
    Buffer.from('chara\0', 'latin1'),
    Buffer.from(charaJson, 'utf-8')
  ])
  const tex = Buffer.from(chunk('tEXt', new Uint8Array(textData)))

  // 签名 + 新 chara chunk（插在签名之后最前面，保证 extract 读到最新卡片）+ 其余 chunk
  const parts: Buffer[] = [src.slice(0, 8), tex]
  let offset = 8
  while (offset + 8 <= src.length) {
    const len = src.readUInt32BE(offset)
    const dataEnd = offset + 8 + len
    const crcEnd = dataEnd + 4
    if (crcEnd > src.length) {
      // 尾部不完整：原样保留剩余字节，避免丢数据
      parts.push(src.slice(offset))
      break
    }
    const type = src.toString('ascii', offset + 4, offset + 8)
    if (type === 'tEXt') {
      const dataStart = offset + 8
      let nul = dataStart
      while (nul < dataEnd && src[nul] !== 0) nul++
      if (nul < dataEnd && src.toString('latin1', dataStart, nul) === 'chara') {
        offset = crcEnd // 跳过旧 chara chunk
        continue
      }
    }
    parts.push(src.slice(offset, crcEnd))
    offset = crcEnd
  }
  return new Uint8Array(Buffer.concat(parts))
}

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return false
  return true
}
