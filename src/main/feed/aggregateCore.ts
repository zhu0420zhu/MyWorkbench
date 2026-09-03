/* ============================================================
 * feed —— 聚合纯逻辑（合并 + 去重 + 排序，无 electron 依赖）
 * 把 buildFeedResult 抽离出 aggregator，便于 headless node 直接测试
 * （dedupeAndRank / categorize 均为纯函数）。
 * ============================================================ */

import { dedupeAndRank, type HotSourceItem } from '../hotDedup.ts'
import { categorize } from './categorizeCore.ts'
import type {
  FeedItem,
  FeedItemSource,
  FeedSourceMeta,
  FeedSourceStatus,
  FeedResult
} from '../../shared/types.ts'
import type { FeedSource } from './source.ts'

/**
 * 由已收集到的 FeedItem[] 构建合并结果。
 * @param collected 各源 collect() 已产出的条目（flat）
 * @param metaMap   sourceId -> FeedSourceMeta 展示名映射
 * @param enabled   实际参与合并的源（用于 platformWeights + sourcesStatus）
 */
export function buildFeedResult(
  collected: FeedItem[],
  metaMap: Map<string, FeedSourceMeta>,
  enabled: FeedSource[]
): FeedResult {
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
