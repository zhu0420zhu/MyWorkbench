/* ============================================================
 * 分类纠正记忆 — 主进程实现（包装 MemoryCore + ConfigStore）
 * 复用 lingmo 统一配置管理（userData JSON 持久化）。
 * ============================================================ */

import { ConfigStore } from '../configStore.ts'
import { getLogger } from '../tools/logger.ts'
import type { ClassificationMemoryEntry } from '../../shared/types.ts'
import { MemoryCore } from './memoryCore.ts'

const logger = getLogger('organize:memory')

export class ClassificationMemory {
  private core = new MemoryCore()
  private store: ConfigStore<{ entries: ClassificationMemoryEntry[] }>

  constructor() {
    this.store = new ConfigStore<{ entries: ClassificationMemoryEntry[] }>('organize-memory', { entries: [] })
  }

  async load(): Promise<void> {
    const cur = await this.store.get()
    this.core.entries = cur.entries
  }

  async record(filePath: string, category: string): Promise<void> {
    this.core.record(filePath, category)
    await this.store.set({ entries: this.core.entries })
    logger.info(`记录分类纠正: ${filePath} → ${category}`)
  }

  async lookup(filePath: string, minVotes = 2): Promise<string | null> {
    return this.core.lookup(filePath, minVotes)
  }

  async list(): Promise<ClassificationMemoryEntry[]> {
    return this.core.list()
  }

  async clear(): Promise<void> {
    this.core.clear()
    await this.store.set({ entries: [] })
  }
}
