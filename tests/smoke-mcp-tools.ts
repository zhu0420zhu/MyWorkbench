/* 无头冒烟：MCP → LLM 函数调度桥（tool-augmented generation）
 * 用内存 LinkedTransport 模拟一个暴露 get_weather 工具的 MCP server，
 * 验证 getAiTools 命名空间映射、runToolLoop 工具调用与无工具直答、QaService 接入、错误路径。
 * 运行：node --experimental-strip-types tests/smoke-mcp-tools.ts
 */

import { McpManager, createMcpToolBridge } from '../src/main/mcp/index.ts'
import { QaService } from '../src/main/searchIndex/qa.ts'
import type { QaIndexerLike } from '../src/main/searchIndex/qa.ts'
import type { ScoredChunk } from '../src/main/searchIndex/types.ts'
import type { McpTransport, JsonRpcMessage } from '../src/main/mcp/transport.ts'
import type { McpServerConfig, AiChatMessage, ToolAwareLlm } from '../src/shared/types.ts'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name} ${detail ? '| ' + detail : ''}`)
  }
}

/** 内存双向 transport：模拟 MCP server 端（响应 client 请求） */
class LinkedTransport implements McpTransport {
  private handler: (msg: JsonRpcMessage) => void = () => {}
  private mode: 'tool' | 'empty'
  constructor(mode: 'tool' | 'empty' = 'tool') {
    this.mode = mode
  }
  connect(): Promise<void> {
    return Promise.resolve()
  }
  onMessage(cb: (msg: JsonRpcMessage) => void): void {
    this.handler = cb
  }
  onError(): void {}
  onClose(): void {}
  close(): void {}
  send(msg: JsonRpcMessage): void {
    const m = msg as { id?: number | string; method?: string; params?: unknown }
    if (m.id === undefined) return // notification，忽略
    const reply = (result: unknown): void => this.handler({ jsonrpc: '2.0', id: m.id, result } as JsonRpcMessage)
    if (m.method === 'initialize') {
      reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } })
    } else if (m.method === 'tools/list') {
      reply(
        this.mode === 'tool'
          ? {
              tools: [
                {
                  name: 'get_weather',
                  description: '查询指定城市天气',
                  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
                }
              ]
            }
          : { tools: [] }
      )
    } else if (m.method === 'tools/call') {
      const p = (m.params ?? {}) as { arguments?: { city?: string } }
      reply({ content: [{ type: 'text', text: `晴 25°C (${p.arguments?.city ?? '?'})` }] })
    }
  }
}

async function main(): Promise<void> {
  console.log('\n=== MCP 工具桥冒烟测试 ===')

  // —— 1. 模拟 server 暴露 get_weather ——
  const serverId = 'svr-0001'
  const config: McpServerConfig = {
    id: serverId,
    name: 'mock-weather',
    command: 'node',
    enabled: true
  }
  const manager = new McpManager(() => new LinkedTransport('tool'))
  const state = await manager.addServer(config)
  check('server 连接成功', state.status === 'connected', `status=${state.status}`)
  check('server 暴露 1 个工具', state.toolCount === 1, `count=${state.toolCount}`)

  const bridge = createMcpToolBridge(manager)

  // —— 2. getAiTools 命名空间映射 ——
  const tools = await bridge.getAiTools()
  check('getAiTools 返回 1 个 LLM 工具', tools.length === 1)
  check('工具名带 serverId 命名空间', tools[0]?.function.name === `${serverId}__get_weather`, tools[0]?.function.name)
  check('工具参数含 city 字段', !!(tools[0]?.function.parameters as Record<string, unknown>)?.properties)

  // —— 3. runToolLoop：LLM 先调用工具，再生成答案 ——
  const fakeLlm: ToolAwareLlm = async (messages, _opts) => {
    const hasToolResult = messages.some((m) => m.role === 'tool')
    if (!hasToolResult) {
      return {
        ok: true,
        toolCalls: [
          { id: 'call_1', type: 'function', function: { name: `${serverId}__get_weather`, arguments: JSON.stringify({ city: '北京' }) } }
        ]
      }
    }
    return { ok: true, text: '北京今天晴，气温 25°C。' }
  }
  const loop = await bridge.runToolLoop(fakeLlm, [{ role: 'user', content: '北京天气？' }])
  check('工具循环成功', loop.ok, loop.error ?? '')
  check('最终答案正确', loop.answer === '北京今天晴，气温 25°C。', loop.answer)
  check('记录 1 次工具调用', loop.invocations.length === 1, `len=${loop.invocations.length}`)
  check('调用路由到正确 server', loop.invocations[0]?.serverId === serverId)
  check('调用目标工具名正确', loop.invocations[0]?.name === 'get_weather')
  check('调用入参解析正确', loop.invocations[0]?.arguments?.city === '北京')
  check('工具返回结果正确', (loop.invocations[0]?.result ?? '').includes('晴 25°C'), loop.invocations[0]?.result)
  const toolMsg = loop.messages.find((m) => m.role === 'tool') as { role: 'tool'; content: string; tool_call_id: string } | undefined
  check('对话含 tool 结果消息', !!toolMsg && toolMsg.tool_call_id === 'call_1')
  const asstMsg = loop.messages.find((m) => m.role === 'assistant' && (m as AiChatMessage & { tool_calls?: unknown }).tool_calls) as
    | (AiChatMessage & { tool_calls?: Array<{ id: string }> })
    | undefined
  check('对话含 assistant 工具调用', !!asstMsg && asstMsg.tool_calls?.[0]?.id === 'call_1')

  // —— 4. 无工具直答：manager 无工具时单轮生成 ——
  const emptyManager = new McpManager(() => new LinkedTransport('empty'))
  await emptyManager.addServer({ ...config, id: 'svr-0002', name: 'mock-empty' })
  const emptyBridge = createMcpToolBridge(emptyManager)
  let directCalls = 0
  const directLlm: ToolAwareLlm = async () => {
    directCalls++
    return { ok: true, text: '直接回答，无需工具。' }
  }
  const loop2 = await emptyBridge.runToolLoop(directLlm, [{ role: 'user', content: '你好' }])
  check('无工具时单轮生成', loop2.ok && loop2.answer === '直接回答，无需工具。', loop2.answer)
  check('无工具时 LLM 仅调用一次', directCalls === 1, `calls=${directCalls}`)
  check('无工具时无工具调用记录', loop2.invocations.length === 0)

  // —— 5. LLM 错误路径 ——
  const errLoop = await bridge.runToolLoop(async () => ({ ok: false, error: 'boom' }), [
    { role: 'user', content: 'x' }
  ])
  check('LLM 失败时循环返回 ok:false', !errLoop.ok && errLoop.error === 'boom', errLoop.error ?? '')

  // —— 6. QaService 接入工具桥 ——
  const fakeIndexer: QaIndexerLike = {
    queryChunks(): ScoredChunk[] {
      return [
        {
          id: 'c1',
          filePath: '/docs/note.txt',
          heading: '',
          text: '北京是中国的首都。',
          score: 1,
          startChar: 0
        } as ScoredChunk
      ]
    }
  }
  const qa = new QaService(fakeIndexer, fakeLlm, {}, bridge)
  const qaRes = await qa.ask({ question: '北京天气如何？', mode: 'basic' })
  check('QaService 工具增强问答成功', qaRes.ok && qaRes.answerMode === 'generated', qaRes.answerMode)
  check('QaService 答案来自工具结果', qaRes.answer === '北京今天晴，气温 25°C。', qaRes.answer)
  check('QaService 透出工具调用', (qaRes.mcpToolCalls?.length ?? 0) === 1, `len=${qaRes.mcpToolCalls?.length}`)

  // —— 7. QaService 无桥时退化为单一生成 ——
  const qaNoBridge = new QaService(fakeIndexer, async () => ({ ok: true, text: '单轮答案。' }), {}, undefined)
  const qaRes2 = await qaNoBridge.ask({ question: '问题', mode: 'basic' })
  check('无桥时 QaService 单轮生成', qaRes2.ok && qaRes2.answer === '单轮答案。' && !qaRes2.mcpToolCalls)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
