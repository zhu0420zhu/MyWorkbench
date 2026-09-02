/* 纯函数：判断常驻任务是否到期（无 electron 依赖，便于无头测试与调度复用） */
export function isJobDue(lastRunAt: number | null, intervalMs: number, now: number): boolean {
  if (lastRunAt == null) return true
  return now - lastRunAt >= intervalMs
}
