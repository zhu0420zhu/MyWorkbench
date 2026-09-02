/* ============================================
 * 重复文件检测模块（由 ck 08_工具集/duplicate_detector.py 移植为 TypeScript）
 * 三层查重：大小分组 → MD5/SHA 完全重复 → 采样指纹汉明相似度
 * 支持保留策略（最新/最早/最短路径/最小）与节省空间计算
 * ============================================ */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, basename } from 'node:path'
import { getLogger } from './logger.ts'
import { computeFileHash } from './fileUtils.ts'

const logger = getLogger('duplicateDetector')

/* ---------- 重复文件组 ---------- */
export class DuplicateGroup {
  files: string[]
  similarity: number
  hashValue: string | null = null
  size = 0

  constructor(files: string[], similarity = 1.0) {
    this.files = files
    this.similarity = similarity
  }

  /** 初始化时惰性读取第一个文件大小（异步） */
  async initSize(): Promise<void> {
    if (this.files.length > 0) {
      try {
        this.size = (await fs.stat(this.files[0])).size
      } catch {
        this.size = 0
      }
    }
  }

  async suggestKeep(strategy: string = 'latest'): Promise<string | null> {
    if (this.files.length === 0) return null
    const stats = new Map<string, { mtime: number; size: number }>()
    for (const f of this.files) {
      try {
        const s = await fs.stat(f)
        stats.set(f, { mtime: s.mtimeMs, size: s.size })
      } catch {
        stats.set(f, { mtime: 0, size: 0 })
      }
    }
    const byMtime = (dir: 1 | -1): string =>
      [...stats.entries()].sort((a, b) => (a[1].mtime - b[1].mtime) * dir)[0][0]

    switch (strategy) {
      case 'latest':
        return byMtime(-1)
      case 'oldest':
        return byMtime(1)
      case 'shortest_path':
        return [...this.files].sort((a, b) => a.length - b.length)[0]
      case 'smallest':
        return [...stats.entries()].sort((a, b) => a[1].size - b[1].size)[0][0]
      default:
        return byMtime(-1)
    }
  }

  getTotalSavings(): number {
    if (this.files.length <= 1) return 0
    return this.size * (this.files.length - 1)
  }
}

/* ---------- 重复文件检测器 ---------- */
export interface DuplicateScanOptions {
  recursive?: boolean
  minSize?: number
  maxSize?: number
  hashType?: 'md5' | 'sha256'
}

export class DuplicateDetector {
  private hashCache = new Map<string, string[]>()
  private sizeCache = new Map<number, string[]>()

  async scanDirectory(
    directory: string,
    opts: DuplicateScanOptions = {}
  ): Promise<DuplicateGroup[]> {
    const { recursive = true, minSize = 0, maxSize, hashType = 'md5' } = opts
    logger.info(`开始扫描重复文件: ${directory}, 递归=${recursive}, 最小大小=${minSize}`)

    this.hashCache.clear()
    this.sizeCache.clear()

    await this.groupBySize(directory, recursive, minSize, maxSize)
    const groups = await this.detectByHash(hashType)

    logger.info(`扫描完成, 发现 ${groups.length} 组重复文件`)
    return groups
  }

  /** 第一步：按文件大小分组（快速过滤） */
  private async groupBySize(
    directory: string,
    recursive: boolean,
    minSize: number,
    maxSize?: number
  ): Promise<void> {
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        try {
          if (entry.isDirectory()) {
            if (recursive) await walk(full)
            continue
          }
          if (!entry.isFile()) continue
          const size = (await fs.stat(full)).size
          if (size < minSize) continue
          if (maxSize !== undefined && size > maxSize) continue
          const list = this.sizeCache.get(size) ?? []
          list.push(full)
          this.sizeCache.set(size, list)
        } catch {
          /* 跳过无法访问的条目 */
        }
      }
    }
    try {
      await walk(directory)
    } catch (err) {
      logger.error(`按大小分组出错: ${directory}, 错误: ${(err as Error).message}`)
    }
  }

  /** 第二步：同大小文件计算哈希，检测完全重复 */
  private async detectByHash(hashType: 'md5' | 'sha256'): Promise<DuplicateGroup[]> {
    const groups: DuplicateGroup[] = []
    for (const files of this.sizeCache.values()) {
      if (files.length < 2) continue
      for (const filePath of files) {
        const fileHash = await computeFileHash(filePath, hashType)
        if (fileHash) {
          const list = this.hashCache.get(fileHash) ?? []
          list.push(filePath)
          this.hashCache.set(fileHash, list)
        }
      }
    }
    for (const [fileHash, files] of this.hashCache.entries()) {
      if (files.length >= 2) {
        const group = new DuplicateGroup(files, 1.0)
        group.hashValue = fileHash
        await group.initSize()
        groups.push(group)
      }
    }
    return groups
  }

  /** 第三步：基于内容采样指纹的相似度检测（大小不同但高度相似） */
  async detectByContentSimilarity(files: string[], threshold = 0.8): Promise<DuplicateGroup[]> {
    const groups: DuplicateGroup[] = []
    if (files.length < 2) return groups

    const fingerprints: { fp: string; files: string[] }[] = []

    for (const filePath of files) {
      const fp = await this.computeContentFingerprint(filePath)
      if (!fp) continue
      let found = false
      for (const entry of fingerprints) {
        if (this.fingerprintSimilarity(fp, entry.fp) >= threshold) {
          entry.files.push(filePath)
          found = true
          break
        }
      }
      if (!found) fingerprints.push({ fp, files: [filePath] })
    }

    for (const entry of fingerprints) {
      if (entry.files.length >= 2) {
        const group = new DuplicateGroup(entry.files, threshold)
        await group.initSize()
        groups.push(group)
      }
    }
    return groups
  }

  /** 计算文件内容指纹：采样开头/中间/结尾各 4096B 合并 MD5 */
  async computeContentFingerprint(filePath: string, sampleSize = 4096): Promise<string | null> {
    try {
      const stat = await fs.stat(filePath)
      const handle = await fs.open(filePath, 'r')
      const buf = Buffer.alloc(sampleSize)
      try {
        let head = Buffer.alloc(0)
        const { bytesRead: headRead } = await handle.read(buf, 0, sampleSize, 0)
        head = buf.subarray(0, headRead)

        let middle = Buffer.alloc(0)
        if (stat.size > sampleSize * 2) {
          const midPos = Math.floor(stat.size / 2 - sampleSize / 2)
          const mb = Buffer.alloc(sampleSize)
          const { bytesRead } = await handle.read(mb, 0, sampleSize, midPos)
          middle = mb.subarray(0, bytesRead)
        }

        let tail = Buffer.alloc(0)
        if (stat.size > sampleSize) {
          const tailPos = stat.size - sampleSize
          const tb = Buffer.alloc(sampleSize)
          const { bytesRead } = await handle.read(tb, 0, sampleSize, tailPos)
          tail = tb.subarray(0, bytesRead)
        }

        const combined = Buffer.concat([head, middle, tail])
        return createHash('md5').update(combined).digest('hex')
      } finally {
        await handle.close()
      }
    } catch (err) {
      logger.error(`计算内容指纹失败: ${filePath}, 错误: ${(err as Error).message}`)
      return null
    }
  }

  /** 指纹相似度：相同字符比例（简化汉明距离） */
  fingerprintSimilarity(fp1: string, fp2: string): number {
    if (fp1 === fp2) return 1.0
    if (fp1.length !== fp2.length) return 0.0
    let matches = 0
    for (let i = 0; i < fp1.length; i++) {
      if (fp1[i] === fp2[i]) matches++
    }
    return matches / fp1.length
  }
}

/* ---------- 快捷函数 ---------- */
export interface DuplicateResultGroup {
  files: string[]
  similarity: number
  size: number
  hash: string | null
  keep: string | null
  delete: string[]
  savings: number
}

export interface DuplicateScanResult {
  directory: string
  total_groups: number
  total_duplicates: number
  total_savings: number
  strategy: string
  groups: DuplicateResultGroup[]
}

export async function findDuplicates(
  directory: string,
  opts: DuplicateScanOptions & { strategy?: string } = {}
): Promise<DuplicateScanResult> {
  const { strategy = 'latest', ...scanOpts } = opts
  const detector = new DuplicateDetector()
  const groups = await detector.scanDirectory(directory, scanOpts)

  let totalSavings = 0
  let totalDuplicates = 0
  const resultGroups: DuplicateResultGroup[] = []

  for (const group of groups) {
    const savings = group.getTotalSavings()
    totalSavings += savings
    totalDuplicates += group.files.length - 1
    const keep = await group.suggestKeep(strategy)
    resultGroups.push({
      files: group.files,
      similarity: group.similarity,
      size: group.size,
      hash: group.hashValue,
      keep,
      delete: keep ? group.files.filter((f) => f !== keep) : [],
      savings
    })
  }

  return {
    directory,
    total_groups: groups.length,
    total_duplicates: totalDuplicates,
    total_savings: totalSavings,
    strategy,
    groups: resultGroups
  }
}

/* 供 UI/测试使用的辅助：仅文件名展示 */
export function displayName(p: string): string {
  return basename(p)
}
