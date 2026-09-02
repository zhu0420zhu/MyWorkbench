/* ============================================
 * 笔记增强功能 IPC 注册（标签 / 检索表 / 智能分类 / 导出导入）
 * 契约类型见 src/shared/types.ts，preload 见 src/preload/index.ts
 * ============================================ */

import { ipcMain } from 'electron'
import type { NoteExportBundle } from '../../shared/types'
import { updateNoteMeta, createNotesBatch, repairNoteEncoding, repairAllNoteEncodings } from '../notes'
import { listTags, addTag, renameTag, removeTag } from './tagsStore'
import { listRules, addRule, updateRule, removeRule, applyAutoCategorize } from './rulesStore'
import { listTables, addTable, updateTable, removeTable, buildIndex } from './indexStore'
import { exportBundle, exportMarkdown, importBundle } from './exportStore'

export function registerNotesFeatureIpc(): void {
  // ---- 笔记元数据（标签/分类） ----
  ipcMain.handle(
    'notes:update-meta',
    (_e, id: string, meta: { tags?: string[]; category?: string; categorizedBy?: 'auto' | 'manual' }) =>
      updateNoteMeta(id, meta)
  )
  // 批量创建（多格式导入）
  ipcMain.handle('notes:create-batch', (_e, inputs: Array<{ title: string; content: string }>) =>
    createNotesBatch(inputs)
  )
  // 编码修复（GBK → UTF-8）：单条/全部
  ipcMain.handle('notes:repair-encoding', (_e, id: string) => repairNoteEncoding(id))
  ipcMain.handle('notes:repair-all-encodings', () => repairAllNoteEncodings())

  // ---- 标签 ----
  ipcMain.handle('notes-feature:tags-list', () => listTags())
  ipcMain.handle('notes-feature:tags-add', (_e, name: string) => addTag(name))
  ipcMain.handle('notes-feature:tags-rename', (_e, oldName: string, newName: string) => renameTag(oldName, newName))
  ipcMain.handle('notes-feature:tags-remove', (_e, name: string) => removeTag(name))

  // ---- 分类规则 ----
  ipcMain.handle('notes-feature:rules-list', () => listRules())
  ipcMain.handle(
    'notes-feature:rules-add',
    (_e, input: { name: string; keywords: string[]; category: string }) => addRule(input)
  )
  ipcMain.handle(
    'notes-feature:rules-update',
    (_e, id: string, input: { name: string; keywords: string[]; category: string }) => updateRule(id, input)
  )
  ipcMain.handle('notes-feature:rules-remove', (_e, id: string) => removeRule(id))
  ipcMain.handle('notes-feature:rules-apply', () => applyAutoCategorize())

  // ---- 检索表 ----
  ipcMain.handle('notes-feature:indexes-list', () => listTables())
  ipcMain.handle('notes-feature:indexes-add', (_e, input: Parameters<typeof addTable>[0]) => addTable(input))
  ipcMain.handle('notes-feature:indexes-update', (_e, id: string, input: Parameters<typeof updateTable>[1]) =>
    updateTable(id, input)
  )
  ipcMain.handle('notes-feature:indexes-remove', (_e, id: string) => removeTable(id))
  ipcMain.handle('notes-feature:indexes-build', (_e, id: string) => buildIndex(id))

  // ---- 导出 / 导入 ----
  ipcMain.handle('notes-feature:export-json', () => exportBundle())
  ipcMain.handle('notes-feature:export-markdown', () => exportMarkdown())
  ipcMain.handle('notes-feature:import', (_e, bundle: NoteExportBundle) => importBundle(bundle))
}
