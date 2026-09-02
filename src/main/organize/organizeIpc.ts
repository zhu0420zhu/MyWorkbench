/* ============================================
 * 智能分类与整理执行 — IPC 桥接
 * 暴露 getFileOrganizer 的核心能力给渲染进程（domain: action 范式）。
 * ============================================ */

import { ipcMain } from 'electron'
import { getFileOrganizer } from './index.ts'
import type {
  ExecuteResult,
  OrganizeAction,
  OrganizeOptions,
  OrganizePlanPreview
} from './types.ts'

export function registerOrganizeIpc(): void {
  const organizer = getFileOrganizer()
  void organizer.loadMemory()

  // 整理目标基目录（配置管理复用 configStore）
  ipcMain.handle('organize:get-target-base', () => organizer.getTargetBase())
  ipcMain.handle('organize:set-target-base', (_e, dir: string) => organizer.setTargetBase(dir))

  // AI 语义分类（复用 lingmo ai.ts 云端端点，失败回退规则分类；记忆优先）
  ipcMain.handle('organize:ai-classify', (_e, filePaths: string[], useAi?: boolean) =>
    organizer.aiClassify(filePaths, useAi ?? true)
  )

  // 分类纠正记忆（个性化，移植自 Memory #11）
  ipcMain.handle('organize:record-correction', (_e, filePath: string, category: string) =>
    organizer.recordCorrection(filePath, category)
  )
  ipcMain.handle('organize:memory-list', () => organizer.listMemory())
  ipcMain.handle('organize:memory-clear', () => organizer.clearMemory())

  // 生成整理方案（仅预览，不改动文件）
  ipcMain.handle(
    'organize:generate-plan',
    (_e, filePaths: string[], opts?: OrganizeOptions): Promise<OrganizePlanPreview> =>
      organizer.generatePlan(filePaths, opts)
  )

  // 执行整理方案（move / rename / copy / delete）
  ipcMain.handle(
    'organize:execute-plan',
    (_e, actions: OrganizeAction[]): Promise<ExecuteResult> => organizer.executePlan(actions)
  )
}
