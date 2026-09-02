/* ============================================
 * 格式转换引擎 — IPC 桥接
 * 同时暴露「直接转换内核（registry.convert）」与「异步任务队列（复用统一 TaskScheduler）」，
 * 以适配不同调用场景；并暴露格式路由查询与临时文件清理能力。
 * ============================================ */

import { ipcMain } from 'electron'
import { getConverterRegistry } from './registry.ts'
import { getConversionQueue } from './index.ts'
import { getTempCleaner } from './tempCleaner.ts'
import type { TaskState } from '../tasks/scheduler.ts'
import type { ConvertInput, ConversionResult } from './types.ts'

export function registerConvertIpc(): void {
  const registry = getConverterRegistry()
  const queue = getConversionQueue()
  // 启动时重建持久化任务状态（进程重启后残留 running 视为 failed，可 retry 重入队）
  void queue.load()
  const cleaner = getTempCleaner()

  // ---- 直接转换（同步内核，适合小文件/即时结果）----
  ipcMain.handle('convert:convert', (_e, input: ConvertInput): Promise<ConversionResult> => registry.convert(input))

  // ---- 格式路由查询 ----
  ipcMain.handle('convert:supported', () => registry.getSupportedConversions())
  ipcMain.handle('convert:converters', () => registry.getAvailableConverters())
  ipcMain.handle('convert:find-converter', (_e, src: string, tgt: string) =>
    registry.findConverter(src, tgt)
  )

  // ---- 异步任务队列（复用统一 TaskScheduler：状态/进度/并发/取消/重试）----
  ipcMain.handle('convert:submit', (_e, input: ConvertInput) => queue.submit(input))
  ipcMain.handle('convert:submit-batch', (_e, inputs: ConvertInput[]) => queue.submitBatch(inputs))
  ipcMain.handle('convert:get-task', (_e, id: string) => queue.getTask(id))
  ipcMain.handle('convert:list-tasks', (_e, state?: string) =>
    queue.getAllTasks(state as TaskState | undefined)
  )
  ipcMain.handle('convert:cancel', (_e, id: string) => queue.cancel(id))
  ipcMain.handle('convert:progress', () => queue.getProgress())
  ipcMain.handle('convert:retry', (_e, id: string, force?: boolean) => queue.retry(id, force))

  // ---- 临时文件清理 ----
  ipcMain.handle('convert:temp-status', () => cleaner.getTempStatus())
  ipcMain.handle('convert:cleanup-temp', (_e, expireHours?: number) => cleaner.cleanupExpired(expireHours))
}
