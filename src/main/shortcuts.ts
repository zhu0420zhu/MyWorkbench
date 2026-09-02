import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Shortcut, ShortcutInput } from '../shared/types'

interface Store {
  version: number
  shortcuts: Shortcut[]
}

const EMPTY: Store = { version: 1, shortcuts: [] }

function dataFile(): string {
  return join(app.getPath('userData'), 'shortcuts.json')
}

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(dataFile(), 'utf-8')
    const parsed = JSON.parse(raw) as Store
    if (!parsed || !Array.isArray(parsed.shortcuts)) return EMPTY
    return parsed
  } catch {
    return EMPTY
  }
}

async function writeStore(store: Store): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(dataFile(), JSON.stringify(store, null, 2), 'utf-8')
}

export async function listShortcuts(): Promise<Shortcut[]> {
  const store = await readStore()
  return store.shortcuts
}

export async function addShortcut(input: ShortcutInput): Promise<Shortcut[]> {
  const store = await readStore()
  const item: Shortcut = { ...input, id: randomUUID(), createdAt: Date.now() }
  store.shortcuts.unshift(item)
  await writeStore(store)
  return store.shortcuts
}

export async function updateShortcut(payload: Shortcut): Promise<Shortcut[]> {
  const store = await readStore()
  store.shortcuts = store.shortcuts.map((s) => (s.id === payload.id ? { ...s, ...payload } : s))
  await writeStore(store)
  return store.shortcuts
}

export async function removeShortcut(id: string): Promise<Shortcut[]> {
  const store = await readStore()
  store.shortcuts = store.shortcuts.filter((s) => s.id !== id)
  await writeStore(store)
  return store.shortcuts
}
