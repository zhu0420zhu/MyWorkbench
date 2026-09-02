/* ============================================================
 * MCP 集成 — IPC 桥接
 * 暴露 server 管理（增删/列举/调用）给渲染进程。
 * 启动时自动连接所有 enabled 的 server（连接失败仅记录，不阻断启动）。
 * 本轮仅落地 MCP 客户端基础设施（连接外部 server、聚合工具、调用工具）；
 * 将 MCP 工具接入智能体/问答的函数调度为后续步骤（需配置具体 server 后）。
 * ============================================================ */

import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { ConfigStore } from '../configStore.ts'
import { getLogger } from '../tools/logger.ts'
import { McpManager } from './manager.ts'
import { getMcpManager } from './index.ts'
import type { McpCallInput, McpServerConfig, McpServerState, McpToolInfo } from './types.ts'

const logger = getLogger('mcp:ipc')

interface McpConfigStore extends Record<string, unknown> {
  servers: McpServerConfig[]
}

export function registerMcpIpc(): void {
  const store = new ConfigStore<McpConfigStore>('mcp-servers', { servers: [] })
  void store.load()
  const manager = getMcpManager()
  // 保存注入时的原始配置，便于持久化与重建（status/tools 为运行态，不存）
  const currentConfigs = new Map<string, McpServerConfig>()

  const persist = async (): Promise<void> => {
    const list = manager.listServers().map((s) => {
      const orig = currentConfigs.get(s.id)
      return orig ?? ({ id: s.id, name: s.name, command: s.command } as McpServerConfig)
    })
    await store.set({ servers: list })
  }

  const addServer = async (config: McpServerConfig): Promise<McpServerState> => {
    const { id, ...rest } = config
    const cfg: McpServerConfig = { ...rest, id: id || randomUUID() }
    currentConfigs.set(cfg.id, cfg)
    const state = await manager.addServer(cfg)
    await persist()
    return state
  }

  // 启动时自动连接已启用的 server（失败仅记录，不阻断启动）
  void (async () => {
    try {
      const cur = await store.get()
      for (const cfg of cur.servers) {
        if (cfg.enabled === false) continue
        currentConfigs.set(cfg.id, cfg)
        await manager.addServer(cfg)
      }
      const states = manager.listServers()
      logger.info(
        `MCP 启动自动连接完成：${states.filter((s) => s.status === 'connected').length}/${states.length} 已连接`
      )
    } catch (err) {
      logger.error(`MCP 启动自动连接异常: ${err instanceof Error ? err.message : String(err)}`)
    }
  })()

  ipcMain.handle('mcp:list-servers', (): McpServerState[] => manager.listServers())
  ipcMain.handle('mcp:add-server', (_e, config: McpServerConfig): Promise<McpServerState> => addServer(config))
  ipcMain.handle('mcp:remove-server', async (_e, id: string): Promise<boolean> => {
    const ok = await manager.removeServer(id)
    currentConfigs.delete(id)
    await persist()
    return ok
  })
  ipcMain.handle('mcp:list-tools', (): Promise<McpToolInfo[]> => Promise.resolve(manager.listTools()))
  ipcMain.handle('mcp:call-tool', (_e, input: McpCallInput) => manager.callTool(input))
}
