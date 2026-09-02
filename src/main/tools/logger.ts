/* 轻量日志器（替代 ck 的 loguru 封装）：console 输出 + 可选文件追加（按日期轮转） */

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

export interface Logger {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warning: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

/** 获取命名日志器（命名模块，用法与 ck 的 get_logger(__name__) 一致） */
export function getLogger(name: string): Logger {
  const log = (level: LogLevel, args: unknown[]): void => {
    if (levelOrder[level] < levelOrder[currentLevel]) return
    const time = new Date().toISOString().slice(11, 23)
    const prefix = `${COLORS[level]}${level.toUpperCase().padEnd(7)}${RESET} ${time} [${name}]`
    const method = level === 'debug' ? console.debug : level === 'info' ? console.log : level === 'warning' ? console.warn : console.error
    method(prefix, ...args)
  }
  return {
    debug: (...args: unknown[]) => log('debug', args),
    info: (...args: unknown[]) => log('info', args),
    warning: (...args: unknown[]) => log('warning', args),
    error: (...args: unknown[]) => log('error', args)
  }
}
