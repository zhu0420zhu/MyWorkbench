/* ============================================================
 * 全文检索索引 — IPC 桥接
 * 暴露本地关键词倒排索引的 ingest → query 流程（替代 ck 的 ChromaDB 语义 RAG），
 * 并新增「与本地文件对话」（Chat with Files，含 CRAG 检索质量增强）与问答历史。
 * 本轮扩展：
 *   - Vision RAG：图片文件入库时调用视觉模型生成描述（降级为文件名索引）
 *   - 问答个性化偏好（记忆与个性化）：qa-prefs-get / qa-prefs-set，ask 时合并
 * ============================================================ */

import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { getIndexer } from './index.ts'
import { QaService } from './qa.ts'
import { tokenize } from './tokenizer.ts'
import { describeImageForIndex } from './vision.ts'
import { complete } from '../ai.ts'
import { ConfigStore } from '../configStore.ts'
import { getLogger } from '../tools/logger.ts'
import { getMcpManager, createMcpToolBridge } from '../mcp/index.ts'
import type {
  AskRequest,
  AskResult,
  QaHistoryEntry,
  QaPrefs
} from '../../shared/types.ts'

const logger = getLogger('searchIndex:ipc')

interface QaHistoryStore extends Record<string, unknown> {
  entries: QaHistoryEntry[]
}

const HISTORY_LIMIT = 50

export function registerSearchIndexIpc(): void {
  const indexer = getIndexer()
  // 启动时加载持久化索引（JSON）
  void indexer.load()

  const qa = new QaService(indexer, complete, {}, createMcpToolBridge(getMcpManager()))
  const historyStore = new ConfigStore<QaHistoryStore>('searchIndex-qa', { entries: [] })
  const prefsStore = new ConfigStore<{ prefs: QaPrefs }>('searchIndex-qa-prefs', { prefs: {} })
  void historyStore.load()
  void prefsStore.load()

  const recordHistory = async (req: AskRequest, res: AskResult): Promise<void> => {
    if (res.answerMode === 'empty') return
    const entry: QaHistoryEntry = {
      id: randomUUID(),
      question: req.question,
      answer: res.answer.slice(0, 2000),
      mode: res.mode,
      citationCount: res.citations.length,
      at: Date.now()
    }
    const cur = await historyStore.get()
    const entries = [entry, ...cur.entries].slice(0, HISTORY_LIMIT)
    await historyStore.set({ entries })
  }

  ipcMain.handle('searchIndex:ingest', (_e, filePath: string) => indexer.ingest(filePath, describeImageForIndex))
  ipcMain.handle(
    'searchIndex:ingest-dir',
    (_e, dir: string, recursive?: boolean, extFilter?: string[], describer?: (p: string) => Promise<string | null>) =>
      indexer.ingestDir(dir, recursive ?? true, extFilter, describer ?? describeImageForIndex)
  )
  ipcMain.handle('searchIndex:query', (_e, q: string, topK?: number) => indexer.query(q, topK ?? 10))
  ipcMain.handle('searchIndex:delete', (_e, filePath: string) => indexer.delete(filePath))
  ipcMain.handle('searchIndex:rebuild', () => indexer.rebuild())
  ipcMain.handle('searchIndex:stats', () => indexer.stats())
  // 分词器工具（调试 / 预览用）
  ipcMain.handle('searchIndex:tokenize', (_e, text: string) => tokenize(text))

  // —— 与本地文件对话（Chat with Files）——
  ipcMain.handle('searchIndex:ask', async (_e, req: AskRequest): Promise<AskResult> => {
    const stored = (await prefsStore.get()).prefs
    const merged: AskRequest = { ...req, prefs: { ...stored, ...(req.prefs ?? {}) } }
    const result = await qa.ask(merged)
    await recordHistory(req, result)
    return result
  })
  ipcMain.handle('searchIndex:qa-history', async () => {
    const cur = await historyStore.get()
    return cur.entries
  })
  ipcMain.handle('searchIndex:qa-history-clear', async () => {
    await historyStore.set({ entries: [] })
    return true
  })

  // —— 问答个性化偏好（记忆与个性化）——
  ipcMain.handle('searchIndex:qa-prefs-get', async (): Promise<QaPrefs> => {
    const cur = await prefsStore.get()
    return cur.prefs
  })
  ipcMain.handle('searchIndex:qa-prefs-set', async (_e, prefs: QaPrefs): Promise<QaPrefs> => {
    const cur = await prefsStore.get()
    const merged: QaPrefs = { ...cur, ...prefs }
    await prefsStore.set({ prefs: merged })
    return merged
  })
}
