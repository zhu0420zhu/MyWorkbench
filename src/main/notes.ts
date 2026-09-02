import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import iconv from 'iconv-lite'
import type { Note, NoteMeta } from '../shared/types'

function notesDir(): string {
  return join(app.getPath('userData'), 'notes')
}

function indexFile(): string {
  return join(notesDir(), 'index.json')
}

function noteFile(id: string): string {
  return join(notesDir(), `${id}.md`)
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(notesDir(), { recursive: true })
}

async function readIndex(): Promise<NoteMeta[]> {
  try {
    const raw = await fs.readFile(indexFile(), 'utf-8')
    const parsed = JSON.parse(raw) as { version: number; notes: NoteMeta[] }
    if (parsed && Array.isArray(parsed.notes)) {
      // 向后兼容：旧数据补默认字段
      return parsed.notes.map((n) => ({ tags: [], ...n }))
    }
    return []
  } catch {
    return []
  }
}

async function writeIndex(notes: NoteMeta[]): Promise<void> {
  await ensureDir()
  await fs.writeFile(indexFile(), JSON.stringify({ version: 1, notes }, null, 2), 'utf-8')
}

function extractTitle(content: string, fallback: string): string {
  const m = content.match(/^#\s+(.+)$/m)
  return (m?.[1] ?? fallback).trim().slice(0, 80)
}

export async function listNotes(): Promise<NoteMeta[]> {
  return readIndex()
}

export interface DecodedContent {
  content: string
  encoding: 'utf-8' | 'gb18030'
  repaired: boolean
  /** 是否检测到替换字符（U+FFFD），可能仍有部分乱码 */
  hasReplacementChar: boolean
}

/**
 * 智能解码笔记正文：优先 UTF-8（带 fatal 严格校验），失败回退 GB18030（GBK 超集）。
 * 处理顺序：去 BOM → 严格 UTF-8 → GB18030。
 * 不主动改写源文件——只返回正确解码内容。
 */
export function detectAndDecode(buf: Buffer): DecodedContent {
  // 1) 显式 BOM：UTF-8 (EF BB BF)
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    const content = iconv.decode(buf.subarray(3), 'utf-8')
    return { content, encoding: 'utf-8', repaired: false, hasReplacementChar: content.includes('\uFFFD') }
  }
  // 2) 严格 UTF-8
  try {
    const dec = new TextDecoder('utf-8', { fatal: true })
    const content = dec.decode(buf)
    return { content, encoding: 'utf-8', repaired: false, hasReplacementChar: content.includes('\uFFFD') }
  } catch {
    // 3) 回退 GB18030
    const content = iconv.decode(buf, 'gb18030')
    return { content, encoding: 'gb18030', repaired: true, hasReplacementChar: content.includes('\uFFFD') }
  }
}

export async function getNote(id: string): Promise<Note | null> {
  try {
    const meta = (await readIndex()).find((n) => n.id === id)
    if (!meta) return null
    const buf = await fs.readFile(noteFile(id))
    const { content, encoding, repaired, hasReplacementChar } = detectAndDecode(buf)
    return { ...meta, content, encoding, repaired, hasReplacementChar } as Note & { encoding: 'utf-8' | 'gb18030'; repaired: boolean; hasReplacementChar: boolean }
  } catch {
    return null
  }
}

/** 把指定笔记的源文件强制重写为 UTF-8（用于把 GBK 笔记无损地转为标准编码） */
export async function repairNoteEncoding(id: string): Promise<Note | null> {
  try {
    const meta = (await readIndex()).find((n) => n.id === id)
    if (!meta) return null
    const buf = await fs.readFile(noteFile(id))
    const { content, encoding } = detectAndDecode(buf)
    if (encoding === 'utf-8') return { ...meta, content } as Note
    // 重写为 UTF-8（带 BOM 可被一些工具识别）
    await fs.writeFile(noteFile(id), content, 'utf-8')
    return { ...meta, content } as Note
  } catch {
    return null
  }
}

/** 扫描全部笔记，把非 UTF-8 笔记全部重写为 UTF-8；返回修复数量 */
export async function repairAllNoteEncodings(): Promise<{ scanned: number; repaired: number }> {
  const metas = await readIndex()
  let scanned = 0
  let repaired = 0
  for (const m of metas) {
    scanned++
    try {
      const buf = await fs.readFile(noteFile(m.id))
      const { encoding, content } = detectAndDecode(buf)
      if (encoding !== 'utf-8') {
        await fs.writeFile(noteFile(m.id), content, 'utf-8')
        repaired++
      }
    } catch {
      /* skip */
    }
  }
  return { scanned, repaired }
}

export async function createNote(title: string): Promise<NoteMeta[]> {
  const notes = await readIndex()
  const id = randomUUID()
  const now = Date.now()
  const meta: NoteMeta = {
    id,
    title: title.trim() || '未命名笔记',
    createdAt: now,
    updatedAt: now
  }
  notes.unshift(meta)
  await writeIndex(notes)
  await fs.writeFile(noteFile(id), `# ${meta.title}\n\n`, 'utf-8')
  return notes
}

/** 批量创建笔记（多格式导入用）：一次写盘，减少 IPC 往返 */
export async function createNotesBatch(inputs: Array<{ title: string; content: string }>): Promise<NoteMeta[]> {
  const notes = await readIndex()
  const now = Date.now()
  const created: NoteMeta[] = []
  for (const input of inputs) {
    const id = randomUUID()
    const meta: NoteMeta = {
      id,
      title: input.title.trim() || '未命名笔记',
      createdAt: now,
      updatedAt: now,
      tags: []
    }
    created.push(meta)
    await fs.writeFile(noteFile(id), input.content, 'utf-8')
  }
  notes.unshift(...created)
  await writeIndex(notes)
  return notes
}

export async function updateNote(id: string, content: string): Promise<NoteMeta[]> {
  const notes = await readIndex()
  const idx = notes.findIndex((n) => n.id === id)
  if (idx < 0) return notes
  notes[idx] = {
    ...notes[idx],
    title: extractTitle(content, notes[idx].title),
    updatedAt: Date.now()
  }
  await writeIndex(notes)
  await fs.writeFile(noteFile(id), content, 'utf-8')
  return notes
}

export async function removeNote(id: string): Promise<NoteMeta[]> {
  const notes = await readIndex()
  const next = notes.filter((n) => n.id !== id)
  await writeIndex(next)
  try {
    await fs.unlink(noteFile(id))
  } catch {
    /* ignore */
  }
  return next
}

/** 更新笔记元数据（标签/分类），不触碰正文 */
export async function updateNoteMeta(id: string, meta: { tags?: string[]; category?: string; categorizedBy?: 'auto' | 'manual' }): Promise<NoteMeta[]> {
  const notes = await readIndex()
  const idx = notes.findIndex((n) => n.id === id)
  if (idx < 0) return notes
  notes[idx] = {
    ...notes[idx],
    ...(meta.tags !== undefined ? { tags: meta.tags } : {}),
    ...(meta.category !== undefined ? { category: meta.category } : {}),
    ...(meta.categorizedBy !== undefined ? { categorizedBy: meta.categorizedBy } : {}),
    updatedAt: Date.now()
  }
  await writeIndex(notes)
  return notes
}

/** 批量覆盖元数据（用于分类/导入/标签重命名同步），不更新 updatedAt */
export async function batchUpdateNoteMetas(updates: Array<{ id: string; tags?: string[]; category?: string; categorizedBy?: 'auto' | 'manual' }>): Promise<void> {
  const notes = await readIndex()
  const map = new Map(updates.map((u) => [u.id, u]))
  for (let i = 0; i < notes.length; i++) {
    const u = map.get(notes[i].id)
    if (!u) continue
    notes[i] = {
      ...notes[i],
      ...(u.tags !== undefined ? { tags: u.tags } : {}),
      ...(u.category !== undefined ? { category: u.category } : {}),
      ...(u.categorizedBy !== undefined ? { categorizedBy: u.categorizedBy } : {})
    }
  }
  await writeIndex(notes)
}

/** 读取全部笔记（含正文），供检索表/导出/分类使用 */
export async function getAllNotesWithContent(): Promise<Array<NoteMeta & { content: string }>> {
  const metas = await readIndex()
  const out: Array<NoteMeta & { content: string }> = []
  for (const m of metas) {
    try {
      const content = await fs.readFile(noteFile(m.id), 'utf-8')
      out.push({ ...m, content })
    } catch {
      /* 跳过缺失正文 */
    }
  }
  return out
}

/** 导出函数（供外部模块复用：删除标签后同步） */
export { readIndex, writeIndex, noteFile, ensureDir }
