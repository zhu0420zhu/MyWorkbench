/**
 * 内容快照与回滚
 *
 * 面向"写作/笔记"这类会反复修改的长文本：每次保存留一个快照点，
 * 随时可回看、对比与恢复。设计上刻意保持低侵入：
 *
 *   - 内容寻址无关，按时间顺序追加，索引在 index.json（小、可快速列出）
 *   - 快照正文独立成 .md 文件，主数据目录不受污染，可直接手工找回
 *   - 内容无变化不打点；自动打点按最短间隔节流，避免刷屏
 *   - 回滚本身也会先给"当前内容"打一个 pre-restore 快照，回滚可逆
 *
 * 存储：userData/snapshots/<kind>/<safeId>/index.json + <snapId>.md
 */
import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

import type { SnapshotKind, SnapshotReason, SnapshotMeta } from '../shared/types'

export type { SnapshotKind, SnapshotReason, SnapshotMeta }

interface SnapshotIndex {
  version: 1
  items: SnapshotMeta[]
}

/** 单个目标保留的快照上限，超出后淘汰最旧的 */
const MAX_SNAPSHOTS = 200

function baseDir(): string {
  return join(app.getPath('userData'), 'snapshots')
}

function safeId(id: string): string {
  return id.replace(/[^\w.@-]+/g, '_').slice(0, 80) || 'default'
}

function dirOf(kind: SnapshotKind, id: string): string {
  return join(baseDir(), kind, safeId(id))
}

function indexFile(kind: SnapshotKind, id: string): string {
  return join(dirOf(kind, id), 'index.json')
}

function snapFile(kind: SnapshotKind, id: string, snapId: string): string {
  return join(dirOf(kind, id), `${snapId}.md`)
}

/**
 * CJK 计字区间：
 *   \u3400-\u4dbf  CJK 扩展 A
 *   \u4e00-\u9fff  CJK 基本区（常用汉字）
 *   \uf900-\ufaff  CJK 兼容表意文字
 *   \u3040-\u30ff  日文假名
 *   \u3000-\u303f  中日标点（。、《》：；！？等）
 *   \uff00-\uffef  全角字符（，．！等）
 *
 * 标点计入是刻意的：网文平台（起点、番茄）与 Word 的中文统计都含标点，
 * 作者在版本历史里看到的字数应与投稿平台口径一致，避免"我写了 3000 字，
 * 这里只显示 2600 字"的困惑。
 */
const CJK_RE =
  /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\u3000-\u303f\uff00-\uffef]/g

/**
 * 字数统计：CJK（含中文标点）按字符计 1，其余按连续字母/数字串计 1。
 * 中文写作场景下比按空白分词准确得多。
 */
export function countWords(text: string): number {
  if (!text) return 0
  const cjk = (text.match(CJK_RE) ?? []).length
  const rest = text.replace(CJK_RE, ' ').match(/[A-Za-z0-9_'\u2019]+/g)
  return cjk + (rest?.length ?? 0)
}

async function readIndex(kind: SnapshotKind, id: string): Promise<SnapshotIndex> {
  try {
    const raw = JSON.parse(await fs.readFile(indexFile(kind, id), 'utf-8')) as SnapshotIndex
    if (raw && Array.isArray(raw.items)) return { version: 1, items: raw.items }
  } catch {
    /* 首次使用或索引损坏 */
  }
  return { version: 1, items: [] }
}

async function writeIndex(kind: SnapshotKind, id: string, idx: SnapshotIndex): Promise<void> {
  await fs.mkdir(dirOf(kind, id), { recursive: true })
  await fs.writeFile(indexFile(kind, id), JSON.stringify(idx, null, 2), 'utf-8')
}

/** 列出快照（新的在前） */
export async function listSnapshots(kind: SnapshotKind, id: string): Promise<SnapshotMeta[]> {
  const idx = await readIndex(kind, id)
  return [...idx.items].sort((a, b) => b.createdAt - a.createdAt)
}

async function readLatest(kind: SnapshotKind, id: string): Promise<SnapshotMeta | null> {
  const idx = await readIndex(kind, id)
  if (idx.items.length === 0) return null
  return idx.items.reduce((a, b) => (a.createdAt > b.createdAt ? a : b))
}

export interface CreateSnapshotOptions {
  reason?: SnapshotReason
  label?: string
  /** 与最新快照内容相同则跳过（默认 true） */
  skipIfUnchanged?: boolean
  /** 自动打点的最短间隔（毫秒），距最新快照不足则跳过 */
  minIntervalMs?: number
}

/**
 * 打一个快照。内容未变化或节流窗口内会跳过，返回 null（不是错误）。
 */
export async function createSnapshot(
  kind: SnapshotKind,
  id: string,
  content: string,
  opts: CreateSnapshotOptions = {}
): Promise<SnapshotMeta | null> {
  const { reason = 'manual', label, skipIfUnchanged = true, minIntervalMs = 0 } = opts

  const latest = await readLatest(kind, id)
  if (latest) {
    if (minIntervalMs > 0 && Date.now() - latest.createdAt < minIntervalMs) return null
    if (skipIfUnchanged) {
      try {
        const prev = await fs.readFile(snapFile(kind, id, latest.id), 'utf-8')
        if (prev === content) return null
      } catch {
        /* 旧快照正文缺失时照常新建 */
      }
    }
  }

  const meta: SnapshotMeta = {
    id: randomUUID(),
    createdAt: Date.now(),
    reason,
    label,
    chars: content.length,
    words: countWords(content)
  }

  await fs.mkdir(dirOf(kind, id), { recursive: true })
  await fs.writeFile(snapFile(kind, id, meta.id), content, 'utf-8')

  const idx = await readIndex(kind, id)
  idx.items.push(meta)
  idx.items.sort((a, b) => a.createdAt - b.createdAt)
  if (idx.items.length > MAX_SNAPSHOTS) {
    const dropped = idx.items.splice(0, idx.items.length - MAX_SNAPSHOTS)
    for (const d of dropped) {
      await fs.rm(snapFile(kind, id, d.id), { force: true }).catch(() => undefined)
    }
  }
  await writeIndex(kind, id, idx)
  return meta
}

/** 读取某个快照的正文 */
export async function getSnapshot(
  kind: SnapshotKind,
  id: string,
  snapId: string
): Promise<string | null> {
  try {
    return await fs.readFile(snapFile(kind, id, snapId), 'utf-8')
  } catch {
    return null
  }
}

/**
 * 回滚：先把"当前内容"存为 pre-restore 快照（保证回滚可逆），
 * 再返回目标快照的正文，由调用方写回主数据。
 */
export async function restoreSnapshot(
  kind: SnapshotKind,
  id: string,
  snapId: string,
  currentContent: string
): Promise<string | null> {
  const target = await getSnapshot(kind, id, snapId)
  if (target === null) return null
  await createSnapshot(kind, id, currentContent, {
    reason: 'pre-restore',
    label: '回滚前的版本',
    skipIfUnchanged: true
  })
  return target
}

export async function removeSnapshot(
  kind: SnapshotKind,
  id: string,
  snapId: string
): Promise<boolean> {
  const idx = await readIndex(kind, id)
  const next = idx.items.filter((i) => i.id !== snapId)
  if (next.length === idx.items.length) return false
  await writeIndex(kind, id, { version: 1, items: next })
  await fs.rm(snapFile(kind, id, snapId), { force: true }).catch(() => undefined)
  return true
}

/** 目标整体删除（如笔记删除）时清理其快照目录 */
export async function clearSnapshots(kind: SnapshotKind, id: string): Promise<boolean> {
  try {
    await fs.rm(dirOf(kind, id), { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}
