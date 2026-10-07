/* 无头冒烟测试：MCP 客户端基础设施（零依赖 JSON-RPC over stdio）
 * 用内存双向 transport 模拟 MCP server，验证：
 *   - client：initialize 握手 → initialized 通知 → listTools → callTool
 *   - manager：addServer（自动连接+握手+列工具）、listTools 聚合、callTool 透传
 *   - 错误路径：server 返回 error 时 callTool 标记 ok=false
 * 运行：node --experimental-strip-types tests/smoke-mcp.ts
 */
import { McpClient } from '../src/main/mcp/client.ts'
import { McpManager } from '../src/main/mcp/manager.ts'
import type { McpTransport, JsonRpcMessage } from '../src/main/mcp/transport.ts'
import type { McpServerConfig } from '../src/main/mcp/types.ts'
import type { McpServerState } from '../src/shared/types.ts'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name} ${extra}`)
  }
}

/** 创建一对互联的内存 transport：client 侧给 McpClient，server 侧由测试模拟 MCP server 行为 */
function createLinkedPair() {
  let clientHandler: (m: JsonRpcMessage) => void = () => {}
  let serverHandler: (m: JsonRpcMessage) => void = () => {}
  const client: McpTransport = {
    connect: async () => {},
    send: (m) => serverHandler(m), // client 发出 → server 收到
    onMessage: (cb) => {
      clientHandler = cb
    },
    onError: () => {},
    onClose: () => {},
    close: () => {}
  }
  const server: McpTransport & { deliver: (m: JsonRpcMessage) => void; setHandler: (cb: (m: JsonRpcMessage) => void) => void } = {
    connect: async () => {},
    send: (m) => clientHandler(m), // server 发出 → client 收到
    onMessage: (cb) => {
      serverHandler = cb
    },
    onError: () => {},
    onClose: () => {},
    close: () => {},
    // 测试用：server 主动向 client 推送消息（经 clientHandler）
    deliver: (m) => clientHandler(m),
    setHandler: (cb) => {
      serverHandler = cb
    }
  }
  return { client, server }
}

/** 为一个内存 server 注册标准 MCP 行为（echo 工具） */
function setupMockServer(server: ReturnType<typeof createLinkedPair>['server'], mode: 'ok' | 'error' = 'ok'): void {
  server.setHandler((msg) => {
    const m = msg as { id?: number; method: string; params?: Record<string, unknown> }
    if (m.method === 'initialize') {
      server.deliver({
        jsonrpc: '2.0',
        id: m.id!,
        result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1.0' } }
      })
    } else if (m.method === 'tools/list') {
      server.deliver({
        jsonrpc: '2.0',
        id: m.id!,
        result: {
          tools: [
            { name: 'echo', description: '回显', inputSchema: { type: 'object' } },
            { name: 'add', description: '相加' }
          ]
        }
      })
    } else if (m.method === 'tools/call') {
      const p = (m.params ?? {}) as { name: string; arguments?: Record<string, unknown> }
      if (mode === 'error') {
        server.deliver({
          jsonrpc: '2.0',
          id: m.id!,
          result: { content: [{ type: 'text', text: 'boom' }], isError: true }
        })
        return
      }
      server.deliver({
        jsonrpc: '2.0',
        id: m.id!,
        result: { content: [{ type: 'text', text: `called ${p.name}` }] }
      })
    }
    // notifications/initialized → 忽略
  })
}

async function main(): Promise<void> {
  /* ---- 1. McpClient 握手 + 列工具 + 调用 ---- */
  {
    const { client, server } = createLinkedPair()
    setupMockServer(server)
    const cli = new McpClient('mock')
    await cli.connect(client)
    check('client 未初始化前为 false', cli.isInitialized === false)

    const init = await cli.initialize()
    check('initialize 返回 protocolVersion', init.protocolVersion === '2024-11-05')
    check('initialize 后 isInitialized=true', cli.isInitialized === true)

    const tools = await cli.listTools()
    check('listTools 返回 2 个工具', tools.length === 2, `got ${tools.length}`)
    check('工具含 echo', tools.some((t) => t.name === 'echo'))

    const r = await cli.callTool('echo', { msg: 'hi' })
    check('callTool 成功', r.ok === true)
    check('callTool 返回文本', r.content[0]?.text === 'called echo', JSON.stringify(r.content))
    cli.close()
  }

  /* ---- 2. McpManager 聚合 + 调用 ---- */
  {
    const { client, server } = createLinkedPair()
    setupMockServer(server)
    // 注入 transport 工厂：每次 addServer 都返回同一个内存 client transport
    const mgr = new McpManager(() => client)
    const cfg: McpServerConfig = { id: 's1', name: 'Mock', command: 'node', enabled: true }
    const state: McpServerState = await mgr.addServer(cfg)
    check('manager addServer → connected', state.status === 'connected', `status=${state.status} err=${state.error ?? ''}`)
    check('manager 记录 2 个工具', state.toolCount === 2, `tools=${state.toolCount}`)

    const agg = mgr.listTools()
    check('listTools 聚合含 serverId', agg.length === 2 && agg[0].serverId === 's1')
    check('聚合项带 serverName', agg[0].serverName === 'Mock')

    const res = await mgr.callTool({ serverId: 's1', name: 'add', arguments: { a: 1 } })
    check('manager callTool 成功', res.ok === true)
    check('manager callTool 文本正确', res.content[0]?.text === 'called add')
  }

  /* ---- 3. 错误路径：server 返回 error ---- */
  {
    const { client, server } = createLinkedPair()
    setupMockServer(server, 'error')
    const cli = new McpClient('mock-err')
    await cli.connect(client)
    await cli.initialize()
    const r = await cli.callTool('echo', {})
    check('错误响应 → ok=false', r.ok === false)
    cli.close()
  }

  /* ---- 4. 未连接 server 调用返回错误 ---- */
  {
    const mgr = new McpManager(() => {
      throw new Error('should not spawn in test')
    })
    const res = await mgr.callTool({ serverId: 'nope', name: 'x' })
    check('调用未连接 server → ok=false 且含错误', res.ok === false && !!res.error)
  }

  /* ---- 5. disabled server 不连接 ---- */
  {
    const mgr = new McpManager(() => {
      throw new Error('disabled 不应连接')
    })
    const cfg: McpServerConfig = { id: 'd1', name: 'Off', command: 'x', enabled: false }
    const state = await mgr.addServer(cfg)
    check('disabled server 状态=disabled', state.status === 'disabled')
    mgr.dispose()
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

void main()
