import { BrowserWindow, screen, type Rectangle } from 'electron'
import { join } from 'path'
import { listStickies } from './stickies'

/**
 * 便利贴悬浮面板窗：主窗口最小化时，把「便利贴」页面整体抽离成
 * 无边框悬浮窗口独立显示在桌面上。
 *
 * 双形态：
 * - collapsed（默认）：约桌面文件夹图标大小的紧凑图标，整窗可拖动，点击展开
 * - expanded：完整便利贴内容窗口，复用同一 React 组件，1:1 保真不压缩
 *
 * 切换时先通知渲染层换 UI，稍后（ANIM_DELAY）再驱动窗口尺寸动画，
 * 保证「内容先就位、窗口再缩放」，观感连贯。
 *
 * 与 stickyWindows.ts（单贴只读悬浮窗）互不干扰。
 */
export type StickyPanelMode = 'collapsed' | 'expanded'

/** 折叠态尺寸：约桌面文件夹图标大小 */
const COLLAPSED_SIZE = { width: 132, height: 132 }
/** 展开态最小尺寸（保证至少 2 列卡片不被压缩） */
const EXPANDED_MIN = { width: 420, height: 360 }
/** 渲染层切换 UI 的错峰延时：让 React 先渲染完，再驱动窗口尺寸动画 */
const ANIM_DELAY = 30
/** 展开后设置最小尺寸的延时：避开动画期间被系统瞬间撑大 */
const MIN_SIZE_DELAY = 280

let panel: BrowserWindow | null = null
let mode: StickyPanelMode = 'collapsed'
/** 两种形态各自记住的位置尺寸，下次弹出/切换时复用 */
let collapsedBounds: Rectangle | null = null
let expandedBounds: Rectangle | null = null
/** showStickyPanel 异步执行中，防止快速连续调用创建第二个窗口 */
let opening = false
/** showStickyPanel 等待期间被 closeStickyPanel 取消（主窗口已还原） */
let cancelled = false

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** 把矩形约束到所在屏幕的工作区内，避免窗口被拖出屏幕或超出边界 */
function clampRect(r: { x: number; y: number; width: number; height: number }): Rectangle {
  const disp = screen.getDisplayMatching({
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height)
  })
  const wa = disp.workArea
  const width = Math.min(Math.round(r.width), wa.width)
  const height = Math.min(Math.round(r.height), wa.height)
  const x = Math.min(Math.max(Math.round(r.x), wa.x), wa.x + wa.width - width)
  const y = Math.min(Math.max(Math.round(r.y), wa.y), wa.y + wa.height - height)
  return { x, y, width, height }
}

/** 主窗口尺寸与位置，作为展开态尺寸的缩放基准 */
function mainBounds(): { x: number; y: number; width: number; height: number } {
  const main = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (main) {
    try {
      return main.getNormalBounds()
    } catch {
      /* ignore */
    }
  }
  const wa = screen.getPrimaryDisplay().workArea
  return { x: wa.x, y: wa.y, width: wa.width, height: wa.height }
}

export function hasStickyPanel(): boolean {
  return !!panel && !panel.isDestroyed()
}

export function getStickyPanelMode(): StickyPanelMode {
  return mode
}

function rememberBounds(): void {
  if (!panel || panel.isDestroyed()) return
  try {
    const b = panel.getBounds()
    if (mode === 'collapsed') collapsedBounds = b
    else expandedBounds = b
  } catch {
    /* ignore */
  }
}

/** 以当前窗口中心为锚点计算目标矩形，保证缩放时中心不跳 */
function targetRect(next: StickyPanelMode, cur: Rectangle): Rectangle {
  const cx = cur.x + cur.width / 2
  const cy = cur.y + cur.height / 2
  if (next === 'collapsed') {
    if (collapsedBounds) return clampRect(collapsedBounds)
    return clampRect({
      width: COLLAPSED_SIZE.width,
      height: COLLAPSED_SIZE.height,
      x: cx - COLLAPSED_SIZE.width / 2,
      y: cy - COLLAPSED_SIZE.height / 2
    })
  }
  if (expandedBounds) return clampRect(expandedBounds)
  const base = mainBounds()
  const width = clamp(Math.round(base.width * 0.62), 520, 880)
  const height = clamp(Math.round(base.height * 0.74), 520, 800)
  return clampRect({ width, height, x: cx - width / 2, y: cy - height / 2 })
}

/**
 * 切换形态：先广播 UI 切换，稍后驱动窗口尺寸动画。
 * 关键细节：折叠前必须把最小尺寸清零，否则 minWidth 会把小窗口顶回去。
 */
function applyMode(next: StickyPanelMode, animate: boolean): void {
  if (!panel || panel.isDestroyed()) return
  mode = next
  try {
    panel.webContents.send('stickies:panel-mode', next)
  } catch {
    /* ignore */
  }
  const rect = targetRect(next, panel.getBounds())
  const run = (): void => {
    if (!panel || panel.isDestroyed() || mode !== next) return
    if (next === 'collapsed') {
      panel.setMinimumSize(0, 0)
      panel.setResizable(false)
      panel.setBounds(rect, animate)
    } else {
      panel.setResizable(true)
      panel.setBounds(rect, animate)
      // 最小尺寸延后设置：动画期间若仍是折叠小窗，提前设 min 会被系统瞬间撑大
      setTimeout(() => {
        if (panel && !panel.isDestroyed() && mode === 'expanded') {
          panel.setMinimumSize(EXPANDED_MIN.width, EXPANDED_MIN.height)
        }
      }, animate ? MIN_SIZE_DELAY : 0)
    }
  }
  if (animate) setTimeout(run, ANIM_DELAY)
  else run()
}

/** 供渲染层调用：展开为完整便利贴 / 收起为紧凑图标 */
export function setStickyPanelMode(next: StickyPanelMode): boolean {
  if (!hasStickyPanel()) return false
  if (mode === next) return true
  applyMode(next, true)
  return true
}

export async function showStickyPanel(): Promise<boolean> {
  if (hasStickyPanel()) {
    panel?.show()
    panel?.focus()
    return true
  }

  // 上一次打开流程尚未结束，避免并发创建第二个窗口
  if (opening) return false
  opening = true
  cancelled = false
  try {
    // 没有任何便利贴时安静最小化，不弹空面板
    try {
      const notes = await listStickies()
      if (notes.length === 0) return false
    } catch {
      return false
    }

    // 等待期间主窗口可能已还原（closeStickyPanel 已被调用），此时不再弹出
    if (cancelled) return false

    // 默认以折叠态（紧凑图标）出现，位置沿用上次折叠位置或屏幕右下角
    const base = mainBounds()
    const init = collapsedBounds
      ? clampRect(collapsedBounds)
      : clampRect({
          width: COLLAPSED_SIZE.width,
          height: COLLAPSED_SIZE.height,
          x: base.x + base.width - COLLAPSED_SIZE.width - 32,
          y: base.y + base.height - COLLAPSED_SIZE.height - 96
        })
    mode = 'collapsed'

    const win = new BrowserWindow({
      x: init.x,
      y: init.y,
      width: init.width,
      height: init.height,
      minWidth: 0,
      minHeight: 0,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      // 透明背景：折叠态圆角图标卡片不出现方角底色
      transparent: true,
      backgroundColor: '#00000000',
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false
      }
    })
    panel = win
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.showInactive()
    })
    win.on('resize', () => rememberBounds())
    win.on('move', () => rememberBounds())
    win.on('closed', () => {
      if (panel === win) panel = null
    })

    if (process.env['ELECTRON_RENDERER_URL']) {
      await win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/?panel=stickies`)
    } else {
      await win.loadFile(join(__dirname, '../renderer/index.html'), { query: { panel: 'stickies' } })
    }
    return true
  } finally {
    opening = false
  }
}

export function closeStickyPanel(): void {
  // 无论窗口是否已创建，都标记取消，阻止正在进行的打开流程继续弹出
  cancelled = true
  if (panel && !panel.isDestroyed()) {
    panel.close()
  }
  panel = null
  mode = 'collapsed'
}
