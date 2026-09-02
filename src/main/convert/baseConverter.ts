/* ============================================
 * 转换器基类（移植自 ck 06_格式转换引擎/convert_engine.py BaseConverter）
 * 保留：格式映射声明、convert 抽象、supports/路由辅助，
 *       以及「内置工具优先（resources/tools）→ 系统 PATH」的解析逻辑。
 * ============================================ */

import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, statSync, mkdirSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { getLogger } from '../tools/logger.ts'
import type { ConversionResult, FormatMap } from './types.ts'

const logger = getLogger('convert.base')

/** 规范化格式串：转小写并确保以点开头 */
export function normFormat(f: string): string {
  const s = f.toLowerCase().trim()
  return s.startsWith('.') ? s : `.${s}`
}

/** 安全读取文件大小（不存在返回 0） */
export function safeSize(p: string): number {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

export abstract class BaseConverter {
  abstract name: string
  abstract formatMap: FormatMap
  abstract isAvailable(): boolean
  abstract convert(
    sourcePath: string,
    targetFormat: string,
    outputDir?: string,
    quality?: string,
    kwargs?: Record<string, unknown>
  ): Promise<ConversionResult>

  supports(sourceFormat: string, targetFormat: string): boolean {
    const s = sourceFormat.toLowerCase()
    const t = targetFormat.toLowerCase()
    return s in this.formatMap && this.formatMap[s].includes(t)
  }

  getSupportedSources(): string[] {
    return Object.keys(this.formatMap)
  }

  getSupportedTargets(sourceFormat: string): string[] {
    return this.formatMap[sourceFormat.toLowerCase()] ?? []
  }

  /** 确保输出目录存在，返回实际输出目录 */
  protected ensureOutputDir(sourcePath: string, outputDir?: string): string {
    const dir = outputDir ?? dirname(sourcePath)
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* ignore */
    }
    return dir
  }

  protected getOutputPath(sourcePath: string, targetFormat: string, outputDir: string): string {
    return join(outputDir, `${parse(sourcePath).name}${targetFormat}`)
  }

  /* ---- 工具解析：内置 resources/tools 优先，回退系统 PATH ---- */

  protected getBundledToolsDir(): string {
    const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
    return join(base, 'resources', 'tools')
  }

  protected resolveBundledTool(toolName: string): string {
    const dir = this.getBundledToolsDir()
    const suffixes = process.platform === 'win32' ? ['.exe', '.bat', '.cmd'] : ['']
    for (const s of suffixes) {
      const c = join(dir, toolName + s)
      if (existsSync(c)) return c
    }
    const sub = join(dir, toolName, toolName)
    for (const s of suffixes) {
      const c = sub + s
      if (existsSync(c)) return c
    }
    const bin = join(dir, 'bin', toolName)
    for (const s of suffixes) {
      const c = bin + s
      if (existsSync(c)) return c
    }
    // LibreOffice：soffice.exe 位于 <tools>/soffice/program/ 下（内置便携布局）
    const prog = join(dir, toolName, 'program', toolName)
    for (const s of suffixes) {
      const c = prog + s
      if (existsSync(c)) return c
    }
    return ''
  }

  /** 系统 PATH 中查找可执行文件 */
  protected which(toolName: string): string {
    const pathEnv = process.env.PATH ?? ''
    const sep = process.platform === 'win32' ? ';' : ':'
    const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
    for (const dir of pathEnv.split(sep)) {
      for (const s of suffixes) {
        const c = join(dir, toolName + s)
        if (c && existsSync(c)) return c
      }
    }
    return ''
  }

  protected checkToolAvailable(tool: string): boolean {
    if (this.resolveBundledTool(tool)) return true
    return this.which(tool) !== ''
  }

  /** 返回可执行完整路径；内置优先，否则返回工具名（交由系统 PATH 解析） */
  protected getToolPath(tool: string): string {
    const bundled = this.resolveBundledTool(tool)
    return bundled || tool
  }

  /** 执行命令（windowsHide，超时强杀）；返回 [成功, 错误信息] */
  protected runCommand(cmd: string[], timeout = 300): Promise<[boolean, string]> {
    return new Promise((resolve) => {
      let done = false
      const timer = setTimeout(() => {
        if (!done) {
          done = true
          try {
            child.kill('SIGKILL')
          } catch {
            /* ignore */
          }
          resolve([false, `转换超时(${timeout}秒)`])
        }
      }, timeout * 1000)

      const child = spawn(cmd[0], cmd.slice(1), { windowsHide: true })
      let stderr = ''
      child.stdout?.on('data', (d) => d.toString())
      child.stderr?.on('data', (d) => {
        stderr += d.toString()
      })
      child.on('error', (err) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve([false, `工具未安装或执行失败: ${err.message}`])
      })
      child.on('close', (code) => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (code === 0) resolve([true, ''])
        else resolve([false, stderr.trim() || `命令返回码: ${code}`])
      })
    })
  }
}

export { logger }
