import { app, net, type WebContents } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'node:crypto'
import type { AiConfig, AiChatMessage, AiTool, AiToolCall, AiVisionMessage } from '../shared/types'
import { getMcpManager } from './mcp'

const DEFAULT_CONFIG: AiConfig = {
  endpoint: '',
  apiKey: '',
  model: '',
  systemPrompt: '你是一个乐于助人的助手。'
}

function configFile(): string {
  return join(app.getPath('userData'), 'ai-config.json')
}

export async function readAiConfig(): Promise<AiConfig> {
  try {
    const raw = await fs.readFile(configFile(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<AiConfig>
    return { ...DEFAULT_CONFIG, ...parsed }
  } catch {
    return DEFAULT_CONFIG
  }
}

export async function saveAiConfig(input: AiConfig): Promise<AiConfig> {
  const cfg: AiConfig = {
    endpoint: (input.endpoint ?? '').trim().replace(/\/+$/, ''),
    apiKey: (input.apiKey ?? '').trim(),
    model: (input.model ?? '').trim(),
    systemPrompt: input.systemPrompt ?? ''
  }
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(configFile(), JSON.stringify(cfg, null, 2), 'utf-8')
  return cfg
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
  const cfg = await readAiConfig()
  if (!cfg.endpoint) return false

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
  opts?: { tools?: AiTool[]; modelOverride?: string }
): Promise<{ ok: boolean; text?: string; toolCalls?: AiToolCall[]; error?: string }> {
  const cfg = await readAiConfig()
  if (!cfg.endpoint) return { ok: false, error: '未配置 AI（请在设置页填写 endpoint/apiKey）' }
  try {
    const body: Record<string, unknown> = {
      model: opts?.modelOverride ?? (cfg.model || undefined),
      messages: cfg.systemPrompt
        ? [{ role: 'system', content: cfg.systemPrompt }, ...messages]
        : messages,
      stream: false
    }
    if (opts?.tools && opts.tools.length) body.tools = opts.tools
    const res = await net.fetch(`${cfg.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {})
      },
      body: JSON.stringify(body)
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; tool_calls?: AiToolCall[] } }>
    }
    const msg = json.choices?.[0]?.message
    return { ok: true, text: msg?.content ?? '', toolCalls: msg?.tool_calls }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
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
