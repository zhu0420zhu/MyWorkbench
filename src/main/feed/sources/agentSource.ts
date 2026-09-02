/* ============================================================
 * feed —— 智能体任务数据源（kind:'agent'）
 * 复用 AgentScheduler 已注册的 job（hn-briefing / release-radar），
 * 把每个 job 包装为 FeedSource，统一进 feed 合并链路。
 * ============================================================ */

import type { AgentScheduler, AgentJob } from '../../agents/scheduler.ts'
import { fetchHnBriefing } from '../../agents/jobs/hn.ts'
import { fetchReleaseRadar } from '../../agents/jobs/releaseRadar.ts'
import { simhash64 } from '../../hotDedup.ts'
import type { FeedSource } from '../source.ts'
import type {
  FeedItem,
  FeedItemSource,
  FeedSourceMeta,
  FeedSourceConfig,
  AgentResultItem
} from '../../../shared/types.ts'

/** 各智能体任务默认归类（FeedItem.category 用） */
const AGENT_DEFAULT_CATEGORY: Record<string, string> = {
  'hn-briefing': '科技',
  'release-radar': '科技'
}

/** 各智能体任务默认周期（毫秒），与 scheduler 默认值保持一致 */
const AGENT_DEFAULT_INTERVAL: Record<string, number> = {
  'hn-briefing': 6 * 3600_000,
  'release-radar': 24 * 3600_000
}

/** 从 meta 字符串里尝试解析点数（HN 「120 分 · torvalds」→ 120），失败置 0 */
function parseHotFromMeta(meta?: string): number {
  if (!meta) return 0
  const m = meta.match(/(\d+)/)
  return m ? Number(m[1]) : 0
}

/** 只读访问 AgentScheduler 私有 jobs（不修改 agents 模块） */
function getSchedulerJobs(sched: AgentScheduler): AgentJob[] {
  const anySched = sched as unknown as { jobs?: Map<string, AgentJob> }
  return anySched.jobs ? [...anySched.jobs.values()] : []
}

export function createAgentSources(sched: AgentScheduler): FeedSource[] {
  return getSchedulerJobs(sched).map((job) => {
    // 元信息快照：getMeta 为同步接口，这里维护一份可刷新的副本，
    // 在 runNow / setConfig 时更新（enabled/intervalMs 以 feed 的 ConfigStore 覆盖为准）。
    const meta: FeedSourceMeta = {
      id: job.id,
      name: job.name,
      kind: 'agent',
      description: job.description,
      defaultCategory: AGENT_DEFAULT_CATEGORY[job.id] ?? '科技',
      enabled: true,
      intervalMs: AGENT_DEFAULT_INTERVAL[job.id] ?? 3600_000,
      lastRunAt: null,
      lastStatus: 'idle',
      lastSummary: undefined,
      lastItemCount: 0
    }

    function toItems(items: AgentResultItem[]): FeedItem[] {
      return items.map((it) => {
        const hot = parseHotFromMeta(it.meta)
        const sources: FeedItemSource[] = [
          {
            platform: job.id,
            name: job.name,
            title: it.title,
            url: it.url ?? '',
            hot
          }
        ]
        return {
          id: simhash64(it.title).toString(16).padStart(16, '0'),
          title: it.title,
          url: it.url,
          hot,
          sources,
          sourceKind: 'agent',
          sourceId: job.id,
          category: meta.defaultCategory ?? '科技',
          meta: it.meta,
          firstSeen: Date.now()
        }
      })
    }

    const source: FeedSource = {
      id: job.id,
      kind: 'agent',
      async collect(): Promise<FeedItem[]> {
        const cfg = await sched.getConfig()
        const res =
          job.id === 'release-radar'
            ? await fetchReleaseRadar(cfg.releaseRepos)
            : await fetchHnBriefing()
        return toItems(res.items)
      },
      getMeta(): FeedSourceMeta {
        return { ...meta }
      },
      async runNow(): Promise<FeedItem[]> {
        const result = await sched.runNow(job.id)
        meta.lastRunAt = Date.now()
        meta.lastStatus = result.ok ? 'ok' : 'error'
        meta.lastSummary = result.summary || (result.error ? `失败：${result.error}` : undefined)
        meta.lastItemCount = result.items.length
        return toItems(result.items)
      },
      setConfig(c: FeedSourceConfig): void {
        meta.enabled = c.enabled
        meta.intervalMs = c.intervalMs
        // 持久化到 AgentScheduler 的配置（智能体任务周期/启用的唯一真相来源）
        void sched.setJobConfig(job.id, c)
      }
    }
    return source
  })
}
