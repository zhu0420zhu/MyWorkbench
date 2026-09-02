/**
 * 角色扮演引擎：提示词构建 + 正则后处理 + 带采样参数的流式对话
 * 复用本应用 AI 配置（readAiConfig），流式事件沿用 ai:chunk / ai:done 通道。
 */
import { type WebContents } from 'electron'
import { readAiConfig } from '../ai'
import type { AiChatMessage } from '../../shared/types'
import type { CharacterCard, ChatMessage, SamplingParams, AuthorNote, RegexScript, WorldInfo } from './types'
import { DEFAULT_SAMPLING } from './presets'
import { collectLoreEntries } from './worlds'

const aborters = new Map<string, AbortController>()

export function stopStream(sessionId: string): boolean {
  const c = aborters.get(sessionId)
  if (!c) return false
  c.abort()
  aborters.delete(sessionId)
  return true
}

/* ---------- 正则后处理 ---------- */
export function applyRegex(text: string, scripts: RegexScript[], placement: RegexScript['placement'][number]): string {
  let out = text
  for (const s of scripts) {
    if (s.disabled) continue
    if (!s.placement.includes(placement)) continue
    try {
      const re = new RegExp(s.findRegex, s.trimStrings ? 'gi' : 'g')
      out = out.replace(re, s.replaceString)
    } catch {
      /* 无效正则跳过 */
    }
  }
  return out
}

/* ---------- 提示词构建 ---------- */

/** 世界书注入文本 */
function loreText(world: WorldInfo | null, conversationText: string): string {
  if (!world) return ''
  const hits = collectLoreEntries(world, conversationText)
  if (!hits.length) return ''
  const blocks = hits.map((e) => `【${e.key.join(' / ')}】\n${e.content}`)
  return `\n[世界书·设定]\n${blocks.join('\n\n')}`
}

/** 构建 system 提示（人设 + 系统指令 + 世界书 + 作者注释） */
export function buildSystemPrompt(opts: {
  card: CharacterCard | null
  world: WorldInfo | null
  conversationText: string
  authorNote: AuthorNote | null
}): string {
  const parts: string[] = []
  if (opts.card) {
    const c = opts.card
    const bio: string[] = []
    if (c.description) bio.push(c.description)
    if (c.personality) bio.push(`性格：${c.personality}`)
    if (c.scenario) bio.push(`场景：${c.scenario}`)
    if (bio.length) parts.push(`你是角色「${c.name}」。\n${bio.join('\n')}`)
    if (c.system_prompt) parts.push(c.system_prompt)
    if (c.post_history_instructions) parts.push(c.post_history_instructions)
    if (c.mes_example) parts.push(`对话示例：\n${c.mes_example}`)
  } else {
    parts.push('你是一位乐于助人的写作助手，请用自然的中文与用户对话。')
  }
  const lore = loreText(opts.world, opts.conversationText)
  if (lore) parts.push(lore)
  if (opts.authorNote?.enabled && opts.authorNote.note) {
    parts.push(`[作者注释] ${opts.authorNote.note}`)
  }
  return parts.join('\n\n')
}

/** 历史 → OpenAI 消息（用户/AI 交替，角色名注入） */
export function buildMessages(
  card: CharacterCard | null,
  history: ChatMessage[],
  userText: string,
  system: string
): AiChatMessage[] {
  const msgs: AiChatMessage[] = []
  if (system) msgs.push({ role: 'system', content: system })
  for (const m of history) {
    if (!m.mes) continue
    const name = m.is_user ? '用户' : card?.name ?? '助手'
    msgs.push({ role: m.is_user ? 'user' : 'assistant', content: m.is_name ? `${name}：${m.mes}` : m.mes })
  }
  msgs.push({ role: 'user', content: card ? `用户：${userText}` : userText })
  return msgs
}

/* ---------- 流式对话（带采样参数） ---------- */
export async function streamChat(
  sender: WebContents,
  sessionId: string,
  messages: AiChatMessage[],
  params: Partial<SamplingParams>,
  modelOverride?: string
): Promise<boolean> {
  const cfg = await readAiConfig()
  if (!cfg.endpoint) {
    sendChunk(sender, sessionId, '\n[未配置 AI：请在「设置 → AI」填写 endpoint/apiKey]')
    sendDone(sender, sessionId, false)
    return false
  }
  const p = { ...DEFAULT_SAMPLING, ...params }
  const controller = new AbortController()
  aborters.set(sessionId, controller)

  const body: Record<string, unknown> = {
    model: modelOverride ?? (cfg.model || undefined),
    messages,
    stream: true,
    temperature: p.temperature,
    top_p: p.top_p,
    max_tokens: p.max_tokens,
    presence_penalty: p.presence_penalty,
    frequency_penalty: p.frequency_penalty
  }
  if (p.top_k > 0) body['top_k'] = p.top_k
  if (p.seed != null) body['seed'] = p.seed

  try {
    const res = await fetch(`${cfg.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      sendChunk(sender, sessionId, `\n[请求失败 ${res.status}] ${text.slice(0, 300)}`)
      sendDone(sender, sessionId, false)
      return false
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const json = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> }
          const delta = json.choices?.[0]?.delta?.content
          if (delta) sendChunk(sender, sessionId, delta)
        } catch {
          /* ignore */
        }
      }
    }
    sendDone(sender, sessionId, true)
    return true
  } catch (err) {
    const aborted = (err as Error)?.name === 'AbortError'
    sendChunk(sender, sessionId, aborted ? '\n[已停止]' : `\n[错误] ${(err as Error)?.message ?? '未知'}`)
    sendDone(sender, sessionId, false)
    return false
  } finally {
    aborters.delete(sessionId)
  }
}

function sendChunk(sender: WebContents, sessionId: string, chunk: string): void {
  try {
    if (!sender.isDestroyed()) sender.send('ai:chunk', { sessionId, chunk })
  } catch {
    /* ignore */
  }
}
function sendDone(sender: WebContents, sessionId: string, ok: boolean): void {
  try {
    if (!sender.isDestroyed()) sender.send('ai:done', { sessionId, ok })
  } catch {
    /* ignore */
  }
}
