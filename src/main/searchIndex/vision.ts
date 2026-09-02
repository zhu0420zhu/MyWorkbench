/* ============================================================
 * 图片视觉描述（Vision RAG 共用）
 * 将图片经视觉模型生成一句描述文本，用于本地全文检索建索引。
 * 失败/视觉模型不可用返回 null（调用方退化为文件名索引）。
 * 抽离为独立模块，供 searchIndexIpc 与 knowledgeBase 流水线共用。
 * ============================================================ */

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { completeVision } from '../ai.ts'
import { getLogger } from '../tools/logger.ts'

const logger = getLogger('searchIndex:vision')

/** 图片视觉描述：成功返回描述文本，失败/不支持返回 null（退化文件名索引） */
export async function describeImageForIndex(filePath: string): Promise<string | null> {
  try {
    const buf = await readFile(filePath)
    const b64 = buf.toString('base64')
    const ext = extname(filePath).slice(1).toLowerCase() || 'png'
    const mime = ext === 'jpg' ? 'jpeg' : ext
    const dataUrl = `data:image/${mime};base64,${b64}`
    const res = await completeVision([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '请用一句话描述这张图片的关键视觉内容，用于后续本地全文检索。只输出描述文本，不要解释。'
          },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ])
    if (res.ok && res.text) return res.text.trim()
    logger.warning(`图片视觉描述失败，退化文件名索引: ${res.error ?? '空响应'}`)
    return null
  } catch (err) {
    logger.warning(`图片读取/描述异常: ${(err as Error).message}`)
    return null
  }
}
