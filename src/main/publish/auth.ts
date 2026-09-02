/* ============================================
 * 多平台发布 · 登录态管理（P1）
 * BrowserWindow 内嵌登录页 + 持久化 session partition（Chromium 自动持久化 Cookie）
 * ============================================ */

import { BrowserWindow, session, type Session } from 'electron'
import { getAdapter, listAdapters, type PublishContext } from './adapter.ts'
import { getLogger } from '../tools/logger.ts'

const logger = getLogger('publishAuth')

/** 平台登录会话分区：登录态持久化到 userData（Chromium 管理，无需自存 Cookie） */
export const PLATFORM_PARTITION = 'persist:platforms'

let platformSession: Session | null = null

export function getPlatformSession(): Session {
  if (!platformSession) platformSession = session.fromPartition(PLATFORM_PARTITION)
  return platformSession
}

export function makePublishContext(): PublishContext {
  return {
    session: getPlatformSession(),
    log: (msg: string) => logger.info(msg)
  }
}

/* ---------- 登录窗口 ---------- */
let loginWindow: BrowserWindow | null = null

export function openLoginWindow(platformId: string): void {
  const adapter = getAdapter(platformId)
  if (!adapter) {
    logger.warning(`登录窗口: 平台适配器不存在 ${platformId}`)
    return
  }
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus()
    return
  }
  loginWindow = new BrowserWindow({
    width: 980,
    height: 720,
    title: `登录 ${adapter.name}`,
    autoHideMenuBar: true,
    webPreferences: {
      partition: PLATFORM_PARTITION,
      contextIsolation: true
    }
  })
  void loginWindow.loadURL(adapter.loginUrl)
  loginWindow.on('closed', () => {
    loginWindow = null
  })
  logger.info(`已打开 ${adapter.name} 登录窗口`)
}

export function closeLoginWindow(): void {
  if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close()
}

/* ---------- 登录状态 ---------- */
export async function checkLogin(platformId: string): Promise<boolean> {
  const adapter = getAdapter(platformId)
  if (!adapter) return false
  try {
    return await adapter.checkLogin(makePublishContext())
  } catch (err) {
    logger.warning(`登录探测失败 [${platformId}]: ${(err as Error).message}`)
    return false
  }
}

export async function checkAllLogin(): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {}
  for (const adapter of listAdapters()) {
    result[adapter.id] = await checkLogin(adapter.id)
  }
  return result
}
