// 验证专用 electron 替身：比 tests/electron-stub.mjs 更完整，
// 让 src/main/docsIpc.ts 能在纯 Node 下加载并真实走一遍 IPC handler。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// tests/pdf-audit/scratch -> 仓库根
const appRoot = fileURLToPath(new URL('../../..', import.meta.url))
const userData = mkdtempSync(join(tmpdir(), 'lm-full-stub-'))

/** 捕获 ipcMain.handle 注册的 handler，供测试直接调用 */
export const handlers = new Map()

export const app = {
  isPackaged: false,
  getPath: (name) => (name === 'temp' ? tmpdir() : userData),
  getAppPath: () => appRoot,
  getVersion: () => '0.0.0-test'
}

export const ipcMain = {
  handle: (channel, fn) => {
    handlers.set(channel, fn)
  },
  on: () => undefined
}

export const BrowserWindow = {
  fromWebContents: () => null,
  getAllWindows: () => []
}

export const dialog = {
  /** 测试前设置：showSaveDialog 将返回该路径 */
  _savePath: null,
  showSaveDialog: async () => ({ canceled: !dialog._savePath, filePath: dialog._savePath }),
  showOpenDialog: async () => ({ canceled: true, filePaths: [] })
}

export default { app, ipcMain, BrowserWindow, dialog, handlers }
