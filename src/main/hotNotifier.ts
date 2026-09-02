/* 热点推送通知（P2）：定时拉取聚合热点，检测新进入 TopN 的事件并弹系统通知 */
import { app, Notification } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { fetchAllHot } from './hot.ts'
import { getLogger } from './tools/logger.ts'

const logger = getLogger('hotNotifier')

export interface HotNotifySettings {
  enabled: boolean
  /** 检查间隔（分钟） */
  intervalMinutes: number
  /** 通知前多少条热榜视为"高热度" */
  topCount: number
}

const DEFAULT_SETTINGS: HotNotifySettings = { enabled: false, intervalMinutes: 15, topCount: 10 }

function settingsFile(): string {
  return join(app.getPath('userData'), 'hot-notify.json')
}
function stateFile(): string {
  return join(app.getPath('userData'), 'hot-notify-state.json')
}

let timer: NodeJS.Timeout | null = null
let settings: HotNotifySettings = { ...DEFAULT_SETTINGS }
let lastRunAt: number | null = null
let lastNotified = 0

export async function loadNotifySettings(): Promise<HotNotifySettings> {
  try {
    const parsed = JSON.parse(await fs.readFile(settingsFile(), 'utf8')) as Partial<HotNotifySettings>
    settings = { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    settings = { ...DEFAULT_SETTINGS }
  }
  return settings
}

export async function saveNotifySettings(input: HotNotifySettings): Promise<HotNotifySettings> {
  settings = {
    enabled: Boolean(input.enabled),
    intervalMinutes: Math.max(1, Math.min(120, Number(input.intervalMinutes) || 15)),
    topCount: Math.max(5, Math.min(50, Number(input.topCount) || 10))
  }
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2), 'utf8')
  if (settings.enabled) startHotNotifier()
  else stopHotNotifier()
  return settings
}

async function loadState(): Promise<string[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile(), 'utf8')) as { ids?: string[] }
    return Array.isArray(parsed?.ids) ? parsed.ids : []
  } catch {
    return []
  }
}

async function saveState(ids: string[]): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(stateFile(), JSON.stringify({ ids, at: Date.now() }, null, 2), 'utf8')
}

/** 检查一次：返回本次新通知数 */
export async function checkHotOnce(): Promise<{ notified: number; total: number }> {
  try {
    const result = await fetchAllHot()
    lastRunAt = Date.now()
    if (result.events.length === 0) return { notified: 0, total: 0 }

    const state = await loadState()
    const known = new Set(state)
    const top = result.events.slice(0, settings.topCount)
    // 仅通知"新进入 TopN"的事件（去重：同 id 只通知一次）
    const fresh = top.filter((e) => !known.has(e.id)).slice(0, 5)

    for (const e of fresh) {
      try {
        const n = new Notification({
          title: `🔥 新热点 · ${e.title.slice(0, 28)}`,
          body: `${e.sources.length} 个平台关注 · 热度 ${formatHot(e.hot)}`
        })
        n.show()
        lastNotified++
      } catch (err) {
        logger.warning(`热点通知失败: ${(err as Error).message}`)
      }
    }

    // 记录当前 TopN 快照（避免下次重复通知；也保留历史 id 防旧事件回升误报）
    const keep = [...new Set([...known, ...top.map((e) => e.id)])].slice(-2000)
    await saveState(keep)
    return { notified: fresh.length, total: result.events.length }
  } catch (err) {
    logger.warning(`热点检查失败: ${(err as Error).message}`)
    return { notified: 0, total: 0 }
  }
}

export function startHotNotifier(): void {
  if (timer) return
  // Windows 通知需 AppUserModelID
  try {
    app.setAppUserModelId('com.lingmo.workbench')
  } catch {
    /* 忽略 */
  }
  const intervalMs = Math.max(60_000, settings.intervalMinutes * 60_000)
  timer = setInterval(() => {
    void checkHotOnce()
  }, intervalMs)
  logger.info(`热点推送已启动（每 ${settings.intervalMinutes} 分钟）`)
  // 启动后立即检查一次
  void checkHotOnce()
}

export function stopHotNotifier(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
    logger.info('热点推送已停止')
  }
}

export function getHotNotifierStatus(): {
  enabled: boolean
  running: boolean
  intervalMinutes: number
  topCount: number
  lastRunAt: number | null
  lastNotified: number
} {
  return {
    enabled: settings.enabled,
    running: timer !== null,
    intervalMinutes: settings.intervalMinutes,
    topCount: settings.topCount,
    lastRunAt,
    lastNotified
  }
}

function formatHot(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  return String(n)
}
