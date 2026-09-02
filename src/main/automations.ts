import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Automation, AutomationInput } from '../shared/types'

interface Store {
  version: number
  automations: Automation[]
}

const EMPTY: Store = { version: 1, automations: [] }

function dataFile(): string {
  return join(app.getPath('userData'), 'automations.json')
}

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(dataFile(), 'utf-8')
    const parsed = JSON.parse(raw) as Store
    if (!parsed || !Array.isArray(parsed.automations)) return EMPTY
    return parsed
  } catch {
    return EMPTY
  }
}

async function writeStore(store: Store): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(dataFile(), JSON.stringify(store, null, 2), 'utf-8')
}

export async function listAutomations(): Promise<Automation[]> {
  const s = await readStore()
  return s.automations
}

export async function addAutomation(input: AutomationInput): Promise<Automation[]> {
  const s = await readStore()
  s.automations.unshift({ ...input, id: randomUUID(), createdAt: Date.now() })
  await writeStore(s)
  return s.automations
}

export async function updateAutomation(payload: Automation): Promise<Automation[]> {
  const s = await readStore()
  s.automations = s.automations.map((a) => (a.id === payload.id ? { ...a, ...payload } : a))
  await writeStore(s)
  return s.automations
}

export async function removeAutomation(id: string): Promise<Automation[]> {
  const s = await readStore()
  s.automations = s.automations.filter((a) => a.id !== id)
  await writeStore(s)
  return s.automations
}
