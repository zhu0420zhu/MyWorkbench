/* ============================================
 * 长篇作品 IPC 注册（作品 / 分卷 / 章节）
 * 契约类型见 src/shared/types.ts，preload 见 src/preload/index.ts
 * ============================================ */

import { ipcMain } from 'electron'
import type {
  AiEditInput,
  BuildContextOptions,
  ChapterStatus,
  ConsistencyIssue,
  ContextBlock,
  EntityKind,
  ForeshadowStatus,
  InspirationKind,
  InspirationNote,
  SkillExportBundle,
  SkillImportResult,
  SkillRunResult,
  WritingSkill
} from '../../shared/types'
import { createSnapshot, clearSnapshots } from '../snapshots'
import {
  listEntities,
  getEntity,
  createEntity,
  updateEntity,
  removeEntity,
  reorderEntities,
  listRelations,
  upsertRelation,
  removeRelation,
  listStates,
  setState,
  removeState,
  detectMentions
} from './entities'
import { indexChapter, unindexChapter } from './chapterIndex'
import {
  buildContextBundle,
  listPinnedNotes,
  addPinnedNote,
  removePinnedNote
} from './contextBuilder'
import { runAiEdit } from './aiEdit'
import { auditProject, applyConsistencyFix } from './consistency'
import { recountTokens, renderBundlePrompt } from './contextCore'
import {
  listForeshadows,
  createForeshadow,
  updateForeshadow,
  setForeshadowStatus,
  removeForeshadow,
  listOverdue
} from './foreshadow'
import {
  listInspirations,
  createInspiration,
  updateInspiration,
  removeInspiration,
  listSkills,
  createSkill,
  updateSkill,
  removeSkill,
  runSkill,
  exportSkills,
  importSkills
} from './inspiration'
import {
  listProjects,
  createProject,
  getProject,
  updateProject,
  removeProject,
  createVolume,
  updateVolume,
  removeVolume,
  createChapter,
  getChapter,
  updateChapter,
  removeChapter,
  reorderChapter,
  collectChapters,
  readChapterContent,
  type CreateProjectInput
} from './store'

export function registerNovelIpc(): void {
  // ---- 作品 ----
  ipcMain.handle('novel:list-projects', () => listProjects())
  ipcMain.handle('novel:create-project', (_e, input: CreateProjectInput) => createProject(input))
  ipcMain.handle('novel:get-project', (_e, projectId: string) => getProject(projectId))
  ipcMain.handle(
    'novel:update-project',
    (_e, projectId: string, patch: { title?: string; genre?: string; synopsis?: string; targetWords?: number }) =>
      updateProject(projectId, patch)
  )
  ipcMain.handle('novel:remove-project', (_e, projectId: string) => removeProject(projectId))

  // ---- 分卷 ----
  ipcMain.handle('novel:create-volume', (_e, projectId: string, title: string, summary?: string) =>
    createVolume(projectId, title, summary)
  )
  ipcMain.handle(
    'novel:update-volume',
    (_e, projectId: string, volumeId: string, patch: { title?: string; summary?: string }) =>
      updateVolume(projectId, volumeId, patch)
  )
  ipcMain.handle(
    'novel:remove-volume',
    (_e, projectId: string, volumeId: string, mode: 'delete-chapters' | 'move-to-first') =>
      removeVolume(projectId, volumeId, mode)
  )

  // ---- 章节 ----
  ipcMain.handle(
    'novel:create-chapter',
    (
      _e,
      input: { projectId: string; volumeId: string; title?: string; summary?: string; wordGoal?: number }
    ) => createChapter(input)
  )
  ipcMain.handle('novel:get-chapter', (_e, projectId: string, chapterId: string) =>
    getChapter(projectId, chapterId)
  )
  ipcMain.handle(
    'novel:update-chapter',
    async (
      _e,
      projectId: string,
      chapterId: string,
      patch: {
        title?: string
        summary?: string
        status?: ChapterStatus
        wordGoal?: number
        content?: string
        /** 自动保存节流：距上一个快照不足此毫秒数则跳过（手动保存不传） */
        snapshotMinIntervalMs?: number
      }
    ) => {
      const updated = await updateChapter(projectId, chapterId, patch)
      // 正文变更才打点；自动保存节流到 3 分钟，避免历史被刷屏
      if (updated && patch.content !== undefined) {
        await createSnapshot('chapter', chapterId, patch.content, {
          reason: 'auto',
          minIntervalMs: patch.snapshotMinIntervalMs ?? 180_000
        }).catch(() => undefined)
        // 同步进检索索引：上下文编排要靠它召回"相关旧章片段"
        await indexChapter(projectId, chapterId, patch.content).catch(() => undefined)
      }
      return updated
    }
  )
  ipcMain.handle('novel:remove-chapter', (_e, projectId: string, chapterId: string) =>
    removeChapter(projectId, chapterId).then((chapters) => {
      void clearSnapshots('chapter', chapterId).catch(() => undefined)
      unindexChapter(projectId, chapterId)
      return chapters
    })
  )
  ipcMain.handle(
    'novel:reorder-chapter',
    (_e, projectId: string, chapterId: string, toVolumeId: string, toIndex: number) =>
      reorderChapter(projectId, chapterId, toVolumeId, toIndex)
  )

  // ---- 导出辅助 ----
  ipcMain.handle('novel:collect-chapters', (_e, projectId: string) => collectChapters(projectId))

  /* ---- 设定库：实体卡 / 关系 / 动态状态 ---- */

  ipcMain.handle('novel:list-entities', (_e, projectId: string) => listEntities(projectId))
  ipcMain.handle('novel:get-entity', (_e, projectId: string, entityId: string) =>
    getEntity(projectId, entityId)
  )
  ipcMain.handle(
    'novel:create-entity',
    (
      _e,
      input: {
        projectId: string
        kind: EntityKind
        name: string
        aliases?: string[]
        tagline?: string
        content?: string
        pinned?: boolean
        firstChapterId?: string
      }
    ) => createEntity(input)
  )
  ipcMain.handle(
    'novel:update-entity',
    (
      _e,
      projectId: string,
      entityId: string,
      patch: {
        kind?: EntityKind
        name?: string
        aliases?: string[]
        tagline?: string
        content?: string
        pinned?: boolean
        index?: number
        firstChapterId?: string
      }
    ) => updateEntity(projectId, entityId, patch)
  )
  ipcMain.handle('novel:remove-entity', (_e, projectId: string, entityId: string) =>
    removeEntity(projectId, entityId)
  )
  ipcMain.handle('novel:reorder-entities', (_e, projectId: string, orderedIds: string[]) =>
    reorderEntities(projectId, orderedIds)
  )

  ipcMain.handle('novel:list-relations', (_e, projectId: string) => listRelations(projectId))
  ipcMain.handle(
    'novel:upsert-relation',
    (
      _e,
      input: {
        projectId: string
        id?: string
        fromId: string
        toId: string
        label: string
        bidirectional?: boolean
      }
    ) => upsertRelation(input)
  )
  ipcMain.handle('novel:remove-relation', (_e, projectId: string, relationId: string) =>
    removeRelation(projectId, relationId)
  )

  ipcMain.handle('novel:list-states', (_e, projectId: string, entityId?: string) =>
    listStates(projectId, entityId)
  )
  ipcMain.handle(
    'novel:set-state',
    (
      _e,
      input: { projectId: string; entityId: string; chapterId: string; text: string; id?: string }
    ) => setState(input)
  )
  ipcMain.handle('novel:remove-state', (_e, projectId: string, stateId: string) =>
    removeState(projectId, stateId)
  )

  /** 正文实体识别（别名感知）：传入正文文本，返回按出现次数降序的出场实体 */
  ipcMain.handle('novel:detect-mentions', (_e, projectId: string, text: string) =>
    detectMentions(projectId, text)
  )

  /* ---- 上下文编排器 ---- */

  ipcMain.handle(
    'novel:build-context',
    (_e, projectId: string, chapterId: string, opts?: BuildContextOptions) =>
      buildContextBundle(projectId, chapterId, opts)
  )
  ipcMain.handle('novel:list-pinned-notes', (_e, projectId: string) =>
    listPinnedNotes(projectId)
  )
  ipcMain.handle('novel:add-pinned-note', (_e, projectId: string, text: string) =>
    addPinnedNote(projectId, text)
  )
  ipcMain.handle('novel:remove-pinned-note', (_e, projectId: string, index: number) =>
    removePinnedNote(projectId, index)
  )

  /**
   * 渲染面板里被作者改过的块：重算 token 并拼成提示词。
   * 放在主进程而不是渲染层各自实现一份，是为了让"面板看到的"和"真正发给模型的"永远一致。
   */
  ipcMain.handle('novel:render-context', (_e, blocks: ContextBlock[]) => {
    const counted = recountTokens(blocks ?? [])
    return {
      blocks: counted,
      totalTokens: counted.filter((b) => b.enabled).reduce((s, b) => s + b.tokens, 0),
      text: renderBundlePrompt(counted)
    }
  })

  /**
   * 全量重建检索索引。
   * 索引是在"章节保存时"增量写入的，本功能上线前就存在的旧章节没有索引，
   * 需要作者手动跑一次，否则上下文编排召不回任何旧章片段。
   */
  ipcMain.handle('novel:reindex-project', async (_e, projectId: string) => {
    const project = await getProject(projectId)
    if (!project) return { indexed: 0, failed: 0 }
    let indexed = 0
    let failed = 0
    for (const c of project.chapters) {
      try {
        const read = await readChapterContent(projectId, c.id)
        if (read?.content.trim()) {
          await indexChapter(projectId, c.id, read.content)
          indexed += 1
        }
      } catch {
        failed += 1
      }
    }
    return { indexed, failed }
  })

  /* ---- 编辑器内 AI 动作（P1-3） ---- */

  ipcMain.handle('novel:ai-edit', (_e, input: AiEditInput) => runAiEdit(input))

  /* ---- 一致性审计（P2-1） ---- */

  ipcMain.handle('novel:audit-project', (_e, projectId: string) => auditProject(projectId))
  ipcMain.handle('novel:apply-fix', (_e, projectId: string, issue: ConsistencyIssue) =>
    applyConsistencyFix(projectId, issue)
  )

  /* ---- 伏笔 / 线索追踪（P2-2） ---- */

  ipcMain.handle('novel:list-foreshadows', (_e, projectId: string) => listForeshadows(projectId))
  ipcMain.handle(
    'novel:create-foreshadow',
    (
      _e,
      input: {
        projectId: string
        content: string
        plantedChapterId: string
        plantedChapterTitle: string
        payoffChapterId?: string
        payoffChapterTitle?: string
        status?: ForeshadowStatus
        note?: string
      }
    ) => createForeshadow(input)
  )
  ipcMain.handle(
    'novel:update-foreshadow',
    (
      _e,
      projectId: string,
      id: string,
      patch: {
        content?: string
        note?: string
        plantedChapterId?: string
        plantedChapterTitle?: string
        payoffChapterId?: string
        payoffChapterTitle?: string
      }
    ) => updateForeshadow(projectId, id, patch)
  )
  ipcMain.handle(
    'novel:set-foreshadow-status',
    (_e, projectId: string, id: string, status: ForeshadowStatus, payoffChapterId?: string, payoffChapterTitle?: string) =>
      setForeshadowStatus(projectId, id, status, payoffChapterId, payoffChapterTitle)
  )
  ipcMain.handle('novel:remove-foreshadow', (_e, projectId: string, id: string) =>
    removeForeshadow(projectId, id)
  )
  ipcMain.handle(
    'novel:list-overdue',
    (_e, projectId: string, currentChapterId: string, threshold: number) =>
      listOverdue(projectId, currentChapterId, threshold)
  )

  /* ---- 灵感工作台：灵感池（按项目，P2-3） ---- */

  ipcMain.handle('novel:list-inspirations', (_e, projectId: string) => listInspirations(projectId))
  ipcMain.handle(
    'novel:create-inspiration',
    (
      _e,
      input: { projectId: string; kind: InspirationKind; content: string; note?: string }
    ) => createInspiration(input)
  )
  ipcMain.handle(
    'novel:update-inspiration',
    (
      _e,
      projectId: string,
      id: string,
      patch: { kind?: InspirationKind; content?: string; note?: string }
    ) => updateInspiration(projectId, id, patch)
  )
  ipcMain.handle('novel:remove-inspiration', (_e, projectId: string, id: string) =>
    removeInspiration(projectId, id)
  )

  /* ---- 灵感工作台：写作 Skill 包（全局，P2-3） ---- */

  ipcMain.handle('novel:list-skills', () => listSkills())
  ipcMain.handle(
    'novel:create-skill',
    (_e, input: { name: string; description?: string; template: string }) => createSkill(input)
  )
  ipcMain.handle(
    'novel:update-skill',
    (
      _e,
      id: string,
      patch: { name?: string; description?: string; template?: string }
    ) => updateSkill(id, patch)
  )
  ipcMain.handle('novel:remove-skill', (_e, id: string) => removeSkill(id))
  ipcMain.handle(
    'novel:run-skill',
    (
      _e,
      input: { projectId: string; skillId: string; chapterId?: string; userInput?: string }
    ) => runSkill(input)
  )
  ipcMain.handle('novel:export-skills', () => exportSkills())
  ipcMain.handle('novel:import-skills', (_e, bundle: SkillExportBundle) => importSkills(bundle))
}
