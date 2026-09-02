/* 智能分类与整理执行 — 类型定义（移植自 ck 08_工具集/file_organizer.py） */

export type OrganizeActionType = 'move' | 'rename' | 'copy' | 'delete'

export type OrganizeMode = 'category' | 'date' | 'size'

/** 单个整理操作（预览与执行共用） */
export interface OrganizeAction {
  actionType: OrganizeActionType
  sourcePath: string
  /** move/copy/rename 的目标完整路径；delete 为 null */
  targetPath: string | null
  reason: string
  success: boolean
  error: string
}

/** 整理方案预览（执行前返回给调用方确认） */
export interface OrganizePlanPreview {
  totalFiles: number
  estimatedSavings: number
  estimatedSavingsFormatted: string
  createdAt: string
  actions: OrganizeAction[]
}

export interface OrganizeOptions {
  targetBase?: string
  useAi?: boolean
  mode?: OrganizeMode
}

/** 执行结果 */
export interface ExecuteResult {
  successCount: number
  failedCount: number
  totalFiles: number
  actions: OrganizeAction[]
  executedAt: string
}
