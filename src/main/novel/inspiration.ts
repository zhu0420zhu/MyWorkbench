/**
 * 灵感工作台 / 写作 Skill 包：存储与 IO（P2-3）
 *
 * 存储布局：
 *   灵感池（按项目）：userData/novel/<projectId>/inspirations/index.json
 *                     { inspirations: InspirationNote[] }
 *   Skill 包（全局）：userData/novel/skills/index.json
 *                     { skills: WritingSkill[] }   ← 首次使用播种 7 个内置 Skill
 *
 * 删除作品时 `store.removeProject` 会整体删掉作品目录，灵感池随之清理；
 * Skill 是全局的，跟着用户走，不随作品删除。
 */
import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type {
  InspirationKind,
  InspirationNote,
  SkillExportBundle,
  SkillImportResult,
  SkillRunResult,
  WritingSkill
} from '../../shared/types'
import { buildSkillPrompt, seedBuiltinSkills } from './inspirationCore'
import { complete } from '../ai'
import { getProject } from './store'
import { buildContextBundle } from './contextBuilder'
import { renderBundlePrompt } from './contextCore'

function safeId(id: string): string {
  return id.replace(/[^\w.@-]+/g, '_').slice(0, 80) || 'default'
}

function novelRoot(): string {
  return join(app.getPath('userData'), 'novel')
}

function projectDir(projectId: string): string {
  return join(novelRoot(), safeId(projectId))
}

function inspirationDir(projectId: string): string {
  return join(projectDir(projectId), 'inspirations')
}

function inspirationIndexFile(projectId: string): string {
  return join(inspirationDir(projectId), 'index.json')
}

function skillsIndexFile(): string {
  return join(novelRoot(), 'skills', 'index.json')
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true })
}

/* ============================================================
 * 灵感池（按项目）
 * ============================================================ */

interface InspirationIndex {
  version: 1
  inspirations: InspirationNote[]
}

async function readInspirations(projectId: string): Promise<InspirationIndex> {
  try {
    const parsed = JSON.parse(await fs.readFile(inspirationIndexFile(projectId), 'utf-8')) as InspirationIndex
    if (parsed && Array.isArray(parsed.inspirations)) {
      return { version: 1, inspirations: parsed.inspirations }
    }
  } catch {
    /* 首次使用或索引损坏 */
  }
  return { version: 1, inspirations: [] }
}

async function writeInspirations(projectId: string, idx: InspirationIndex): Promise<void> {
  await ensureDir(inspirationDir(projectId))
  await fs.writeFile(inspirationIndexFile(projectId), JSON.stringify(idx, null, 2), 'utf-8')
}

export async function listInspirations(projectId: string): Promise<InspirationNote[]> {
  const idx = await readInspirations(projectId)
  return [...idx.inspirations].sort((a, b) => b.createdAt - a.createdAt)
}

export interface CreateInspirationInput {
  projectId: string
  kind: InspirationKind
  content: string
  note?: string
}

export async function createInspiration(input: CreateInspirationInput): Promise<InspirationNote | null> {
  const content = (input.content ?? '').trim()
  if (!content) return null
  const now = Date.now()
  const note: InspirationNote = {
    id: randomUUID(),
    projectId: input.projectId,
    kind: input.kind ?? 'idea',
    content,
    note: (input.note ?? '').trim() || undefined,
    createdAt: now,
    updatedAt: now
  }
  const idx = await readInspirations(input.projectId)
  idx.inspirations.push(note)
  await writeInspirations(input.projectId, idx)
  return note
}

export interface UpdateInspirationInput {
  kind?: InspirationKind
  content?: string
  note?: string
}

export async function updateInspiration(
  projectId: string,
  id: string,
  patch: UpdateInspirationInput
): Promise<InspirationNote | null> {
  const idx = await readInspirations(projectId)
  const i = idx.inspirations.findIndex((n) => n.id === id)
  if (i < 0) return null
  const prev = idx.inspirations[i]
  const next: InspirationNote = { ...prev }
  if (patch.content !== undefined) next.content = patch.content.trim()
  if (patch.note !== undefined) next.note = patch.note.trim() || undefined
  if (patch.kind !== undefined) next.kind = patch.kind
  next.updatedAt = Date.now()
  idx.inspirations[i] = next
  await writeInspirations(projectId, idx)
  return next
}

export async function removeInspiration(projectId: string, id: string): Promise<InspirationNote[]> {
  const idx = await readInspirations(projectId)
  idx.inspirations = idx.inspirations.filter((n) => n.id !== id)
  await writeInspirations(projectId, idx)
  return [...idx.inspirations].sort((a, b) => b.createdAt - a.createdAt)
}

/* ============================================================
 * 写作 Skill 包（全局）
 * ============================================================ */

interface SkillsIndex {
  version: 1
  skills: WritingSkill[]
}

async function readSkills(): Promise<SkillsIndex> {
  try {
    const parsed = JSON.parse(await fs.readFile(skillsIndexFile(), 'utf-8')) as SkillsIndex
    if (parsed && Array.isArray(parsed.skills)) {
      return { version: 1, skills: parsed.skills }
    }
  } catch {
    /* 首次使用：播种内置 Skill */
  }
  const seeded = seedBuiltinSkills()
  await writeSkills({ version: 1, skills: seeded })
  return { version: 1, skills: seeded }
}

async function writeSkills(idx: SkillsIndex): Promise<void> {
  await ensureDir(join(novelRoot(), 'skills'))
  await fs.writeFile(skillsIndexFile(), JSON.stringify(idx, null, 2), 'utf-8')
}

export async function listSkills(): Promise<WritingSkill[]> {
  const idx = await readSkills()
  return [...idx.skills].sort((a, b) => a.createdAt - b.createdAt)
}

export interface CreateSkillInput {
  name: string
  description?: string
  template: string
}

export async function createSkill(input: CreateSkillInput): Promise<WritingSkill | null> {
  const name = (input.name ?? '').trim()
  const template = (input.template ?? '').trim()
  if (!name || !template) return null
  const now = Date.now()
  const skill: WritingSkill = {
    id: randomUUID(),
    name,
    description: (input.description ?? '').trim(),
    template,
    builtin: false,
    createdAt: now,
    updatedAt: now
  }
  const idx = await readSkills()
  idx.skills.push(skill)
  await writeSkills(idx)
  return skill
}

export interface UpdateSkillInput {
  name?: string
  description?: string
  template?: string
}

export async function updateSkill(id: string, patch: UpdateSkillInput): Promise<WritingSkill | null> {
  const idx = await readSkills()
  const i = idx.skills.findIndex((s) => s.id === id)
  if (i < 0) return null
  const prev = idx.skills[i]
  const next: WritingSkill = { ...prev }
  if (patch.name !== undefined) next.name = patch.name.trim()
  if (patch.description !== undefined) next.description = patch.description.trim()
  if (patch.template !== undefined) next.template = patch.template
  next.updatedAt = Date.now()
  idx.skills[i] = next
  await writeSkills(idx)
  return next
}

export async function removeSkill(id: string): Promise<WritingSkill[]> {
  const idx = await readSkills()
  idx.skills = idx.skills.filter((s) => s.id !== id)
  await writeSkills(idx)
  return [...idx.skills].sort((a, b) => a.createdAt - b.createdAt)
}

export interface RunSkillInput {
  projectId: string
  skillId: string
  /** 当前章节（用于组装上下文）；不传则退化为仅作品设定 */
  chapterId?: string
  /** 作者额外输入：如要润色的台词、要设计的人物名（替换 {{input}}） */
  userInput?: string
}

/**
 * 组装喂给 Skill 的"当前章上下文"。
 * 优先用上下文编排器（设定/前文/设定库/检索召回），失败时退化为仅作品设定。
 */
async function assembleContext(projectId: string, chapterId?: string): Promise<string> {
  const project = await getProject(projectId)
  if (!project) return ''
  if (chapterId) {
    try {
      const bundle = await buildContextBundle(projectId, chapterId)
      if (bundle) {
        const text = renderBundlePrompt(bundle.blocks)
        if (text && text.trim()) return text
      }
    } catch {
      /* 编排失败不影响主功能，继续走退化路径 */
    }
  }
  const lines: string[] = []
  if (project.meta.title) lines.push(`书名：${project.meta.title}`)
  if (project.meta.genre) lines.push(`题材：${project.meta.genre}`)
  if (project.meta.synopsis) lines.push(`梗概：${project.meta.synopsis}`)
  return lines.join('\n')
}

export async function runSkill(input: RunSkillInput): Promise<SkillRunResult> {
  if (!input.projectId || !input.skillId) {
    return { ok: false, error: '缺少 projectId 或 skillId' }
  }
  const idx = await readSkills()
  const skill = idx.skills.find((s) => s.id === input.skillId)
  if (!skill) return { ok: false, error: 'Skill 不存在' }

  const context = await assembleContext(input.projectId, input.chapterId)
  const prompt = buildSkillPrompt(skill.template, context, (input.userInput ?? '').trim() || '')

  try {
    const r = await complete([{ role: 'user', content: prompt }])
    if (!r.ok) return { ok: false, error: r.error ?? 'AI 调用失败' }
    return { ok: true, text: (r.text ?? '').trim() }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/* ------------------------------ 导出 / 导入 ------------------------------ */

export async function exportSkills(): Promise<SkillExportBundle> {
  const idx = await readSkills()
  return { version: 1, exportedAt: Date.now(), skills: idx.skills }
}

export async function importSkills(bundle: SkillExportBundle): Promise<SkillImportResult> {
  if (!bundle || !Array.isArray(bundle.skills)) {
    return { ok: false, count: 0, error: '数据包格式不正确' }
  }
  // 校验每条至少含 id / name / template
  const valid = bundle.skills.filter(
    (s) => s && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.template === 'string'
  )
  if (valid.length === 0) {
    return { ok: false, count: 0, error: '数据包中没有可用的 Skill' }
  }
  // 整体覆盖式写入（备份还原语义）；保留每条自身的 builtin 标记
  const now = Date.now()
  const normalized: WritingSkill[] = valid.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description ?? '',
    template: s.template,
    builtin: !!s.builtin,
    createdAt: s.createdAt ?? now,
    updatedAt: s.updatedAt ?? now
  }))
  await writeSkills({ version: 1, skills: normalized })
  return { ok: true, count: normalized.length }
}
