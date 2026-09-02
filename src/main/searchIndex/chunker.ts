/* ============================================
 * 文本切分（移植自 ck RAG 的 ChunkingService）
 * 按行累积成块（默认上限 ~800 字），记录块内起始偏移与最近标题，
 * 保留「切分」核心逻辑，供本地倒排索引使用。
 * ============================================================ */

import type { IndexChunk } from './types.ts'

export interface ChunkOptions {
  maxChars?: number
}

function isHeading(line: string): string | null {
  const t = line.trim()
  if (!t) return null
  if (/^#{1,6}\s/.test(t)) return t.replace(/^#{1,6}\s/, '')
  if (/^[一-鿿A-Za-z0-9].{0,30}[：:]$/.test(t)) return t
  if (/^(第[一二三四五六七八九十\d]+[章节目节部分])/.test(t)) return t
  return null
}

/** 将文本切分为若干块 */
export function chunkText(text: string, filePath: string, docId: string, opts: ChunkOptions = {}): IndexChunk[] {
  const maxChars = opts.maxChars ?? 800
  const lines = text.split(/\r?\n/)
  const chunks: IndexChunk[] = []
  let buffer = ''
  let startChar = 0
  let lastHeading: string | undefined

  const flush = (endChar: number): void => {
    const body = buffer.trim()
    if (!body) return
    chunks.push({
      id: `${docId}#${chunks.length}`,
      docId,
      filePath,
      text: body,
      startChar,
      heading: lastHeading
    })
    buffer = ''
    startChar = endChar
  }

  for (const line of lines) {
    const h = isHeading(line)
    if (h) lastHeading = h
    if (buffer.length + line.length > maxChars && buffer.trim()) {
      flush(text.indexOf(line, startChar))
    }
    buffer += line + '\n'
  }
  flush(text.length)
  return chunks
}
