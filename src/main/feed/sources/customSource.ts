/* ============================================================
 * feed —— 自定义数据源（kind:'hot' | 'agent'）
 * 允许用户添加一个 JSON feed URL，作为 feed 流的额外来源。
 * 支持数组格式 [{title,url,hot?}] 或对象格式 {items:[...]}。
 * ============================================================ */

import { simhash64 } from '../../hotDedup.ts'
import type { FeedSource } from '../source.ts'
import type {
  FeedItem,
  FeedItemSource,
  FeedSourceMeta,
  FeedSourceConfig,
  CustomFeedSourceDef
} from '../../../shared/types.ts'
import { categorize } from '../categorizeCore.ts'

interface JsonFeedItem {
  title: string
  url?: string
  hot?: number
  meta?: string
}

export function createCustomFeedSource(def: CustomFeedSourceDef): FeedSource {
  const meta: FeedSourceMeta = {
    id: def.id,
    name: def.name,
    kind: def.kind,
    description: def.description,
    defaultCategory: def.defaultCategory,
    enabled: def.enabled,
    intervalMs: def.intervalMs,
    lastRunAt: null,
    lastStatus: 'idle',
    lastSummary: undefined,
    lastItemCount: 0,
    builtIn: false
  }

  async function fetchItems(): Promise<JsonFeedItem[]> {
    if (!def.url.trim()) return []
    try {
      const res = await fetch(def.url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as JsonFeedItem[] | { items?: JsonFeedItem[] }
      if (Array.isArray(data)) return data
      if (data && Array.isArray(data.items)) return data.items
      return []
    } catch (err) {
      meta.lastStatus = 'error'
      meta.lastSummary = `获取失败：${(err as Error).message}`
      throw err
    }
  }

  function toItem(raw: JsonFeedItem): FeedItem {
    const hot = typeof raw.hot === 'number' ? raw.hot : 0
    const source: FeedItemSource = {
      platform: def.id,
      name: def.name,
      title: raw.title,
      url: raw.url ?? '',
      hot
    }
    const title = raw.title || '（无标题）'
    return {
      id: simhash64(title).toString(16).padStart(16, '0'),
      title,
      url: raw.url,
      hot,
      sources: [source],
      sourceKind: def.kind,
      sourceId: def.id,
      category: meta.defaultCategory ?? categorize(title),
      meta: raw.meta,
      firstSeen: Date.now()
    }
  }

  const source: FeedSource = {
    id: def.id,
    kind: def.kind,
    async collect(): Promise<FeedItem[]> {
      const items = await fetchItems()
      return items.map(toItem)
    },
    getMeta(): FeedSourceMeta {
      return { ...meta }
    },
    async runNow(): Promise<FeedItem[]> {
      const items = await fetchItems()
      meta.lastRunAt = Date.now()
      meta.lastStatus = 'ok'
      meta.lastSummary = `运行 ${def.name}：产出 ${items.length} 条`
      meta.lastItemCount = items.length
      return items.map(toItem)
    },
    setConfig(c: FeedSourceConfig): void {
      meta.enabled = c.enabled
      meta.intervalMs = c.intervalMs
    }
  }

  return source
}
