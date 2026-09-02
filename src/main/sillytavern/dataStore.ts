/**
 * 数据存储：读写 userData/sillytavern-data（与 SillyTavern 目录布局兼容，可继承旧数据）
 *   dataRoot/
 *     default-user/
 *       characters/*.png       角色卡（PNG 内嵌 JSON）
 *       worlds/*.json          世界书
 *       chats/<charId>/<chatId>.json  聊天记录
 *       presets/<name>.json    预设
 *       settings.json          用户设置（默认角色/世界书等）
 */
import { app } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'

export function dataRoot(): string {
  return join(app.getPath('userData'), 'sillytavern-data')
}

function userDir(): string {
  return join(dataRoot(), 'default-user')
}

async function ensureUserDir(): Promise<void> {
  await fs.mkdir(userDir(), { recursive: true })
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true })
}

/* ---------- 通用 JSON 读写 ---------- */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T
  } catch {
    return fallback
  }
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await ensureDir(join(file, '..'))
  await fs.writeFile(file, JSON.stringify(data, null, 4), 'utf-8')
}

/* ---------- 目录定位 ---------- */
export function charactersDir(): string {
  return join(userDir(), 'characters')
}
export function worldsDir(): string {
  return join(userDir(), 'worlds')
}
export function chatsDir(): string {
  return join(userDir(), 'chats')
}
export function presetsDir(): string {
  return join(userDir(), 'presets')
}
export function settingsFile(): string {
  return join(userDir(), 'settings.json')
}

/** 聊天记录目录：chats/<charId>/ */
export function charChatsDir(charId: string): string {
  return join(chatsDir(), charId)
}

/** 聊天记录文件：chats/<charId>/<chatId>.json */
export function chatFile(charId: string, chatId: string): string {
  return join(charChatsDir(charId), `${chatId}.json`)
}

export async function listDirNames(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isFile() || d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

export async function removeFile(p: string): Promise<boolean> {
  try {
    await fs.unlink(p)
    return true
  } catch {
    return false
  }
}

/** 工作台配置（默认角色/世界书/预设/当前会话）存于 settings.json 的 lingmo 段 */
export async function readWorkshopConfig(): Promise<Record<string, unknown>> {
  const s = await readJson<Record<string, unknown>>(settingsFile(), {})
  return (s['lingmo_workshop'] as Record<string, unknown>) ?? {}
}

export async function writeWorkshopConfig(patch: Record<string, unknown>): Promise<void> {
  const s = await readJson<Record<string, unknown>>(settingsFile(), {})
  const cur = (s['lingmo_workshop'] as Record<string, unknown>) ?? {}
  s['lingmo_workshop'] = { ...cur, ...patch }
  await writeJson(settingsFile(), s)
}

export async function initDataStore(): Promise<void> {
  await ensureUserDir()
  await ensureDir(charactersDir())
  await ensureDir(worldsDir())
  await ensureDir(chatsDir())
  await ensureDir(presetsDir())
}
