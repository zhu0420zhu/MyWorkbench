/* ============================================
 * 智能分类与整理执行（移植自 ck 08_工具集/file_organizer.py）
 * 核心逻辑完整保留：
 *   - AI 语义分类（复用 lingmo ai.ts 的 complete 云端调用，失败回退规则分类）
 *   - 规则分类（复用 fileUtils.getFileCategory）
 *   - 生成方案（category / date / size 三模式，仅预览不改动）
 *   - 执行方案（move / rename / copy / delete，复用 fileUtils 能力）
 * 适配：AI 调用改用 lingmo 既有端点配置；分类目标目录使用中文类别名（与 ck 一致）。
 * ============================================ */

import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { statSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import {
  getFileCategory,
  getFileCategoryName,
  formatFileSize,
  moveFile,
  copyFileResumable,
  deleteFile
} from '../tools/fileUtils.ts'
import { complete } from '../ai.ts'
import { getLogger } from '../tools/logger.ts'
import { ConfigStore } from '../configStore.ts'
import { ClassificationMemory } from './memory.ts'
import type { ClassificationMemoryEntry } from '../../shared/types.ts'
import type {
  ExecuteResult,
  OrganizeAction,
  OrganizeMode,
  OrganizeOptions,
  OrganizePlanPreview
} from './types.ts'

const logger = getLogger('organize')

type OrganizeConfig = {
  targetBase: string
}

const config = new ConfigStore<OrganizeConfig>('organize-config', { targetBase: '' })
const memory = new ClassificationMemory()

const SIZE_TIERS: Array<[string, number]> = [
  ['超大文件', 500 * 1024 * 1024],
  ['大文件', 50 * 1024 * 1024],
  ['中等文件', 5 * 1024 * 1024],
  ['小文件', 0]
]

const CLASSIFY_CATEGORIES = [
  '文档', '图片', '视频', '音频', '压缩包', '代码', '安装包', '下载文件', '其他'
]

export class FileOrganizer {
  /** 默认整理目标基目录（可在配置中覆盖） */
  async getTargetBase(): Promise<string> {
    const cfg = await config.get()
    if (cfg.targetBase && cfg.targetBase.trim()) return cfg.targetBase.trim()
    return join(homedir(), 'Documents', '灵墨整理')
  }

  async setTargetBase(dir: string): Promise<string> {
    const v = dir.trim()
    await config.set({ targetBase: v })
    return v
  }

  /** 加载分类记忆（启动时调用一次） */
  async loadMemory(): Promise<void> {
    await memory.load()
  }

  /** AI 语义分类（复用 lingmo 云端端点；失败回退规则分类）。
   *  记忆优先：命中个性化记忆（达到置信阈值）的文件直接采用，不调 LLM。 */
  async aiClassify(filePaths: string[], useAi = true): Promise<Record<string, string>> {
    if (!useAi) return this.ruleBasedClassify(filePaths)
    const results: Record<string, string> = {}
    const remaining: string[] = []
    for (const p of filePaths) {
      const mem = await memory.lookup(p)
      if (mem) results[p] = mem
      else remaining.push(p)
    }
    if (remaining.length === 0) return results

    const batchSize = 10
    for (let i = 0; i < remaining.length; i += batchSize) {
      const batch = remaining.slice(i, i + batchSize)
      const prompt = this.buildClassifyPrompt(batch)
      const resp = await complete([{ role: 'user', content: prompt }])
      if (resp.ok && resp.text) {
        const parsed = this.parseClassifyResponse(resp.text)
        for (const p of batch) results[p] = parsed[p] ?? this.ruleOne(p)
      } else {
        logger.warning(`AI 分类失败, 回退规则分类: ${resp.error ?? 'unknown'}`)
        for (const p of batch) results[p] = this.ruleOne(p)
      }
    }
    return results
  }

  /** 记录一次用户纠正（个性化记忆），供后续分类优先采用 */
  async recordCorrection(filePath: string, category: string): Promise<void> {
    await memory.record(filePath, category)
  }

  /** 列出当前分类记忆 */
  async listMemory(): Promise<ClassificationMemoryEntry[]> {
    return memory.list()
  }

  /** 清空分类记忆 */
  async clearMemory(): Promise<void> {
    await memory.clear()
  }

  ruleBasedClassify(filePaths: string[]): Record<string, string> {
    const out: Record<string, string> = {}
    for (const p of filePaths) out[p] = this.ruleOne(p)
    return out
  }

  private ruleOne(path: string): string {
    return getFileCategoryName(getFileCategory(path))
  }

  private buildClassifyPrompt(batch: string[]): string {
    const info = batch.map((p) => `- ${p.split(/[\\/]/).pop()}`).join('\n')
    return [
      '请对以下文件进行语义分类。',
      '',
      '分类类别列表(必须从以下选择):',
      CLASSIFY_CATEGORIES.map((c) => `- ${c}`).join('\n'),
      '',
      '待分类文件:',
      info,
      '',
      '请返回JSON格式, 键为文件名, 值为分类类别。例如:',
      '{',
      '  "报告.pdf": "文档",',
      '  "照片.jpg": "图片"',
      '}'
    ].join('\n')
  }

  private parseClassifyResponse(content: string): Record<string, string> {
    try {
      const start = content.indexOf('{')
      const end = content.lastIndexOf('}')
      if (start < 0 || end <= start) return {}
      const obj = JSON.parse(content.slice(start, end + 1)) as Record<string, string>
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(obj)) {
        if (CLASSIFY_CATEGORIES.includes(v)) out[k] = v
      }
      return out
    } catch {
      return {}
    }
  }

  /** 生成整理方案（供预览确认，不改动任何文件） */
  async generatePlan(filePaths: string[], opts: OrganizeOptions = {}): Promise<OrganizePlanPreview> {
    const mode: OrganizeMode = opts.mode ?? 'category'
    const targetBase = opts.targetBase?.trim() || (await this.getTargetBase())
    await fsp.mkdir(targetBase, { recursive: true })

    const actions: OrganizeAction[] = []
    if (mode === 'category') {
      const classifications = await this.aiClassify(filePaths, opts.useAi ?? true)
      for (const path of filePaths) {
        const category = classifications[path] ?? '其他'
        const action = this.buildMoveAction(path, join(targetBase, category), `按类别整理: ${category}`)
        if (action) actions.push(action)
      }
    } else if (mode === 'date') {
      for (const path of filePaths) {
        const action = this.buildDateAction(path, targetBase)
        if (action) actions.push(action)
      }
    } else {
      for (const path of filePaths) {
        const action = this.buildSizeAction(path, targetBase)
        if (action) actions.push(action)
      }
    }

    return {
      totalFiles: actions.length,
      estimatedSavings: 0,
      estimatedSavingsFormatted: formatFileSize(0),
      createdAt: new Date().toISOString(),
      actions
    }
  }

  private buildMoveAction(source: string, targetPath: string, reason: string): OrganizeAction | null {
    try {
      if (resolve(source) === resolve(targetPath)) return null
    } catch {
      /* ignore */
    }
    return {
      actionType: 'move',
      sourcePath: source,
      targetPath,
      reason,
      success: false,
      error: ''
    }
  }

  private buildDateAction(source: string, targetBase: string): OrganizeAction | null {
    const st = statSyncSafe(source)
    if (!st) return null
    const d = new Date(st.mtimeMs)
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    return this.buildMoveAction(source, join(targetBase, ym), `按日期整理: ${ym}`)
  }

  private buildSizeAction(source: string, targetBase: string): OrganizeAction | null {
    const st = statSyncSafe(source)
    if (!st) return null
    const size = st.size
    let category = '小文件'
    for (const [name, threshold] of SIZE_TIERS) {
      if (size > threshold) {
        category = name
        break
      }
    }
    return this.buildMoveAction(
      source,
      join(targetBase, category),
      `按大小整理: ${category} (${formatFileSize(size)})`
    )
  }

  /** 执行整理方案（批量 move / rename / copy / delete） */
  async executePlan(actions: OrganizeAction[]): Promise<ExecuteResult> {
    let successCount = 0
    let failedCount = 0
    for (const action of actions) {
      try {
        switch (action.actionType) {
          case 'move':
            await this.execMove(action)
            break
          case 'rename':
            await this.execRename(action)
            break
          case 'copy':
            await this.execCopy(action)
            break
          case 'delete':
            await this.execDelete(action)
            break
        }
        if (action.success) successCount++
        else failedCount++
      } catch (err) {
        action.success = false
        action.error = (err as Error).message
        failedCount++
      }
    }
    logger.info(`整理完成: 成功=${successCount}, 失败=${failedCount}`)
    return {
      successCount,
      failedCount,
      totalFiles: actions.length,
      actions,
      executedAt: new Date().toISOString()
    }
  }

  private async execMove(a: OrganizeAction): Promise<void> {
    if (!a.targetPath) {
      a.error = '目标路径不能为空'
      return
    }
    const res = await moveFile(a.sourcePath, dirname(a.targetPath))
    if (res.success) {
      a.success = true
    } else {
      a.success = false
      a.error = res.error ?? '移动失败'
    }
  }

  private async execCopy(a: OrganizeAction): Promise<void> {
    if (!a.targetPath) {
      a.error = '目标路径不能为空'
      return
    }
    const res = await copyFileResumable(a.sourcePath, a.targetPath)
    if (res.success) {
      a.success = true
    } else {
      a.success = false
      a.error = res.error ?? '复制失败'
    }
  }

  private async execRename(a: OrganizeAction): Promise<void> {
    if (!a.targetPath) {
      a.error = '目标路径不能为空'
      return
    }
    try {
      await fsp.mkdir(dirname(a.targetPath), { recursive: true })
      await fsp.rename(a.sourcePath, a.targetPath)
      a.success = true
    } catch (err) {
      a.success = false
      a.error = (err as Error).message
    }
  }

  private async execDelete(a: OrganizeAction): Promise<void> {
    const ok = await deleteFile(a.sourcePath, true)
    a.success = ok
    if (!ok) a.error = '删除失败（可能已被移除或无权限）'
  }
}

function statSyncSafe(p: string): { size: number; mtimeMs: number } | null {
  try {
    const s = statSync(p)
    return { size: s.size, mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}
