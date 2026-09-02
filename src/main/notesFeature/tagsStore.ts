/* ============================================
 * 笔记标签存储（tags.json）
 * 职责：标签 CRUD；重命名/删除时同步所有笔记的 tags 字段
 * ============================================ */

import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { NoteTag } from '../../shared/types'
import { readIndex, writeIndex, batchUpdateNoteMetas } from '../notes'

function tagsFile(): string {
  return join(app.getPath('userData'), 'notes-feature', 'tags.json')
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(join(app.getPath('userData'), 'notes-feature'), { recursive: true })
}

async function readTags(): Promise<NoteTag[]> {
  try {
    const raw = await fs.readFile(tagsFile(), 'utf-8')
    const parsed = JSON.parse(raw) as { version: number; tags: NoteTag[] }
    if (parsed && Array.isArray(parsed.tags)) return parsed.tags
    return []
  } catch {
    return []
  }
}

async function writeTags(tags: NoteTag[]): Promise<void> {
  await ensureDir()
  await fs.writeFile(tagsFile(), JSON.stringify({ version: 1, tags }, null, 2), 'utf-8')
}

export { readTags, writeTags }

export async function listTags(): Promise<NoteTag[]> {
  return readTags()
}

export async function addTag(name: string): Promise<NoteTag[]> {
  const tags = await readTags()
  const trimmed = name.trim()
  if (!trimmed) return tags
  if (tags.some((t) => t.name.toLowerCase() === trimmed.toLowerCase())) return tags
  tags.push({ name: trimmed, color: undefined, createdAt: Date.now() })
  await writeTags(tags)
  return tags
}

/** 重命名标签：同步所有笔记 */
export async function renameTag(oldName: string, newName: string): Promise<NoteTag[]> {
  const tags = await readTags()
  const trimmed = newName.trim()
  const tag = tags.find((t) => t.name === oldName)
  if (!tag || !trimmed || trimmed.toLowerCase() === oldName.toLowerCase()) return tags
  tag.name = trimmed
  await writeTags(tags)
  const notes = await readIndex()
  const updates = notes
    .filter((n) => n.tags?.includes(oldName))
    .map((n) => ({
      id: n.id,
      tags: (n.tags ?? []).map((t) => (t === oldName ? trimmed : t))
    }))
  if (updates.length > 0) await batchUpdateNoteMetas(updates)
  return tags
}

/** 删除标签：从所有笔记移除 */
export async function removeTag(name: string): Promise<NoteTag[]> {
  const tags = await readTags()
  const next = tags.filter((t) => t.name !== name)
  await writeTags(next)
  const notes = await readIndex()
  const updates = notes
    .filter((n) => n.tags?.includes(name))
    .map((n) => ({ id: n.id, tags: (n.tags ?? []).filter((t) => t !== name) }))
  if (updates.length > 0) await batchUpdateNoteMetas(updates)
  return next
}

/** 校验标签名可用（供导入去重时引用） */
export { randomUUID as _uuid }
