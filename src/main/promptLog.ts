import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { PromptLogItem, PromptLogSource } from '../shared/types'

export interface PromptLogAddInput {
  text: string
  source: PromptLogSource
  model?: string
}

interface PromptLogData {
  items: PromptLogItem[]
}

/** 最多保留条数，超出后丢弃最旧 */
const MAX_ITEMS = 500

function logFile(): string {
  return join(app.getPath('userData'), 'prompt-log.json')
}

async function load(): Promise<PromptLogData> {
  try {
    const raw = await fs.readFile(logFile(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PromptLogData>
    return { items: Array.isArray(parsed.items) ? parsed.items : [] }
  } catch {
    return { items: [] }
  }
}

async function save(data: PromptLogData): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(logFile(), JSON.stringify(data, null, 2), 'utf-8')
}

/** 追加一条提示词记录（自动去首尾空白，空内容忽略） */
export async function addPromptLog(input: PromptLogAddInput): Promise<PromptLogItem | null> {
  const text = (input.text ?? '').trim()
  if (!text) return null
  const item: PromptLogItem = {
    id: randomUUID(),
    text,
    at: Date.now(),
    source: input.source,
    ...(input.model ? { model: input.model } : {})
  }
  const data = await load()
  const items = [item, ...data.items].slice(0, MAX_ITEMS)
  await save({ items })
  return item
}

/** 返回全部记录（新→旧） */
export async function listPromptLog(): Promise<PromptLogItem[]> {
  const data = await load()
  return data.items
}

/** 删除一条记录，返回剩余列表 */
export async function deletePromptLog(id: string): Promise<PromptLogItem[]> {
  const data = await load()
  const items = data.items.filter((x) => x.id !== id)
  await save({ items })
  return items
}

/** 清空全部记录 */
export async function clearPromptLog(): Promise<PromptLogItem[]> {
  await save({ items: [] })
  return []
}
