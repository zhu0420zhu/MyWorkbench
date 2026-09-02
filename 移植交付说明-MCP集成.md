# 移植交付说明 — MCP 集成（Model Context Protocol）

> 对应 awesome-llm-apps 类别：**MCP（P1，架构级）**
> 移植目标：灵墨工作台（Electron 43 + React 19 + TS 7 + Vite 7）
> 日期：2026-08-12

## 1. 本次交付的能力

让工作台具备**连接外部 MCP server、聚合并调用其 Tools** 的客户端基础设施（移植自 awesome-llm-apps 的 MCP 类别）。采用**零外部依赖**实现：纯 Node `child_process` + JSON-RPC 2.0 over stdio（newline-delimited JSON）。

- **Transport 抽象**：`McpTransport` 接口 + `StdioTransport`（spawn 子进程，stdout 按行解析 JSON-RPC，stdin 写 JSON+换行）。可注入内存 transport 做无头测试。
- **McpClient**：`initialize` 握手（protocolVersion `2024-11-05`）→ 发送 `notifications/initialized` → `listTools` → `callTool`；按 `id` 匹配 request/response，notification 忽略，30s 超时。
- **McpManager**：多 server 生命周期管理（连接/握手/列工具/调用），聚合所有 connected server 的工具（带 `serverId` 命名空间），失败不崩溃（状态置 `error`）。`transportFactory` 可注入，便于测试。
- **自动连接**：启动时读取持久化配置，自动连接所有 `enabled` server；连接失败仅记录，不阻断启动。
- **配置持久化**：server 配置存于 `userData/mcp-servers.json`（运行态不持久化）。

## 2. 改动清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/main/mcp/types.ts` | 修改 | 转发 shared 的 IPC 契约；保留 client 内部 `McpInitializeResult` |
| `src/main/mcp/transport.ts` | 新增 | `McpTransport` 抽象 + 零依赖 `StdioTransport` |
| `src/main/mcp/client.ts` | 新增 | JSON-RPC 2.0 客户端（握手/列工具/调用） |
| `src/main/mcp/manager.ts` | 新增 | 多 server 管理、工具聚合、调用路由 |
| `src/main/mcp/index.ts` | 新增 | 模块出口 |
| `src/main/mcp/mcpIpc.ts` | 新增 | `mcp:list-servers` / `add-server` / `remove-server` / `list-tools` / `call-tool` |
| `src/main/index.ts` | 修改 | 注册 `registerMcpIpc()` |
| `src/shared/types.ts` | 修改 | 新增 MCP IPC 契约（McpServerConfig/McpServerState/McpToolInfo/McpCallInput/McpCallResult） |
| `src/preload/index.ts` + `index.d.ts` | 修改 | 暴露 `api.mcp` 五接口 |
| `tests/smoke-mcp.ts` | 新增 | 无头冒烟（16 项，内存 transport 模拟 server） |

## 3. 行为验证

| 验证项 | 命令 | 结果 |
|--------|------|------|
| 类型检查（node） | `npm run typecheck:node` | ✅ 通过 |
| 类型检查（web） | `npm run typecheck:web` | ✅ 通过 |
| MCP 无头测试 | `node --experimental-strip-types tests/smoke-mcp.ts` | ✅ 16/0 |
| QA 回归 | `node --experimental-strip-types tests/smoke-qa.ts` | ✅ 18/0（无回归） |
| 上下文优化回归 | `node --experimental-strip-types tests/smoke-context.ts` | ✅ 25/0（无回归） |
| 生产构建 | `npm run build` | ✅ main / preload 13.77 kB |

## 4. 用法

渲染进程（`window.api.mcp`）：

```ts
// 添加并连接一个 MCP server（如 filesystem MCP）
const state = await api.mcp.addServer({
  name: 'filesystem',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/path'],
  enabled: true
})
// state.status === 'connected' / 'error'

const tools = await api.mcp.listTools()      // 聚合所有 server 工具（含 serverId）
const res = await api.mcp.callTool({ serverId: state.id, name: 'read_file', arguments: { path: '...' } })
// res.ok / res.content / res.isError
await api.mcp.removeServer(state.id)
```

## 5. 后续可选（未做项）

- **接入函数调度**：将 MCP tools 暴露给常驻智能体 / 问答（searchIndex:ask）的 LLM 工具调用（function calling），作为外部能力源。需配置具体 server 后编排。
- **真实 server 验证**：stdio 路径（`StdioTransport`）已就绪，但需真实 MCP server 二进制端到端验证；核心 JSON-RPC 握手/调用逻辑已被协议层单测覆盖。
- P2 Agent Skills / GenUI、各模块渲染层 GUI（均延后）。
