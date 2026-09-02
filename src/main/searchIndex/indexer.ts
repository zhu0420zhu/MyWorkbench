/* ============================================
 * 本地全文检索索引（替代 ck 的 ChromaDB 向量索引）
 * 保留 ck RAG 的 ingest → chunk → query 核心流程形态：
 *   ingest(file)  解析→切分→建倒排索引
 *   query(q)      分词→倒排命中→按文档聚合评分→返回片段
 * 索引以 JSON 持久化于数据目录，完全离线、无外部依赖。
 * ============================================================ */

import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join, sep } from 'node:path'
import { getLogger } from '../tools/logger.ts'
import { extractText, isImageFile } from './parser.ts'
import { chunkText } from './chunker.ts'
import { tokenize } from './tokenizer.ts'
import type { IndexChunk, IndexDoc, IndexStats, IngestResult, SearchHit, ScoredChunk } from './types.ts'
import type { AssetType } from '../../shared/types.ts'

const logger = getLogger('searchIndex')

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.cache', 'Cache'])

function docIdOf(filePath: string): string {
  return createHash('md5').update(filePath).digest('hex').slice(0, 10)
}

export class Indexer {
  private docs = new Map<string, IndexDoc>()
  private chunks = new Map<string, IndexChunk>()
  private docChunks = new Map<string, string[]>()
  private postings = new Map<string, Set<string>>()
  private file: string
  private loaded = false

  constructor(indexPath: string) {
    this.file = indexPath
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await fs.readFile(this.file, 'utf-8')
      const parsed = JSON.parse(raw) as { docs: IndexDoc[]; chunks: IndexChunk[] }
      for (const d of parsed.docs) this.docs.set(d.docId, d)
      for (const c of parsed.chunks) {
        this.chunks.set(c.id, c)
        const arr = this.docChunks.get(c.docId) ?? []
        arr.push(c.id)
        this.docChunks.set(c.docId, arr)
      }
      this.rebuildPostings()
      logger.info(`索引已加载: ${this.docs.size} 文档 / ${this.chunks.size} 块`)
    } catch {
      logger.info('索引文件不存在或为空，初始化空索引')
    }
  }

  private rebuildPostings(): void {
    this.postings.clear()
    for (const c of this.chunks.values()) {
      for (const t of tokenize(c.text)) {
        if (!this.postings.has(t)) this.postings.set(t, new Set())
        this.postings.get(t)!.add(c.id)
      }
    }
  }

  private async save(): Promise<void> {
    try {
      await fs.mkdir(dirname(this.file), { recursive: true })
      const data = { docs: [...this.docs.values()], chunks: [...this.chunks.values()] }
      await fs.writeFile(this.file, JSON.stringify(data), 'utf-8')
    } catch (err) {
      logger.error(`索引持久化失败: ${(err as Error).message}`)
    }
  }

  /** 入库单个文件（已索引则先移除旧索引再重建）。
   *  describer 用于图片视觉描述（Vision RAG）；未提供时图片按「不支持」跳过。 */
  async ingest(filePath: string, describer?: (p: string) => Promise<string | null>): Promise<IngestResult> {
    const text = await extractText(filePath)
    if (text !== null) {
      return this.ingestText(filePath, text)
    }
    // 非文本：尝试图片视觉描述入库（Vision RAG）
    if (describer && isImageFile(filePath)) {
      let desc = await describer(filePath)
      if (!desc || !desc.trim()) {
        // 视觉描述不可用 → 退化：仅以文件名为可检索文本
        desc = basename(filePath)
      }
      return this.ingestImage(filePath, desc)
    }
    return { success: false, filePath, chunkCount: 0, error: '不支持的文件类型或读取失败' }
  }

  /** 文本入库（内部/外部复用）。
   *  知识库流水线据此将「转换后的文本」以原始文档路径建索引（origin='converted'）。
   *  @param origin 'text'=直接文本抽取；'converted'=经格式转换后抽取 */
  ingestText(filePath: string, text: string, origin: 'text' | 'converted' = 'text'): Promise<IngestResult> {
    const docId = docIdOf(filePath)
    this.remove(docId)

    let size = 0
    try {
      size = statSync(filePath).size
    } catch {
      /* ignore */
    }
    const chunks = chunkText(text, filePath, docId)
    const doc: IndexDoc = {
      docId,
      filePath,
      fileName: basename(filePath),
      extension: extname(filePath).toLowerCase(),
      size,
      indexedAt: Date.now(),
      chunkCount: chunks.length,
      origin
    }
    this.docs.set(docId, doc)
    this.docChunks.set(
      docId,
      chunks.map((c) => c.id)
    )
    for (const c of chunks) {
      this.chunks.set(c.id, c)
      for (const t of tokenize(c.text)) {
        if (!this.postings.has(t)) this.postings.set(t, new Set())
        this.postings.get(t)!.add(c.id)
      }
    }
    void this.save()
    logger.info(`已入库(文本): ${filePath} | 块数=${chunks.length}`)
    return Promise.resolve({ success: true, filePath, docId, chunkCount: chunks.length })
  }

  /** 图片入库（视觉描述或退化文件名），标记为 image 来源 */
  private ingestImage(filePath: string, description: string): Promise<IngestResult> {
    const docId = docIdOf(filePath)
    this.remove(docId)

    let size = 0
    try {
      size = statSync(filePath).size
    } catch {
      /* ignore */
    }
    const chunks = chunkText(description, filePath, docId).map((c) => ({ ...c, origin: 'image' as const }))
    const doc: IndexDoc = {
      docId,
      filePath,
      fileName: basename(filePath),
      extension: extname(filePath).toLowerCase(),
      size,
      indexedAt: Date.now(),
      chunkCount: chunks.length,
      origin: 'image'
    }
    this.docs.set(docId, doc)
    this.docChunks.set(
      docId,
      chunks.map((c) => c.id)
    )
    for (const c of chunks) {
      this.chunks.set(c.id, c)
      for (const t of tokenize(c.text)) {
        if (!this.postings.has(t)) this.postings.set(t, new Set())
        this.postings.get(t)!.add(c.id)
      }
    }
    void this.save()
    logger.info(`已入库(图片): ${filePath} | 块数=${chunks.length}`)
    return Promise.resolve({ success: true, filePath, docId, chunkCount: chunks.length })
  }

  /** 批量入库目录 */
  async ingestDir(
    dir: string,
    recursive = true,
    extFilter?: string[],
    describer?: (p: string) => Promise<string | null>
  ): Promise<IngestResult[]> {
    const results: IngestResult[] = []
    const walk = async (d: string): Promise<void> => {
      let entries
      try {
        entries = await fs.readdir(d, { withFileTypes: true })
      } catch (err) {
        logger.warning(`扫描目录失败: ${d}, ${(err as Error).message}`)
        return
      }
      for (const e of entries) {
        const full = join(d, e.name)
        if (e.isDirectory()) {
          if (recursive && !SKIP_DIRS.has(e.name)) await walk(full)
          continue
        }
        if (extFilter && extFilter.length) {
          const ext = e.name.toLowerCase().slice(e.name.lastIndexOf('.'))
          if (!extFilter.map((x) => x.toLowerCase()).includes(ext)) continue
        }
        results.push(await this.ingest(full, describer))
      }
    }
    await walk(dir)
    return results
  }

  /** 检索：返回按评分降序的命中文档列表 */
  query(q: string, topK = 10): SearchHit[] {
    const tokens = tokenize(q)
    if (!tokens.length) return []
    const scoreMap = new Map<string, { score: number; matched: Set<string> }>()
    for (const t of tokens) {
      const chunkIds = this.postings.get(t)
      if (!chunkIds) continue
      for (const cid of chunkIds) {
        const c = this.chunks.get(cid)
        if (!c) continue
        const entry = scoreMap.get(c.docId) ?? { score: 0, matched: new Set<string>() }
        entry.score += 1
        entry.matched.add(cid)
        scoreMap.set(c.docId, entry)
      }
    }
    const hits: SearchHit[] = []
    for (const [docId, info] of scoreMap) {
      const doc = this.docs.get(docId)
      if (!doc) continue
      const snippets = [...info.matched]
        .slice(0, 3)
        .map((cid) => {
          const c = this.chunks.get(cid)
          return c ? c.text.slice(0, 160) : ''
        })
        .filter(Boolean)
      hits.push({
        docId,
        filePath: doc.filePath,
        fileName: doc.fileName,
        score: info.score,
        snippets,
        chunkCount: doc.chunkCount
      })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, topK)
  }

  /** 块级检索：返回命中的具体块（含 startChar 偏移），用于问答引用定位。
   *  scope 可限定为文件完整路径或目录前缀（目录需以路径分隔符结尾以精确匹配）。
   *  不改变既有索引数据格式，向后兼容。 */
  queryChunks(q: string, topK = 5, scope?: string): ScoredChunk[] {
    const tokens = tokenize(q)
    if (!tokens.length) return []
    const scoreMap = new Map<string, number>()
    for (const t of tokens) {
      const chunkIds = this.postings.get(t)
      if (!chunkIds) continue
      for (const cid of chunkIds) {
        if (!this.chunks.has(cid)) continue
        scoreMap.set(cid, (scoreMap.get(cid) ?? 0) + 1)
      }
    }
    const scoped = scope
      ? (scope.replace(/[\\/]$/, '') + sep)
      : null
    const chunks: ScoredChunk[] = []
    for (const [cid, score] of scoreMap) {
      const c = this.chunks.get(cid)!
      if (scoped && c.filePath !== scope && !c.filePath.startsWith(scoped)) continue
      chunks.push({ ...c, score })
    }
    chunks.sort((a, b) => b.score - a.score)
    return chunks.slice(0, topK)
  }

  /** 删除某文件的索引 */
  delete(filePath: string): { deletedCount: number } {
    return this.remove(docIdOf(filePath))
  }

  private remove(docId: string): { deletedCount: number } {
    const chunkIds = this.docChunks.get(docId) ?? []
    for (const cid of chunkIds) {
      const c = this.chunks.get(cid)
      if (c) {
        for (const t of tokenize(c.text)) {
          const set = this.postings.get(t)
          if (set) {
            set.delete(cid)
            if (!set.size) this.postings.delete(t)
          }
        }
        this.chunks.delete(cid)
      }
    }
    this.docChunks.delete(docId)
    this.docs.delete(docId)
    return { deletedCount: chunkIds.length }
  }

  /** 重建倒排（分词器/切分策略变更后调用） */
  async rebuild(): Promise<void> {
    this.rebuildPostings()
    await this.save()
  }

  stats(): IndexStats {
    return {
      docCount: this.docs.size,
      chunkCount: this.chunks.size,
      tokenCount: this.postings.size,
      available: true
    }
  }
}
