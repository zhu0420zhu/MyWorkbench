/* ============================================================
 * feed —— 聚合器（合并 + 去重 + 排序）
 * 把全部 FeedSource.collect() 的产出合并为 FeedItem[]，再规整为
 * HotSourceItem[] 喂给既有 dedupeAndRank（热点/智能体进入同一套去重排序链路），
 * 最后映射回 FeedItem（保留 sourceKind / category / meta / url）。
 * ============================================================ */

import { dedupeAndRank, type HotSourceItem } from '../hotDedup.ts'
import { categorize } from './categorizeCore.ts'
import type { FeedSource } from './source.ts'
import type {
  FeedItem,
  FeedItemSource,
  FeedSourceMeta,
  FeedSourceStatus,
  FeedResult
} from '../../shared/types.ts'
import { prefetchHotAll } from './sources/hotSource.ts'

export async function aggregateFeed(sources: FeedSource[]): Promise<FeedResult> {
  const enabled = sources.filter((s) => s.getMeta().enabled)
  // 展示名映射（event.sources → FeedItemSource.name 用）
  const metaMap = new Map<string, FeedSourceMeta>(enabled.map((s) => [s.id, s.getMeta()]))

  // 热点平台共享一次 fetchAllHot（注入缓存，避免重复网络请求）
  const hasHot = enabled.some((s) => s.kind === 'hot')
  if (hasHot) await prefetchHotAll()

  const collected: FeedItem[] = (await Promise.all(enabled.map((s) => s.collect()))).flat()

  // 规整为 HotSourceItem[] 喂给既有 dedupeAndRank（platform 用 sourceId）
  const norm: HotSourceItem[] = collected.map((i) => ({
    platform: i.sourceId,
    title: i.title,
    url: i.url ?? '',
    hot: i.hot
  }))

  const platformWeights: Record<string, number> = {}
  for (const s of enabled) platformWeights[s.id] = 1
  const events = dedupeAndRank(norm, { platformWeights })

  const items: FeedItem[] = events.map((e) => {
    // 用 event.id（=simhash(title)）匹配原始 FeedItem，补全 sourceKind/category/meta/url
    const sameId = collected.filter((i) => i.id === e.id)
    const best: FeedItem | undefined =
      sameId.length > 0 ? sameId.reduce((a, b) => (b.hot > a.hot ? b : a)) : collected.find((i) => i.title === e.title)

    const src: FeedItemSource[] = e.sources.map((hs) => ({
      platform: hs.platform,
      name: metaMap.get(hs.platform)?.name ?? hs.platform,
      title: hs.title,
      url: hs.url,
      hot: hs.hot
    }))

    if (!best) {
      // 极端兜底：直接由 event 构造（理论上不会走到）
      return {
        id: e.id,
        title: e.title,
        hot: e.hot,
        sources: src,
        sourceKind: e.sources[0] ? (metaMap.get(e.sources[0].platform)?.kind ?? 'hot') : 'hot',
        sourceId: e.sources[0]?.platform ?? '',
        category: categorize(e.title),
        firstSeen: Date.now()
      }
    }

    return {
      id: e.id,
      title: e.title,
      url: best.url,
      hot: e.hot,
      sources: src,
      sourceKind: best.sourceKind,
      sourceId: best.sourceId,
      category: best.category,
      meta: best.meta,
      firstSeen: Date.now()
    }
  })

  const sourcesStatus: FeedSourceStatus[] = enabled.map((s) => ({
    id: s.id,
    status: 'ok',
    count: collected.filter((i) => i.sourceId === s.id).length,
    error: undefined
  }))

  return { items, sources: sourcesStatus, updatedAt: Date.now() }
}
