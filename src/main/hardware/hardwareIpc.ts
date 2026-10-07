/* 硬件工具 IPC：本地采集剪贴板历史 + systeminformation 硬件信息 */
import { ipcMain, clipboard, BrowserWindow } from 'electron'
import {
  getSystemOverview,
  getCpuMemory,
  getGraphics,
  getBoardFirmware,
  getDiskHealth,
  getNetworkDevices,
  getPowerSensors,
  getHardwareSummary,
  warmupHardware
} from './hardwareInfo.ts'

export interface ClipboardEntry {
  id: string
  kind: 'text' | 'image' | 'files'
  text?: string
  preview?: string
  filePaths?: string[]
  size: number
  createdAt: number
}

const MAX_CLIP = 40
let clipHistory: ClipboardEntry[] = []
let clipTimer: NodeJS.Timeout | null = null
let lastText = ''
let lastImageHash = ''
let lastFilesKey = ''

function hashBytes(buf: Buffer): string {
  let h = 0
  for (let i = 0; i < buf.length; i += 64) h = (h + buf[i]) | 0
  return `${buf.length}:${h}`
}

function pushEntry(entry: ClipboardEntry): void {
  // 去重：同内容只保留最新
  clipHistory = clipHistory.filter((e) => {
    if (e.kind === 'text' && entry.kind === 'text') return e.text !== entry.text
    if (e.kind === 'image' && entry.kind === 'image') return e.preview !== entry.preview
    if (e.kind === 'files' && entry.kind === 'files') return e.preview !== entry.preview
    return true
  })
  clipHistory.unshift(entry)
  if (clipHistory.length > MAX_CLIP) clipHistory = clipHistory.slice(0, MAX_CLIP)
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('hardware:clipboard-event', entry)
  }
}

function pollClipboard(): void {
  try {
    // 文件路径（Windows: CF_HDROP 以 text 形式偶发；优先 readBuffer 的 FileNameW 不可用则用 text 行）
    const hasImage = clipboard.readImage()
    if (!hasImage.isEmpty()) {
      const png = hasImage.toPNG()
      const hash = hashBytes(png)
      if (hash !== lastImageHash) {
        lastImageHash = hash
        // 内存优化：只保留 64px 缩略图；完整图不驻留内存
        const thumb = hasImage.resize({ width: 64 })
        pushEntry({
          id: `img-${Date.now()}`,
          kind: 'image',
          preview: thumb.toDataURL(),
          size: png.length,
          createdAt: Date.now()
        })
      }
    }

    const text = clipboard.readText().trim()
    if (text && text !== lastText) {
      // 过滤过长文本，避免历史膨胀
      const clipped = text.length > 20000 ? text.slice(0, 20000) + '…' : text
      lastText = text
      // 文件路径列表（每行一个存在的路径风格）
      const lines = clipped.split(/\r?\n/).filter(Boolean)
      const looksLikeFiles =
        lines.length > 0 &&
        lines.length <= 32 &&
        lines.every((l) => /^[a-zA-Z]:\\|^\\\\|^\//.test(l) && l.length < 260)
      if (looksLikeFiles && lines.length > 1) {
        const key = lines.join('|')
        if (key !== lastFilesKey) {
          lastFilesKey = key
          pushEntry({
            id: `files-${Date.now()}`,
            kind: 'files',
            preview: lines.join('\n'),
            filePaths: lines,
            size: clipped.length,
            createdAt: Date.now()
          })
        }
      } else {
        pushEntry({
          id: `txt-${Date.now()}`,
          kind: 'text',
          text: clipped,
          preview: clipped.length > 120 ? clipped.slice(0, 120) + '…' : clipped,
          size: clipped.length,
          createdAt: Date.now()
        })
      }
    }
  } catch {
    /* 剪贴板占用时忽略 */
  }
}

let clipIdleTicks = 0
const CLIP_BASE_MS = 1200
const CLIP_MAX_MS = 8000

export function startClipboardWatcher(intervalMs = CLIP_BASE_MS): void {
  if (clipTimer) return
  pollClipboard()
  // 空闲退避：连续无变化时拉长轮询间隔，降低 CPU 占用
  let current = intervalMs
  const tick = () => {
    const before = clipHistory.length
    pollClipboard()
    if (clipHistory.length === before) {
      clipIdleTicks = Math.min(clipIdleTicks + 1, 8)
    } else {
      clipIdleTicks = 0
      current = intervalMs
    }
    if (clipIdleTicks >= 2) {
      current = Math.min(CLIP_MAX_MS, intervalMs * (1 + clipIdleTicks))
      if (clipTimer) clearInterval(clipTimer)
      clipTimer = setInterval(tick, current)
    }
  }
  clipTimer = setInterval(tick, intervalMs)
}

export function stopClipboardWatcher(): void {
  if (clipTimer) {
    clearInterval(clipTimer)
    clipTimer = null
  }
}

export function registerHardwareIpc(): void {
  startClipboardWatcher()

  ipcMain.handle('hardware:clipboard-list', () => clipHistory)
  ipcMain.handle('hardware:clipboard-clear', () => {
    clipHistory = []
    return true
  })
  ipcMain.handle('hardware:clipboard-remove', (_e, id: string) => {
    clipHistory = clipHistory.filter((e) => e.id !== id)
    return true
  })
  ipcMain.handle('hardware:clipboard-copy', (_e, id: string) => {
    const item = clipHistory.find((e) => e.id === id)
    if (!item) return false
    if (item.kind === 'text' && item.text) {
      clipboard.writeText(item.text)
      return true
    }
    if (item.kind === 'image') {
      // 不保留原图 dataURL；若系统剪贴板仍是同一图片则直接视为已可粘贴
      const current = clipboard.readImage()
      if (!current.isEmpty()) {
        const hash = hashBytes(current.toPNG())
        if (hash === lastImageHash) return true
      }
      return false
    }
    if (item.kind === 'files' && item.filePaths?.length) {
      // 复制为多行路径文本（跨应用兼容）
      clipboard.writeText(item.filePaths.join('\n'))
      return true
    }
    return false
  })

  // force=true 时绕过缓存强制重采（面板「刷新」按钮）
  ipcMain.handle('hardware:system', (_e, force = false) => getSystemOverview(force))
  ipcMain.handle('hardware:cpu-memory', (_e, force = false) => getCpuMemory(force))
  ipcMain.handle('hardware:graphics', (_e, force = false) => getGraphics(force))
  ipcMain.handle('hardware:board', (_e, force = false) => getBoardFirmware(force))
  ipcMain.handle('hardware:disk', (_e, force = false) => getDiskHealth(force))
  ipcMain.handle('hardware:network', (_e, force = false) => getNetworkDevices(force))
  ipcMain.handle('hardware:power', (_e, force = false) => getPowerSensors(force))
  ipcMain.handle('hardware:summary', () => getHardwareSummary())

  // 应用启动后台预热：并行预采集全部硬件数据，用户首次打开面板即秒出。
  // LINGMO_SKIP_HW_WARMUP=1 时跳过（受限沙箱/自动化会话里 reg.exe 可能被安全策略拦截，预热会导致整个应用被终止）
  if (process.env.LINGMO_SKIP_HW_WARMUP !== '1') {
    setTimeout(() => warmupHardware(), 1500)
  }
}
