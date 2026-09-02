/* MCP JSON-RPC 2.0 客户端
 * 负责：initialize 握手 → 发送 initialized 通知 → listTools → callTool。
 * 通过 id 匹配 request/response；notification（无 id）直接忽略。
 * 纯逻辑、可注入 transport，便于无头测试。
 */

import { getLogger } from '../tools/logger.ts'
import type { McpTransport, JsonRpcMessage } from './transport.ts'
import type { McpCallResult, McpInitializeResult, McpToolInfo } from './types.ts'

const logger = getLogger('mcp:client')

const PROTOCOL_VERSION = '2024-11-05'
const REQUEST_TIMEOUT_MS = 30000

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class McpClient {
  private transport: McpTransport | null = null
  private pending = new Map<number | string, Pending>()
  private nextId = 1
  private initialized = false
  private msgHandler: (msg: JsonRpcMessage) => void = (m) => this.handleMessage(m)
  private serverLabel: string

  constructor(serverLabel: string) {
    this.serverLabel = serverLabel
  }

  async connect(transport: McpTransport): Promise<void> {
    this.transport = transport
    transport.onMessage((m) => this.msgHandler(m))
    transport.onError((err) => {
      logger.warning(`[${this.serverLabel}] transport 错误: ${err.message}`)
    })
    await transport.connect()
  }

  /** 握手：initialize → 收到 result → 发送 initialized 通知 */
  async initialize(): Promise<McpInitializeResult> {
    const res = (await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'lingmo-workbench', version: '0.1.0' }
    })) as McpInitializeResult
    // initialized 通知（无 id，不期望响应）
    this.transport?.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    this.initialized = true
    return res
  }

  async listTools(): Promise<McpToolInfo[]> {
    const res = (await this.request('tools/list', {})) as { tools?: McpToolInfo[] }
    return res.tools ?? []
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpCallResult> {
    const res = (await this.request('tools/call', { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>
      isError?: boolean
    }
    return {
      ok: !(res.isError ?? false),
      content: res.content ?? [],
      isError: res.isError
    }
  }

  /** 发送 JSON-RPC request 并等待匹配 id 的 response */
  request(method: string, params: unknown): Promise<unknown> {
    if (!this.transport) return Promise.reject(new Error('未连接'))
    const id = this.nextId++
    const msg: JsonRpcMessage = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`[${this.serverLabel}] 请求超时: ${method}`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.transport!.send(msg)
    })
  }

  private handleMessage(msg: JsonRpcMessage): void {
    // notification（无 id）→ 忽略
    if (msg.id === undefined) return
    const pending = this.pending.get(msg.id as number | string)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(msg.id as number | string)
    if (msg.error) {
      pending.reject(new Error(`[${this.serverLabel}] ${String(msg.error)}`))
      return
    }
    pending.resolve(msg.result ?? {})
  }

  close(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('client 已关闭'))
    }
    this.pending.clear()
    this.transport?.close()
    this.transport = null
    this.initialized = false
  }

  get isInitialized(): boolean {
    return this.initialized
  }
}
