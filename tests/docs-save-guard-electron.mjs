// 空内容守卫 e2e 专用 electron 替身：只实现 src/main/docsIpc.ts 注册/执行所需的最小面。
// 与 tests/electron-stub.mjs 分开，避免影响其他使用 loader.mjs 的既有测试。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'lm-docs-guard-'))

/** 记录 showSaveDialog 的每一次调用（守卫必须让空内容用例一次都不触发它） */
export const dialogCalls = []
/** 捕获 ipcMain.handle 注册的处理器 */
export const handlers = new Map()
/** 测试注入：showSaveDialog 的返回值 */
export const dialogResponse = { value: { canceled: true, filePath: undefined } }

export const app = {
  getPath: (name) => (name === 'userData' ? userData : join(userData, String(name))),
  getAppPath: () => process.cwd(),
  isPackaged: false
}

export const ipcMain = {
  handle: (channel, fn) => {
    handlers.set(channel, fn)
  },
  on: () => undefined,
  removeHandler: () => undefined
}

export const dialog = {
  showSaveDialog: async (...args) => {
    dialogCalls.push(args)
    return dialogResponse.value
  },
  showOpenDialog: async () => ({ canceled: true, filePaths: [] })
}

export const BrowserWindow = {
  fromWebContents: () => null,
  getAllWindows: () => []
}

export default { app, ipcMain, dialog, BrowserWindow }
