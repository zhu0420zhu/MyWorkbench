/* MCP（Model Context Protocol）集成 — 类型
 * IPC 契约（McpServerConfig / McpServerState / McpToolInfo / McpCallInput / McpCallResult）
 * 统一放 src/shared/types.ts（详见该文件「MCP 集成契约」段）；此处转发，
 * 并保留 client 内部握手返回类型 McpInitializeResult。
 */

export type {
  McpServerConfig,
  McpServerState,
  McpToolInfo,
  McpCallInput,
  McpCallResult
} from '../../shared/types.ts'

/** 初始化握手返回（initialize 的 result，client 内部使用，非 IPC 契约） */
export interface McpInitializeResult {
  protocolVersion: string
  capabilities: { tools?: { listChanged?: boolean }; [k: string]: unknown }
  serverInfo: { name: string; version?: string }
}
