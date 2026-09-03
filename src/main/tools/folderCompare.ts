/* ============================================================
 * 目录对比工具（由 ck 工具集移植扩展）
 * 对比两个目录：列出仅在左/右的文件、内容相同/不同的文件，
 * 并对文本文件提供逐行差异。
 * ============================================================ */

import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { scanDirectory, type FileInfo } from './fileUtils.ts'

const logger = console

export interface FolderCompareDiffLine {
  type: 'same' | 'added' | 'removed'
  line: string
  leftNo?: number
  rightNo?: number
}

export interface FolderCompareFile {
  relativePath: string
  leftPath?: string
  rightPath?: string
  leftSize?: number
  rightSize?: number
  leftModified?: number
  rightModified?: number
  leftHash?: string
  rightHash?: string
  status: 'identical' | 'different' | 'only-left' | 'only-right'
  /** 文本文件差异（仅 status=different 且为文本时填充） */
  diff?: FolderCompareDiffLine[]
}

export interface FolderCompareResult {
  left: string
  right: string
  onlyInLeft: FolderCompareFile[]
  onlyInRight: FolderCompareFile[]
  different: FolderCompareFile[]
  identical: FolderCompareFile[]
  summary: {
    totalLeft: number
    totalRight: number
    identical: number
    different: number
    onlyLeft: number
    onlyRight: number
  }
}

export interface FolderCompareOptions {
  /** 是否计算哈希（默认 true）；false 时仅用大小判断内容差异 */
  hash?: boolean
  /** 是否对文本文件生成逐行差异（默认 true） */
  diffText?: boolean
  /** 文本文件差异最大行数（默认 2000） */
  maxDiffLines?: number
}

const TEXT_LIKE_EXTS = new Set([
  '.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml',
  '.js', '.ts', '.jsx', '.tsx', '.html', '.htm', '.css', '.scss', '.less',
  '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.cs', '.php', '.rb',
  '.sh', '.bat', '.cmd', '.ps1', '.sql', '.log', '.ini', '.conf', '.cfg'
])

function normalizeRel(p: string): string {
  return p.split(sep).join('/')
}

function isTextFile(path: string): boolean {
  const dot = path.lastIndexOf('.')
  const ext = dot > 0 ? path.slice(dot).toLowerCase() : ''
  return TEXT_LIKE_EXTS.has(ext)
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const chunk of stream) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

function lcsDiff(left: string[], right: string[]): FolderCompareDiffLine[] {
  const maxLines = Math.min(left.length, right.length)
  if (maxLines > 2000) {
    // 超大文本退化到逐行对齐差异，避免 O(n*m) 内存爆炸
    const out: FolderCompareDiffLine[] = []
    const n = Math.max(left.length, right.length)
    for (let i = 0; i < n; i++) {
      if (i < left.length && i < right.length && left[i] === right[i]) {
        out.push({ type: 'same', line: left[i], leftNo: i + 1, rightNo: i + 1 })
      } else {
        if (i < left.length) out.push({ type: 'removed', line: left[i], leftNo: i + 1 })
        if (i < right.length) out.push({ type: 'added', line: right[i], rightNo: i + 1 })
      }
    }
    return out
  }

  const m = left.length
  const n = right.length
  const dp: number[][] = Array(m + 1)
    .fill(0)
    .map(() => Array(n + 1).fill(0))

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = left[i] === right[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const out: FolderCompareDiffLine[] = []
  let i = 0
  let j = 0
  while (i < m || j < n) {
    if (i < m && j < n && left[i] === right[j]) {
      out.push({ type: 'same', line: left[i], leftNo: i + 1, rightNo: j + 1 })
      i++
      j++
    } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
      out.push({ type: 'added', line: right[j], rightNo: j + 1 })
      j++
    } else if (i < m) {
      out.push({ type: 'removed', line: left[i], leftNo: i + 1 })
      i++
    }
  }
  return out
}

async function buildTextDiff(leftPath: string, rightPath: string, maxLines: number): Promise<FolderCompareDiffLine[]> {
  const [l, r] = await Promise.all([
    fs.readFile(leftPath, 'utf-8'),
    fs.readFile(rightPath, 'utf-8')
  ])
  const leftLines = l.split(/\r?\n/)
  const rightLines = r.split(/\r?\n/)
  const diff = lcsDiff(leftLines, rightLines)
  return diff.slice(0, maxLines)
}

export async function compareFolders(
  left: string,
  right: string,
  opts: FolderCompareOptions = {}
): Promise<FolderCompareResult> {
  const { hash = true, diffText = true, maxDiffLines = 2000 } = opts

  const [leftFiles, rightFiles] = await Promise.all([
    scanDirectory(left, { recursive: true }),
    scanDirectory(right, { recursive: true })
  ])

  const leftMap = new Map<string, FileInfo>(leftFiles.map((f) => [normalizeRel(f.relative_path), f]))
  const rightMap = new Map<string, FileInfo>(rightFiles.map((f) => [normalizeRel(f.relative_path), f]))

  const onlyInLeft: FolderCompareFile[] = []
  const onlyInRight: FolderCompareFile[] = []
  const different: FolderCompareFile[] = []
  const identical: FolderCompareFile[] = []

  const allKeys = new Set([...leftMap.keys(), ...rightMap.keys()])

  for (const key of allKeys) {
    const l = leftMap.get(key)
    const r = rightMap.get(key)

    if (l && !r) {
      onlyInLeft.push({
        relativePath: key,
        leftPath: l.path,
        leftSize: l.size,
        leftModified: l.modified,
        status: 'only-left'
      })
      continue
    }

    if (r && !l) {
      onlyInRight.push({
        relativePath: key,
        rightPath: r.path,
        rightSize: r.size,
        rightModified: r.modified,
        status: 'only-right'
      })
      continue
    }

    // 两边都存在
    const base: FolderCompareFile = {
      relativePath: key,
      leftPath: l!.path,
      rightPath: r!.path,
      leftSize: l!.size,
      rightSize: r!.size,
      leftModified: l!.modified,
      rightModified: r!.modified,
      status: 'identical'
    }

    if (l!.size !== r!.size) {
      base.status = 'different'
      different.push(base)
      continue
    }

    if (hash) {
      const [lh, rh] = await Promise.all([hashFile(l!.path), hashFile(r!.path)])
      base.leftHash = lh
      base.rightHash = rh
      if (lh !== rh) {
        base.status = 'different'
        if (diffText && isTextFile(key)) {
          try {
            base.diff = await buildTextDiff(l!.path, r!.path, maxDiffLines)
          } catch (err) {
            logger.warn(`文本差异生成失败: ${key}, ${(err as Error).message}`)
          }
        }
        different.push(base)
      } else {
        identical.push(base)
      }
    } else {
      identical.push(base)
    }
  }

  const byRel = (a: FolderCompareFile, b: FolderCompareFile) => a.relativePath.localeCompare(b.relativePath)
  onlyInLeft.sort(byRel)
  onlyInRight.sort(byRel)
  different.sort(byRel)
  identical.sort(byRel)

  return {
    left,
    right,
    onlyInLeft,
    onlyInRight,
    different,
    identical,
    summary: {
      totalLeft: leftFiles.length,
      totalRight: rightFiles.length,
      identical: identical.length,
      different: different.length,
      onlyLeft: onlyInLeft.length,
      onlyRight: onlyInRight.length
    }
  }
}
