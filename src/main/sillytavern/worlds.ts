/**
 * 世界书 Lorebook：CRUD + 关键词触发（兼容 SillyTavern 数据格式）
 */
import { join } from 'path'
import { promises as fs } from 'fs'
import type { WorldInfo, WorldEntry } from './types'
import { worldsDir, listDirNames, removeFile, readWorkshopConfig, writeWorkshopConfig } from './dataStore'

export function emptyWorld(name = '新世界书'): WorldInfo {
  return { entries: [], name, recursive_scaling: 50, enable_recursion: false, always_use_pos: false }
}

export async function listWorlds(): Promise<Array<{ id: string; name: string; entryCount: number }>> {
  const names = await listDirNames(worldsDir())
  const out: Array<{ id: string; name: string; entryCount: number }> = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -5)
    const w = await getWorld(id)
    if (w) out.push({ id, name: w.name || id, entryCount: w.entries.length })
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return out
}

export async function getWorld(id: string): Promise<WorldInfo | null> {
  try {
    const raw = JSON.parse(await fs.readFile(join(worldsDir(), `${id}.json`), 'utf-8'))
    const entries: WorldEntry[] = Array.isArray(raw.entries) ? raw.entries : []
    return {
      entries,
      name: String(raw.name ?? id),
      recursive_scaling: Number(raw.recursive_scaling ?? 50),
      enable_recursion: Boolean(raw.enable_recursion),
      always_use_pos: Boolean(raw.always_use_pos)
    }
  } catch {
    return null
  }
}

export async function saveWorld(id: string, world: WorldInfo): Promise<void> {
  await fs.mkdir(worldsDir(), { recursive: true })
  await fs.writeFile(join(worldsDir(), `${id}.json`), JSON.stringify(world, null, 4), 'utf-8')
}

export async function deleteWorld(id: string): Promise<boolean> {
  return removeFile(join(worldsDir(), `${id}.json`))
}

export async function getDefaultWorldId(): Promise<string | null> {
  const cfg = await readWorkshopConfig()
  return (cfg['defaultWorldId'] as string) ?? null
}

export async function setDefaultWorldId(id: string | null): Promise<void> {
  await writeWorkshopConfig({ defaultWorldId: id })
}

/** 关键词触发：从世界书提取应注入的条目（按 insertion_order 升序） */
export function collectLoreEntries(world: WorldInfo, text: string, maxDepth = 999): WorldEntry[] {
  if (!world) return []
  const hit = world.entries.filter((e) => e.enabled !== false && !e.constant && e.key.some((k) => k && text.toLowerCase().includes(k.toLowerCase())))
  const constant = world.entries.filter((e) => e.constant === true)
  const all = [...constant, ...hit]
  all.sort((a, b) => (a.insertion_order ?? 0) - (b.insertion_order ?? 0))
  return all.slice(0, maxDepth)
}
