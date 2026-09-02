/**
 * 聊天记录：CRUD + 会话列表（兼容 SillyTavern chats/<charId>/<chatId>.json）
 */
import { join } from 'path'
import { promises as fs } from 'fs'
import type { ChatMessage } from './types'
import { charChatsDir, chatFile, listDirNames, removeFile, readWorkshopConfig, writeWorkshopConfig } from './dataStore'

export interface ChatSummary {
  id: string
  charId: string
  messageCount: number
  lastMessage: string
  updatedAt: number
}

export async function listChats(charId: string): Promise<ChatSummary[]> {
  const names = await listDirNames(charChatsDir(charId))
  const out: ChatSummary[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -5)
    const msgs = await getChat(charId, id)
    if (!msgs) continue
    const last = msgs.length ? msgs[msgs.length - 1].mes : ''
    out.push({
      id,
      charId,
      messageCount: msgs.length,
      lastMessage: last.slice(0, 40),
      updatedAt: await statMs(join(charChatsDir(charId), name))
    })
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

async function statMs(p: string): Promise<number> {
  try {
    return Math.floor((await fs.stat(p)).mtimeMs)
  } catch {
    return 0
  }
}

/** 读取聊天记录（SillyTavern 数组格式 → ChatMessage[]） */
export async function getChat(charId: string, chatId: string): Promise<ChatMessage[] | null> {
  try {
    const raw = JSON.parse(await fs.readFile(chatFile(charId, chatId), 'utf-8'))
    if (!Array.isArray(raw)) return null
    return raw.map((m) => ({
      name: String(m.name ?? ''),
      is_user: Boolean(m.is_user),
      is_name: Boolean(m.is_name),
      send_date: String(m.send_date ?? new Date().toISOString()),
      mes: String(m.mes ?? ''),
      swipes: Array.isArray(m.swipes) ? m.swipes.map(String) : undefined,
      swipe_id: typeof m.swipe_id === 'number' ? m.swipe_id : 0,
      extra: m.extra
    }))
  } catch {
    return null
  }
}

export async function saveChat(charId: string, chatId: string, messages: ChatMessage[]): Promise<void> {
  await fs.mkdir(charChatsDir(charId), { recursive: true })
  await fs.writeFile(chatFile(charId, chatId), JSON.stringify(messages, null, 2), 'utf-8')
}

export async function deleteChat(charId: string, chatId: string): Promise<boolean> {
  return removeFile(chatFile(charId, chatId))
}

export async function newChatId(): Promise<string> {
  return `chat_${Date.now()}`
}

/** 当前活动会话 */
export async function getActiveChat(): Promise<{ charId: string; chatId: string } | null> {
  const cfg = await readWorkshopConfig()
  const charId = cfg['activeChatCharacterId'] as string
  const chatId = cfg['activeChatId'] as string
  return charId && chatId ? { charId, chatId } : null
}

export async function setActiveChat(charId: string, chatId: string): Promise<void> {
  await writeWorkshopConfig({ activeChatCharacterId: charId, activeChatId: chatId })
}
