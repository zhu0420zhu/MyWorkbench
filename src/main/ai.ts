import { app, net, safeStorage, type WebContents } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'node:crypto'
import type {
  AiConfig,
  AiChatMessage,
  AiProfile,
  AiProfilesState,
  AiRouting,
  AiTool,
  AiToolCall,
  AiVisionMessage
} from '../shared/types'
import { getMcpManager } from './mcp'
import { recordAiUsage, estimateTokens } from './usageStats'

const DEFAULT_CONFIG: AiConfig = {
  endpoint: '',
  apiKey: '',
  model: '',
  systemPrompt: '你是一个乐于助人的助手。'
}

/** 磁盘上的单套配置（旧版兼容 + profiles 内部条目） */
interface AiConfigFile {
  id?: string
  name?: string
  endpoint: string
  model: string
  systemPrompt: string
  secondaryModel?: string
  apiKeyEnc?: string
  apiKey?: string
  createdAt?: number
  updatedAt?: number
}

/** 多套配置文件 */
interface AiProfilesFile {
  version: 2
  activeId: string
  profiles: AiConfigFile[]
  routing?: {
    primaryId: string
    primaryIds?: string[]
    fallbackId?: string
    fallbackIds?: string[]
    mode: 'primary-only' | 'failover' | 'both'
  }
}

function configFile(): string {
  return join(app.getPath('userData'), 'ai-config.json')
}

function encryptApiKey(key: string): string | undefined {
  const k = (key ?? '').trim()
  if (!k) return undefined
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(k).toString('base64')
    }
  } catch {
    /* fall through */
  }
  // 系统安全存储不可用时仍允许保存（否则配置无法写入/调用），用可识别前缀标记为弱加密
  return 'plain:' + Buffer.from(k, 'utf-8').toString('base64')
}

function decryptApiKey(enc: string | undefined): string {
  if (!enc) return ''
  if (enc.startsWith('plain:')) {
    try {
      return Buffer.from(enc.slice(6), 'base64').toString('utf-8')
    } catch {
      return ''
    }
  }
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    }
  } catch {
    /* ignore */
  }
  return ''
}

function normalizeProfile(raw: AiConfigFile, fallbackName?: string): AiProfile {
  let apiKey = decryptApiKey(raw.apiKeyEnc)
  if (!apiKey && raw.apiKey) apiKey = String(raw.apiKey)
  return {
    id: raw.id || randomUUID(),
    name: (raw.name || fallbackName || '未命名配置').trim(),
    endpoint: (raw.endpoint ?? '').trim().replace(/\/+$/, ''),
    apiKey,
    model: (raw.model ?? '').trim(),
    systemPrompt: raw.systemPrompt ?? '你是一个乐于助人的助手。',
    secondaryModel: raw.secondaryModel,
    createdAt: raw.createdAt ?? Date.now(),
    updatedAt: raw.updatedAt ?? Date.now()
  }
}

function profileToFile(p: AiProfile): AiConfigFile {
  return {
    id: p.id,
    name: p.name,
    endpoint: p.endpoint.trim().replace(/\/+$/, ''),
    model: p.model.trim(),
    systemPrompt: p.systemPrompt ?? '',
    secondaryModel: p.secondaryModel,
    apiKeyEnc: encryptApiKey(p.apiKey),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt
  }
}

/** 读磁盘：兼容旧单套格式 → 自动迁移为 v2 多套 */
async function readProfilesFile(): Promise<AiProfilesState> {
  try {
    const raw = JSON.parse(await fs.readFile(configFile(), 'utf-8')) as Partial<AiProfilesFile> & Partial<AiConfigFile>
    if (raw && Array.isArray((raw as AiProfilesFile).profiles)) {
      const f = raw as AiProfilesFile
      const profiles = f.profiles.map((p, i) => normalizeProfile(p, `配置 ${i + 1}`))
      const activeId = profiles.find((x) => x.id === f.activeId)?.id ?? profiles[0]?.id ?? ''
      return {
        activeId,
        profiles,
        routing: f.routing
          ? normalizeRouting(
              {
                primaryId: f.routing.primaryId,
                primaryIds: f.routing.primaryIds ?? (f.routing.primaryId ? [f.routing.primaryId] : []),
                fallbackId: f.routing.fallbackId,
                fallbackIds: f.routing.fallbackIds ?? (f.routing.fallbackId ? [f.routing.fallbackId] : []),
                mode: f.routing.mode || 'failover'
              },
              { activeId, profiles }
            )
          : undefined
      }
    }
    // 旧版单套
    const legacy = raw as AiConfigFile
    const p = normalizeProfile(legacy, '默认配置')
    if (legacy.apiKey && !legacy.apiKeyEnc) {
      p.apiKey = String(legacy.apiKey)
    }
    return { activeId: p.id, profiles: [p], routing: undefined }
  } catch {
    return { activeId: '', profiles: [], routing: undefined }
  }
}

async function writeProfilesFile(state: AiProfilesState): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  const file: AiProfilesFile = {
    version: 2,
    activeId: state.activeId,
    profiles: state.profiles.map(profileToFile),
    routing: state.routing
  }
  await fs.writeFile(configFile(), JSON.stringify(file, null, 2), 'utf-8')
}

/** 默认路由：activeId 为主力，无 fallback */
function defaultRouting(state: AiProfilesState): AiRouting {
  const id = state.activeId || state.profiles[0]?.id || ''
  return {
    primaryId: id,
    primaryIds: id ? [id] : [],
    fallbackId: undefined,
    fallbackIds: [],
    mode: 'failover'
  }
}

/** 规范化路由（兼容旧 primaryId/fallbackId） */
function normalizeRouting(r: AiRouting | undefined, state: AiProfilesState): AiRouting {
  const d = defaultRouting(state)
  if (!r) return d
  const rawPrimary: string[] = r.primaryIds?.length ? r.primaryIds : r.primaryId ? [r.primaryId] : (d.primaryIds || [])
  const primaryIds = (rawPrimary || []).filter((id) => state.profiles.some((p) => p.id === id))
  const rawFallback: string[] = r.fallbackIds?.length ? r.fallbackIds : r.fallbackId ? [r.fallbackId] : []
  const fallbackIds = (rawFallback || []).filter(
    (id) => id && state.profiles.some((p) => p.id === id) && !primaryIds.includes(id)
  )
  return {
    primaryId: primaryIds[0] || d.primaryId,
    primaryIds: primaryIds.length ? primaryIds : (d.primaryIds || []),
    fallbackId: fallbackIds[0],
    fallbackIds,
    mode: r.mode || 'failover'
  }
}

export async function getRouting(): Promise<AiRouting> {
  const state = await readProfilesFile()
  return normalizeRouting(state.routing, state)
}

export async function setRouting(r: Partial<AiRouting>): Promise<AiRouting> {
  const state = await readProfilesFile()
  const prev = normalizeRouting(state.routing, state)
  const next = normalizeRouting({ ...prev, ...r }, state)
  state.routing = next
  state.activeId = next.primaryId
  await writeProfilesFile(state)
  return next
}

function profileChain(state: AiProfilesState, routing: AiRouting, mode: 'auto' | 'both' | 'failover'): AiProfile[] {
  const byId = (id?: string) => (id ? state.profiles.find((p) => p.id === id) ?? null : null)
  const primary = (routing.primaryIds ?? []).map(byId).filter(Boolean) as AiProfile[]
  const fallback = (routing.fallbackIds ?? []).map(byId).filter(Boolean) as AiProfile[]
  if (mode === 'both' || routing.mode === 'both') return [...primary, ...fallback]
  if (mode === 'failover' || routing.mode === 'failover') return [...primary, ...fallback]
  return primary.length ? primary : fallback.slice(0, 1)
}

/** 按配置发起一次请求（供主/备切换与多路） */
async function completeWithProfile(
  profile: AiProfile | null,
  messages: AiChatMessage[],
  opts?: { tools?: AiTool[]; modelOverride?: string }
): Promise<{ ok: boolean; text?: string; toolCalls?: AiToolCall[]; error?: string; profileName?: string }> {
  const name = profile?.name || '未指定'
  if (!profile?.endpoint) return { ok: false, error: `${name}：未配置 API 地址`, profileName: name }
  const promptText = messages.map((m) => m.content ?? '').join('\n')
  void recordAiUsage({
    model: opts?.modelOverride || profile.model || name,
    kind: 'complete',
    promptChars: promptText.length,
    approxTokens: estimateTokens(promptText)
  })
  try {
    const body: Record<string, unknown> = {
      model: opts?.modelOverride ?? (profile.model || undefined),
      messages: profile.systemPrompt
        ? [{ role: 'system', content: profile.systemPrompt }, ...messages]
        : messages,
      stream: false
    }
    if (opts?.tools && opts.tools.length) body.tools = opts.tools
    const res = await net.fetch(`${profile.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {})
      },
      body: JSON.stringify(body)
    })
    if (!res.ok) return { ok: false, error: `${name}：HTTP ${res.status}`, profileName: name }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; tool_calls?: AiToolCall[] } }>
    }
    const msg = json.choices?.[0]?.message
    return { ok: true, text: msg?.content ?? '', toolCalls: msg?.tool_calls, profileName: name }
  } catch (err) {
    return { ok: false, error: `${name}：${(err as Error).message}`, profileName: name }
  }
}

export async function listAiProfiles(): Promise<AiProfilesState> {
  const state = await readProfilesFile()
  if (!state.profiles.length) {
    return { activeId: '', profiles: [], routing: undefined }
  }
  state.routing = normalizeRouting(state.routing, state)
  try {
    await writeProfilesFile(state)
  } catch {
    /* ignore */
  }
  return state
}

/** 一键添加本地 Ollama（无需 Key） */
export async function addOllamaProfile(opts?: {
  endpoint?: string
  model?: string
  name?: string
}): Promise<AiProfilesState> {
  const endpoint = (opts?.endpoint || 'http://localhost:11434/v1').trim().replace(/\/+$/, '')
  const model = (opts?.model || 'qwen2.5:14b').trim()
  const name = (opts?.name || `Ollama ${model}`).trim()
  // 先探活
  try {
    const res = await net.fetch(`${endpoint}/models`, { method: 'GET' })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
  } catch (err) {
    throw new Error(`无法连接 Ollama（${endpoint}）：${(err as Error).message}。请确认 ollama serve 已启动`)
  }
  return addAiProfile({
    name,
    endpoint,
    apiKey: '',
    model,
    systemPrompt: '你是一个乐于助人的助手。',
    activate: true
  })
}

export async function getActiveAiProfile(): Promise<AiProfile | null> {
  const state = await listAiProfiles()
  return state.profiles.find((p) => p.id === state.activeId) ?? state.profiles[0] ?? null
}

/** 当前生效配置（chat/complete/AI 右键统一走这里） */
export async function readAiConfig(): Promise<AiConfig> {
  const p = await getActiveAiProfile()
  if (!p) return DEFAULT_CONFIG
  return {
    endpoint: p.endpoint,
    apiKey: p.apiKey,
    model: p.model,
    systemPrompt: p.systemPrompt,
    secondaryModel: p.secondaryModel
  }
}

/** 保存当前生效配置（设置页单套表单 / 兼容旧 IPC） */
export async function saveAiConfig(input: AiConfig): Promise<AiConfig> {
  const state = await readProfilesFile()
  const now = Date.now()
  const next: AiConfig = {
    endpoint: (input.endpoint ?? '').trim().replace(/\/+$/, ''),
    apiKey: (input.apiKey ?? '').trim(),
    model: (input.model ?? '').trim(),
    systemPrompt: input.systemPrompt ?? '',
    secondaryModel: input.secondaryModel
  }
  const profile: AiProfile = {
    id: state.activeId || randomUUID(),
    name: state.profiles.find((p) => p.id === state.activeId)?.name || '默认配置',
    endpoint: next.endpoint,
    apiKey: next.apiKey,
    model: next.model,
    systemPrompt: next.systemPrompt,
    secondaryModel: next.secondaryModel,
    createdAt: state.profiles.find((p) => p.id === state.activeId)?.createdAt ?? now,
    updatedAt: now
  }
  const profiles = state.profiles.some((p) => p.id === profile.id)
    ? state.profiles.map((p) => (p.id === profile.id ? profile : p))
    : [...state.profiles, profile]
  await writeProfilesFile({ activeId: profile.id, profiles })
  return next
}

export async function addAiProfile(input: {
  name: string
  endpoint?: string
  apiKey?: string
  model?: string
  systemPrompt?: string
  secondaryModel?: string
  activate?: boolean
}): Promise<AiProfilesState> {
  const state = await readProfilesFile()
  const now = Date.now()
  const p: AiProfile = {
    id: randomUUID(),
    name: (input.name || '新配置').trim(),
    endpoint: (input.endpoint ?? '').trim().replace(/\/+$/, ''),
    apiKey: (input.apiKey ?? '').trim(),
    model: (input.model ?? '').trim(),
    systemPrompt: input.systemPrompt ?? '你是一个乐于助人的助手。',
    secondaryModel: input.secondaryModel,
    createdAt: now,
    updatedAt: now
  }
  const profiles = [...state.profiles, p]
  const activeId = input.activate !== false || !state.activeId ? p.id : state.activeId
  await writeProfilesFile({ activeId, profiles })
  return { activeId, profiles }
}

export async function updateAiProfile(
  id: string,
  patch: Partial<Pick<AiProfile, 'name' | 'endpoint' | 'apiKey' | 'model' | 'systemPrompt' | 'secondaryModel'>>
): Promise<AiProfilesState> {
  const state = await readProfilesFile()
  const profiles = state.profiles.map((p) => {
    if (p.id !== id) return p
    const next = { ...p, ...patch, updatedAt: Date.now() }
    if (patch.endpoint !== undefined) next.endpoint = patch.endpoint.trim().replace(/\/+$/, '')
    if (patch.apiKey !== undefined) next.apiKey = patch.apiKey.trim()
    if (patch.model !== undefined) next.model = patch.model.trim()
    return next
  })
  await writeProfilesFile({ activeId: state.activeId, profiles })
  return { activeId: state.activeId, profiles }
}

export async function removeAiProfile(id: string): Promise<AiProfilesState> {
  const state = await readProfilesFile()
  const profiles = state.profiles.filter((p) => p.id !== id)
  let activeId = state.activeId
  if (activeId === id) activeId = profiles[0]?.id ?? ''
  await writeProfilesFile({ activeId, profiles })
  return { activeId, profiles }
}

export async function setActiveAiProfile(id: string): Promise<AiProfilesState> {
  const state = await readProfilesFile()
  if (!state.profiles.some((p) => p.id === id)) return state
  await writeProfilesFile({ activeId: id, profiles: state.profiles })
  return { activeId: id, profiles: state.profiles }
}

/** 测试指定配置连通性（不切换当前生效配置） */
export async function testAiProfile(input: AiConfig): Promise<{ ok: boolean; error?: string; latencyMs?: number }> {
  const endpoint = (input.endpoint ?? '').trim().replace(/\/+$/, '')
  if (!endpoint) return { ok: false, error: '未配置 API 地址' }
  const start = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await net.fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...((input.apiKey ?? '').trim() ? { Authorization: `Bearer ${input.apiKey.trim()}` } : {})
      },
      body: JSON.stringify({
        model: (input.model ?? '').trim() || undefined,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false
      }),
      signal: controller.signal
    })
    clearTimeout(timer)
    if (res.ok) return { ok: true, latencyMs: Date.now() - start }
    const text = await res.text().catch(() => '')
    // 模型名拼写错误（如 wen2.5:14b）时给出可执行提示
    if (res.status === 404 && /model|not.?found/i.test(text)) {
      return {
        ok: false,
        error: `模型「${input.model}」不存在。请改成服务上的准确模型名（Ollama 可先点「拉取模型列表」）。原文：${text.slice(0, 160)}`
      }
    }
    return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 200)}` }
  } catch (err) {
    clearTimeout(timer)
    return { ok: false, error: (err as Error).message }
  }
}

/** 从 OpenAI 兼容端点拉取可用模型列表 */
export async function listEndpointModels(
  endpoint: string,
  apiKey?: string
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const ep = (endpoint ?? '').trim().replace(/\/+$/, '')
  if (!ep) return { ok: false, models: [], error: '未配置 API 地址' }
  try {
    const res = await net.fetch(`${ep}/models`, {
      method: 'GET',
      headers: {
        ...(apiKey?.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {})
      }
    })
    if (!res.ok) return { ok: false, models: [], error: `HTTP ${res.status}` }
    const json = (await res.json()) as { data?: Array<{ id?: string }> }
    const models = (json.data ?? []).map((d) => d.id ?? '').filter(Boolean)
    return { ok: true, models }
  } catch (err) {
    return { ok: false, models: [], error: (err as Error).message }
  }
}

const aborters = new Map<string, AbortController>()

export function stopChat(sessionId: string): boolean {
  const c = aborters.get(sessionId)
  if (!c) return false
  c.abort()
  aborters.delete(sessionId)
  return true
}

/** 流式调用 OpenAI 兼容 /chat/completions，chunk 通过 sender 推送
 *  支持 tools：解析流式 tool_calls → 经 MCP 管理器执行 → 回填 tool 消息 → 循环，直到无工具调用。 */
export async function chat(
  sender: WebContents,
  sessionId: string,
  messages: AiChatMessage[],
  modelOverride?: string,
  tools?: AiTool[],
  sampling?: Record<string, number | string | boolean>
): Promise<boolean> {
  const state = await listAiProfiles()
  const routing = normalizeRouting(state.routing, state)
  const chain = profileChain(state, routing, routing.mode === 'both' ? 'failover' : 'auto')

  const send = (channel: string, payload: unknown): void => {
    try {
      if (!sender.isDestroyed()) sender.send(channel, payload)
    } catch {
      /* ignore */
    }
  }

  if (!chain.length) {
    send('ai:chunk', { sessionId, chunk: '\n[未配置 AI：请到设置添加 Ollama 或云端 API]' })
    send('ai:done', { sessionId, ok: false })
    return false
  }

  for (let i = 0; i < chain.length; i++) {
    const p = chain[i]
    const localCfg: AiConfig = {
      endpoint: p.endpoint,
      apiKey: p.apiKey,
      model: p.model,
      systemPrompt: p.systemPrompt,
      secondaryModel: p.secondaryModel
    }
    const ok = await chatOnce(sender, sessionId, messages, modelOverride, tools, sampling, localCfg)
    if (ok) return true
    if (i + 1 < chain.length) {
      send('ai:chunk', { sessionId, chunk: `\n[切换模型 ${chain[i + 1].name}…]\n` })
    }
  }
  return false
}

/** 单配置流式对话核心 */
async function chatOnce(
  sender: WebContents,
  sessionId: string,
  messages: AiChatMessage[],
  modelOverride: string | undefined,
  tools: AiTool[] | undefined,
  sampling: Record<string, number | string | boolean> | undefined,
  cfg: AiConfig
): Promise<boolean> {
  const controller = new AbortController()
  aborters.set(sessionId, controller)

  const send = (channel: string, payload: unknown): void => {
    try {
      if (!sender.isDestroyed()) sender.send(channel, payload)
    } catch {
      /* ignore */
    }
  }

  // 把 MCP 工具结果规整为一段可读文本
  const toolResultText = (content: Array<{ type: string; text?: string }> | undefined, fallback: string): string => {
    if (!content || content.length === 0) return fallback
    return content.map((c) => c.text ?? '').join('\n').trim() || fallback
  }

  // 工作消息副本（跨工具调用轮次累积）
  const working: AiChatMessage[] = [...messages]
  const activeTools = tools && tools.length ? tools : undefined
  const MAX_TOOL_ROUNDS = 5

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      // 调用方已在消息首条放入 system（如角色/世界书上下文）→ 优先使用，不再追加 AI 设置里的 systemPrompt
      const hasCallerSystem = working.length > 0 && working[0]?.role === 'system'
      const body: Record<string, unknown> = {
        model: modelOverride ?? (cfg.model || undefined),
        messages: hasCallerSystem ? working : cfg.systemPrompt ? [{ role: 'system', content: cfg.systemPrompt }, ...working] : working,
        stream: true
      }
      if (activeTools) body.tools = activeTools
      if (sampling) {
        const allow = ['temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty'] as const
        for (const k of allow) {
          const v = sampling[k]
          if (v !== undefined && v !== null) body[k] = v
        }
      }

      const res = await net.fetch(`${cfg.endpoint}/chat/completions`, {
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
        send('ai:chunk', { sessionId, chunk: `\n[请求失败 ${res.status}] ${text.slice(0, 300)}` })
        aborters.delete(sessionId)
        send('ai:done', { sessionId, ok: false })
        return true
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      // 累积流式 tool_calls（按 index 归并）
      const acc: Array<{ id?: string; function: { name?: string; arguments?: string } }> = []
      let sawToolCall = false

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
            const json = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }>
            }
            const delta = json.choices?.[0]?.delta
            if (delta?.content) send('ai:chunk', { sessionId, chunk: delta.content })
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const i = tc.index ?? 0
                if (!acc[i]) acc[i] = { function: {} }
                if (tc.id) acc[i].id = tc.id
                if (tc.function?.name) acc[i].function.name = (acc[i].function.name ?? '') + tc.function.name
                if (tc.function?.arguments) acc[i].function.arguments = (acc[i].function.arguments ?? '') + tc.function.arguments
                sawToolCall = true
              }
            }
          } catch {
            /* 忽略无法解析的 SSE 行 */
          }
        }
      }

      // 本轮无工具调用 → 正常结束
      if (!sawToolCall || !activeTools) {
        aborters.delete(sessionId)
        send('ai:done', { sessionId, ok: true })
        return true
      }

      // 执行工具调用并回填 tool 消息
      const calls = acc
        .filter(Boolean)
        .map((c) => ({
          id: c.id || `call_${randomUUID()}`,
          name: c.function.name ?? '',
          args: c.function.arguments || '{}'
        }))
      const assistantMsg: AiChatMessage = {
        role: 'assistant',
        content: '',
        tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } }))
      }
      working.push(assistantMsg)

      for (const c of calls) {
        const [serverId, toolName] = c.name.includes('::') ? c.name.split('::') : [undefined, c.name]
        let resultText = `[未知工具 ${c.name}]`
        if (serverId) {
          try {
            const r = await getMcpManager().callTool({ serverId, name: toolName ?? '', arguments: safeJson(c.args) })
            resultText = r.ok ? toolResultText(r.content, '(工具返回空)') : r.error || '工具调用失败'
          } catch (e) {
            resultText = `工具执行异常：${e instanceof Error ? e.message : String(e)}`
          }
        }
        send('ai:chunk', { sessionId, chunk: `\n🔧 ${c.name}：${resultText.slice(0, 240)}\n` })
        working.push({ role: 'tool', content: resultText, tool_call_id: c.id })
      }
      // 继续下一轮，让模型基于工具结果产出最终答复
    }

    aborters.delete(sessionId)
    send('ai:done', { sessionId, ok: true })
    return true
  } catch (err) {
    const aborted = (err as Error)?.name === 'AbortError'
    aborters.delete(sessionId)
    send('ai:chunk', { sessionId, chunk: aborted ? '\n[已停止]' : `\n[错误] ${(err as Error)?.message ?? '未知'}` })
    send('ai:done', { sessionId, ok: false })
    return true
  }
}

/** 容错解析工具参数 JSON */
function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s || '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

/** 非流式单次调用：返回完整文本（AI 摘要 / 多平台改写等主进程工具用）
 *  支持 tools 参数，可将 MCP 等外部工具暴露给 LLM 进行函数调用（tool-augmented generation）。 */
export async function complete(
  messages: AiChatMessage[],
  opts?: { tools?: AiTool[]; modelOverride?: string; usageKind?: 'complete' | 'rightClick'; profileId?: string }
): Promise<{ ok: boolean; text?: string; toolCalls?: AiToolCall[]; error?: string; profileName?: string }> {
  const state = await listAiProfiles()
  const byId = (id?: string) => (id ? state.profiles.find((p) => p.id === id) ?? null : null)

  if (opts?.profileId) {
    return completeWithProfile(byId(opts.profileId), messages, opts)
  }

  const routing = normalizeRouting(state.routing, state)
  const chain = profileChain(state, routing, 'auto')

  // both：所有主力+备用同时出结果（本地 + 云端混用）
  if (routing.mode === 'both' && chain.length > 1) {
    const results = await Promise.all(chain.map((p) => completeWithProfile(p, messages, opts)))
    const parts = results.filter((r) => r.ok && r.text).map((r) => `【${r.profileName}】\n${r.text}`)
    if (parts.length) {
      return {
        ok: true,
        text: parts.join('\n\n———\n\n'),
        toolCalls: results.find((r) => r.toolCalls)?.toolCalls,
        profileName: results.map((r) => r.profileName).filter(Boolean).join('+')
      }
    }
    return { ok: false, error: results.map((r) => r.error).filter(Boolean).join('；') || '多路均失败' }
  }

  // failover / 主优先：按顺序
  for (const p of chain) {
    const r = await completeWithProfile(p, messages, opts)
    if (r.ok) return r
  }
  return {
    ok: false,
    error: chain.map((p) => p.name).join('、') + ' 全部失败，请检查地址/Key/模型名'
  }
}

/** 多模态单次调用（Vision RAG）：content 可含图片块，返回完整文本。
 *  模型不支持视觉时由调用方降级处理（如退回文件名索引）。 */
export async function completeVision(
  messages: AiVisionMessage[]
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const cfg = await readAiConfig()
  if (!cfg.endpoint) return { ok: false, error: '未配置 AI（请在设置页填写 endpoint/apiKey）' }
  try {
    const res = await net.fetch(`${cfg.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: cfg.model || undefined,
        messages: cfg.systemPrompt
          ? [{ role: 'system', content: cfg.systemPrompt }, ...messages]
          : messages,
        stream: false
      })
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return { ok: true, text: json.choices?.[0]?.message?.content ?? '' }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** 测试 AI 配置连通性：发送最小请求（10s 超时） */
export async function testAiConnection(): Promise<{ ok: boolean; error?: string; latencyMs?: number }> {
  const cfg = await readAiConfig()
  if (!cfg.endpoint) return { ok: false, error: '未配置 API 地址' }
  const start = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await net.fetch(`${cfg.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: cfg.model || undefined,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false
      }),
      signal: controller.signal
    })
    clearTimeout(timer)
    if (res.ok) return { ok: true, latencyMs: Date.now() - start }
    const text = await res.text().catch(() => '')
    return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 200)}` }
  } catch (err) {
    clearTimeout(timer)
    return { ok: false, error: (err as Error).message }
  }
}
