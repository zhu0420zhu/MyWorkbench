/**
 * 极简 ZIP 打包器（仅 store 模式，零依赖）。
 *
 * 与 guiguiyan930-source/game-ui-design-workflow 的 split_sprite_sheet.py
 * 行为对齐：把单元素 PNG 与 manifest 打包成可直接下载的 .zip。
 * PNG 已自带压缩，store 模式（不二次压缩）无损且足够。
 */

export interface ZipEntry {
  name: string
  data: Uint8Array
}

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const encoder = new TextEncoder()

export function createStoreZip(entries: ZipEntry[]): Blob {
  const chunks: Uint8Array<ArrayBuffer>[] = []
  const central: Uint8Array<ArrayBuffer>[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const crc = crc32(entry.data)
    const size = entry.data.length
    // 复制到独立的 ArrayBuffer，确保 Blob 入参为 Uint8Array<ArrayBuffer>
    const dataBuf = new Uint8Array(entry.data.byteLength)
    dataBuf.set(entry.data)

    // 本地文件头
    const local = new DataView(new ArrayBuffer(30 + nameBytes.length))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(6, 0, true)
    local.setUint16(8, 0, true) // store
    local.setUint16(10, 0, true)
    local.setUint16(12, 0, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, size, true)
    local.setUint32(22, size, true)
    local.setUint16(26, nameBytes.length, true)
    local.setUint16(28, 0, true)
    chunks.push(new Uint8Array(local.buffer), nameBytes, dataBuf)

    // 中央目录记录
    const cd = new DataView(new ArrayBuffer(46 + nameBytes.length))
    cd.setUint32(0, 0x02014b50, true)
    cd.setUint16(4, 20, true)
    cd.setUint16(6, 20, true)
    cd.setUint16(8, 0, true)
    cd.setUint16(10, 0, true)
    cd.setUint16(12, 0, true)
    cd.setUint16(14, 0, true)
    cd.setUint32(16, crc, true)
    cd.setUint32(20, size, true)
    cd.setUint32(24, size, true)
    cd.setUint16(28, nameBytes.length, true)
    cd.setUint16(30, 0, true)
    cd.setUint16(32, 0, true)
    cd.setUint16(34, 0, true)
    cd.setUint16(36, 0, true)
    cd.setUint32(38, 0, true)
    cd.setUint32(42, offset, true)
    central.push(new Uint8Array(cd.buffer), nameBytes)

    offset += 30 + nameBytes.length + size
  }

  const centralSize = central.reduce((s, c) => s + c.length, 0)
  const cdOffset = offset

  // 中央目录结束记录
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(4, 0, true)
  end.setUint16(6, 0, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, cdOffset, true)
  end.setUint16(20, 0, true)

  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' })
}
