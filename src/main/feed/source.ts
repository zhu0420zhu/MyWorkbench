/* ============================================================
 * feed —— 统一数据源接口
 * 所有「数据源」（16 个热点平台 + 各智能体任务）都实现 FeedSource，
 * 由 aggregator / feedService 统一调度。
 * ============================================================ */

import type { FeedItem, FeedSourceMeta, FeedSourceConfig } from '../../shared/types.ts'

export interface FeedSource {
  /** 数据源 id（weibo / hn-briefing / ...） */
  id: string
  kind: 'hot' | 'agent'
  /** 拉取本源条目（合并进统一 feed 用） */
  collect(): Promise<FeedItem[]>
  /** 管理面板元信息（同步；快照式，runNow/setConfig 时刷新） */
  getMeta(): FeedSourceMeta
  /** 立即运行一次（智能体任务 / 热点也可手动刷新单源） */
  runNow(): Promise<FeedItem[]>
  /** 设置启用 / 周期 */
  setConfig(c: FeedSourceConfig): void
}
