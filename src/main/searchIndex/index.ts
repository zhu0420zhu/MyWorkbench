/* 全文检索索引 — 统一出口 */

import { app } from 'electron'
import { join } from 'node:path'
import { Indexer } from './indexer.ts'

export * from './types.ts'
export { tokenize, isCjk } from './tokenizer.ts'
export { extractText, stripHtml } from './parser.ts'
export { chunkText } from './chunker.ts'
export { Indexer } from './indexer.ts'
export { QaService } from './qa.ts'
export type { QaIndexerLike, QaOptions, CompleteFn } from './qa.ts'
export { selectContext, estimateTokens, truncateToTokens } from './contextOptimizer.ts'
export type { ContextItem, ContextBudget, ContextSelection } from './contextOptimizer.ts'

let _indexer: Indexer | null = null

/** 获取索引器单例（持久化于 userData/search-index.json） */
export function getIndexer(): Indexer {
  if (!_indexer) {
    _indexer = new Indexer(join(app.getPath('userData'), 'search-index.json'))
  }
  return _indexer
}
