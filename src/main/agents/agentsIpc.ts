/* ============================================================
 * 常驻智能体 — IPC 桥接
 * 暴露任务列表 / 历史 / 手动执行 / 配置；注册时启动周期调度。
 * ============================================================ */

import { ipcMain } from 'electron'
import { getAgentScheduler } from './index.ts'
import type { AgentJobInfo, AgentRunRecord, AgentsConfig, AgentConfig, AgentRunResult } from '../../shared/types.ts'

export function registerAgentsIpc(): void {
  const s = getAgentScheduler()
  void s.load()
  s.start()

  ipcMain.handle('agents:list', (): Promise<AgentJobInfo[]> => s.list())
  ipcMain.handle('agents:history', (_e, id: string): Promise<AgentRunRecord[]> => s.historyOf(id))
  ipcMain.handle('agents:run-now', (_e, id: string): Promise<AgentRunResult> => s.runNow(id))
  ipcMain.handle('agents:config', (_e, patch: Partial<AgentsConfig>): Promise<AgentsConfig> => s.setConfig(patch))
  ipcMain.handle(
    'agents:job-config',
    (_e, id: string, c: Partial<AgentConfig>): Promise<AgentsConfig> => s.setJobConfig(id, c)
  )
}
