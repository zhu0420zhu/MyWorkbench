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

/** V2 契约内（本工程建模）的顶层字段集合 */
const KNOWN_CARD_KEYS = new Set<string>([
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'creator_notes',
  'system_prompt',
  'post_history_instructions',
  'alternate_greetings',
  'tags',
  'creator',
  'character_version',
  'extensions'
])

export function cardToJson(card: CharacterCard): string {
  // 把留存位（未知顶层字段）展平回顶层：输出结构与导入时等价，不留 __extra 内部键。
  // 已知字段后展开，确保契约字段永远优先于同名留存键。
  const { __extra, ...known } = card
  return JSON.stringify({ ...(__extra ?? {}), ...known })
}

function parseCardJson(text: string): CharacterCard | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    // 收集不认识的顶层键，往返零损保留
    const extra: Record<string, unknown> = {}
    for (const k of Object.keys(raw)) {
      if (k === '__extra' || KNOWN_CARD_KEYS.has(k)) continue
      extra[k] = raw[k]
    }
    const card: CharacterCard = {
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
    if (Object.keys(extra).length > 0) card.__extra = extra
    return card
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

/**
 * 保存角色：以 getCharacter 的读取顺序为准——若存在合法 PNG 卡，就把新卡片 JSON
 * 嵌回该 PNG（保留原图字节），否则写纯 JSON 文件。
 * 关键：PNG 卡编辑后必须回写 PNG，否则写入的 .json 永远不会被 getCharacter 读到，
 * 用户会看到「保存成功」但重载后仍是旧卡（静默丢数据）。回写 PNG 时顺带删除同 id
 * 的 .json 残留，避免双份影子文件。
 */
export async function saveCharacter(id: string, card: CharacterCard): Promise<CharacterMeta> {
  const dir = charactersDir()
  await fs.mkdir(dir, { recursive: true })
  const pngPath = join(dir, `${id}.png`)
  const jsonPath = join(dir, `${id}.json`)
  const pngBuf = await fs.readFile(pngPath).catch(() => null)
  if (pngBuf && isPng(new Uint8Array(pngBuf))) {
    const out = embedCharaInPng(new Uint8Array(pngBuf), cardToJson(card))
    await fs.writeFile(pngPath, Buffer.from(out))
    await removeFile(jsonPath)
    return { id, card, hasAvatar: true, updatedAt: Date.now() }
  }
  await fs.writeFile(jsonPath, cardToJson(card), 'utf-8')
  return { id, card, hasAvatar: false, updatedAt: Date.now() }
}

/** 更新角色头像（把当前卡片 JSON 嵌回新 PNG 的 tEXt） */
export async function updateCharacterAvatar(id: string, pngBytes: Uint8Array): Promise<boolean> {
  try {
    const dir = charactersDir()
    await fs.mkdir(dir, { recursive: true })
    // 统一以 getCharacter 的读取顺序取「当前卡片」：这样「先编辑保存、再换头像」不会丢编辑
    const meta = await getCharacter(id)
    let out = pngBytes
    if (meta && isPng(pngBytes)) {
      out = embedCharaInPng(pngBytes, cardToJson(meta.card))
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
