/* MCP 传输层
 * - Transport：抽象接口（便于注入内存 transport 做无头测试）
 * - StdioTransport：零依赖实现，spawn 子进程，stdout 按行解析 JSON-RPC，stdin 写 JSON+换行
 *   MCP stdio 传输使用 newline-delimited JSON（每行一个 JSON-RPC 消息）。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { getLogger } from '../tools/logger.ts'

const logger = getLogger('mcp:transport')

/** 任意 JSON-RPC 2.0 消息 */
export type JsonRpcMessage = Record<string, unknown> & { jsonrpc: '2.0' }

export interface McpTransport {
  connect(): Promise<void>
  send(msg: JsonRpcMessage): void
  onMessage(cb: (msg: JsonRpcMessage) => void): void
  onError(cb: (err: Error) => void): void
  onClose(cb: () => void): void
  close(): void
}

/** 默认 stdio 传输工厂（真实连接外部 MCP server） */
export function createStdioTransport(opts: {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}): McpTransport {
  return new StdioTransport(opts.command, opts.args, opts.env, opts.cwd)
}

class StdioTransport implements McpTransport {
  private child: ChildProcessWithoutNullStreams | null = null
  private msgHandler: (msg: JsonRpcMessage) => void = () => {}
  private errHandler: (err: Error) => void = () => {}
  private closeHandler: () => void = () => {}
  private connected = false
  private readonly command: string
  private readonly args: string[]
  private readonly env?: Record<string, string>
  private readonly cwd?: string

  constructor(command: string, args: string[] = [], env?: Record<string, string>, cwd?: string) {
    this.command = command
    this.args = args
    this.env = env
    this.cwd = cwd
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const child = spawn(this.command, this.args, {
          cwd: this.cwd,
          env: { ...process.env, ...(this.env ?? {}) },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
        this.child = child
        let buffer = ''
        child.stdout.setEncoding('utf-8')
        child.stdout.on('data', (chunk: string) => {
          buffer += chunk
          let idx: number
          // 按行切分 JSON-RPC 消息
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim()
            buffer = buffer.slice(idx + 1)
            if (!line) continue
            try {
              this.msgHandler(JSON.parse(line) as JsonRpcMessage)
            } catch (err) {
              logger.warning(`stdout 解析失败: ${String(err)} | 行: ${line.slice(0, 120)}`)
            }
          }
        })
        child.stderr.setEncoding('utf-8')
        child.stderr.on('data', (d: string) => {
          logger.warning(`[${this.command}] ${d.trim()}`)
        })
        child.on('error', (err) => this.errHandler(err))
        child.on('close', () => {
          this.connected = false
          this.closeHandler()
        })
        // 给子进程一点启动时间；server 会在收到 initialize 后响应
        this.connected = true
        resolve()
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  send(msg: JsonRpcMessage): void {
    if (!this.child || !this.connected) {
      this.errHandler(new Error('transport 未连接，无法发送消息'))
      return
    }
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  onMessage(cb: (msg: JsonRpcMessage) => void): void {
    this.msgHandler = cb
  }
  onError(cb: (err: Error) => void): void {
    this.errHandler = cb
  }
  onClose(cb: () => void): void {
    this.closeHandler = cb
  }

  close(): void {
    this.connected = false
    try {
      this.child?.kill()
    } catch {
      /* ignore */
    }
    this.child = null
  }
}
