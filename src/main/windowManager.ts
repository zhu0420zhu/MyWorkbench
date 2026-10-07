/**
 * 窗口管理：尺寸记忆 / 最小最大限制 / 八向拖拽缩放 / 关闭行为守卫 / 后台托盘
 *
 * 无边框窗口（frame: false）没有系统原生边框，因此既没有原生拖拽缩放热区，
 * 关闭也没有系统确认。本模块统一补齐这些能力，且对任意 BrowserWindow 可复用：
 *
 *   attachWindowManager(win, 'main', MAIN_PROFILE)   // 记忆 + 限制
 *   attachCloseGuard(win, { onBackground })          // 关闭确认 + 后台
 *   registerWindowIpc()                              // 拖拽缩放 / 关闭确认 IPC
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  screen,
  Tray,
  type IpcMainEvent,
  type Rectangle
} from 'electron'
import { existsSync } from 'fs'
import { promises as fs } from 'fs'
import { join } from 'path'

/** 八向缩放：四边 + 四角 */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** 关闭窗口时的最终处置 */
export type CloseAction = 'minimize' | 'quit'
/** 关闭行为：ask=每次询问；minimize=始终最小化到后台；quit=始终直接退出 */
export type CloseBehavior = 'ask' | CloseAction
export type CloseDecision = CloseAction | 'cancel'

export interface WindowProfile {
  minWidth: number
  minHeight: number
  /** 0 表示不限制（拖拽时仍受当前显示器工作区尺寸约束） */
  maxWidth: number
  maxHeight: number
  defaultWidth: number
  defaultHeight: number
  /** 是否记忆位置与尺寸 */
  rememberBounds: boolean
}

interface WindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

interface WindowStore {
  bounds: Record<string, WindowState>
  behavior: CloseBehavior
}

/** 主窗口档案：写作/笔记等页面共用，最小尺寸保证侧栏+内容区可用 */
export const MAIN_PROFILE: WindowProfile = {
  minWidth: 880,
  minHeight: 560,
  maxWidth: 0,
  maxHeight: 0,
  defaultWidth: 1280,
  defaultHeight: 820,
  rememberBounds: true
}

/** 独立便利贴悬浮窗档案 */
export const STICKY_PROFILE: WindowProfile = {
  minWidth: 200,
  minHeight: 160,
  maxWidth: 720,
  maxHeight: 900,
  defaultWidth: 280,
  defaultHeight: 320,
  rememberBounds: false
}

/**
 * 各页面独立窗口的档案：不同页面内容形态差异很大，
 * 统一用主窗口的 880×560 会让"写作单栏"过大、"白板"过小，因此按页面给默认值。
 * 未列出的页面走 default 档案。
 */
export const PAGE_PROFILES: Record<string, WindowProfile> = {
  default: {
    minWidth: 640,
    minHeight: 420,
    maxWidth: 0,
    maxHeight: 0,
    defaultWidth: 1100,
    defaultHeight: 720,
    rememberBounds: true
  },
  /** 写作：三栏（角色库/对话/设定），需要较宽 */
  writing: {
    minWidth: 760,
    minHeight: 480,
    maxWidth: 0,
    maxHeight: 0,
    defaultWidth: 1280,
    defaultHeight: 840,
    rememberBounds: true
  },
  /** 笔记：列表 + 编辑器两栏，窄一些也能用 */
  notes: {
    minWidth: 560,
    minHeight: 400,
    maxWidth: 0,
    maxHeight: 0,
    defaultWidth: 1040,
    defaultHeight: 700,
    rememberBounds: true
  },
  /** 白板（tldraw）：画布越大越好 */
  boards: {
    minWidth: 720,
    minHeight: 480,
    maxWidth: 0,
    maxHeight: 0,
    defaultWidth: 1360,
    defaultHeight: 880,
    rememberBounds: true
  },
  /** AI 对话：单栏窄窗更接近聊天窗形态 */
  ai: {
    minWidth: 480,
    minHeight: 420,
    maxWidth: 0,
    maxHeight: 0,
    defaultWidth: 820,
    defaultHeight: 760,
    rememberBounds: true
  },
  /** 文本工具：左右对照，需要宽度 */
  texttools: {
    minWidth: 680,
    minHeight: 420,
    maxWidth: 0,
    maxHeight: 0,
    defaultWidth: 1160,
    defaultHeight: 760,
    rememberBounds: true
  },
  /** 长篇作品：章节树 + 编辑器 + 细纲三栏，最吃宽度的一页 */
  novel: {
    minWidth: 860,
    minHeight: 480,
    maxWidth: 0,
    maxHeight: 0,
    defaultWidth: 1400,
    defaultHeight: 880,
    rememberBounds: true
  }
}

/** 取页面档案，未配置时回落到 default */
export function pageProfile(page: string): WindowProfile {
  return PAGE_PROFILES[page] ?? PAGE_PROFILES.default!
}

const STORE_DEFAULTS: WindowStore = { bounds: {}, behavior: 'ask' }

let store: WindowStore = { ...STORE_DEFAULTS, bounds: {} }
let loaded = false
let flushTimer: ReturnType<typeof setTimeout> | null = null

function storeFile(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function normalizeState(raw: unknown): WindowState | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (![r.x, r.y, r.width, r.height].every(isFiniteNumber)) return null
  const s: WindowState = {
    x: r.x as number,
    y: r.y as number,
    width: r.width as number,
    height: r.height as number,
    maximized: r.maximized === true
  }
  return s.width > 0 && s.height > 0 ? s : null
}

/** 应用启动时调用一次：载入窗口尺寸记忆与关闭行为 */
export async function initWindowManager(): Promise<void> {
  try {
    const raw = JSON.parse(await fs.readFile(storeFile(), 'utf-8')) as Record<string, unknown>
    const bounds: Record<string, WindowState> = {}
    const rawBounds = (raw.bounds ?? {}) as Record<string, unknown>
    for (const [key, value] of Object.entries(rawBounds)) {
      const s = normalizeState(value)
      if (s) bounds[key] = s
    }
    const behavior = raw.behavior
    store = {
      bounds,
      behavior: behavior === 'minimize' || behavior === 'quit' ? behavior : 'ask'
    }
  } catch {
    store = { bounds: {}, behavior: 'ask' }
  }
  loaded = true
}

function persistNow(): void {
  if (!loaded) return
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const payload = JSON.stringify(store, null, 2)
  void fs
    .mkdir(app.getPath('userData'), { recursive: true })
    .then(() => fs.writeFile(storeFile(), payload, 'utf-8'))
    .catch(() => undefined)
}

/** resize/move 事件高频触发，300ms 防抖后落盘 */
function schedulePersist(): void {
  if (!loaded) return
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(persistNow, 300)
}

export function getCloseBehavior(): CloseBehavior {
  return store.behavior
}

export function setCloseBehavior(b: CloseBehavior): CloseBehavior {
  store.behavior = b
  persistNow()
  return b
}

/** 保存的位置是否仍落在某个显示器上（防止拔掉外接屏后窗口“消失”） */
function isOnScreen(s: WindowState): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    const overlapX = Math.min(s.x + s.width, a.x + a.width) - Math.max(s.x, a.x)
    const overlapY = Math.min(s.y + s.height, a.y + a.height) - Math.max(s.y, a.y)
    return overlapX > 80 && overlapY > 60
  })
}

function centerBounds(profile: WindowProfile): Rectangle {
  const area = screen.getPrimaryDisplay().workArea
  const width = Math.max(profile.minWidth, Math.min(profile.defaultWidth, area.width))
  const height = Math.max(profile.minHeight, Math.min(profile.defaultHeight, area.height))
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height
  }
}

/** 当前窗口可用的最大尺寸：档案上限与所在显示器工作区取小 */
function maxBoundsFor(win: BrowserWindow): { width: number; height: number } {
  const [maxW, maxH] = win.getMaximumSize()
  const area = screen.getDisplayMatching(win.getBounds()).workArea
  return {
    width: Math.max(1, Math.min(maxW > 0 ? maxW : Number.POSITIVE_INFINITY, area.width)),
    height: Math.max(1, Math.min(maxH > 0 ? maxH : Number.POSITIVE_INFINITY, area.height))
  }
}

/**
 * 让窗口具备：最小/最大尺寸限制、位置尺寸记忆、跨屏保护。
 * 记忆的 bounds 在显示器变更后自动回退到居中默认值。
 */
export function attachWindowManager(
  win: BrowserWindow,
  name: string,
  profile: WindowProfile
): void {
  win.setMinimumSize(profile.minWidth, profile.minHeight)
  if (profile.maxWidth > 0 && profile.maxHeight > 0) {
    win.setMaximumSize(profile.maxWidth, profile.maxHeight)
  }

  const saved = profile.rememberBounds ? store.bounds[name] : undefined
  if (saved && isOnScreen(saved)) {
    win.setBounds({ x: saved.x, y: saved.y, width: saved.width, height: saved.height })
    if (saved.maximized) win.maximize()
  } else {
    win.setBounds(centerBounds(profile))
  }

  if (!profile.rememberBounds) return

  const capture = (): void => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
    if (win.isMaximized()) {
      const prev = store.bounds[name]
      store.bounds[name] = prev ? { ...prev, maximized: true } : { ...win.getBounds(), maximized: true }
      schedulePersist()
      return
    }
    store.bounds[name] = { ...win.getBounds(), maximized: false }
    schedulePersist()
  }

  win.on('resize', capture)
  win.on('move', capture)
  win.on('closed', () => {
    if (store.bounds[name]) persistNow()
  })
}

/* ------------------------------------------------------------------ */
/* 八向拖拽缩放                                                        */
/* ------------------------------------------------------------------ */

interface DragSession {
  edge: ResizeEdge
  startCursor: { x: number; y: number }
  startBounds: Rectangle
}

const drags = new Map<number, DragSession>()

function registerResizeIpc(): void {
  ipcMain.on('window:resize-begin', (e: IpcMainEvent, edge: ResizeEdge) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return
    drags.set(win.id, {
      edge,
      startCursor: screen.getCursorScreenPoint(),
      startBounds: win.getBounds()
    })
  })

  ipcMain.on('window:resize-move', (e: IpcMainEvent) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return
    const s = drags.get(win.id)
    if (!s) return

    const cur = screen.getCursorScreenPoint()
    const dx = cur.x - s.startCursor.x
    const dy = cur.y - s.startCursor.y

    let { x, y, width, height } = s.startBounds
    const toEast = s.edge.includes('e')
    const toWest = s.edge.includes('w')
    const toSouth = s.edge.includes('s')
    const toNorth = s.edge.includes('n')

    if (toEast) width = s.startBounds.width + dx
    if (toWest) {
      width = s.startBounds.width - dx
      x = s.startBounds.x + dx
    }
    if (toSouth) height = s.startBounds.height + dy
    if (toNorth) {
      height = s.startBounds.height - dy
      y = s.startBounds.y + dy
    }

    // 触底/触顶时反向补偿锚点：拖西边越界不会把窗口“顶回去”漂移
    const [minW, minH] = win.getMinimumSize()
    const max = maxBoundsFor(win)
    if (width < minW) {
      if (toWest) x -= minW - width
      width = minW
    }
    if (height < minH) {
      if (toNorth) y -= minH - height
      height = minH
    }
    if (width > max.width) {
      if (toWest) x += width - max.width
      width = max.width
    }
    if (height > max.height) {
      if (toNorth) y += height - max.height
      height = max.height
    }

    win.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height)
    })
  })

  const end = (e: IpcMainEvent): void => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) drags.delete(win.id)
  }
  ipcMain.on('window:resize-end', end)
}

/* ------------------------------------------------------------------ */
/* 关闭行为守卫                                                        */
/* ------------------------------------------------------------------ */

const forceClose = new WeakSet<BrowserWindow>()

interface CloseGuardOptions {
  /** 进入后台前回调（例如顺手收起便利贴悬浮面板） */
  onBackground?: () => void
  /** 从后台恢复后回调 */
  onRestore?: () => void
}

let primaryWindow: BrowserWindow | null = null
let guardOptions: CloseGuardOptions = {}
let tray: Tray | null = null
/** 关闭守卫触发的最小化标志：用于抑制主窗口最小化时自动弹出便利贴面板 */
let closeGuardMinimize = false

export function isCloseGuardMinimize(): boolean {
  return closeGuardMinimize
}

/** 托盘图标候选路径：打包态 <resourcesPath>/icons/，开发态仓库内 build/ 或 resources/icons/ */
function trayIconCandidates(): string[] {
  return [
    join(process.resourcesPath, 'icons', 'icon.png'),
    join(app.getAppPath(), 'build', 'icon.png'),
    join(app.getAppPath(), 'resources', 'icons', 'icon.png')
  ]
}

function resolveTrayIcon(): string | null {
  return trayIconCandidates().find((p) => existsSync(p)) ?? null
}

function trayAvailable(): boolean {
  if (tray && !tray.isDestroyed()) return true
  const icon = resolveTrayIcon()
  if (!icon) {
    // 不静默：图标缺失会导致托盘不可用，明确记录候选路径便于定位打包配置问题
    console.warn(`[tray] 未找到托盘图标，后台托盘不可用。已尝试: ${trayIconCandidates().join(' ; ')}`)
    return false
  }
  try {
    tray = new Tray(icon)
  } catch {
    tray = null
    return false
  }
  tray.setToolTip('灵墨工作台')
  tray.on('click', () => restorePrimary())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开主窗口', click: () => restorePrimary() },
      { type: 'separator' },
      { label: '退出灵墨工作台', click: () => quitApp() }
    ])
  )
  return true
}

function restorePrimary(): void {
  const win = primaryWindow
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
  guardOptions.onRestore?.()
}

/**
 * 让主窗口跳转到指定页面（独立窗口内的跨页导航走这里，避免子窗口内容漂移）。
 * 主窗口处于后台时先唤起再跳转。
 */
export function navigatePrimaryWindow(page: string, id?: string): boolean {
  const win = primaryWindow
  if (!win || win.isDestroyed()) return false
  restorePrimary()
  win.webContents.send('main:navigate', { page, id })
  return true
}

/** 真正退出：跳过关闭确认 */
export function quitApp(): void {
  for (const w of BrowserWindow.getAllWindows()) forceClose.add(w)
  app.quit()
}

function sendBackground(win: BrowserWindow): void {
  guardOptions.onBackground?.()
  trayAvailable() // 确保托盘图标存在，用户仍可从托盘恢复
  // 改为最小化而非 hide：关闭→后台时窗口保留在任务栏，避免用户找不到入口
  closeGuardMinimize = true
  win.minimize()
  setImmediate(() => {
    closeGuardMinimize = false
  })
}

/** 询问渲染层：返回 null 表示渲染层无响应（超时/未实现） */
function askRenderer(
  win: BrowserWindow
): Promise<{ action: CloseDecision; remember: boolean } | null> {
  return new Promise((resolve) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      resolve(null)
      return
    }
    let settled = false
    const finish = (v: { action: CloseDecision; remember: boolean } | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ipcMain.removeListener('window:close-reply', handler)
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), 15000)
    const handler = (
      e: IpcMainEvent,
      payload: { action?: string; remember?: boolean } | undefined
    ): void => {
      // 只接受来自被询问窗口的答复
      if (e.sender.id !== win.webContents.id) return
      const a = payload?.action
      if (a === 'minimize' || a === 'quit') finish({ action: a, remember: payload?.remember === true })
      else finish({ action: 'cancel', remember: false })
    }
    ipcMain.on('window:close-reply', handler)
    win.webContents.send('window:confirm-close')
  })
}

/** 渲染层无响应时的兜底：原生对话框同样带「不再提示」 */
async function askNative(
  win: BrowserWindow
): Promise<{ action: CloseDecision; remember: boolean }> {
  try {
    const res = await dialog.showMessageBox(win, {
      type: 'question',
      title: '关闭灵墨工作台',
      message: '要最小化到后台继续运行，还是直接退出？',
      detail: '最小化到后台后，应用会在系统托盘中继续运行，方便随时回到写作。',
      buttons: ['最小化到后台', '直接退出', '取消'],
      defaultId: 0,
      cancelId: 2,
      checkboxLabel: '不再提示，以后始终按此方式处理',
      checkboxChecked: false,
      noLink: true
    })
    const action: CloseDecision =
      res.response === 0 ? 'minimize' : res.response === 1 ? 'quit' : 'cancel'
    return { action, remember: res.checkboxChecked && action !== 'cancel' }
  } catch {
    return { action: 'quit', remember: false }
  }
}

async function runCloseFlow(win: BrowserWindow): Promise<void> {
  let decision: CloseDecision
  let remember = false

  if (store.behavior === 'ask') {
    let reply = await askRenderer(win)
    if (!reply) reply = await askNative(win)
    decision = reply.action
    remember = reply.remember
    if (remember && decision !== 'cancel') setCloseBehavior(decision)
  } else {
    decision = store.behavior
  }

  if (decision === 'cancel') return
  if (decision === 'minimize') {
    sendBackground(win)
    return
  }

  forceClose.add(win)
  win.destroy()
}

/**
 * 拦截窗口关闭：按已保存行为处理；未设置时弹出确认（渲染层优先，原生兜底）。
 * 只对显式调用本函数的窗口生效，悬浮便利贴等子窗口不受影响。
 */
export function attachCloseGuard(win: BrowserWindow, opts: CloseGuardOptions = {}): void {
  primaryWindow = win
  guardOptions = opts
  win.on('close', (e) => {
    if (forceClose.has(win)) {
      forceClose.delete(win)
      return
    }
    e.preventDefault()
    void runCloseFlow(win)
  })
}

/* ------------------------------------------------------------------ */
/* IPC 注册                                                            */
/* ------------------------------------------------------------------ */

export function registerWindowIpc(): void {
  registerResizeIpc()

  ipcMain.handle('window:is-maximized', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    return win ? win.isMaximized() : false
  })

  ipcMain.handle('window:bounds', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    return win ? win.getBounds() : null
  })

  ipcMain.handle('window:get-close-behavior', () => getCloseBehavior())
  ipcMain.handle('window:set-close-behavior', (_e, b: CloseBehavior) =>
    setCloseBehavior(b === 'minimize' || b === 'quit' ? b : 'ask')
  )

  ipcMain.handle('window:navigate-main', (_e, page: string, id?: string) =>
    navigatePrimaryWindow(page, id)
  )
}
