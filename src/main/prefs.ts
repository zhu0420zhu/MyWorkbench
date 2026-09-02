import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'

export interface Prefs {
  colorPrimary: string
  defaultPage: string
}

const DEFAULTS: Prefs = { colorPrimary: '#4f6ef7', defaultPage: 'dashboard' }

function file(): string {
  return join(app.getPath('userData'), 'preferences.json')
}

export async function getPrefs(): Promise<Prefs> {
  try {
    const raw = await fs.readFile(file(), 'utf-8')
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) }
  } catch {
    return DEFAULTS
  }
}

export async function setPrefs(p: Prefs): Promise<Prefs> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(file(), JSON.stringify(p, null, 2), 'utf-8')
  return p
}
