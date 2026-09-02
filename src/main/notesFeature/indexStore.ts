/* ============================================
 * 可自定义检索表（indexTables.json）
 * 职责：检索表 CRUD；按 关键词/标签/日期 维度实时生成内容索引
 * ============================================ */

import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { IndexHit, NoteIndexTable } from '../../shared/types'
import { getAllNotesWithContent } from '../notes'

function tablesFile(): string {
  return join(app.getPath('userData'), 'notes-feature', 'indexTables.json')
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(join(app.getPath('userData'), 'notes-feature'), { recursive: true })
}

async function readTables(): Promise<NoteIndexTable[]> {
  try {
    const raw = await fs.readFile(tablesFile(), 'utf-8')
    const parsed = JSON.parse(raw) as { version: number; tables: NoteIndexTable[] }
    if (parsed && Array.isArray(parsed.tables)) return parsed.tables
    return []
  } catch {
    return []
  }
}

async function writeTables(tables: NoteIndexTable[]): Promise<void> {
  await ensureDir()
  await fs.writeFile(tablesFile(), JSON.stringify({ version: 1, tables }, null, 2), 'utf-8')
}

export { readTables, writeTables }

export type IndexTableInput = {
  name: string
  keywords?: string[]
  tags?: string[]
  dateFrom?: number
  dateTo?: number
}

function normalize(input: IndexTableInput): Omit<NoteIndexTable, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: input.name.trim() || '未命名检索表',
    keywords: input.keywords?.map((k) => k.trim()).filter(Boolean) ?? [],
    tags: input.tags?.map((t) => t.trim()).filter(Boolean) ?? [],
    dateFrom: input.dateFrom,
    dateTo: input.dateTo
  }
}

export async function listTables(): Promise<NoteIndexTable[]> {
  return readTables()
}

export async function addTable(input: IndexTableInput): Promise<NoteIndexTable[]> {
  const tables = await readTables()
  tables.push({ id: randomUUID(), ...normalize(input), createdAt: Date.now(), updatedAt: Date.now() })
  await writeTables(tables)
  return tables
}

export async function updateTable(id: string, input: IndexTableInput): Promise<NoteIndexTable[]> {
  const tables = await readTables()
  const t = tables.find((x) => x.id === id)
  if (!t) return tables
  Object.assign(t, normalize(input), { updatedAt: Date.now() })
  await writeTables(tables)
  return tables
}

export async function removeTable(id: string): Promise<NoteIndexTable[]> {
  const tables = await readTables()
  const next = tables.filter((x) => x.id !== id)
  await writeTables(next)
  return next
}

/** 按检索表实时生成索引（标题+正文匹配关键词；标签取交集；日期范围过滤） */
export async function buildIndex(tableId: string): Promise<IndexHit[]> {
  const tables = await readTables()
  const table = tables.find((t) => t.id === tableId)
  if (!table) return []
  const notes = await getAllNotesWithContent()
  const keywords = (table.keywords ?? []).map((k) => k.toLowerCase())
  const hits: IndexHit[] = []
  for (const n of notes) {
    // 关键词维度
    const text = (n.title + '\n' + n.content).toLowerCase()
    const matchedKeywords = keywords.filter((k) => k && text.includes(k))
    // 标签维度
    const noteTags = n.tags ?? []
    const matchedTags = (table.tags ?? []).filter((t) => noteTags.includes(t))
    // 日期维度
    if (table.dateFrom !== undefined && n.createdAt < table.dateFrom) continue
    if (table.dateTo !== undefined && n.createdAt > table.dateTo) continue
    // 任一维度命中即收录
    if (matchedKeywords.length === 0 && matchedTags.length === 0) continue
    hits.push({
      noteId: n.id,
      title: n.title,
      category: n.category,
      tags: noteTags,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      matchedKeywords,
      matchedTags
    })
  }
  // 按更新时间倒序
  hits.sort((a, b) => b.updatedAt - a.updatedAt)
  return hits
}
