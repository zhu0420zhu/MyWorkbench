import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { AiChatMessage } from '../shared/types'

export interface AiMemory {
  enabled: boolean
  messages: AiChatMessage[]
}

const DEFAULT_MEMORY: AiMemory = { enabled: false, messages: [] }

function memoryFile(): string {
  return join(app.getPath('userData'), 'ai-memory.json')
}

export async function loadMemory(): Promise<AiMemory> {
  try {
    const raw = await fs.readFile(memoryFile(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<AiMemory>
    return {
      enabled: parsed.enabled ?? false,
      messages: Array.isArray(parsed.messages) ? parsed.messages : []
    }
  } catch {
    return DEFAULT_MEMORY
  }
}

export async function saveMemory(memory: AiMemory): Promise<AiMemory> {
  const data: AiMemory = {
    enabled: Boolean(memory.enabled),
    messages: Array.isArray(memory.messages) ? memory.messages : []
  }
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(memoryFile(), JSON.stringify(data, null, 2), 'utf-8')
  return data
}

export async function clearMemory(): Promise<AiMemory> {
  const data: AiMemory = { enabled: true, messages: [] }
  await saveMemory(data)
  return data
}

/** 记忆导出：返回 JSON 字符串（含开关与消息） */
export async function exportMemory(): Promise<string> {
  const m = await loadMemory()
  return JSON.stringify(m, null, 2)
}

/** 记忆导入：解析 JSON 并保存，返回新记忆 */
export async function importMemory(json: string): Promise<AiMemory> {
  const parsed = JSON.parse(json) as Partial<AiMemory>
  const data: AiMemory = {
    enabled: Boolean(parsed.enabled),
    messages: Array.isArray(parsed.messages) ? parsed.messages : []
  }
  await saveMemory(data)
  return data
}
