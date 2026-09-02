/**
 * 章节检索索引（复用本地全文检索索引，不引入向量库）
 *
 * **为什么用虚拟路径**：检索索引以"文件路径"作为文档主键。章节正文存在
 * userData/novel/<pid>/chapters/<cid>.md，直接拿真实路径入库也能跑，
 * 但一旦 userData 路径变化（重装 / 换机器）旧索引就成了孤儿。
 * 用 `novel/<pid>/<cid>.md` 这种与磁盘位置无关的虚拟路径，索引永远可迁移。
 *
 * **为什么按 projectId 划作用域**：queryChunks 的 scope 是"路径前缀"，
 * 每部作品一个前缀，检索时不会跨作品串味（A 书的"青云门"不该召回 B 书的段落）。
 */
import { join } from 'path'
import { getIndexer } from '../searchIndex/index'

export interface ChapterHit {
  chapterId: string
  text: string
  score: number
}

function safeId(id: string): string {
  return id.replace(/[^\w.@-]+/g, '_').slice(0, 80) || 'default'
}

/** 章节在索引里的虚拟路径（与磁盘位置解耦） */
export function chapterVirtualPath(projectId: string, chapterId: string): string {
  return join('novel', safeId(projectId), `${safeId(chapterId)}.md`)
}

/** 某部作品在索引里的作用域前缀 */
export function chapterScope(projectId: string): string {
  return join('novel', safeId(projectId))
}

/**
 * 把章节正文写进检索索引。
 * 不调用 load()：Indexer 是单例，启动时 registerSearchIndexIpc 已 load 过一次，
 * 这里再 load 会把其它模块尚未落盘的内存改动冲掉。
 */
export async function indexChapter(
  projectId: string,
  chapterId: string,
  content: string
): Promise<void> {
  if (!content || !content.trim()) return
  await getIndexer().ingestText(chapterVirtualPath(projectId, chapterId), content)
}

/** 章节删除时同步清理索引 */
export function unindexChapter(projectId: string, chapterId: string): void {
  getIndexer().delete(chapterVirtualPath(projectId, chapterId))
}

/**
 * 在本作品已入库的旧章里召回片段。
 * excludeChapterId 用来排除"正在写的这一章"——回忆自己没有意义。
 */
export function searchChapters(
  projectId: string,
  query: string,
  topK = 3,
  excludeChapterId?: string
): ChapterHit[] {
  const q = (query ?? '').trim()
  if (!q) return []
  // 多取一些再过滤：被排除的当前章很可能排在前面
  const raw = getIndexer().queryChunks(q, topK * 4 + 4, chapterScope(projectId))
  const out: ChapterHit[] = []
  for (const c of raw) {
    const chapterId = c.filePath.split(/[\\/]/).pop()?.replace(/\.md$/, '') ?? ''
    if (!chapterId) continue
    if (excludeChapterId && chapterId === safeId(excludeChapterId)) continue
    out.push({ chapterId, text: c.text, score: c.score })
    if (out.length >= topK) break
  }
  return out
}
