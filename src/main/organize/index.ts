/* 智能分类与整理执行 — 统一出口 */
export * from './types.ts'
export { FileOrganizer } from './organizer.ts'

import { FileOrganizer } from './organizer.ts'

let _instance: FileOrganizer | null = null

/** 获取 FileOrganizer 全局单例（与 ck get_file_organizer 一致） */
export function getFileOrganizer(): FileOrganizer {
  if (!_instance) _instance = new FileOrganizer()
  return _instance
}
