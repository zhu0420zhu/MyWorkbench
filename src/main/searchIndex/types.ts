/* 全文检索索引 — 类型定义（本地关键词检索，替代 ck 的 ChromaDB 语义 RAG） */

import type { AssetType } from '../../shared/types'

export interface IndexChunk {
  id: string
  docId: string
  filePath: string
  text: string
  startChar: number
  heading?: string
  /** 来源：文本抽取 / 图片视觉描述（Vision RAG） / 经格式转换后抽取（知识库流水线） */
  origin?: 'text' | 'image' | 'converted'
}

/** 带检索评分的块（queryChunks 返回，用于问答引用定位） */
export interface ScoredChunk extends IndexChunk {
  score: number
}

export interface IndexDoc {
  docId: string
  filePath: string
  fileName: string
  extension: string
  size: number
  indexedAt: number
  chunkCount: number
  /** 来源：文本抽取 / 图片视觉描述（Vision RAG） / 经格式转换后抽取（知识库流水线） */
  origin?: 'text' | 'image' | 'converted'
}

export interface SearchHit {
  docId: string
  filePath: string
  fileName: string
  score: number
  snippets: string[]
  chunkCount: number
}

export interface IngestResult {
  success: boolean
  filePath: string
  docId?: string
  chunkCount: number
  error?: string
}

export interface IndexStats {
  docCount: number
  chunkCount: number
  tokenCount: number
  available: boolean
}
