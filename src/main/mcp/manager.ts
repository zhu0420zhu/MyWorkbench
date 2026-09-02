/* MCP 管理器：多 server 生命周期与工具聚合
 * - 每个 server 一个 McpClient + transport（transport 可注入，便于测试）
 * - addServer：连接 → initialize → listTools → 记录工具
 * - 聚合所有 connected server 的工具（带 serverId 命名空间）
 * - 失败不崩溃：状态置 error 并记录
 */

import { getLogger } from '../tools/logger.ts'
import { McpClient } from './client.ts'
import { createStdioTransport } from './transport.ts'
import type { McpTransport } from './transport.ts'
import type {
  McpCallInput,
  McpCallResult,
  McpServerConfig,
  McpServerState,
  McpToolInfo
} from './types.ts'

const logger = getLogger('mcp:manager')

export type TransportFactory = (config: McpServerConfig) => McpTransport

interface ServerEntry {
  config: McpServerConfig
  client: McpClient
  state: McpServerState
}

export class McpManager {
  private servers = new Map<string, ServerEntry>()
  private factory: TransportFactory

  constructor(factory?: TransportFactory) {
    this.factory = factory ?? ((cfg) => createStdioTransport({
      command: cfg.command,
      args: cfg.args,
      env: cfg.env,
      cwd: cfg.cwd
    }))
  }

  async addServer(config: McpServerConfig): Promise<McpServerState> {
    if (this.servers.has(config.id)) {
      await this.removeServer(config.id)
    }
    const base: McpServerState = {
      id: config.id,
      name: config.name,
      command: config.command,
      status: config.enabled === false ? 'disabled' : 'connecting',
      toolCount: 0,
      tools: []
    }
    if (config.enabled === false) {
      this.servers.set(config.id, {
        config,
        client: new McpClient(config.name),
        state: base
      })
      return base
    }

    const client = new McpClient(config.name)
    const entry: ServerEntry = { config, client, state: { ...base } }
    this.servers.set(config.id, entry)

    try {
      const transport = this.factory(config)
      await client.connect(transport)
      await client.initialize()
      const tools = await client.listTools()
      entry.state.status = 'connected'
      entry.state.tools = tools.map((t) => t.name)
      entry.state.toolCount = tools.length
      logger.info(`MCP server 已连接: ${config.name} | 工具 ${tools.length} 个`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      entry.state.status = 'error'
      entry.state.error = message
      logger.error(`MCP server 连接失败: ${config.name} | ${message}`)
    }
    return entry.state
  }

  async removeServer(id: string): Promise<boolean> {
    const entry = this.servers.get(id)
    if (!entry) return false
    try {
      entry.client.close()
    } catch {
      /* ignore */
    }
    this.servers.delete(id)
    return true
  }

  listServers(): McpServerState[] {
    return [...this.servers.values()].map((e) => ({ ...e.state }))
  }

  listTools(): McpToolInfo[] {
    const out: McpToolInfo[] = []
    for (const e of this.servers.values()) {
      if (e.state.status !== 'connected') continue
      for (const name of e.state.tools) {
        out.push({ serverId: e.config.id, serverName: e.config.name, name })
      }
    }
    return out
  }

  async listToolsFull(): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = []
    for (const e of this.servers.values()) {
      if (e.state.status !== 'connected') continue
      try {
        const tools = await e.client.listTools()
        for (const t of tools) {
          out.push({ ...t, serverId: e.config.id, serverName: e.config.name })
        }
      } catch {
        /* ignore */
      }
    }
    return out
  }

  async callTool(input: McpCallInput): Promise<McpCallResult> {
    const entry = this.servers.get(input.serverId)
    if (!entry || entry.state.status !== 'connected') {
      return { ok: false, content: [], error: `server 未连接: ${input.serverId}` }
    }
    try {
      const res = await entry.client.callTool(input.name, input.arguments ?? {})
      if (!res.ok) return { ok: false, content: res.content, isError: res.isError, error: '工具返回错误' }
      return res
    } catch (err) {
      return { ok: false, content: [], error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 关闭所有 server（应用退出时） */
  dispose(): void {
    for (const e of this.servers.values()) {
      try {
        e.client.close()
      } catch {
        /* ignore */
      }
    }
    this.servers.clear()
  }
}
