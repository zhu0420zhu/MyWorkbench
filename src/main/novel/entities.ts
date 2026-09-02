/**
 * 设定库实体化：实体卡 / 关系 / 动态状态
 *
 * 存储布局（与章节同构：索引单独放、设定正文分文件）：
 *
 *   userData/novel/<projectId>/entities/index.json    实体元数据 + 关系边
 *   userData/novel/<projectId>/entities/states.json   动态状态（随章节推进）
 *   userData/novel/<projectId>/entities/<id>.md       设定卡正文
 *
 * **三件套的关系**：
 *  - 实体卡 = 静态设定（"萧炎是谁"），写一次改一次，不随剧情变；
 *  - 动态状态 = 剧情快照（"第 30 章后：已被废掉斗气"），按章节生效；
 *  - 关系边 = 实体之间的网（"萧炎 —师徒→ 药老"），供关系图与上下文召回。
 *
 * 上下文编排（contextBuilder）只吃"本章出场实体"：静态设定 + 截至本章最新的动态状态。
 * 没有动态状态的话，让 AI 写第 100 章时它只会拿到"主角是个天才"，
 * 却不知道主角在第 80 章已经瞎了 —— 这是长篇一致性的头号杀手。
 */
import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type {
  Entity,
  EntityKind,
  EntityMeta,
  EntityMention,
  EntityRelation,
  EntityState
} from '../../shared/types'
import { buildCandidates, matchEntities } from './entityMatch'

function projectDir(projectId: string): string {
  return join(app.getPath('userData'), 'novel', safeId(projectId))
}

function entitiesDir(projectId: string): string {
  return join(projectDir(projectId), 'entities')
}

function indexFile(projectId: string): string {
  return join(entitiesDir(projectId), 'index.json')
}

function statesFile(projectId: string): string {
  return join(entitiesDir(projectId), 'states.json')
}

function entityFile(projectId: string, entityId: string): string {
  return join(entitiesDir(projectId), `${safeId(entityId)}.md`)
}

function safeId(id: string): string {
  return id.replace(/[^\w.@-]+/g, '_').slice(0, 80) || 'default'
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true })
}

/* ------------------------------ 读写底层 ------------------------------ */

interface EntityIndex {
  version: 1
  entities: EntityMeta[]
  relations: EntityRelation[]
}

interface StateIndex {
  version: 1
  states: EntityState[]
}

async function readIndex(projectId: string): Promise<EntityIndex> {
  try {
    const parsed = JSON.parse(await fs.readFile(indexFile(projectId), 'utf-8')) as EntityIndex
    return {
      version: 1,
      entities: Array.isArray(parsed?.entities) ? parsed.entities : [],
      relations: Array.isArray(parsed?.relations) ? parsed.relations : []
    }
  } catch {
    return { version: 1, entities: [], relations: [] }
  }
}

async function writeIndex(projectId: string, idx: EntityIndex): Promise<void> {
  await ensureDir(entitiesDir(projectId))
  await fs.writeFile(indexFile(projectId), JSON.stringify(idx, null, 2), 'utf-8')
}

async function readStates(projectId: string): Promise<StateIndex> {
  try {
    const parsed = JSON.parse(await fs.readFile(statesFile(projectId), 'utf-8')) as StateIndex
    return { version: 1, states: Array.isArray(parsed?.states) ? parsed.states : [] }
  } catch {
    return { version: 1, states: [] }
  }
}

async function writeStates(projectId: string, idx: StateIndex): Promise<void> {
  await ensureDir(entitiesDir(projectId))
  await fs.writeFile(statesFile(projectId), JSON.stringify(idx, null, 2), 'utf-8')
}

async function readContent(projectId: string, entityId: string): Promise<string> {
  try {
    return await fs.readFile(entityFile(projectId, entityId), 'utf-8')
  } catch {
    return ''
  }
}

/* ------------------------------ 实体卡 ------------------------------ */

/** 列表用：按 kind 分组序 + index 排序（pinned 不参与排序，由调用方自行置顶） */
export async function listEntities(projectId: string): Promise<EntityMeta[]> {
  const idx = await readIndex(projectId)
  return [...idx.entities].sort((a, b) => a.index - b.index || a.createdAt - b.createdAt)
}

export async function getEntity(projectId: string, entityId: string): Promise<Entity | null> {
  const idx = await readIndex(projectId)
  const meta = idx.entities.find((e) => e.id === entityId)
  if (!meta) return null
  return { ...meta, content: await readContent(projectId, entityId) }
}

export interface CreateEntityInput {
  projectId: string
  kind: EntityKind
  name: string
  aliases?: string[]
  tagline?: string
  content?: string
  pinned?: boolean
  firstChapterId?: string
}

export async function createEntity(input: CreateEntityInput): Promise<EntityMeta | null> {
  const name = (input.name ?? '').trim()
  if (!name) return null
  const idx = await readIndex(input.projectId)
  const now = Date.now()
  const meta: EntityMeta = {
    id: randomUUID(),
    projectId: input.projectId,
    kind: input.kind,
    name,
    aliases: normalizeAliases(input.aliases, name),
    tagline: (input.tagline ?? '').trim(),
    pinned: Boolean(input.pinned),
    index: idx.entities.length,
    firstChapterId: input.firstChapterId,
    createdAt: now,
    updatedAt: now
  }
  idx.entities.push(meta)
  await writeIndex(input.projectId, idx)
  if (input.content) {
    await ensureDir(entitiesDir(input.projectId))
    await fs.writeFile(entityFile(input.projectId, meta.id), input.content, 'utf-8')
  }
  return meta
}

function normalizeAliases(aliases: string[] | undefined, name: string): string[] {
  const set = new Set<string>()
  for (const a of aliases ?? []) {
    const t = (a ?? '').trim()
    if (t && t !== name) set.add(t)
  }
  return [...set]
}

export interface UpdateEntityInput {
  kind?: EntityKind
  name?: string
  aliases?: string[]
  tagline?: string
  content?: string
  pinned?: boolean
  index?: number
  firstChapterId?: string
}

export async function updateEntity(
  projectId: string,
  entityId: string,
  patch: UpdateEntityInput
): Promise<EntityMeta | null> {
  const idx = await readIndex(projectId)
  const i = idx.entities.findIndex((e) => e.id === entityId)
  if (i < 0) return null
  const prev = idx.entities[i]
  const next: EntityMeta = { ...prev }

  if (patch.kind !== undefined) next.kind = patch.kind
  if (patch.name !== undefined) next.name = patch.name.trim()
  if (patch.tagline !== undefined) next.tagline = patch.tagline
  if (patch.pinned !== undefined) next.pinned = patch.pinned
  if (patch.index !== undefined) next.index = patch.index
  if (patch.firstChapterId !== undefined) next.firstChapterId = patch.firstChapterId
  if (patch.aliases !== undefined) next.aliases = normalizeAliases(patch.aliases, next.name)
  if (patch.content !== undefined) {
    await ensureDir(entitiesDir(projectId))
    await fs.writeFile(entityFile(projectId, entityId), patch.content, 'utf-8')
  }
  next.updatedAt = Date.now()
  idx.entities[i] = next
  await writeIndex(projectId, idx)
  return next
}

/** 删除实体：连带清理关系边与动态状态，避免留下悬空引用 */
export async function removeEntity(projectId: string, entityId: string): Promise<EntityMeta[]> {
  const idx = await readIndex(projectId)
  idx.entities = idx.entities.filter((e) => e.id !== entityId)
  idx.relations = idx.relations.filter((r) => r.fromId !== entityId && r.toId !== entityId)
  await writeIndex(projectId, idx)

  const st = await readStates(projectId)
  st.states = st.states.filter((s) => s.entityId !== entityId)
  await writeStates(projectId, st)

  try {
    await fs.unlink(entityFile(projectId, entityId))
  } catch {
    /* 正文文件可能本就不存在 */
  }
  return [...idx.entities].sort((a, b) => a.index - b.index || a.createdAt - b.createdAt)
}

/** 重排（设定库列表拖拽）：按传入顺序重设 index */
export async function reorderEntities(projectId: string, orderedIds: string[]): Promise<EntityMeta[]> {
  const idx = await readIndex(projectId)
  const map = new Map(idx.entities.map((e) => [e.id, e]))
  let i = 0
  for (const id of orderedIds) {
    const e = map.get(id)
    if (e) e.index = i++
  }
  await writeIndex(projectId, idx)
  return [...idx.entities].sort((a, b) => a.index - b.index || a.createdAt - b.createdAt)
}

/* ------------------------------ 关系边 ------------------------------ */

export async function listRelations(projectId: string): Promise<EntityRelation[]> {
  const idx = await readIndex(projectId)
  return idx.relations
}

export interface UpsertRelationInput {
  projectId: string
  id?: string
  fromId: string
  toId: string
  label: string
  bidirectional?: boolean
}

/**
 * 新增或更新关系边。同 from→to+label 视为同一条，重复调用是更新而非新增——
 * 关系图里拖错一次就留下两条一样的边，非常难清理。
 */
export async function upsertRelation(input: UpsertRelationInput): Promise<EntityRelation | null> {
  if (!input.fromId || !input.toId || input.fromId === input.toId) return null
  const idx = await readIndex(input.projectId)
  if (input.id) {
    const i = idx.relations.findIndex((r) => r.id === input.id)
    if (i >= 0) {
      const next: EntityRelation = {
        ...idx.relations[i],
        fromId: input.fromId,
        toId: input.toId,
        label: input.label,
        bidirectional: Boolean(input.bidirectional)
      }
      idx.relations[i] = next
      await writeIndex(input.projectId, idx)
      return next
    }
  }
  const dup = idx.relations.find(
    (r) => r.fromId === input.fromId && r.toId === input.toId && r.label === input.label
  )
  if (dup) {
    dup.bidirectional = Boolean(input.bidirectional)
    await writeIndex(input.projectId, idx)
    return dup
  }
  const rel: EntityRelation = {
    id: randomUUID(),
    projectId: input.projectId,
    fromId: input.fromId,
    toId: input.toId,
    label: input.label,
    bidirectional: Boolean(input.bidirectional)
  }
  idx.relations.push(rel)
  await writeIndex(input.projectId, idx)
  return rel
}

export async function removeRelation(projectId: string, relationId: string): Promise<EntityRelation[]> {
  const idx = await readIndex(projectId)
  idx.relations = idx.relations.filter((r) => r.id !== relationId)
  await writeIndex(projectId, idx)
  return idx.relations
}

/* ------------------------------ 动态状态 ------------------------------ */

export async function listStates(projectId: string, entityId?: string): Promise<EntityState[]> {
  const st = await readStates(projectId)
  const out = entityId ? st.states.filter((s) => s.entityId === entityId) : st.states
  return [...out].sort((a, b) => a.createdAt - b.createdAt)
}

export interface SetStateInput {
  projectId: string
  entityId: string
  chapterId: string
  text: string
  id?: string
}

export async function setState(input: SetStateInput): Promise<EntityState | null> {
  const text = (input.text ?? '').trim()
  if (!text) return null
  const st = await readStates(input.projectId)
  if (input.id) {
    const i = st.states.findIndex((s) => s.id === input.id)
    if (i >= 0) {
      const next: EntityState = { ...st.states[i], chapterId: input.chapterId, text }
      st.states[i] = next
      await writeStates(input.projectId, st)
      return next
    }
  }
  const state: EntityState = {
    id: randomUUID(),
    projectId: input.projectId,
    entityId: input.entityId,
    chapterId: input.chapterId,
    text,
    createdAt: Date.now()
  }
  st.states.push(state)
  await writeStates(input.projectId, st)
  return state
}

export async function removeState(projectId: string, stateId: string): Promise<EntityState[]> {
  const st = await readStates(projectId)
  st.states = st.states.filter((s) => s.id !== stateId)
  await writeStates(projectId, st)
  return st.states
}

/* ------------------------------ 正文识别 ------------------------------ */

/**
 * 识别一段正文中出现了哪些实体。
 * 返回按出现次数降序；未命中的实体不返回（上下文编排不需要它们）。
 */
export async function detectMentions(
  projectId: string,
  text: string
): Promise<EntityMention[]> {
  const idx = await readIndex(projectId)
  if (!idx.entities.length) return []
  return matchEntities(buildCandidates(idx.entities), text)
}
