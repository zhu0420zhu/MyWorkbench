/* ============================================================
 * feed —— 聚合器（合并 + 去重 + 排序）
 * 主进程入口：过滤启用源、触发热点平台预取（唯一触及 electron 的调用），
 * 收集各源条目后委托给纯逻辑 buildFeedResult（可 headless 测试）。
 * ============================================================ */

import type { FeedSource } from './source.ts'
import type { FeedItem, FeedResult, FeedSourceMeta } from '../../shared/types.ts'
import { prefetchHotAll } from './sources/hotSource.ts'
import { buildFeedResult } from './aggregateCore.ts'

export async function aggregateFeed(sources: FeedSource[]): Promise<FeedResult> {
  const enabled = sources.filter((s) => s.getMeta().enabled)
  // 展示名映射（event.sources → FeedItemSource.name 用）
  const metaMap = new Map<string, FeedSourceMeta>(enabled.map((s) => [s.id, s.getMeta()]))

  // 热点平台共享一次 fetchAllHot（注入缓存，避免重复网络请求）
  const hasHot = enabled.some((s) => s.kind === 'hot')
  if (hasHot) await prefetchHotAll()

  const collected: FeedItem[] = (await Promise.all(enabled.map((s) => s.collect()))).flat()

  return buildFeedResult(collected, metaMap, enabled)
}
