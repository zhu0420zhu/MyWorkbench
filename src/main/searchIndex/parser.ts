/* ============================================
 * 文件文本抽取（移植自 ck RAG 的「文档解析」步骤，本地化）
 * 支持：纯文本类（txt/md/json/csv/代码/配置等）、HTML（去标签）。
 * 不支持的二进制（docx/pdf/xlsx 等）返回 null，由调用方优雅跳过。
 * ============================================================ */

import { promises as fs } from 'node:fs'

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.mkd', '.text', '.log', '.json', '.csv', '.tsv',
  '.xml', '.yml', '.yaml', '.ini', '.conf', '.cfg', '.toml', '.env',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.cpp', '.c', '.h', '.hpp', '.cs', '.php', '.rb', '.sh', '.sql', '.html',
  '.htm', '.css', '.scss', '.less'
])

const HTML_EXTS = new Set(['.html', '.htm'])

/** 支持的图片扩展名（Vision RAG 入库用；抽取失败由调用方降级为文件名索引） */
export const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff', '.tif', '.avif'
])

/** 判断是否为可视觉描述的图片文件 */
export function isImageFile(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  const ext = lower.slice(lower.lastIndexOf('.'))
  return IMAGE_EXTS.has(ext)
}

/** 抽取文件纯文本；不支持或读取失败返回 null */
export async function extractText(filePath: string): Promise<string | null> {
  const lower = filePath.toLowerCase()
  const ext = lower.slice(lower.lastIndexOf('.'))
  if (!TEXT_EXTS.has(ext) && !HTML_EXTS.has(ext)) return null
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch {
    return null
  }
  if (HTML_EXTS.has(ext)) return stripHtml(raw)
  return raw
}

/** 去除 HTML 标签与脚本/样式，保留可见文本 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}
