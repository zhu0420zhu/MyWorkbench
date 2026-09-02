/* ============================================================
 * 常驻智能体调度器（Always-on Agents）
 * 移植自 awesome-llm-apps 的 Always-on Agents（HN Briefing / Release Radar）。
 * 复用：统一配置管理（ConfigStore）、日志（getLogger）；运行期依赖公开 API。
 * 仅主进程使用（setInterval 周期扫描 + Electron Notification 通知）。
 * ============================================================ */

import { randomUUID } from 'node:crypto'
import { Notification } from 'electron'
import { ConfigStore } from '../configStore.ts'
import { getLogger } from '../tools/logger.ts'
import type {
  AgentsConfig,
  AgentConfig,
  AgentJobInfo,
  AgentRunRecord,
  AgentRunResult
} from '../../shared/types.ts'
import { isJobDue } from './due.ts'

const logger = getLogger('agents')

export interface AgentJob {
  id: string
  name: string
  description: string
  run: (repos?: string[]) => Promise<AgentRunResult>
}

const DEFAULT_INTERVAL: Record<string, number> = {
  'hn-briefing': 6 * 3600_000,
  'release-radar': 24 * 3600_000
}

export class AgentScheduler {
  private jobs = new Map<string, AgentJob>()
  private cfg: ConfigStore<AgentsConfig>
  private history: ConfigStore<{ records: AgentRunRecord[] }>
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly historyLimit = 30

  constructor() {
    this.cfg = new ConfigStore<AgentsConfig>('agents-config', {
      jobs: {
        'hn-briefing': { enabled: true, intervalMs: DEFAULT_INTERVAL['hn-briefing'] },
        'release-radar': { enabled: true, intervalMs: DEFAULT_INTERVAL['release-radar'] }
      },
      releaseRepos: ['electron/electron', 'microsoft/vscode']
    })
    this.history = new ConfigStore<{ records: AgentRunRecord[] }>('agents-history', { records: [] })
  }

  async load(): Promise<void> {
    await this.cfg.load()
    await this.history.load()
  }

  register(job: AgentJob): void {
    this.jobs.set(job.id, job)
  }

  async getConfig(): Promise<AgentsConfig> {
    return this.cfg.get()
  }

  async setConfig(patch: Partial<AgentsConfig>): Promise<AgentsConfig> {
    return this.cfg.set(patch)
  }

  async setJobConfig(id: string, c: Partial<AgentConfig>): Promise<AgentsConfig> {
    const cur = await this.cfg.get()
    cur.jobs[id] = {
      ...(cur.jobs[id] ?? { enabled: true, intervalMs: DEFAULT_INTERVAL[id] ?? 3600_000 }),
      ...c
    }
    return this.cfg.set(cur)
  }

  async list(): Promise<AgentJobInfo[]> {
    const cfg = await this.cfg.get()
    const records = await this.history.get()
    return [...this.jobs.values()].map((j) => {
      const c = cfg.jobs[j.id] ?? { enabled: true, intervalMs: DEFAULT_INTERVAL[j.id] ?? 3600_000 }
      const recs = records.records.filter((r) => r.jobId === j.id)
      const last = recs[0]
      return {
        id: j.id,
        name: j.name,
        description: j.description,
        enabled: c.enabled,
        intervalMs: c.intervalMs,
        lastRunAt: last?.at ?? null,
        lastStatus: last ? (last.ok ? 'ok' : 'error') : 'idle',
        lastSummary: last?.summary
      }
    })
  }

  async historyOf(id: string): Promise<AgentRunRecord[]> {
    const r = await this.history.get()
    return r.records.filter((x) => x.jobId === id)
  }

  /** 立即执行一次（手动触发） */
  async runNow(id: string): Promise<AgentRunResult> {
    const job = this.jobs.get(id)
    if (!job) return { ok: false, summary: '', items: [], error: '未知任务' }
    const cfg = await this.cfg.get()
    const result = id === 'release-radar' ? await job.run(cfg.releaseRepos) : await job.run()
    await this.recordRun(id, result)
    this.notify(job, result)
    return result
  }

  private async recordRun(id: string, result: AgentRunResult): Promise<void> {
    const rec: AgentRunRecord = {
      id: randomUUID(),
      jobId: id,
      at: Date.now(),
      ok: result.ok,
      summary: result.summary,
      itemCount: result.items?.length ?? 0,
      items: result.items ?? [],
      error: result.error
    }
    const cur = await this.history.get()
    const records = [rec, ...cur.records].slice(0, this.historyLimit)
    await this.history.set({ records })
  }

  private notify(job: AgentJob, result: AgentRunResult): void {
    if (!result.ok || !result.summary) return
    try {
      new Notification({ title: `灵墨 · ${job.name}`, body: result.summary }).show()
    } catch {
      /* 无桌面环境（如测试）时静默忽略 */
    }
  }

  /** 启动周期检查（仅主进程调用）。每 60s 扫描到期任务。 */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), 60_000)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    const cfg = await this.cfg.get()
    const records = await this.history.get()
    const now = Date.now()
    for (const job of this.jobs.values()) {
      const c = cfg.jobs[job.id]
      if (!c?.enabled) continue
      const last = records.records.find((r) => r.jobId === job.id)
      if (!isJobDue(last?.at ?? null, c.intervalMs, now)) continue
      try {
        const result = job.id === 'release-radar' ? await job.run(cfg.releaseRepos) : await job.run()
        await this.recordRun(job.id, result)
        this.notify(job, result)
      } catch (err) {
        logger.error(`常驻智能体执行失败 ${job.id}: ${(err as Error).message}`)
      }
    }
  }
}
