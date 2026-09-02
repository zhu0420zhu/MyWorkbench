/**
 * 角色卡系统：CRUD + PNG 卡片导入导出 + 默认角色
 * 兼容 SillyTavern：characters/<id>.png（内嵌 JSON）或 <id>.json（无头像）
 */
import { join } from 'path'
import { promises as fs } from 'fs'
import type { CharacterCard, CharacterMeta } from './types'
import { charactersDir, listDirNames, removeFile, readWorkshopConfig, writeWorkshopConfig } from './dataStore'
import { extractCharaFromPng, embedCharaInPng, isPng } from './pngCards'

export function emptyCard(name = '新角色'): CharacterCard {
  return {
    name,
    description: '',
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '',
    extensions: {}
  }
}

export function cardToJson(card: CharacterCard): string {
  return JSON.stringify(card)
}

function parseCardJson(text: string): CharacterCard | null {
  try {
    const raw = JSON.parse(text) as Partial<CharacterCard>
    return {
      name: String(raw.name ?? '未命名'),
      description: String(raw.description ?? ''),
      personality: String(raw.personality ?? ''),
      scenario: String(raw.scenario ?? ''),
      first_mes: String(raw.first_mes ?? ''),
      mes_example: String(raw.mes_example ?? ''),
      creator_notes: String(raw.creator_notes ?? ''),
      system_prompt: String(raw.system_prompt ?? ''),
      post_history_instructions: String(raw.post_history_instructions ?? ''),
      alternate_greetings: Array.isArray(raw.alternate_greetings) ? raw.alternate_greetings.map(String) : [],
      tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
      creator: String(raw.creator ?? ''),
      character_version: String(raw.character_version ?? ''),
      extensions: (raw.extensions as Record<string, unknown>) ?? {}
    }
  } catch {
    return null
  }
}

async function statTime(p: string): Promise<number> {
  try {
    const s = await fs.stat(p)
    return Math.floor(s.mtimeMs)
  } catch {
    return 0
  }
}

/** 读取单个角色（文件为 PNG 卡片或纯 JSON） */
export async function getCharacter(id: string): Promise<CharacterMeta | null> {
  const dir = charactersDir()
  const pngPath = join(dir, `${id}.png`)
  const jsonPath = join(dir, `${id}.json`)
  try {
    const pngBuf = await fs.readFile(pngPath).catch(() => null)
    if (pngBuf) {
      const chara = isPng(pngBuf) ? extractCharaFromPng(new Uint8Array(pngBuf)) : null
      const card = chara ? parseCardJson(chara) : null
      if (!card) return null
      return { id, card, hasAvatar: true, updatedAt: await statTime(pngPath) }
    }
    const json = await fs.readFile(jsonPath, 'utf-8').catch(() => null)
    if (json) {
      const card = parseCardJson(json)
      if (!card) return null
      return { id, card, hasAvatar: false, updatedAt: await statTime(jsonPath) }
    }
    return null
  } catch {
    return null
  }
}

/** 列出全部角色 */
export async function listCharacters(): Promise<CharacterMeta[]> {
  const names = await listDirNames(charactersDir())
  const metas: CharacterMeta[] = []
  for (const name of names) {
    const m = /^(.*)\.(png|json)$/.exec(name)
    if (!m) continue
    const id = m[1]
    // 避免 png/json 双文件重复
    if (metas.some((x) => x.id === id)) continue
    const meta = await getCharacter(id)
    if (meta) metas.push(meta)
  }
  metas.sort((a, b) => a.card.name.localeCompare(b.card.name, 'zh'))
  return metas
}

/** 保存角色：纯 JSON 卡（保留原有 PNG 头像时走 updateAvatar） */
export async function saveCharacter(id: string, card: CharacterCard): Promise<CharacterMeta> {
  const jsonPath = join(charactersDir(), `${id}.json`)
  await fs.mkdir(charactersDir(), { recursive: true })
  await fs.writeFile(jsonPath, cardToJson(card), 'utf-8')
  return { id, card, hasAvatar: false, updatedAt: Date.now() }
}

/** 更新角色头像（原角色为 PNG 卡时，把新卡 JSON 嵌回 PNG 的 tEXt） */
export async function updateCharacterAvatar(id: string, pngBytes: Uint8Array): Promise<boolean> {
  try {
    const dir = charactersDir()
    await fs.mkdir(dir, { recursive: true })
    const existingPng = await fs.readFile(join(dir, `${id}.png`)).catch(() => null)
    const card = existingPng && isPng(existingPng)
      ? extractCharaFromPng(new Uint8Array(existingPng))
      : await fs.readFile(join(dir, `${id}.json`), 'utf-8').catch(() => null)
    let out = pngBytes
    if (card && isPng(pngBytes)) {
      out = embedCharaInPng(pngBytes, card)
    }
    await fs.writeFile(join(dir, `${id}.png`), Buffer.from(out))
    await removeFile(join(dir, `${id}.json`))
    return true
  } catch {
    return false
  }
}

/** 导出角色为 PNG 卡片（无图时生成纯 JSON 文件字节） */
export async function exportCharacterCard(id: string): Promise<{ bytes: Uint8Array; isPng: boolean }> {
  const dir = charactersDir()
  const pngPath = join(dir, `${id}.png`)
  const png = await fs.readFile(pngPath).catch(() => null)
  if (png) return { bytes: new Uint8Array(png), isPng: true }
  const json = await fs.readFile(join(dir, `${id}.json`), 'utf-8')
  return { bytes: new Uint8Array(Buffer.from(json, 'utf-8')), isPng: false }
}

/** 导入角色卡（PNG 或 JSON 字节），返回新角色 id；重名则加后缀 */
export async function importCharacter(bytes: Uint8Array, preferredId?: string): Promise<CharacterMeta | null> {
  const isPngFile = isPng(bytes)
  const charaText = isPngFile ? extractCharaFromPng(bytes) : new TextDecoder().decode(bytes)
  if (!charaText) return null
  const card = parseCardJson(charaText)
  if (!card) return null
  const dir = charactersDir()
  await fs.mkdir(dir, { recursive: true })
  const baseId = (preferredId && /^[\w\u4e00-\u9fa5-]+$/.test(preferredId))
    ? preferredId
    : (card.name || '角色').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)
  let id = baseId
  let n = 2
  while (await fs.access(join(dir, `${id}.png`)).then(() => true, () => fs.access(join(dir, `${id}.json`)).then(() => true, () => false))) {
    id = `${baseId}_${n++}`
  }
  if (isPngFile) {
    // 新 PNG 卡：卡片 JSON 已在图内，直接落盘
    await fs.writeFile(join(dir, `${id}.png`), Buffer.from(bytes))
  } else {
    await fs.writeFile(join(dir, `${id}.json`), Buffer.from(bytes))
  }
  return getCharacter(id)
}

export async function deleteCharacter(id: string): Promise<boolean> {
  await removeFile(join(charactersDir(), `${id}.png`))
  await removeFile(join(charactersDir(), `${id}.json`))
  return true
}

/** 获取/设置默认角色 */
export async function getDefaultCharacterId(): Promise<string | null> {
  const cfg = await readWorkshopConfig()
  return (cfg['defaultCharacterId'] as string) ?? null
}

export async function setDefaultCharacterId(id: string | null): Promise<void> {
  await writeWorkshopConfig({ defaultCharacterId: id })
}
