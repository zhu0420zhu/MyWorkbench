/**
 * 预设系统：采样参数 / 上下文模板 / 指导模板（兼容 SillyTavern presets/ 目录）
 * 同时承载 作者注释 与 正则脚本 与 快速回复（存于 settings.json 的 lingmo_workshop 段）
 */
import { join } from 'path'
import { promises as fs } from 'fs'
import type { RolePreset, SamplingParams, AuthorNote, RegexScript, QuickReply } from './types'
import { presetsDir, listDirNames, removeFile, readWorkshopConfig, writeWorkshopConfig, readJson, writeJson, settingsFile } from './dataStore'

export const DEFAULT_SAMPLING: SamplingParams = {
  temperature: 0.9,
  top_p: 1,
  max_tokens: 1024,
  presence_penalty: 0,
  frequency_penalty: 0,
  repetition_penalty: 1,
  top_k: 0,
  seed: null
}

export function emptyPreset(name = '新预设'): RolePreset {
  return { id: `preset_${Date.now()}`, name, sampling: { ...DEFAULT_SAMPLING }, instruct: {}, context: '', wrap: false, createdAt: Date.now() }
}

export async function listPresets(): Promise<Array<{ id: string; name: string }>> {
  const names = await listDirNames(presetsDir())
  const out: Array<{ id: string; name: string }> = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -5)
    const p = await getPreset(id)
    if (p) out.push({ id, name: p.name || id })
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return out
}

export async function getPreset(id: string): Promise<RolePreset | null> {
  return readJson<RolePreset | null>(join(presetsDir(), `${id}.json`), null)
}

export async function savePreset(preset: RolePreset): Promise<void> {
  await fs.mkdir(presetsDir(), { recursive: true })
  await fs.writeFile(join(presetsDir(), `${preset.id}.json`), JSON.stringify(preset, null, 4), 'utf-8')
}

export async function deletePreset(id: string): Promise<boolean> {
  return removeFile(join(presetsDir(), `${id}.json`))
}

export async function getDefaultPresetId(): Promise<string | null> {
  const cfg = await readWorkshopConfig()
  return (cfg['defaultPresetId'] as string) ?? null
}

export async function setDefaultPresetId(id: string | null): Promise<void> {
  await writeWorkshopConfig({ defaultPresetId: id })
}

/* ---------- 作者注释 / 正则 / 快速回复（settings.json lingmo_workshop 段） ---------- */
const AUTHOR_NOTE_KEY = 'authorNote'
const REGEX_KEY = 'regexScripts'
const QUICK_KEY = 'quickReplies'

export async function getAuthorNote(): Promise<AuthorNote> {
  const cfg = await readWorkshopConfig()
  return (cfg[AUTHOR_NOTE_KEY] as AuthorNote) ?? { enabled: false, note: '', position: 'top', depth: 0, role: 'system' }
}

export async function setAuthorNote(note: AuthorNote): Promise<void> {
  await writeWorkshopConfig({ [AUTHOR_NOTE_KEY]: note })
}

export async function getRegexScripts(): Promise<RegexScript[]> {
  const cfg = await readWorkshopConfig()
  return (cfg[REGEX_KEY] as RegexScript[]) ?? []
}

export async function setRegexScripts(list: RegexScript[]): Promise<void> {
  await writeWorkshopConfig({ [REGEX_KEY]: list })
}

export async function getQuickReplies(): Promise<QuickReply[]> {
  const cfg = await readWorkshopConfig()
  return (cfg[QUICK_KEY] as QuickReply[]) ?? []
}

export async function setQuickReplies(list: QuickReply[]): Promise<void> {
  await writeWorkshopConfig({ [QUICK_KEY]: list })
}

/** 确保 settings.json 存在（首次启动时由引擎调用） */
export async function touchSettings(): Promise<void> {
  const s = await readJson<Record<string, unknown>>(settingsFile(), {})
  await writeJson(settingsFile(), s)
}
