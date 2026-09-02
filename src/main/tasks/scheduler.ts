/* ============================================
 * 统一任务调度器（JSON 持久化 + 状态机 + 并发控制 + 进度回调）
 * 由 ck 转换队列 / 发布队列 的能力提炼为通用组件，
 * 供「格式转换」「全文索引」等模块复用，避免各自实现一套调度。
 * ============================================ */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { getLogger } from '../tools/logger.ts'

const logger = getLogger('tasks.scheduler')

export type TaskState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface TaskRecord<I, O> {
  id: string
  kind: string
  input: I
  state: TaskState
  output?: O
  error?: string
  retryCount: number
  progress: number
  createdAt: number
  startedAt?: number
  completedAt?: number
}

export interface SchedulerOptions<I, O> {
  /** 持久化 JSON 文件路径（建议放在 userData 下） */
  filePath: string
  /** 任务类型标识，用于日志与统计 */
  kind: string
  /** 最大并发数，默认 2 */
  maxWorkers?: number
  /** 最大重试次数，默认 0（与 ck 转换队列一致：失败即失败，由调用方决定是否重试） */
  maxRetries?: number
  /** 实际执行函数，update 用于上报进度（0~1） */
  runner: (input: I, update: (progress: number) => void) => Promise<O>
  /** 状态变更回调（供 IPC 推送进度） */
  onUpdate?: (task: TaskRecord<I, O>) => void
}

/** 指数退避（与 publish/queue.ts 同范式）：第 n 次重试等待 1min / 5min / 30min */
export function backoffMs(attempt: number): number {
  if (attempt <= 0) return 60 * 1000
  if (attempt === 1) return 5 * 60 * 1000
  return 30 * 60 * 1000
}

export class TaskScheduler<I, O> {
  private tasks = new Map<string, TaskRecord<I, O>>()
  private filePath: string
  private kind: string
  private maxWorkers: number
  private maxRetries: number
  private runner: SchedulerOptions<I, O>['runner']
  private onUpdate?: (task: TaskRecord<I, O>) => void
  private running = 0

  constructor(opts: SchedulerOptions<I, O>) {
    this.filePath = opts.filePath
    this.kind = opts.kind
    this.maxWorkers = opts.maxWorkers ?? 2
    this.maxRetries = opts.maxRetries ?? 0
    this.runner = opts.runner
    this.onUpdate = opts.onUpdate
  }

  /** 启动时加载持久化任务；进程重启后残留 running 视为失败，交由 retry() 重新入队 */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as TaskRecord<I, O>[]
      this.tasks = new Map(parsed.map((t) => [t.id, t]))
      for (const t of this.tasks.values()) {
        if (t.state === 'running') {
          t.state = 'failed'
          t.error = t.error ?? '进程重启中断'
        }
      }
    } catch {
      this.tasks = new Map()
    }
  }

  private async save(): Promise<void> {
    try {
      await fs.mkdir(dirname(this.filePath), { recursive: true })
      await fs.writeFile(this.filePath, JSON.stringify([...this.tasks.values()], null, 2), 'utf8')
    } catch (err) {
      logger.error(`调度器持久化失败 [${this.kind}]: ${(err as Error).message}`)
    }
  }

  list(filterState?: TaskState): TaskRecord<I, O>[] {
    const all = [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
    return filterState ? all.filter((t) => t.state === filterState) : all
  }

  get(id: string): TaskRecord<I, O> | undefined {
    return this.tasks.get(id)
  }

  async submit(input: I): Promise<TaskRecord<I, O>> {
    const task: TaskRecord<I, O> = {
      id: randomUUID(),
      kind: this.kind,
      input,
      state: 'pending',
      retryCount: 0,
      progress: 0,
      createdAt: Date.now()
    }
    this.tasks.set(task.id, task)
    await this.save()
    this.pump()
    return task
  }

  async submitBatch(inputs: I[]): Promise<TaskRecord<I, O>[]> {
    const out: TaskRecord<I, O>[] = []
    for (const inp of inputs) out.push(await this.submit(inp))
    return out
  }

  /** 取消等待中的任务 */
  cancel(id: string): boolean {
    const t = this.tasks.get(id)
    if (!t) return false
    if (t.state === 'pending') {
      t.state = 'cancelled'
      this.onUpdate?.(t)
      void this.save()
      return true
    }
    return false
  }

  /** 进度概览（与 ck 转换队列 get_progress 对齐） */
  progress(): {
    total: number
    pending: number
    running: number
    completed: number
    failed: number
    progressPercent: number
  } {
    const all = [...this.tasks.values()]
    const total = all.length
    const pending = all.filter((t) => t.state === 'pending').length
    const running = all.filter((t) => t.state === 'running').length
    const completed = all.filter((t) => t.state === 'completed').length
    const failed = all.filter((t) => t.state === 'failed').length
    return {
      total,
      pending,
      running,
      completed,
      failed,
      progressPercent: total ? Math.round((completed / total) * 1000) / 10 : 0
    }
  }

  /** 手动重试（force 忽略 maxRetries 限制） */
  retry(id: string, force = false): TaskRecord<I, O> | undefined {
    const t = this.tasks.get(id)
    if (!t) return undefined
    if (t.state === 'running') return t
    if (!force && t.state === 'failed' && t.retryCount >= this.maxRetries) return t
    t.state = 'pending'
    t.error = undefined
    t.progress = 0
    this.onUpdate?.(t)
    void this.save()
    this.pump()
    return t
  }

  private pump(): void {
    if (this.running >= this.maxWorkers) return
    for (const t of this.tasks.values()) {
      if (this.running >= this.maxWorkers) break
      if (t.state !== 'pending') continue
      this.running++
      t.state = 'running'
      t.startedAt = Date.now()
      this.onUpdate?.(t)
      void this.save()
      void this.execute(t)
    }
  }

  private async execute(task: TaskRecord<I, O>): Promise<void> {
    try {
      const output = await this.runner(task.input, (p: number) => {
        task.progress = Math.max(0, Math.min(1, p))
        this.onUpdate?.(task)
      })
      task.output = output
      task.state = 'completed'
      task.progress = 1
      task.completedAt = Date.now()
      this.onUpdate?.(task)
    } catch (err) {
      task.error = (err as Error).message
      task.retryCount++
      task.state = 'failed'
      task.completedAt = Date.now()
      logger.warning(`任务失败 [${this.kind}] ${task.id}: ${task.error}`)
      this.onUpdate?.(task)
    } finally {
      this.running--
      await this.save()
      this.pump()
    }
  }
}
