import { BrowserWindow } from 'electron'
import { join } from 'path'
import { getSticky } from './stickies'
import type { StickyNote } from '../shared/types'

const windows = new Map<string, BrowserWindow>()

export function hasStickyWindow(id: string): boolean {
  const w = windows.get(id)
  return !!w && !w.isDestroyed()
}

export async function showStickyWindow(id: string): Promise<boolean> {
  const note = await getSticky(id)
  if (!note) return false

  const existing = windows.get(id)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return true
  }

  const win = new BrowserWindow({
    width: 280,
    height: 320,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: note.color,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  windows.set(id, win)
  win.on('closed', () => {
    windows.delete(id)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    await win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/sticky.html?id=${id}`)
  } else {
    await win.loadFile(join(__dirname, '../renderer/sticky.html'), { query: { id } })
  }
  return true
}

export function closeStickyWindow(id: string): boolean {
  const w = windows.get(id)
  if (w && !w.isDestroyed()) {
    w.close()
    return true
  }
  return false
}

/** 单贴悬浮窗尺寸切换（折叠/大尺寸），供渲染层「展开大尺寸」按钮调用 */
export function setStickyWindowSize(id: string, width: number, height: number): boolean {
  const w = windows.get(id)
  if (w && !w.isDestroyed()) {
    w.setSize(Math.max(200, Math.round(width)), Math.max(200, Math.round(height)))
    return true
  }
  return false
}

/** 便利贴内容变更时同步到已打开的悬浮窗 */
export function broadcastStickyUpdate(note: StickyNote): void {
  const w = windows.get(note.id)
  if (w && !w.isDestroyed()) {
    w.webContents.send('sticky:update', note)
  }
}

export function closeAllStickyWindows(): void {
  for (const w of windows.values()) {
    if (!w.isDestroyed()) w.close()
  }
  windows.clear()
}
