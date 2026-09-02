/**
 * 伏笔 / 线索追踪：存储与 IO（P2-2）
 *
 * 存储布局（与实体库同构，单文件索引即可，伏笔内容很短不必分文件）：
 *
 *   userData/novel/<projectId>/foreshadows/index.json   { foreshadows: Foreshadow[] }
 *
 * 删除作品时 `store.removeProject` 会整体删掉作品目录，这里无需单独清理。
 */
import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Foreshadow, ForeshadowStatus } from '../../shared/types'
import { buildChapterOrder, detectOverdue } from './foreshadowCore'
import { getProject } from './store'

function projectDir(projectId: string): string {
  return join(app.getPath('userData'), 'novel', safeId(projectId))
}

function fsDir(projectId: string): string {
  return join(projectDir(projectId), 'foreshadows')
}

function indexFile(projectId: string): string {
  return join(fsDir(projectId), 'index.json')
}

function safeId(id: string): string {
  return id.replace(/[^\w.@-]+/g, '_').slice(0, 80) || 'default'
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true })
}

interface FsIndex {
  version: 1
  foreshadows: Foreshadow[]
}

async function readIndex(projectId: string): Promise<FsIndex> {
  try {
    const parsed = JSON.parse(await fs.readFile(indexFile(projectId), 'utf-8')) as FsIndex
    if (parsed && Array.isArray(parsed.foreshadows)) return { version: 1, foreshadows: parsed.foreshadows }
  } catch {
    /* 首次使用或索引损坏 */
  }
  return { version: 1, foreshadows: [] }
}

async function writeIndex(projectId: string, idx: FsIndex): Promise<void> {
  await ensureDir(fsDir(projectId))
  await fs.writeFile(indexFile(projectId), JSON.stringify(idx, null, 2), 'utf-8')
}

/* ------------------------------ 增删改查 ------------------------------ */

export async function listForeshadows(projectId: string): Promise<Foreshadow[]> {
  const idx = await readIndex(projectId)
  return [...idx.foreshadows].sort((a, b) => a.createdAt - b.createdAt)
}

export interface CreateForeshadowInput {
  projectId: string
  content: string
  plantedChapterId: string
  plantedChapterTitle: string
  payoffChapterId?: string
  payoffChapterTitle?: string
  status?: ForeshadowStatus
  note?: string
}

export async function createForeshadow(input: CreateForeshadowInput): Promise<Foreshadow | null> {
  const content = (input.content ?? '').trim()
  if (!content) return null
  const now = Date.now()
  const f: Foreshadow = {
    id: randomUUID(),
    projectId: input.projectId,
    content,
    plantedChapterId: input.plantedChapterId,
    plantedChapterTitle: input.plantedChapterTitle,
    payoffChapterId: input.payoffChapterId,
    payoffChapterTitle: input.payoffChapterTitle,
    status: input.status ?? 'planted',
    note: (input.note ?? '').trim() || undefined,
    createdAt: now,
    updatedAt: now
  }
  const idx = await readIndex(input.projectId)
  idx.foreshadows.push(f)
  await writeIndex(input.projectId, idx)
  return f
}

export interface UpdateForeshadowInput {
  content?: string
  note?: string
  plantedChapterId?: string
  plantedChapterTitle?: string
  payoffChapterId?: string
  payoffChapterTitle?: string
}

export async function updateForeshadow(
  projectId: string,
  id: string,
  patch: UpdateForeshadowInput
): Promise<Foreshadow | null> {
  const idx = await readIndex(projectId)
  const i = idx.foreshadows.findIndex((f) => f.id === id)
  if (i < 0) return null
  const prev = idx.foreshadows[i]
  const next: Foreshadow = { ...prev }
  if (patch.content !== undefined) next.content = patch.content.trim()
  if (patch.note !== undefined) next.note = patch.note.trim() || undefined
  if (patch.plantedChapterId !== undefined) next.plantedChapterId = patch.plantedChapterId
  if (patch.plantedChapterTitle !== undefined) next.plantedChapterTitle = patch.plantedChapterTitle
  if (patch.payoffChapterId !== undefined) next.payoffChapterId = patch.payoffChapterId
  if (patch.payoffChapterTitle !== undefined) next.payoffChapterTitle = patch.payoffChapterTitle
  next.updatedAt = Date.now()
  idx.foreshadows[i] = next
  await writeIndex(projectId, idx)
  return next
}

export async function setForeshadowStatus(
  projectId: string,
  id: string,
  status: ForeshadowStatus,
  payoffChapterId?: string,
  payoffChapterTitle?: string
): Promise<Foreshadow | null> {
  const idx = await readIndex(projectId)
  const i = idx.foreshadows.findIndex((f) => f.id === id)
  if (i < 0) return null
  const next: Foreshadow = { ...idx.foreshadows[i], status, updatedAt: Date.now() }
  if (status === 'payed-off') {
    // 回收：记录回收章节（默认由调用方传入当前章）
    next.payoffChapterId = payoffChapterId
    next.payoffChapterTitle = payoffChapterTitle
  } else if (status === 'planted') {
    // 重新埋下：清空回收记录
    next.payoffChapterId = undefined
    next.payoffChapterTitle = undefined
  }
  idx.foreshadows[i] = next
  await writeIndex(projectId, idx)
  return next
}

export async function removeForeshadow(projectId: string, id: string): Promise<Foreshadow[]> {
  const idx = await readIndex(projectId)
  idx.foreshadows = idx.foreshadows.filter((f) => f.id !== id)
  await writeIndex(projectId, idx)
  return [...idx.foreshadows].sort((a, b) => a.createdAt - b.createdAt)
}

/* ------------------------------ 逾期提醒 ------------------------------ */

/**
 * 列出「已埋下超过 N 章仍未回收」的伏笔，供侧边栏/面板在当前章写作时提醒。
 * 需要作品的卷/章顺序来算间隔——这里临时取一次工程数据，再交给纯逻辑判定。
 */
export async function listOverdue(
  projectId: string,
  currentChapterId: string,
  threshold: number
): Promise<Foreshadow[]> {
  if (!currentChapterId || threshold < 1) return []
  const project = await getProject(projectId)
  if (!project) return []
  const order = buildChapterOrder(project.volumes, project.chapters)
  const list = await listForeshadows(projectId)
  return detectOverdue(list, order, currentChapterId, threshold)
}
