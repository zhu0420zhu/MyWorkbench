/* ============================================
 * 多平台发布 · 任务队列（JSON 持久化）+ 指数退避重试
 * ============================================ */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { getLogger } from '../tools/logger.ts'
import { getAdapter, type PublishContext, type PublishInput, type PublishJob } from './adapter.ts'

const logger = getLogger('publishQueue')

export interface QueueOptions {
  filePath: string
  maxRetries?: number
}

/** 指数退避：第 n 次重试等待 1min / 5min / 30min */
export function backoffMs(attempt: number): number {
  if (attempt <= 0) return 60 * 1000
  if (attempt === 1) return 5 * 60 * 1000
  return 30 * 60 * 1000
}

export class PublishQueue {
  private jobs: PublishJob[] = []
  private filePath: string
  private maxRetries: number
  private running = new Set<string>()

  constructor(opts: QueueOptions) {
    this.filePath = opts.filePath
    this.maxRetries = opts.maxRetries ?? 3
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as PublishJob[]
      this.jobs = Array.isArray(parsed) ? parsed : []
      logger.info(`发布队列已加载: ${this.jobs.length} 条任务`)
    } catch {
      this.jobs = []
    }
  }

  private async save(): Promise<void> {
    try {
      await fs.mkdir(dirname(this.filePath), { recursive: true })
      await fs.writeFile(this.filePath, JSON.stringify(this.jobs, null, 2), 'utf8')
    } catch (err) {
      logger.error(`发布队列持久化失败: ${(err as Error).message}`)
    }
  }

  list(): PublishJob[] {
    return [...this.jobs].sort((a, b) => b.createdAt - a.createdAt)
  }

  async add(input: PublishInput, platformId: string, contentId = '', scheduledAt?: number): Promise<PublishJob> {
    const now = Date.now()
    const job: PublishJob = {
      id: randomUUID(),
      contentId,
      title: input.title,
      content: input.content,
      platformId,
      status: 'pending',
      scheduledAt: scheduledAt && scheduledAt > now ? scheduledAt : undefined,
      retryCount: 0,
      createdAt: now,
      updatedAt: now
    }
    this.jobs.push(job)
    await this.save()
    return job
  }

  /** 执行单个任务（成功/失败/超限终态；未到预约时间则不执行） */
  async runJob(id: string, ctx: PublishContext): Promise<PublishJob | null> {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) return null
    if (this.running.has(id)) return job
    if (job.scheduledAt && job.scheduledAt > Date.now()) return job // 未到预约时间

    const adapter = getAdapter(job.platformId)
    if (!adapter) {
      job.status = 'failed'
      job.error = '平台适配器不存在'
      job.updatedAt = Date.now()
      await this.save()
      return job
    }
    if (adapter.status === 'skeleton') {
      job.status = 'failed'
      job.error = '该平台适配器尚未完成，敬请期待'
      job.updatedAt = Date.now()
      await this.save()
      return job
    }

    this.running.add(id)
    job.status = 'running'
    job.updatedAt = Date.now()
    await this.save()
    try {
      const result = await adapter.publish({ title: job.title, content: job.content }, ctx)
      if (result.ok) {
        job.status = 'success'
        job.mode = result.mode
        job.externalId = result.externalId
        job.error = undefined
        logger.info(`发布成功 [${job.platformId}] ${job.title.slice(0, 20)}`)
      } else {
        await this.markFailed(job, result.error ?? '发布失败')
      }
    } catch (err) {
      await this.markFailed(job, (err as Error).message)
    } finally {
      this.running.delete(id)
    }
    await this.save()
    return job
  }

  private async markFailed(job: PublishJob, error: string): Promise<void> {
    job.retryCount += 1
    job.error = error
    // 未超限的任务仍可被 pendingJobs() 按退避时间重跑
    job.status = 'failed'
    job.updatedAt = Date.now()
    logger.warning(`发布失败 [${job.platformId}] 第 ${job.retryCount} 次: ${error}`)
  }

  /** 重试失败任务（带退避：未到退避时间则保持 pending） */
  async retry(id: string, force = false): Promise<PublishJob | null> {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) return null
    if (job.status === 'running') return job
    if (!force && job.status === 'failed' && job.retryCount > 0 && job.retryCount < this.maxRetries) {
      const wait = backoffMs(job.retryCount - 1)
      if (Date.now() - job.updatedAt < wait) {
        job.status = 'pending'
        await this.save()
        return job
      }
    }
    job.status = 'pending'
    await this.save()
    return job
  }

  /** 到期待执行的任务（pending 且到达 scheduledAt；失败未超限且过退避期） */
  pendingJobs(): PublishJob[] {
    const now = Date.now()
    return this.jobs.filter((j) => {
      if (j.status === 'running') return false
      if (j.scheduledAt && j.scheduledAt > now) return false // 未到预约时间
      if (j.status === 'pending') return true
      if (j.status === 'failed' && j.retryCount < this.maxRetries) {
        return now - j.updatedAt >= backoffMs(j.retryCount - 1)
      }
      return false
    })
  }

  async runPending(ctx: PublishContext): Promise<PublishJob[]> {
    const done: PublishJob[] = []
    for (const job of this.pendingJobs()) {
      const r = await this.runJob(job.id, ctx)
      if (r) done.push(r)
    }
    return done
  }
}
