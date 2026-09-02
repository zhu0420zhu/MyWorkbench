/* ============================================
 * 文件监控模块（由 ck 08_工具集/file_watcher.py 移植为 TypeScript）
 * 轮询模式监控多个目录：创建/修改/删除事件回调、启停/暂停/恢复
 * ============================================ */

import { promises as fs, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getLogger } from './logger.ts'

const logger = getLogger('fileWatcher')

/* ---------- 文件事件类型 ---------- */
export type FileEventType =
  | 'created'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'moved_from'
  | 'moved_to'

export interface FileEvent {
  event_type: FileEventType
  path: string
  old_path?: string
  timestamp: number
}

export interface WatchedDirInfo {
  name: string
  path: string
  enabled: boolean
}

export type FileEventCallback = (event: FileEvent) => void

/* ---------- 文件监控器（轮询模式） ---------- */
export class FileWatcher {
  private watchedDirs = new Map<string, WatchedDirInfo>()
  private callbacks: FileEventCallback[] = []
  private running = false
  private paused = false
  private timer: NodeJS.Timeout | null = null
  private pollInterval = 1.0
  private fileCache = new Map<string, number>()

  addWatch(directory: string, name?: string): boolean {
    if (!this.isDir(directory)) {
      logger.warning(`监控目录不存在或不是目录: ${directory}`)
      return false
    }
    const dirKey = this.normalize(directory)
    if (this.watchedDirs.has(dirKey)) {
      logger.info(`目录已在监控中: ${directory}`)
      return true
    }
    this.watchedDirs.set(dirKey, {
      name: name ?? this.baseName(directory),
      path: dirKey,
      enabled: true
    })
    this.loadFileCache(dirKey)
    logger.info(`已添加监控目录: ${name ?? directory}`)
    return true
  }

  removeWatch(directory: string): boolean {
    const dirKey = this.normalize(directory)
    if (this.watchedDirs.delete(dirKey)) {
      logger.info(`已移除监控目录: ${directory}`)
      return true
    }
    return false
  }

  addCallback(callback: FileEventCallback): void {
    this.callbacks.push(callback)
  }

  removeCallback(callback: FileEventCallback): void {
    const idx = this.callbacks.indexOf(callback)
    if (idx >= 0) this.callbacks.splice(idx, 1)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.paused = false
    this.timer = setInterval(() => this.monitorTick(), this.pollInterval * 1000)
    logger.info('文件监控器已启动')
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    logger.info('文件监控器已停止')
  }

  pause(): void {
    this.paused = true
    logger.info('文件监控器已暂停')
  }

  resume(): void {
    this.paused = false
    logger.info('文件监控器已恢复')
  }

  setPollInterval(interval: number): void {
    this.pollInterval = Math.max(0.1, interval)
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = setInterval(() => this.monitorTick(), this.pollInterval * 1000)
    }
  }

  get watchedDirectories(): WatchedDirInfo[] {
    return [...this.watchedDirs.values()]
  }

  get isRunning(): boolean {
    return this.running
  }

  get isPaused(): boolean {
    return this.paused
  }

  /* ---- 内部实现 ---- */

  private normalize(directory: string): string {
    return directory.replace(/[\\/]+$/, '')
  }

  private baseName(directory: string): string {
    const parts = directory.split(/[\\/]/).filter(Boolean)
    return parts[parts.length - 1] ?? directory
  }

  private isDir(directory: string): boolean {
    try {
      return statSync(directory).isDirectory()
    } catch {
      return false
    }
  }

  private loadFileCache(dirKey: string): void {
    fs.readdir(dirKey, { withFileTypes: true })
      .then((entries) => {
        for (const entry of entries) {
          if (entry.isFile()) {
            fs.stat(join(dirKey, entry.name))
              .then((s) => this.fileCache.set(`${dirKey}/${entry.name}`, s.mtimeMs))
              .catch(() => undefined)
          }
        }
      })
      .catch((err) => logger.error(`加载文件缓存失败: ${dirKey}, 错误: ${(err as Error).message}`))
  }

  private monitorTick(): void {
    if (this.paused) return
    for (const [dirKey, dirInfo] of this.watchedDirs.entries()) {
      if (!dirInfo.enabled) continue
      this.scanDirectory(dirKey)
    }
  }

  private async scanDirectory(dirKey: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dirKey, { withFileTypes: true })
    } catch (err) {
      logger.warning(`监控目录权限不足: ${dirKey}, 错误: ${(err as Error).message}`)
      return
    }

    const currentFiles = new Map<string, number>()
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const fileKey = `${dirKey}/${entry.name}`
      let mtime = 0
      try {
        mtime = (await fs.stat(join(dirKey, entry.name))).mtimeMs
      } catch {
        continue
      }
      currentFiles.set(fileKey, mtime)
      const cached = this.fileCache.get(fileKey)
      if (cached === undefined) {
        this.notify({ event_type: 'created', path: fileKey, timestamp: Date.now() / 1000 })
      } else if (cached < mtime) {
        this.notify({ event_type: 'modified', path: fileKey, timestamp: Date.now() / 1000 })
      }
    }

    for (const fileKey of this.fileCache.keys()) {
      if (fileKey.startsWith(`${dirKey}/`) && !currentFiles.has(fileKey)) {
        this.notify({ event_type: 'deleted', path: fileKey, timestamp: Date.now() / 1000 })
      }
    }

    for (const [fileKey, mtime] of currentFiles.entries()) this.fileCache.set(fileKey, mtime)
  }

  private notify(event: FileEvent): void {
    for (const callback of this.callbacks) {
      try {
        callback(event)
      } catch (err) {
        logger.error(`回调执行失败: ${(err as Error).message}`)
      }
    }
  }
}

/* ---------- 常用目录获取 ---------- */
export function getDesktopDirectory(): string {
  return join(homedir(), 'Desktop')
}

export function getDownloadsDirectory(): string {
  return join(homedir(), 'Downloads')
}

export function getDocumentsDirectory(): string {
  return join(homedir(), 'Documents')
}

/* ---------- 全局单例 ---------- */
let watcherInstance: FileWatcher | null = null

export function getFileWatcher(): FileWatcher {
  if (!watcherInstance) {
    watcherInstance = new FileWatcher()
    watcherInstance.addWatch(getDesktopDirectory(), '桌面')
    watcherInstance.addWatch(getDownloadsDirectory(), '下载')
  }
  return watcherInstance
}
