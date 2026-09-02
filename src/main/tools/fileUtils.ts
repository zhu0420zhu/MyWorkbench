/* ============================================
 * 文件工具模块（由 ck 08_工具集/file_utils.py 移植为 TypeScript）
 * 提供：文件类型分类、扫描、安全重命名、批量重命名、移动、
 *       断点续传复制、删除（回收站）、哈希计算、文件信息、大小格式化
 * ============================================ */

import { createHash } from 'node:crypto'
import { promises as fs, type Stats } from 'node:fs'
import { join, basename, extname, dirname, parse } from 'node:path'
import { getLogger } from './logger.ts'

const logger = getLogger('fileUtils')

/* ---------- 文件类型定义（REQ-02-01 后缀规则分类） ---------- */
export const FILE_TYPE_CATEGORIES: Record<string, string[]> = {
  documents: [
    '.txt', '.md', '.docx', '.doc', '.pdf', '.rtf', '.odt',
    '.xlsx', '.xls', '.csv', '.ods',
    '.pptx', '.ppt', '.odp'
  ],
  images: [
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.webp',
    '.svg', '.ico', '.heic', '.heif'
  ],
  videos: [
    '.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.webm',
    '.m4v', '.mpeg', '.mpg', '.ts'
  ],
  audio: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma', '.m4a'],
  archives: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz'],
  code: [
    '.py', '.js', '.ts', '.html', '.css', '.json', '.xml',
    '.go', '.rust', '.java', '.cpp', '.c', '.h', '.sql'
  ],
  executables: ['.exe', '.msi', '.dll', '.bat', '.cmd'],
  temp: ['.tmp', '.temp', '.bak', '.swp', '.swo']
}

export function getFileCategory(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  for (const [category, extensions] of Object.entries(FILE_TYPE_CATEGORIES)) {
    if (extensions.includes(ext)) return category
  }
  return 'other'
}

export function getFileCategoryName(category: string): string {
  const names: Record<string, string> = {
    documents: '文档',
    images: '图片',
    videos: '视频',
    audio: '音频',
    archives: '压缩包',
    code: '代码',
    executables: '可执行文件',
    temp: '临时文件',
    other: '其他'
  }
  return names[category] ?? category
}

/* ---------- 文件信息 ---------- */
export interface FileInfo {
  path: string
  relative_path: string
  name: string
  stem: string
  extension: string
  size: number
  category: string
  created: number
  modified: number
  accessed: number
}

function statInfo(stat: Stats): Pick<FileInfo, 'created' | 'modified' | 'accessed'> {
  return {
    created: stat.birthtimeMs / 1000,
    modified: stat.mtimeMs / 1000,
    accessed: stat.atimeMs / 1000
  }
}

/* ---------- 文件扫描与遍历（REQ-01-01） ---------- */
export interface ScanOptions {
  recursive?: boolean
  includeExtensions?: string[]
  excludeExtensions?: string[]
  excludeDirs?: string[]
  minSize?: number
  maxSize?: number
}

/** 扫描目录获取文件列表（ck 的生成器 → 异步数组） */
export async function scanDirectory(rootDir: string, opts: ScanOptions = {}): Promise<FileInfo[]> {
  const {
    recursive = true,
    includeExtensions,
    excludeExtensions,
    excludeDirs,
    minSize,
    maxSize
  } = opts

  const results: FileInfo[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      logger.warning(`扫描目录失败: ${dir}, 错误: ${(err as Error).message}`)
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      try {
        if (entry.isDirectory()) {
          if (recursive) await walk(full, depth + 1)
          continue
        }
        if (!entry.isFile()) continue

        // 排除目录检查
        if (excludeDirs && excludeDirs.length > 0) {
          const rel = full.slice(rootDir.length).split(/[\\/]/)
          if (rel.some((part) => excludeDirs.includes(part))) continue
        }

        // 后缀过滤
        const ext = extname(full).toLowerCase()
        if (includeExtensions && !includeExtensions.includes(ext)) continue
        if (excludeExtensions && excludeExtensions.includes(ext)) continue

        // 大小过滤
        let size = 0
        try {
          size = (await fs.stat(full)).size
        } catch {
          size = 0
        }
        if (minSize !== undefined && size < minSize) continue
        if (maxSize !== undefined && size > maxSize) continue

        const stat = await fs.stat(full)
        results.push({
          path: full,
          relative_path: full.slice(rootDir.length).replace(/^[\\/]/, ''),
          name: entry.name,
          stem: parse(entry.name).name,
          extension: ext,
          size,
          category: getFileCategory(full),
          ...statInfo(stat)
        })
      } catch (err) {
        logger.warning(`跳过无法访问的条目: ${full}, 错误: ${(err as Error).message}`)
      }
    }
  }

  try {
    if (await fs.stat(rootDir).then((s) => !s.isDirectory()).catch(() => true)) {
      logger.warning(`扫描目录不存在: ${rootDir}`)
      return results
    }
    await walk(rootDir, 0)
  } catch (err) {
    logger.error(`扫描目录出错: ${rootDir}, 错误: ${(err as Error).message}`)
  }
  return results
}

/* ---------- 文件重命名（REQ-01-03） ---------- */
/** 安全重命名：目标名冲突时自动加序号 */
export async function safeRename(source: string, newName: string): Promise<boolean> {
  try {
    await fs.access(source)
  } catch {
    logger.warning(`重命名: 源文件不存在: ${source}`)
    return false
  }

  const destDir = dirname(source)
  let newPath = join(destDir, newName)

  if (newPath !== source) {
    let exists = false
    try {
      await fs.access(newPath)
      exists = true
    } catch {
      exists = false
    }
    if (exists) {
      const { name, ext } = parse(newPath)
      let counter = 1
      do {
        newPath = join(destDir, `${name}_${counter}${ext}`)
        counter++
        try {
          await fs.access(newPath)
          exists = true
        } catch {
          exists = false
        }
      } while (exists)
    }
  }

  try {
    await fs.rename(source, newPath)
    logger.info(`文件重命名: ${source} -> ${newPath}`)
    return true
  } catch (err) {
    logger.error(`重命名失败: ${source} -> ${newName}, 错误: ${(err as Error).message}`)
    return false
  }
}

export interface RenameResult {
  original: string
  new: string | null
  success: boolean
  error: string | null
}

/** 批量重命名：模板支持 {index} {date} {name} {ext} 占位符 */
export async function batchRename(files: string[], template: string): Promise<RenameResult[]> {
  const results: RenameResult[] = []
  for (let idx = 0; idx < files.length; idx++) {
    const filePath = files[idx]
    let stat
    try {
      stat = await fs.stat(filePath)
    } catch {
      results.push({ original: filePath, new: null, success: false, error: '文件不存在' })
      continue
    }

    let newName = template
      .replaceAll('{index}', String(idx + 1))
      .replaceAll('{date}', String(Math.floor(stat.mtimeMs / 1000)))
      .replaceAll('{name}', parse(filePath).name)
      .replaceAll('{ext}', extname(filePath))

    const ext = extname(filePath)
    if (!newName.endsWith(ext)) newName += ext

    const success = await safeRename(filePath, newName)
    results.push({
      original: filePath,
      new: success ? join(dirname(filePath), newName) : null,
      success,
      error: success ? null : '重命名失败'
    })
  }
  return results
}

/* ---------- 文件移动与断点续传（REQ-01-04） ---------- */
export interface MoveResult {
  success: boolean
  error?: string
  source?: string
  destination?: string
}

export async function moveFile(
  source: string,
  destDir: string,
  overwrite = false
): Promise<MoveResult> {
  try {
    await fs.access(source)
  } catch {
    return { success: false, error: '源文件不存在' }
  }

  try {
    await fs.mkdir(destDir, { recursive: true })
  } catch (err) {
    return { success: false, error: `创建目录失败: ${(err as Error).message}` }
  }

  const destFile = join(destDir, basename(source))

  let destExists = false
  try {
    await fs.access(destFile)
    destExists = true
  } catch {
    destExists = false
  }

  if (destExists) {
    if (overwrite) {
      try {
        await fs.unlink(destFile)
      } catch (err) {
        return { success: false, error: `无法覆盖目标文件: ${(err as Error).message}` }
      }
    } else {
      return { success: false, error: '目标文件已存在' }
    }
  }

  try {
    await fs.rename(source, destFile)
    logger.info(`文件移动: ${source} -> ${destFile}`)
    return { success: true, source, destination: destFile }
  } catch (err) {
    logger.error(`文件移动失败: ${source} -> ${destDir}, 错误: ${(err as Error).message}`)
    return { success: false, error: (err as Error).message }
  }
}

export interface CopyResult {
  success: boolean
  error?: string
  source?: string
  destination?: string
  bytes_written?: number
  total_size?: number
}

/** 断点续传复制：目标已存在且小于源文件时从断点继续 */
export async function copyFileResumable(
  source: string,
  dest: string,
  chunkSize = 1024 * 1024
): Promise<CopyResult> {
  let sourceSize: number
  try {
    sourceSize = (await fs.stat(source)).size
  } catch {
    return { success: false, error: '源文件不存在' }
  }

  let bytesWritten = 0
  try {
    bytesWritten = (await fs.stat(dest)).size
  } catch {
    bytesWritten = 0
  }

  if (bytesWritten >= sourceSize) {
    logger.info(`文件已存在且完整: ${dest}`)
    return { success: true, bytes_written: sourceSize, total_size: sourceSize }
  }

  try {
    const handle = await fs.open(source, 'r')
    const destHandle = await fs.open(dest, 'a')
    const buf = Buffer.alloc(chunkSize)
    let position = bytesWritten
    try {
      while (position < sourceSize) {
        const { bytesRead } = await handle.read(buf, 0, chunkSize, position)
        if (bytesRead === 0) break
        // dest 以追加模式打开且已含 bytesWritten 字节，写入偏移相对其末尾
        await destHandle.write(buf.subarray(0, bytesRead), 0, bytesRead, position - bytesWritten)
        position += bytesRead
      }
    } finally {
      await handle.close()
      await destHandle.close()
    }

    logger.info(`文件复制完成: ${source} -> ${dest}, 大小: ${sourceSize}`)
    return {
      success: true,
      source,
      destination: dest,
      bytes_written: position,
      total_size: sourceSize
    }
  } catch (err) {
    logger.error(`文件复制失败: ${source} -> ${dest}, 错误: ${(err as Error).message}`)
    return { success: false, error: (err as Error).message, bytes_written: bytesWritten, total_size: sourceSize }
  }
}

/* ---------- 文件删除（安全删除） ---------- */
/** 删除文件：sendToTrash=true 走回收站（Electron shell.trashItem），失败回退永久删除 */
export async function deleteFile(filePath: string, sendToTrash = true): Promise<boolean> {
  try {
    await fs.access(filePath)
  } catch {
    logger.warning(`删除: 文件不存在: ${filePath}`)
    return false
  }

  try {
    if (sendToTrash) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { shell } = require('electron') as typeof import('electron')
        if (shell?.trashItem) {
          await shell.trashItem(filePath)
          logger.info(`文件移入回收站: ${filePath}`)
          return true
        }
      } catch {
        // Electron 不可用（如纯 node 测试环境）→ 回退永久删除
      }
    }
    await fs.unlink(filePath)
    logger.info(`文件删除: ${filePath}`)
    return true
  } catch (err) {
    logger.error(`文件删除失败: ${filePath}, 错误: ${(err as Error).message}`)
    return false
  }
}

export interface DeleteResult {
  path: string
  success: boolean
  error: string | null
}

export async function batchDelete(files: string[], sendToTrash = true): Promise<DeleteResult[]> {
  const results: DeleteResult[] = []
  for (const filePath of files) {
    const success = await deleteFile(filePath, sendToTrash)
    results.push({ path: filePath, success, error: success ? null : '删除失败' })
  }
  return results
}

/* ---------- 文件哈希计算（REQ-03-02） ---------- */
export async function computeFileHash(filePath: string, hashType: 'md5' | 'sha256' = 'md5'): Promise<string | null> {
  try {
    const hash = createHash(hashType)
    const buf = Buffer.alloc(8192)
    const handle = await fs.open(filePath, 'r')
    try {
      let position = 0
      for (;;) {
        const { bytesRead } = await handle.read(buf, 0, buf.length, position)
        if (bytesRead === 0) break
        hash.update(buf.subarray(0, bytesRead))
        position += bytesRead
      }
    } finally {
      await handle.close()
    }
    return hash.digest('hex')
  } catch (err) {
    logger.error(`计算文件哈希失败: ${filePath}, 错误: ${(err as Error).message}`)
    return null
  }
}

/* ---------- 文件信息获取 ---------- */
export interface FileDetail {
  path: string
  name: string
  stem: string
  extension: string
  size: number
  category: string
  created: number
  modified: number
  accessed: number
  is_file: boolean
  is_dir: boolean
}

export async function getFileInfo(filePath: string): Promise<FileDetail | null> {
  try {
    const stat = await fs.stat(filePath)
    return {
      path: filePath,
      name: basename(filePath),
      stem: parse(filePath).name,
      extension: extname(filePath),
      size: stat.size,
      category: getFileCategory(filePath),
      ...statInfo(stat),
      is_file: stat.isFile(),
      is_dir: stat.isDirectory()
    }
  } catch (err) {
    logger.error(`获取文件信息失败: ${filePath}, 错误: ${(err as Error).message}`)
    return null
  }
}

export function formatFileSize(bytesSize: number): string {
  if (bytesSize < 1024) return `${bytesSize} B`
  if (bytesSize < 1024 * 1024) return `${(bytesSize / 1024).toFixed(2)} KB`
  if (bytesSize < 1024 * 1024 * 1024) return `${(bytesSize / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytesSize / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
