/**
 * 页面独立窗口：把写作 / 笔记 / 白板等页面从主窗口"拖"成独立无边框窗口
 *
 * 与主窗口共享同一套能力（见 windowManager）：
 *   - 按页面分配的 min/max 尺寸档案（PAGE_PROFILES）
 *   - 位置尺寸记忆（key = page:<页面>:<id>，换页不串台）
 *   - 八向边角拖拽缩放（渲染层 WindowResizeHandles + window:resize-* IPC）
 *
 * 约定：
 *   - 同一 page + id 只开一个窗口，重复调用聚焦已有窗口
 *   - 子窗口关闭只是"关掉这个窗口"，不触发应用退出确认；主窗口才走 attachCloseGuard
 *   - 窗口清单变化时向所有窗口广播 page-windows:changed，供渲染层显示"已在独立窗口打开"
 */
import { BrowserWindow } from 'electron'
import { join } from 'path'
import { attachWindowManager, pageProfile } from './windowManager'
import { pageLabelOf } from '../shared/pageMeta'

/**
 * 页面 key → 窗口标题。
 *
 * 中文名不再在此硬编码，统一取自 `../shared/pageMeta` 的 PAGE_LABELS，
 * 与渲染层侧边栏（navItems.tsx）、命令面板（search.ts）同源。
 * 另注：此处设置的 title 仅作用于窗口创建瞬间，
 * 渲染层 PageWindowShell 会用 document.title 覆盖为「<页面名> · 灵墨工作台」。
 */

/** key = `${page}:${id ?? ''}` */
const windows = new Map<string, BrowserWindow>()

function keyOf(page: string, id?: string): string {
  return `${page}:${id ?? ''}`
}

function broadcast(): void {
  const list = [...windows.keys()]
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('page-windows:changed', list)
  }
}

/** 已打开的独立窗口 key 列表 */
export function listPageWindows(): string[] {
  for (const [k, w] of windows) {
    if (w.isDestroyed()) windows.delete(k)
  }
  return [...windows.keys()]
}

export function hasPageWindow(page: string, id?: string): boolean {
  const w = windows.get(keyOf(page, id))
  return !!w && !w.isDestroyed()
}

/** 载入渲染入口，并带上 ?win=<page>&id=<id> 让渲染层进入独立窗口分支 */
async function loadShell(win: BrowserWindow, page: string, id?: string): Promise<void> {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    const url = new URL(devUrl)
    url.searchParams.set('win', page)
    if (id) url.searchParams.set('id', id)
    await win.loadURL(url.toString())
    return
  }
  await win.loadFile(join(__dirname, '../renderer/index.html'), {
    query: id ? { win: page, id } : { win: page }
  })
}

/**
 * 打开（或聚焦）某个页面的独立窗口。
 * @param page 页面 key，同 nav.tsx 的 PageKey
 * @param id 目标 id（笔记 id / 白板 id 等），可选
 */
export async function openPageWindow(page: string, id?: string): Promise<boolean> {
  const key = keyOf(page, id)

  const existing = windows.get(key)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    if (!existing.isVisible()) existing.show()
    existing.focus()
    return true
  }

  const profile = pageProfile(page)
  const win = new BrowserWindow({
    width: profile.defaultWidth,
    height: profile.defaultHeight,
    minWidth: profile.minWidth,
    minHeight: profile.minHeight,
    show: false,
    autoHideMenuBar: true,
    frame: false,
    backgroundColor: '#141414',
    title: pageLabelOf(page),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webviewTag: true
    }
  })

  windows.set(key, win)

  // 尺寸记忆 + 最小限制（记忆的 bounds 若已不在任何显示器上会自动回到居中默认）
  attachWindowManager(win, key, profile)

  win.on('ready-to-show', () => {
    win.show()
    win.webContents.send('window:maximized', win.isMaximized())
  })
  win.on('maximize', () => {
    if (!win.webContents.isDestroyed()) win.webContents.send('window:maximized', true)
  })
  win.on('unmaximize', () => {
    if (!win.webContents.isDestroyed()) win.webContents.send('window:maximized', false)
  })
  win.on('closed', () => {
    windows.delete(key)
    broadcast()
  })

  await loadShell(win, page, id)
  broadcast()
  return true
}

export function closePageWindow(page: string, id?: string): boolean {
  const key = keyOf(page, id)
  const w = windows.get(key)
  if (w && !w.isDestroyed()) {
    w.close()
    return true
  }
  return false
}

export function closeAllPageWindows(): void {
  for (const w of windows.values()) {
    if (!w.isDestroyed()) w.close()
  }
  windows.clear()
}

/** 供渲染层展示标题用 */
export function pageTitle(page: string): string {
  return pageLabelOf(page)
}
