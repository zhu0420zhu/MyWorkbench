/* 工具集 IPC 桥接：把移植自 ck 08_工具集 的四模块暴露给渲染进程 */
import { ipcMain, BrowserWindow } from 'electron'
import {
  scanDirectory,
  getFileInfo,
  formatFileSize,
  deleteFile,
  getDiskInfo,
  getAllDisks,
  DiskAnalyzer,
  findDuplicates,
  getFileWatcher
} from './tools/index.ts'
import type { ScanOptions, DuplicateScanOptions } from './tools/index.ts'

export function registerToolsIpc(): void {
  const analyzer = new DiskAnalyzer()

  // ---- 文件工具 ----
  ipcMain.handle('tools:scan-directory', (_e, dir: string, opts?: ScanOptions) => scanDirectory(dir, opts))
  ipcMain.handle('tools:file-info', (_e, p: string) => getFileInfo(p))
  ipcMain.handle('tools:format-size', (_e, bytes: number) => formatFileSize(bytes))
  ipcMain.handle('tools:delete-file', (_e, p: string, sendToTrash: boolean = true) => deleteFile(p, sendToTrash))

  // ---- 磁盘分析 ----
  ipcMain.handle('tools:get-disk-info', (_e, p: string) => getDiskInfo(p))
  ipcMain.handle('tools:get-all-disks', () => getAllDisks())
  ipcMain.handle(
    'tools:analyze-directory',
    (_e, dir: string, recursive?: boolean, minSizeLarge?: number) =>
      analyzer.analyzeDirectory(dir, recursive ?? true, minSizeLarge)
  )
  ipcMain.handle('tools:find-large-files', (_e, dir: string, minSize?: number, limit?: number) =>
    analyzer.findLargeFiles(dir, minSize, limit)
  )

  // ---- 重复检测 ----
  ipcMain.handle('tools:find-duplicates', (_e, dir: string, opts?: DuplicateScanOptions & { strategy?: string }) =>
    findDuplicates(dir, opts)
  )

  // ---- 文件监控（事件推送到所有窗口）----
  const watcher = getFileWatcher()
  ipcMain.handle('tools:watcher-add', (_e, dir: string, name?: string) => watcher.addWatch(dir, name))
  ipcMain.handle('tools:watcher-remove', (_e, dir: string) => watcher.removeWatch(dir))
  ipcMain.handle('tools:watcher-start', () => {
    watcher.start()
    return true
  })
  ipcMain.handle('tools:watcher-stop', () => {
    watcher.stop()
    return true
  })
  ipcMain.handle('tools:watcher-pause', () => {
    watcher.pause()
    return true
  })
  ipcMain.handle('tools:watcher-resume', () => {
    watcher.resume()
    return true
  })
  ipcMain.handle('tools:watcher-list', () => watcher.watchedDirectories)
  watcher.addCallback((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('tools:watcher-event', event)
    }
  })
}
