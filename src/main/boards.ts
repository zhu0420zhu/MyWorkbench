import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { BoardMeta } from '../shared/types'

interface Store {
  version: number
  boards: BoardMeta[]
}

const EMPTY: Store = { version: 1, boards: [] }

function boardsDir(): string {
  return join(app.getPath('userData'), 'boards')
}

function indexFile(): string {
  return join(boardsDir(), 'boards.json')
}

function boardFile(id: string): string {
  return join(boardsDir(), `${id}.json`)
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(boardsDir(), { recursive: true })
}

async function readIndex(): Promise<BoardMeta[]> {
  try {
    const raw = await fs.readFile(indexFile(), 'utf-8')
    const parsed = JSON.parse(raw) as Store
    if (parsed && Array.isArray(parsed.boards)) return parsed.boards
    return []
  } catch {
    return []
  }
}

async function writeIndex(boards: BoardMeta[]): Promise<void> {
  await ensureDir()
  await fs.writeFile(indexFile(), JSON.stringify({ version: 1, boards }, null, 2), 'utf-8')
}

export async function listBoards(): Promise<BoardMeta[]> {
  return readIndex()
}

export async function createBoard(title: string): Promise<BoardMeta[]> {
  const boards = await readIndex()
  const now = Date.now()
  const meta: BoardMeta = {
    id: randomUUID(),
    title: title.trim() || '未命名白板',
    createdAt: now,
    updatedAt: now
  }
  boards.unshift(meta)
  await writeIndex(boards)
  await fs.writeFile(boardFile(meta.id), JSON.stringify({ document: {} }), 'utf-8')
  return boards
}

export async function renameBoard(id: string, title: string): Promise<BoardMeta[]> {
  const boards = await readIndex()
  const idx = boards.findIndex((b) => b.id === id)
  if (idx < 0) return boards
  boards[idx] = {
    ...boards[idx],
    title: title.trim() || '未命名白板',
    updatedAt: Date.now()
  }
  await writeIndex(boards)
  return boards
}

export async function removeBoard(id: string): Promise<BoardMeta[]> {
  const boards = await readIndex()
  const next = boards.filter((b) => b.id !== id)
  await writeIndex(next)
  try {
    await fs.unlink(boardFile(id))
  } catch {
    /* ignore */
  }
  return next
}

export async function getBoardSnapshot(id: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(boardFile(id), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function saveBoard(id: string, snapshot: unknown): Promise<BoardMeta[]> {
  const boards = await readIndex()
  const idx = boards.findIndex((b) => b.id === id)
  if (idx < 0) return boards
  boards[idx] = { ...boards[idx], updatedAt: Date.now() }
  await writeIndex(boards)
  await ensureDir()
  await fs.writeFile(boardFile(id), JSON.stringify(snapshot), 'utf-8')
  return boards
}
