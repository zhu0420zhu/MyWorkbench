/* ============================================================
 * MCP → LLM 函数调度桥（tool-augmented generation）
 * 将已连接的 MCP server 工具暴露给 LLM，并按 ReAct 循环执行：
 *   LLM(携 tools) → 返回 tool_calls → 路由到对应 server 执行 →
 *   结果回填为 tool 消息 → 再次调用 LLM → 直至生成最终文本。
 *
 * 纯逻辑、不引入 electron，便于无头测试与复用（QA / 智能体共用）。
 * 工具名采用 `${serverId}__${name}` 命名空间，执行时拆回路由。
 * ============================================================ */

import { getLogger } from '../tools/logger.ts'
import type { McpManager } from './manager.ts'
import type {
  AiChatMessage,
  AiTool,
  AiToolCall,
  ToolAwareLlm,
  ToolBridge,
  ToolInvocation,
  ToolLoopResult
} from '../../shared/types.ts'

const logger = getLogger('mcp:bridge')

/** 命名空间分隔符（serverId 为 UUID 含短横，但工具名可能含下划线） */
const SEP = '__'

/** 将 MCP content 数组压平为文本（截断避免撑爆上下文） */
function flattenContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .map((c) => c.text ?? '')
    .join('\n')
    .slice(0, 4000)
}

export function createMcpToolBridge(manager: McpManager): ToolBridge {
  /** 聚合所有已连接 server 的工具，按 serverId 命名空间生成 LLM 工具定义 */
  const getAiTools = async (): Promise<AiTool[]> => {
    const tools = await manager.listToolsFull()
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: `${t.serverId}${SEP}${t.name}`,
        description: t.description ?? `${t.serverName} 提供的工具 ${t.name}`,
        parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} }
      }
    }))
  }

  /** 解析 LLM 返回的 tool_call，路由到对应 MCP server 执行 */
  const executeToolCall = async (call: AiToolCall): Promise<ToolInvocation> => {
    const idx = call.function.name.indexOf(SEP)
    const serverId = idx > 0 ? call.function.name.slice(0, idx) : call.function.name
    const name = idx > 0 ? call.function.name.slice(idx + SEP.length) : ''
    let args: Record<string, unknown> = {}
    try {
      args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {}
    } catch {
      args = {}
    }
    const res = await manager.callTool({ serverId, name, arguments: args })
    return {
      serverId,
      name,
      arguments: args,
      result: res.ok ? flattenContent(res.content) : res.error ?? '工具调用失败',
      isError: !res.ok || !!res.isError
    }
  }

  /** ReAct 工具循环：最多 maxIterations 轮工具调用，超出则强制生成文本 */
  const runToolLoop = async (
    llm: ToolAwareLlm,
    messages: AiChatMessage[],
    opts?: { maxIterations?: number; tools?: AiTool[] }
  ): Promise<ToolLoopResult> => {
    const maxIterations = opts?.maxIterations ?? 4
    const tools = opts?.tools ?? (await getAiTools())
    // 无可用工具 → 直接单次生成，避免 listToolsFull 与循环开销
    if (!tools.length) {
      const res = await llm(messages)
      return { ok: res.ok, answer: res.text ?? '', messages, invocations: [] }
    }

    const conv: AiChatMessage[] = [...messages]
    const invocations: ToolInvocation[] = []

    for (let i = 0; i < maxIterations; i++) {
      const res = await llm(conv, { tools })
      if (!res.ok) {
        return { ok: false, answer: '', messages: conv, invocations, error: res.error ?? 'LLM 未返回内容' }
      }
      const calls = res.toolCalls ?? []
      if (!calls.length) {
        return { ok: true, answer: res.text ?? '', messages: conv, invocations }
      }
      // 追加 assistant（含 tool_calls），再逐条追加 tool 结果
      conv.push({ role: 'assistant', content: res.text, tool_calls: calls })
      for (const call of calls) {
        const inv = await executeToolCall(call)
        invocations.push(inv)
        conv.push({ role: 'tool', content: inv.result, tool_call_id: call.id })
      }
    }

    // 超出迭代上限：最后一次不带工具约束，强制生成文本答案
    const finalRes = await llm(conv)
    return {
      ok: finalRes.ok,
      answer: finalRes.text ?? '',
      messages: conv,
      invocations,
      error: finalRes.ok ? undefined : finalRes.error
    }
  }

  return { getAiTools, runToolLoop }
}
