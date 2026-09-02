/* 灵墨工作台 · 文件编码检测与解码（渲染层）
 * Electron/Chromium 内置 TextDecoder 支持 UTF-8/GBK/GB18030/Big5/Shift_JIS/EUC-KR/Latin1 等，
 * 因此无需在主进程引入 iconv 等第三方库，直接对 pickBufferFile 返回的原始字节解码即可。
 */

export interface EncodingOption {
  value: string
  label: string
}

/** 渲染层可手动选择的编码列表。value 必须是 TextDecoder 认可的标准标签。 */
export const SUPPORTED_ENCODINGS: EncodingOption[] = [
  { value: 'auto', label: '自动识别' },
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'gbk', label: 'GBK' },
  { value: 'gb18030', label: 'GB18030' },
  { value: 'big5', label: 'Big5' },
  { value: 'shift_jis', label: 'Shift_JIS' },
  { value: 'euc-kr', label: 'EUC-KR' },
  { value: 'windows-1252', label: 'Windows-1252' },
  { value: 'iso-8859-1', label: 'Latin1' }
]

/** 供 UI 展示用的编码名称。 */
export function encodingLabel(value: string): string {
  return SUPPORTED_ENCODINGS.find((e) => e.value === value)?.label ?? value.toUpperCase()
}

/** 优先用 fatal UTF-8 校验；失败再试常见中文/东亚编码；最后回退 Latin1（单字节映射不会丢数据）。 */
export function detectEncoding(bytes: Uint8Array): string {
  const candidates = ['utf-8', 'gb18030', 'big5', 'shift_jis', 'euc-kr', 'windows-1252', 'iso-8859-1']
  for (const encoding of candidates) {
    try {
      const decoder = new TextDecoder(encoding, { fatal: true })
      decoder.decode(bytes)
      // GB18030 是 GBK 超集，检测到 GB18030 时对外展示 GBK 更常见
      if (encoding === 'gb18030') return 'gbk'
      return encoding
    } catch {
      // 该编码无法完整解码，继续尝试下一个
    }
  }
  return 'iso-8859-1'
}

/** 解码字节。encoding 为 'auto' 时先检测再解码。 */
export function decodeBytes(bytes: Uint8Array, encoding: string): string {
  const actual = encoding === 'auto' ? detectEncoding(bytes) : encoding
  // 实际解码时 fatal=false，确保即使有不可映射字节也不会抛错，而是给出替换字符
  const decoder = new TextDecoder(actual, { fatal: false })
  return decoder.decode(bytes)
}

/** 自动识别后的真实编码值（把 'auto' 解析成具体编码）。 */
export function resolveEncoding(bytes: Uint8Array, encoding: string): string {
  return encoding === 'auto' ? detectEncoding(bytes) : encoding
}
