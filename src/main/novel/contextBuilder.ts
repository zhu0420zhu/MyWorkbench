/**
 * 上下文编排器 —— 主进程装配层
 *
 * 职责：把散落在磁盘各处的数据（作品设定 / 历史章节 / 设定库 / 检索索引 / 备忘）
 * 读出来，交给 contextCore 组装成 ContextBundle。所有"读什么、按什么顺序"的决策
 * 都在 contextCore 里（纯逻辑、可单测），这一层只负责取数。
 *
 * **全书顺序的定义**：分卷按 index 排，卷内章节按 index 排。
 * 这是"前文/后文"的唯一判据，动态状态的生效范围也按它算。
 */
import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type {
  BuildContextOptions,
  ChapterMeta,
  ContextBundle,
  EntityMeta,
  EntityRelation,
  EntityState,
  Volume
} from '../../shared/types'
import { getProject, readChapterContent } from './store'
import { getEntity, listEntities, listRelations, listStates, detectMentions } from './entities'
import { searchChapters } from './chapterIndex'
import {
  buildContextBlocks,
  applyBudget,
  type EntityBrief,
  type ChapterBrief
} from './contextCore'

/** 单次最多读几张设定卡正文：出场实体再多也不该把 IO 拖垮 */
const MAX_ENTITY_FETCH = 40

/* ------------------------------ 钉住的备忘 ------------------------------ */

interface NotesFile {
  version: 1
  notes: string[]
}

function notesFile(projectId: string): string {
  return join(app.getPath('userData'), 'novel', safeId(projectId), 'context-notes.json')
}

function safeId(id: string): string {
  return id.replace(/[^\w.@-]+/g, '_').slice(0, 80) || 'default'
}

async function readNotes(projectId: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(notesFile(projectId), 'utf-8')) as NotesFile
    return Array.isArray(parsed?.notes) ? parsed.notes : []
  } catch {
    return []
  }
}

async function writeNotes(projectId: string, notes: string[]): Promise<void> {
  await fs.mkdir(join(app.getPath('userData'), 'novel', safeId(projectId)), { recursive: true })
  await fs.writeFile(notesFile(projectId), JSON.stringify({ version: 1, notes }, null, 2), 'utf-8')
}

export async function listPinnedNotes(projectId: string): Promise<string[]> {
  return readNotes(projectId)
}

export async function addPinnedNote(projectId: string, text: string): Promise<string[]> {
  const t = (text ?? '').trim()
  if (!t) return readNotes(projectId)
  const notes = [...(await readNotes(projectId)), t]
  await writeNotes(projectId, notes)
  return notes
}

export async function removePinnedNote(projectId: string, index: number): Promise<string[]> {
  const notes = await readNotes(projectId)
  if (index < 0 || index >= notes.length) return notes
  const next = notes.filter((_, i) => i !== index)
  await writeNotes(projectId, next)
  return next
}

/* ------------------------------ 顺序 ------------------------------ */

/** 全书顺序：先按分卷顺序，卷内按章节 index */
export function flattenInBookOrder(volumes: Volume[], chapters: ChapterMeta[]): ChapterMeta[] {
  const vOrder = new Map(
    [...volumes]
      .sort((a, b) => a.index - b.index)
      .map((v, i) => [v.id, i] as const)
  )
  return [...chapters].sort((a, b) => {
    const va = vOrder.get(a.volumeId) ?? 9999
    const vb = vOrder.get(b.volumeId) ?? 9999
    return va - vb || a.index - b.index
  })
}

/* ------------------------------ 编排 ------------------------------ */

export async function buildContextBundle(
  projectId: string,
  chapterId: string,
  opts: BuildContextOptions = {}
): Promise<ContextBundle | null> {
  const project = await getProject(projectId)
  if (!project) return null

  const ordered = flattenInBookOrder(project.volumes, project.chapters)
  const curIdx = ordered.findIndex((c) => c.id === chapterId)
  if (curIdx < 0) return null

  const cur = ordered[curIdx]
  const prevChapters = ordered.slice(0, curIdx)
  const prev = curIdx > 0 ? ordered[curIdx - 1] : null

  const [curRead, prevRead, entities, relations, allStates, pinnedNotes] = await Promise.all([
    readChapterContent(projectId, chapterId),
    prev ? readChapterContent(projectId, prev.id) : Promise.resolve(null),
    listEntities(projectId),
    listRelations(projectId),
    listStates(projectId),
    listPinnedNotes(projectId)
  ])

  const curContent = curRead?.content ?? ''
  const prevContent = prevRead?.content ?? ''

  // 细纲 + 正文一起识别：新章正文还空着时，至少能靠细纲里提到的人名召回设定卡
  const mentionMap = new Map(
    (await detectMentions(projectId, `${cur.summary ?? ''}\n${curContent}`)).map(
      (m) => [m.entityId, m.count] as const
    )
  )

  /* ---- 本章出场实体：钉住的 + 正文命中的，按 IO 上限截断 ---- */
  const picked = pickEntities(entities, mentionMap, MAX_ENTITY_FETCH)

  const ids = new Set(picked.map((e) => e.id))
  const fulls = await Promise.all(picked.map((e) => getEntity(projectId, e.id)))

  // 动态状态只保留"起效章节不晚于本章"的；未指定章节的状态视为一直有效
  const orderIndex = new Map(ordered.map((c, i) => [c.id, i] as const))
  const statesBy = new Map<string, EntityState[]>()
  for (const s of allStates) {
    if (!ids.has(s.entityId)) continue
    const at = orderIndex.get(s.chapterId)
    if (at !== undefined && at > curIdx) continue // 未来的状态不能剧透给模型
    const list = statesBy.get(s.entityId) ?? []
    list.push(s)
    statesBy.set(s.entityId, list)
  }

  const relBy = new Map<string, EntityRelation[]>()
  for (const r of relations) {
    if (ids.has(r.fromId)) {
      relBy.set(r.fromId, [...(relBy.get(r.fromId) ?? []), r])
    }
    if (r.bidirectional && ids.has(r.toId)) {
      relBy.set(r.toId, [...(relBy.get(r.toId) ?? []), { ...r, fromId: r.toId, toId: r.fromId }])
    }
  }
  const nameOf = (id: string) => entities.find((e) => e.id === id)?.name ?? '（已删除）'

  const entityBriefs: EntityBrief[] = picked.map((e, i) => {
    const full = fulls[i]
    const rels = (relBy.get(e.id) ?? [])
      .filter((r) => ids.has(r.toId))
      .map((r) => ({
        targetName: nameOf(r.toId),
        label: r.label,
        bidirectional: r.bidirectional
      }))
    return {
      id: e.id,
      name: e.name,
      kind: e.kind,
      tagline: e.tagline,
      content: full?.content ?? '',
      pinned: e.pinned,
      states: (statesBy.get(e.id) ?? []).sort((a, b) => a.createdAt - b.createdAt),
      relations: rels,
      mentions: mentionMap.get(e.id) ?? 0
    }
  })

  /* ---- 检索召回：用本章细纲 + 上一章结尾当查询 ---- */
  const retrievalTopK = opts.retrievalTopK ?? 3
  const query = [cur.summary ?? '', prevContent.slice(-300)].filter(Boolean).join('\n').slice(0, 800)
  const hits = searchChapters(projectId, query, retrievalTopK, chapterId)
  const titleOf = (id: string) => ordered.find((c) => c.id === id)?.title ?? '（未知章节）'

  const data = {
    projectTitle: project.meta.title,
    genre: project.meta.genre,
    synopsis: project.meta.synopsis,
    chapterTitle: cur.title,
    chapterSummary: cur.summary ?? '',
    previous: prevChapters.map<ChapterBrief>((c) => ({
      id: c.id,
      title: c.title,
      summary: c.summary ?? '',
      volumeTitle: project.volumes.find((v) => v.id === c.volumeId)?.title ?? ''
    })),
    prevChapterContent: prevContent,
    entities: entityBriefs,
    retrieval: hits.map((h) => ({
      chapterTitle: titleOf(h.chapterId),
      text: h.text,
      score: h.score
    })),
    pinnedNotes
  }

  const blocks = buildContextBlocks(data, opts)
  const budget = opts.budgetTokens ?? 24000
  const { blocks: trimmed, totalTokens, trimmed: dropped } = applyBudget(blocks, budget)

  return {
    projectId,
    chapterId,
    chapterTitle: cur.title,
    blocks: trimmed,
    totalTokens,
    budgetTokens: budget,
    trimmed: dropped
  }
}

/** 选出要读正文的实体：钉住的最优先，其次按本章出现次数 */
function pickEntities(
  entities: EntityMeta[],
  mentionMap: Map<string, number>,
  cap: number
): EntityMeta[] {
  return entities
    .filter((e) => e.pinned || (mentionMap.get(e.id) ?? 0) > 0)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return (mentionMap.get(b.id) ?? 0) - (mentionMap.get(a.id) ?? 0)
    })
    .slice(0, cap)
}
