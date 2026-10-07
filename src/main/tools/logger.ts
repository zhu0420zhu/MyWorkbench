/* 轻量日志器：console 输出 + userData/logs 按日文件追加与轮转 */
import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'

export type LogLevel = 'debug' | 'info' | 'warning' | 'error'

const levelOrder: Record<LogLevel, number> = { debug: 10, info: 20, warning: 30, error: 40 }

let currentLevel: LogLevel = 'info'

export function setLogLevel(level: LogLevel): void {
  currentLevel = level
}

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warning: '\x1b[33m',
  error: '\x1b[31m'
}
const RESET = '\x1b[0m'

/** 保留最近 N 天日志文件 */
const KEEP_DAYS = 7
let fileQueue: Promise<void> = Promise.resolve()
let fileReady = false

function logDir(): string {
  return join(app.getPath('userData'), 'logs')
}

function dayStamp(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function logFile(): string {
  return join(logDir(), `main-${dayStamp()}.log`)
}

async function pruneOldLogs(): Promise<void> {
  try {
    const names = await fs.readdir(logDir())
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000
    for (const name of names) {
      if (!name.startsWith('main-') || !name.endsWith('.log')) continue
      const full = join(logDir(), name)
      try {
        const st = await fs.stat(full)
        if (st.mtimeMs < cutoff) await fs.unlink(full)
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function appendFileLine(line: string): void {
  fileQueue = fileQueue
    .then(async () => {
      if (!fileReady) {
        await fs.mkdir(logDir(), { recursive: true })
        await pruneOldLogs()
        fileReady = true
      }
      await fs.appendFile(logFile(), line + '\n', 'utf-8')
    })
    .catch(() => {
      /* 文件日志失败不影响主流程 */
    })
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return a.stack || a.message
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
}

export interface Logger {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warning: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

/** 获取命名日志器 */
export function getLogger(name: string): Logger {
  const log = (level: LogLevel, args: unknown[]): void => {
    if (levelOrder[level] < levelOrder[currentLevel]) return
    const iso = new Date().toISOString()
    const time = iso.slice(11, 23)
    const prefix = `${COLORS[level]}${level.toUpperCase().padEnd(7)}${RESET} ${time} [${name}]`
    const method =
      level === 'debug' ? console.debug : level === 'info' ? console.log : level === 'warning' ? console.warn : console.error
    method(prefix, ...args)
    appendFileLine(`${iso} ${level.toUpperCase().padEnd(7)} [${name}] ${formatArgs(args)}`)
  }
  return {
    debug: (...args: unknown[]) => log('debug', args),
    info: (...args: unknown[]) => log('info', args),
    warning: (...args: unknown[]) => log('warning', args),
    error: (...args: unknown[]) => log('error', args)
  }
}

/** 主进程全局异常兜底：写入文件日志（打包后可查 userData/logs/） */
export function installGlobalErrorHandlers(): void {
  process.on('uncaughtException', (err) => {
    getLogger('uncaughtException').error(err)
  })
  process.on('unhandledRejection', (reason) => {
    getLogger('unhandledRejection').error(reason)
  })
}
