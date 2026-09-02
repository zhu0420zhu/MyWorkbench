/* ============================================
 * 转换任务队列（复用统一 TaskScheduler 实现批量/状态/进度/并发）
 * 与 ck convert_queue.py 的行为对齐：提交/批量提交、状态查询、进度、取消、重试。
 * 实际转换逻辑委托给 ConverterRegistry（自动格式路由）。
 * ============================================ */

import { TaskScheduler, type TaskState } from '../tasks/scheduler.ts'
import { getConverterRegistry } from './registry.ts'
import type { ConversionResult, ConvertInput } from './types.ts'

export class ConversionQueue {
  private scheduler: TaskScheduler<ConvertInput, ConversionResult>

  constructor(filePath: string, maxWorkers = 2) {
    this.scheduler = new TaskScheduler<ConvertInput, ConversionResult>({
      filePath,
      kind: 'convert',
      maxWorkers,
      runner: async (input) => getConverterRegistry().convert(input)
    })
  }

  async load(): Promise<void> {
    await this.scheduler.load()
  }

  submit(input: ConvertInput) {
    return this.scheduler.submit(input)
  }

  submitBatch(inputs: ConvertInput[]) {
    return this.scheduler.submitBatch(inputs)
  }

  getTask(id: string) {
    return this.scheduler.get(id)
  }

  getAllTasks(state?: TaskState) {
    return this.scheduler.list(state)
  }

  cancel(id: string): boolean {
    return this.scheduler.cancel(id)
  }

  getProgress() {
    return this.scheduler.progress()
  }

  retry(id: string, force = false) {
    return this.scheduler.retry(id, force)
  }
}
