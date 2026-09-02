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

/** 将角色卡 JSON 嵌入 PNG 的 tEXt chunk（保留原图字节） */
export function embedCharaInPng(bytes: Uint8Array, charaJson: string): Uint8Array {
  const textData = Buffer.concat([
    Buffer.from('chara\0', 'latin1'),
    Buffer.from(charaJson, 'utf-8')
  ])
  const tex = chunk('tEXt', new Uint8Array(textData))
  const head = Buffer.from(bytes.slice(0, 8))
  const rest = Buffer.from(bytes.slice(8))
  return new Uint8Array(Buffer.concat([head, Buffer.from(tex), rest]))
}

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return false
  return true
}
