/* ============================================================
 * feed —— IPC 桥接（feed:* 统一 domain）
 * 新增 feed:* handle，保留旧 hot:* 与 agents:* 不动（迁移完成前可回滚）。
 * 通知类 handler 直接复用 hotNotifier 既有函数，不重写推送逻辑。
 * ============================================================ */

import { ipcMain, Notification } from 'electron'
import { getFeedService } from './feedService.ts'
import { getAgentScheduler } from '../agents/index.ts'
import { checkHotOnce, getHotNotifierStatus } from '../hotNotifier.ts'
import type {
  FeedItem,
  FeedSourceMeta,
  FeedSourceConfig,
  FeedResult,
  FeedRunRecord,
  FeedNotifySettings,
  CustomFeedSourceDef
} from '../../shared/types.ts'

export function registerFeedIpc(): void {
  const s = getFeedService()

  ipcMain.handle('feed:result', (): Promise<FeedResult> => s.result())

  ipcMain.handle('feed:list-sources', (): Promise<FeedSourceMeta[]> => s.listSources())

  ipcMain.handle('feed:run-source', (_e, id: string): Promise<FeedItem[]> => s.runSource(id))

  ipcMain.handle(
    'feed:set-source-config',
    (_e, id: string, c: FeedSourceConfig): Promise<void> => s.setSourceConfig(id, c)
  )

  ipcMain.handle(
    'feed:add-source',
    (_e, def: CustomFeedSourceDef): Promise<FeedSourceMeta> => s.addSource(def)
  )

  ipcMain.handle('feed:remove-source', (_e, id: string): Promise<void> => s.removeSource(id))

  ipcMain.handle('feed:history', (_e, id: string): Promise<FeedRunRecord[]> => s.historyOf(id))

  ipcMain.handle('feed:notify-get', (): Promise<FeedNotifySettings> => s.getNotifySettings())

  ipcMain.handle(
    'feed:notify-set',
    (_e, settings: FeedNotifySettings): Promise<FeedNotifySettings> => s.setNotifySettings(settings)
  )

  // 委托 hotNotifier.checkHotOnce()；notifyAgents 为 true 时顺带对最近一次智能体运行结果弹通知（简单实现）
  ipcMain.handle(
    'feed:notify-check',
    async (): Promise<{ notified: number; total: number }> => {
      const result = await checkHotOnce()
      try {
        const settings = await s.getNotifySettings()
        if (settings.notifyAgents) {
          const jobs = await getAgentScheduler().list()
          const recent = jobs.find((j) => j.lastStatus === 'ok' && j.lastSummary)
          if (recent) {
            new Notification({ title: `灵墨 · ${recent.name}`, body: recent.lastSummary ?? '' }).show()
          }
        }
      } catch {
        /* 无桌面环境（如测试）时静默忽略 */
      }
      return result
    }
  )

  ipcMain.handle('feed:notify-status', () => getHotNotifierStatus())
}
