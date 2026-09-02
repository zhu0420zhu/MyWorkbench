/* ============================================================
 * feed —— 服务层（注册表 + 启用/周期/立即运行/历史/通知）
 * 持有全部 FeedSource，复用 ConfigStore 持久化启用/周期与运行历史；
 * 复用 isJobDue 做周期调度；通知直接复用 hotNotifier 的现有实现。
 * ============================================================ */

import { randomUUID } from 'node:crypto'
import { ConfigStore } from '../configStore.ts'
import { getLogger } from '../tools/logger.ts'
import { getAgentScheduler } from '../agents/index.ts'
import { loadNotifySettings, saveNotifySettings } from '../hotNotifier.ts'
import { createHotSources } from './sources/hotSource.ts'
import { createAgentSources } from './sources/agentSource.ts'
import { aggregateFeed } from './aggregator.ts'
import { isJobDue } from '../agents/due.ts'
import type { FeedSource } from './source.ts'
import type {
  FeedItem,
  FeedSourceMeta,
  FeedSourceConfig,
  FeedResult,
  FeedRunRecord,
  FeedNotifySettings
} from '../../shared/types.ts'

const logger = getLogger('feed')

const DEFAULT_NOTIFY: FeedNotifySettings = {
  enabled: false,
  intervalMinutes: 15,
  topCount: 10,
  notifyAgents: true
}

const HISTORY_LIMIT = 30

export class FeedService {
  private sources: Map<string, FeedSource>
  private cfg: ConfigStore<{ sources: Record<string, FeedSourceConfig> }>
  private history: ConfigStore<{ records: FeedRunRecord[] }>
  private notifySettings: ConfigStore<FeedNotifySettings>
  private timer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.sources = new Map<string, FeedSource>()
    for (const s of createHotSources()) this.sources.set(s.id, s)
    for (const s of createAgentSources(getAgentScheduler())) this.sources.set(s.id, s)
    this.cfg = new ConfigStore<{ sources: Record<string, FeedSourceConfig> }>('feed-sources', {
      sources: {}
    })
    this.history = new ConfigStore<{ records: FeedRunRecord[] }>('feed-history', { records: [] })
    this.notifySettings = new ConfigStore<FeedNotifySettings>('feed-notify', DEFAULT_NOTIFY)
  }

  /** 列出全部数据源元信息（合并 getMeta + 持久化的启用/周期覆盖） */
  async listSources(): Promise<FeedSourceMeta[]> {
    const cfg = await this.cfg.get()
    const out: FeedSourceMeta[] = []
    for (const s of this.sources.values()) {
      const meta = s.getMeta()
      const override = cfg.sources[meta.id]
      if (override) {
        meta.enabled = override.enabled
        meta.intervalMs = override.intervalMs
      }
      out.push(meta)
    }
    return out
  }

  getSource(id: string): FeedSource | undefined {
    return this.sources.get(id)
  }

  /** 立即运行某数据源，写入历史，返回本次产出 */
  async runSource(id: string): Promise<FeedItem[]> {
    const s = this.sources.get(id)
    if (!s) return []
    const items = await s.runNow()
    const rec: FeedRunRecord = {
      id: randomUUID(),
      sourceId: id,
      at: Date.now(),
      ok: true,
      summary: `运行 ${s.getMeta().name}：产出 ${items.length} 条`,
      itemCount: items.length,
      items,
      error: undefined
    }
    const cur = await this.history.get()
    const records = [rec, ...cur.records].slice(0, HISTORY_LIMIT)
    await this.history.set({ records })
    return items
  }

  async setSourceConfig(id: string, c: FeedSourceConfig): Promise<void> {
    const s = this.sources.get(id)
    if (!s) return
    s.setConfig(c)
    const cfg = await this.cfg.get()
    cfg.sources[id] = { enabled: c.enabled, intervalMs: c.intervalMs }
    await this.cfg.set(cfg)
  }

  async historyOf(id: string): Promise<FeedRunRecord[]> {
    const r = await this.history.get()
    return r.records.filter((x) => x.sourceId === id)
  }

  /** 合并后的信息流结果 */
  async result(): Promise<FeedResult> {
    return aggregateFeed([...this.sources.values()])
  }

  async getNotifySettings(): Promise<FeedNotifySettings> {
    const hot = await loadNotifySettings()
    const full = await this.notifySettings.get()
    return { ...hot, notifyAgents: full.notifyAgents }
  }

  async setNotifySettings(s: FeedNotifySettings): Promise<FeedNotifySettings> {
    // notifyAgents 持久化到 feed 配置；热点周期推送（enabled/intervalMinutes/topCount）
    // 交由 hotNotifier 驱动其定时器（原 hot:notifier-set → saveNotifySettings 行为），恢复后保留原能力。
    await this.notifySettings.set(s)
    await saveNotifySettings({
      enabled: s.enabled,
      intervalMinutes: s.intervalMinutes,
      topCount: s.topCount
    })
    return this.getNotifySettings()
  }

  /** 启动周期调度：每 60s 扫描到期（intervalMs>0 且 enabled）的数据源 */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, 60_000)
    logger.info('feed 周期调度已启动（每 60s 扫描到期数据源）')
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    const cfg = await this.cfg.get()
    const now = Date.now()
    for (const s of this.sources.values()) {
      const meta = s.getMeta()
      const override = cfg.sources[meta.id]
      const enabled = override ? override.enabled : meta.enabled
      const intervalMs = override ? override.intervalMs : meta.intervalMs
      if (!enabled || intervalMs <= 0) continue
      if (!isJobDue(meta.lastRunAt, intervalMs, now)) continue
      try {
        await this.runSource(meta.id)
      } catch (err) {
        logger.error(`feed 数据源 ${meta.id} 周期运行失败: ${(err as Error).message}`)
      }
    }
  }
}

let _feedService: FeedService | null = null

/** FeedService 全局单例 */
export function getFeedService(): FeedService {
  if (!_feedService) {
    _feedService = new FeedService()
  }
  return _feedService
}
