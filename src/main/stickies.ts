import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { StickyNote, StickyNoteInput } from '../shared/types'

interface Store {
  version: number
  stickies: StickyNote[]
}

const EMPTY: Store = { version: 1, stickies: [] }

function dataFile(): string {
  return join(app.getPath('userData'), 'stickies.json')
}

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(dataFile(), 'utf-8')
    const parsed = JSON.parse(raw) as Store
    if (!parsed || !Array.isArray(parsed.stickies)) return EMPTY
    return parsed
  } catch {
    return EMPTY
  }
}

async function writeStore(store: Store): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(dataFile(), JSON.stringify(store, null, 2), 'utf-8')
}

export async function listStickies(): Promise<StickyNote[]> {
  const s = await readStore()
  return s.stickies
}

export async function getSticky(id: string): Promise<StickyNote | null> {
  const s = await readStore()
  return s.stickies.find((n) => n.id === id) ?? null
}

export async function createSticky(input: StickyNoteInput): Promise<StickyNote[]> {
  const s = await readStore()
  const now = Date.now()
  const note: StickyNote = {
    ...input,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now
  }
  s.stickies.unshift(note)
  await writeStore(s)
  return s.stickies
}

export async function updateSticky(payload: StickyNote): Promise<StickyNote[]> {
  const s = await readStore()
  const idx = s.stickies.findIndex((n) => n.id === payload.id)
  if (idx < 0) return s.stickies
  s.stickies[idx] = { ...payload, updatedAt: Date.now() }
  await writeStore(s)
  return s.stickies
}

export async function removeSticky(id: string): Promise<StickyNote[]> {
  const s = await readStore()
  s.stickies = s.stickies.filter((n) => n.id !== id)
  await writeStore(s)
  return s.stickies
}
