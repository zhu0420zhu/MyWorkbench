/* MCP 集成 — 统一出口 */

export * from './types.ts'
export { McpClient } from './client.ts'
export { McpManager } from './manager.ts'
export type { TransportFactory } from './manager.ts'
export { createStdioTransport } from './transport.ts'
export type { McpTransport, JsonRpcMessage } from './transport.ts'
export { createMcpToolBridge } from './toolBridge.ts'
export type { ToolBridge, ToolAwareLlm, ToolInvocation, ToolLoopResult } from '../../shared/types.ts'

import { McpManager } from './manager.ts'

/** 全局共享的 MCP 管理器单例（mcpIpc 与 searchIndexIpc 等共用同一组连接） */
let singleton: McpManager | null = null

export function getMcpManager(): McpManager {
  if (!singleton) singleton = new McpManager()
  return singleton
}
