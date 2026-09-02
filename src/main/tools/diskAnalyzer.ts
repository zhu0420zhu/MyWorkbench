/* ============================================
 * 磁盘空间分析模块（由 ck 08_工具集/disk_analyzer.py 移植为 TypeScript）
 * 提供：磁盘容量信息、目录占用分析、大文件扫描、类型/后缀分布统计
 * ============================================ */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { statfsSync, accessSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { join, extname } from 'node:path'
import { getLogger } from './logger.ts'
import { getFileCategory, formatFileSize } from './fileUtils.ts'

const logger = getLogger('diskAnalyzer')
// 关键：磁盘信息走 PowerShell 子进程，绝不能 execFileSync 阻塞主进程事件循环
const execFileAsync = promisify(execFile)

/* ---------- 磁盘信息 ---------- */
export interface DiskInfoDict {
  path: string
  total: number
  used: number
  free: number
  percent_used: number
  total_formatted: string
  used_formatted: string
  free_formatted: string
}

/** Windows：通过 PowerShell Get-PSDrive 获取单个卷的容量（字节，异步不阻塞主进程） */
async function getVolumeByPowerShell(root: string): Promise<{ total: number; free: number } | null> {
  try {
    const script =
      `$d = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -eq '${root.replace(/'/g, "''")}' } | ` +
      `Select-Object @{n='Total';e={$_.Used + $_.Free}}, Free; ` +
      `if ($d) { $d | ConvertTo-Json -Compress } else { 'null' }`
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true
    })
    const out = stdout.trim()
    if (!out || out === 'null') return null
    const parsed = JSON.parse(out)
    return { total: Number(parsed.Total ?? 0), free: Number(parsed.Free ?? 0) }
  } catch (err) {
    logger.warning(`PowerShell 获取磁盘信息失败: ${root}, 错误: ${(err as Error).message}`)
    return null
  }
}

/** POSIX：fs.statfs 获取容量 */
function getVolumeByStatfs(root: string): { total: number; free: number } | null {
  try {
    const s = statfsSync(root)
    return { total: s.bsize * s.blocks, free: s.bsize * s.bavail }
  } catch (err) {
    logger.warning(`statfs 获取磁盘信息失败: ${root}, 错误: ${(err as Error).message}`)
    return null
  }
}

export async function getDiskInfo(path: string): Promise<DiskInfoDict> {
  const info = { path, total: 0, used: 0, free: 0, percent_used: 0 }
  let vol: { total: number; free: number } | null = null
  if (process.platform === 'win32') {
    vol = await getVolumeByPowerShell(path.endsWith('\\') ? path : path + '\\')
    if (!vol) vol = getVolumeByStatfs(path) // PowerShell 失败时尝试 statfs
  } else {
    vol = getVolumeByStatfs(path)
  }
  if (vol) {
    info.total = vol.total
    info.free = vol.free
    info.used = vol.total - vol.free
    if (info.total > 0) info.percent_used = (info.used / info.total) * 100
  }
  return {
    ...info,
    percent_used: Math.round(info.percent_used * 100) / 100,
    total_formatted: formatFileSize(info.total),
    used_formatted: formatFileSize(info.used),
    free_formatted: formatFileSize(info.free)
  }
}

/** Windows：列出所有本地磁盘；POSIX：常见挂载点（各卷并行查询，避免 N×15s 串行阻塞） */
export async function getAllDisks(): Promise<DiskInfoDict[]> {
  const disks: DiskInfoDict[] = []
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object { $_.Root }"
        ],
        { encoding: 'utf8', timeout: 15000, windowsHide: true }
      )
      const roots: string[] = []
      for (const line of stdout.split(/\r?\n/)) {
        const root = line.trim()
        if (root && /^[A-Za-z]:\\?$/.test(root)) roots.push(root)
      }
      // 并行获取各卷容量，而非逐个 await（串行会按盘数累积 PowerShell 启动耗时）
      disks.push(...(await Promise.all(roots.map((r) => getDiskInfo(r)))))
    } catch (err) {
      logger.warning(`列出磁盘失败: ${(err as Error).message}`)
    }
    // PowerShell 无结果时兜底 C 盘
    if (disks.length === 0) disks.push(await getDiskInfo('C:\\'))
  } else {
    for (const mp of ['/', '/home', '/var']) {
      try {
        accessSync(mp)
        disks.push(await getDiskInfo(mp))
      } catch {
        /* 挂载点不存在则跳过 */
      }
    }
  }
  return disks
}

/* ---------- 目录占用分析器 ---------- */
export interface StatEntry {
  count: number
  size: number
}

export interface CategoryStat {
  category: string
  count: number
  size: number
  size_formatted: string
  percent: number
}

export interface ExtensionStat {
  extension: string
  count: number
  size: number
  size_formatted: string
  percent: number
}

export interface LargeFile {
  path: string
  name: string
  size: number
  size_formatted: string
  modified: number
}

export interface DirectoryAnalysis {
  directory: string
  total_size: number
  total_size_formatted: string
  category_stats: CategoryStat[]
  extension_stats: ExtensionStat[]
  large_files: LargeFile[]
  large_file_count: number
}

export class DirectoryAnalyzer {
  private categoryStats: Record<string, StatEntry> = {}
  private extensionStats: Record<string, StatEntry> = {}
  private largeFiles: LargeFile[] = []

  async analyze(
    directory: string,
    recursive = true,
    minSizeLarge = 1024 * 1024 * 50
  ): Promise<DirectoryAnalysis> {
    logger.info(`开始分析目录: ${directory}, 递归=${recursive}`)
    this.categoryStats = {}
    this.extensionStats = {}
    this.largeFiles = []

    const totalSize = await this.scanDirectory(directory, recursive, minSizeLarge)
    this.largeFiles.sort((a, b) => b.size - a.size)
    logger.info(`分析完成: 总大小=${formatFileSize(totalSize)}`)

    return {
      directory,
      total_size: totalSize,
      total_size_formatted: formatFileSize(totalSize),
      category_stats: this.getCategoryStats(),
      extension_stats: this.getExtensionStats(),
      large_files: this.largeFiles,
      large_file_count: this.largeFiles.length
    }
  }

  private async scanDirectory(directory: string, recursive: boolean, minSizeLarge: number): Promise<number> {
    let totalSize = 0
    const walk = async (dir: string): Promise<number> => {
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (err) {
        logger.warning(`无法访问目录: ${dir}, 错误: ${(err as Error).message}`)
        return 0
      }
      let sum = 0
      for (const entry of entries) {
        const full = join(dir, entry.name)
        try {
          if (entry.isFile()) {
            const stat = await fs.stat(full)
            const fileSize = stat.size
            sum += fileSize
            if (fileSize >= minSizeLarge) {
              this.largeFiles.push({
                path: full,
                name: entry.name,
                size: fileSize,
                size_formatted: formatFileSize(fileSize),
                modified: stat.mtimeMs / 1000
              })
            }
            const category = getFileCategory(full)
            this.updateStats(this.categoryStats, category, fileSize)
            const ext = extname(full).toLowerCase()
            this.updateStats(this.extensionStats, ext, fileSize)
          } else if (entry.isDirectory() && recursive) {
            sum += await walk(full)
          }
        } catch (err) {
          logger.warning(`跳过条目: ${full}, 错误: ${(err as Error).message}`)
        }
      }
      return sum
    }
    try {
      const rootStat = await fs.stat(directory).catch(() => null)
      if (!rootStat || !rootStat.isDirectory()) {
        logger.warning(`分析目录不存在: ${directory}`)
        return 0
      }
      totalSize = await walk(directory)
    } catch (err) {
      logger.error(`扫描目录出错: ${directory}, 错误: ${(err as Error).message}`)
    }
    return totalSize
  }

  private updateStats(store: Record<string, StatEntry>, key: string, size: number): void {
    if (!store[key]) store[key] = { count: 0, size: 0 }
    store[key].count += 1
    store[key].size += size
  }

  private getCategoryStats(): CategoryStat[] {
    const totalSize = Object.values(this.categoryStats).reduce((s, v) => s + v.size, 0)
    const result: CategoryStat[] = Object.entries(this.categoryStats).map(([category, stats]) => {
      const percent = totalSize > 0 ? (stats.size / totalSize) * 100 : 0
      return {
        category,
        count: stats.count,
        size: stats.size,
        size_formatted: formatFileSize(stats.size),
        percent: Math.round(percent * 100) / 100
      }
    })
    result.sort((a, b) => b.size - a.size)
    return result
  }

  private getExtensionStats(): ExtensionStat[] {
    const totalSize = Object.values(this.extensionStats).reduce((s, v) => s + v.size, 0)
    const result: ExtensionStat[] = Object.entries(this.extensionStats).map(([extension, stats]) => {
      const percent = totalSize > 0 ? (stats.size / totalSize) * 100 : 0
      return {
        extension,
        count: stats.count,
        size: stats.size,
        size_formatted: formatFileSize(stats.size),
        percent: Math.round(percent * 100) / 100
      }
    })
    result.sort((a, b) => b.size - a.size)
    return result
  }
}

/* ---------- 磁盘分析器 ---------- */
export class DiskAnalyzer {
  private diskInfoCache = new Map<string, DiskInfoDict>()

  async getDiskInfo(path: string): Promise<DiskInfoDict> {
    const key = path.endsWith('\\') || path.endsWith('/') ? path : path + (process.platform === 'win32' ? '\\' : '/')
    if (!this.diskInfoCache.has(key)) this.diskInfoCache.set(key, await getDiskInfo(key))
    return this.diskInfoCache.get(key) as DiskInfoDict
  }

  getAllDisks(): Promise<DiskInfoDict[]> {
    return getAllDisks()
  }

  analyzeDirectory(directory: string, recursive = true, minSizeLarge = 1024 * 1024 * 50): Promise<DirectoryAnalysis> {
    const analyzer = new DirectoryAnalyzer()
    return analyzer.analyze(directory, recursive, minSizeLarge)
  }

  async findLargeFiles(directory: string, minSize = 1024 * 1024 * 50, limit = 50): Promise<LargeFile[]> {
    const analyzer = new DirectoryAnalyzer()
    const result = await analyzer.analyze(directory, true, minSize)
    return result.large_files.slice(0, limit)
  }
}

/* ---------- 全局单例 ---------- */
let diskAnalyzer: DiskAnalyzer | null = null

export function getDiskAnalyzer(): DiskAnalyzer {
  if (!diskAnalyzer) diskAnalyzer = new DiskAnalyzer()
  return diskAnalyzer
}
