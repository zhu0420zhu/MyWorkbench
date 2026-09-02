/* ============================================================
 * feed —— 热点平台数据源（kind:'hot'）
 * 复用既有 fetchAllHot()（本地 Hono 服务 + 去重），把 16 个平台各自包装为 FeedSource。
 * 性能：aggregator 通过 prefetchHotAll() 只 fetch 一次全量，各 hot source 读缓存，
 * 避免 16 个平台各自发起一次网络请求。
 * ============================================================ */

import { fetchAllHot, PLATFORMS, type HotFetchResult } from '../../hot.ts'
import { categorize } from '../categorizeCore.ts'
import type { FeedSource } from '../source.ts'
import type {
  FeedItem,
  FeedItemSource,
  FeedSourceMeta,
  FeedSourceConfig
} from '../../../shared/types.ts'

/** 平台 id → 展示名（映射 FeedItemSource.name 用） */
const PLATFORM_NAME: Record<string, string> = Object.fromEntries(
  PLATFORMS.map((p) => [p.id, p.name])
)

// 模块级缓存：aggregator 调用一次 fetchAllHot 后注入，各 hot source 的 collect 读取，
// 避免 16 个平台各自发起一次网络请求。
let cachedAllHot: HotFetchResult | null = null

/** 供 aggregator 注入一次全量结果（热点平台共享，避免重复 fetch） */
export async function prefetchHotAll(): Promise<HotFetchResult> {
  cachedAllHot = await fetchAllHot()
  return cachedAllHot
}

function eventsToItems(all: HotFetchResult, platformId: string): FeedItem[] {
  const items: FeedItem[] = []
  for (const ev of all.events) {
    if (!ev.sources.some((s) => s.platform === platformId)) continue
    const firstUrl = ev.sources.find((s) => s.platform === platformId)?.url ?? ev.sources[0]?.url
    const sources: FeedItemSource[] = ev.sources.map((s) => ({
      platform: s.platform,
      name: PLATFORM_NAME[s.platform] ?? s.platform,
      title: s.title,
      url: s.url,
      hot: s.hot
    }))
    items.push({
      id: ev.id,
      title: ev.title,
      url: firstUrl,
      hot: ev.hot,
      sources,
      sourceKind: 'hot',
      sourceId: platformId,
      category: categorize(ev.title),
      firstSeen: Date.now()
    })
  }
  return items
}

export function createHotSources(): FeedSource[] {
  return PLATFORMS.map((cfg) => {
    async function collect(): Promise<FeedItem[]> {
      // 缓存命中（aggregator 已注入）则不再重复 fetch
      const all = cachedAllHot ?? (cachedAllHot = await fetchAllHot())
      return eventsToItems(all, cfg.id)
    }

    function getMeta(): FeedSourceMeta {
      const pf = cachedAllHot?.platforms.find((p) => p.id === cfg.id)
      const lastStatus: 'idle' | 'ok' | 'error' = pf ? (pf.status === 'error' ? 'error' : 'ok') : 'idle'
      return {
        id: cfg.id,
        name: cfg.name,
        kind: 'hot',
        description: `全网热点平台：${cfg.name}`,
        enabled: true,
        intervalMs: 0,
        lastRunAt: cachedAllHot ? cachedAllHot.updatedAt : null,
        lastStatus,
        lastSummary: pf?.error,
        lastItemCount: pf?.count ?? 0
      }
    }

    const source: FeedSource = {
      id: cfg.id,
      kind: 'hot',
      collect,
      getMeta,
      async runNow(): Promise<FeedItem[]> {
        return collect()
      },
      setConfig(_c: FeedSourceConfig): void {
        // 热点平台全量参与聚合；enabled/intervalMs 留作未来单源开关（当前忽略）
      }
    }
    return source
  })
}
