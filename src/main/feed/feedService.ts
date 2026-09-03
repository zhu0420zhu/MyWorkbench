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
import { createCustomFeedSource } from './sources/customSource.ts'
import { aggregateFeed } from './aggregator.ts'
import { isJobDue } from '../agents/due.ts'
import type { FeedSource } from './source.ts'
import type {
  FeedItem,
  FeedSourceMeta,
  FeedSourceConfig,
  FeedResult,
  FeedRunRecord,
  FeedNotifySettings,
  CustomFeedSourceDef
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
  private customCfg: ConfigStore<{ sources: CustomFeedSourceDef[] }>
  private history: ConfigStore<{ records: FeedRunRecord[] }>
  private notifySettings: ConfigStore<FeedNotifySettings>
  private timer: ReturnType<typeof setInterval> | null = null
  private customLoaded = false

  constructor() {
    this.sources = new Map<string, FeedSource>()
    for (const s of createHotSources()) this.sources.set(s.id, s)
    for (const s of createAgentSources(getAgentScheduler())) this.sources.set(s.id, s)
    this.cfg = new ConfigStore<{ sources: Record<string, FeedSourceConfig> }>('feed-sources', {
      sources: {}
    })
    this.customCfg = new ConfigStore<{ sources: CustomFeedSourceDef[] }>('feed-custom-sources', {
      sources: []
    })
    this.history = new ConfigStore<{ records: FeedRunRecord[] }>('feed-history', { records: [] })
    this.notifySettings = new ConfigStore<FeedNotifySettings>('feed-notify', DEFAULT_NOTIFY)
  }

  private async loadCustomSources(): Promise<void> {
    if (this.customLoaded) return
    this.customLoaded = true
    try {
      const custom = await this.customCfg.get()
      for (const def of custom.sources) {
        if (!def?.id || this.sources.has(def.id)) continue
        const source = createCustomFeedSource(def)
        const anySource = source as unknown as { __def: CustomFeedSourceDef }
        anySource.__def = { ...def }
        this.sources.set(def.id, source)
      }
    } catch (err) {
      logger.error(`加载自定义 feed 源失败: ${(err as Error).message}`)
    }
  }

  private async saveCustomSources(): Promise<void> {
    const defs: CustomFeedSourceDef[] = []
    for (const s of this.sources.values()) {
      const meta = s.getMeta()
      if (meta.builtIn) continue
      // 自定义源通过 source 上的内部 def 快照重建
      const anySource = s as unknown as { __def?: CustomFeedSourceDef }
      if (anySource.__def) {
        defs.push(anySource.__def)
      }
    }
    await this.customCfg.set({ sources: defs })
  }

  /** 列出全部数据源元信息（合并 getMeta + 持久化的启用/周期覆盖） */
  async listSources(): Promise<FeedSourceMeta[]> {
    await this.loadCustomSources()
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

  /** 添加自定义数据源 */
  async addSource(def: CustomFeedSourceDef): Promise<FeedSourceMeta> {
    await this.loadCustomSources()
    if (!def.id || !def.name) throw new Error('数据源 id 与名称不能为空')
    if (this.sources.has(def.id)) throw new Error(`数据源 ${def.id} 已存在`)
    const source = createCustomFeedSource(def)
    // 在 source 上挂载 def 快照，便于 saveCustomSources 序列化
    const anySource = source as unknown as { __def: CustomFeedSourceDef }
    anySource.__def = { ...def }
    this.sources.set(def.id, source)
    await this.saveCustomSources()
    return source.getMeta()
  }

  /** 删除数据源；内置源不可删除 */
  async removeSource(id: string): Promise<void> {
    await this.loadCustomSources()
    const s = this.sources.get(id)
    if (!s) throw new Error(`数据源 ${id} 不存在`)
    const meta = s.getMeta()
    if (meta.builtIn) throw new Error('内置数据源不可删除')
    this.sources.delete(id)
    const cfg = await this.cfg.get()
    delete cfg.sources[id]
    await this.cfg.set(cfg)
    await this.saveCustomSources()
  }

  /** 立即运行某数据源，写入历史，返回本次产出 */
  async runSource(id: string): Promise<FeedItem[]> {
    await this.loadCustomSources()
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
    await this.loadCustomSources()
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
    await this.loadCustomSources()
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
    await this.loadCustomSources()
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
