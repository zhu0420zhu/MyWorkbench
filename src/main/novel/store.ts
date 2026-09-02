/**
 * 长篇作品存储：作品 → 分卷 → 章节
 *
 * 存储布局（与 notes / boards 模块同构：索引单独放、正文分文件）：
 *
 *   userData/novel/projects.json                  作品索引（列表用，不含正文）
 *   userData/novel/<projectId>/meta.json          分卷 + 章节元数据
 *   userData/novel/<projectId>/chapters/<id>.md   章节正文
 *
 * **为什么正文要分文件**：编辑器自动保存每 30s 落一次盘，若正文塞进一个 JSON，
 * 每次保存都要重写整个作品文件；分文件后单次写入只有当前章节，几百章也不掉帧。
 *
 * **索引里的 wordCount / chapterCount 是冗余字段**：列表页不该为了显示字数去读
 * 几百个 .md 文件，因此在每次章节保存后回写索引。读取时如发现索引缺失会自动重算兜底。
 */
import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type {
  Chapter,
  ChapterMeta,
  ChapterStatus,
  NovelProject,
  NovelProjectMeta,
  Volume
} from '../../shared/types'
import { countWords } from '../snapshots'

function novelDir(): string {
  return join(app.getPath('userData'), 'novel')
}

function projectsFile(): string {
  return join(novelDir(), 'projects.json')
}

function projectDir(projectId: string): string {
  return join(novelDir(), safeId(projectId))
}

function metaFile(projectId: string): string {
  return join(projectDir(projectId), 'meta.json')
}

function chaptersDir(projectId: string): string {
  return join(projectDir(projectId), 'chapters')
}

function chapterFile(projectId: string, chapterId: string): string {
  return join(chaptersDir(projectId), `${safeId(chapterId)}.md`)
}

function safeId(id: string): string {
  return id.replace(/[^\w.@-]+/g, '_').slice(0, 80) || 'default'
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true })
}

/* ------------------------------ 作品索引 ------------------------------ */

interface ProjectIndex {
  version: 1
  projects: NovelProjectMeta[]
}

async function readProjectIndex(): Promise<ProjectIndex> {
  try {
    const parsed = JSON.parse(await fs.readFile(projectsFile(), 'utf-8')) as ProjectIndex
    if (parsed && Array.isArray(parsed.projects)) return { version: 1, projects: parsed.projects }
  } catch {
    /* 首次使用或索引损坏 */
  }
  return { version: 1, projects: [] }
}

async function writeProjectIndex(idx: ProjectIndex): Promise<void> {
  await ensureDir(novelDir())
  await fs.writeFile(projectsFile(), JSON.stringify(idx, null, 2), 'utf-8')
}

/* ------------------------------ 作品元数据 ------------------------------ */

interface MetaFile {
  version: 1
  volumes: Volume[]
  chapters: ChapterMeta[]
}

async function readMeta(projectId: string): Promise<MetaFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(metaFile(projectId), 'utf-8')) as MetaFile
    if (parsed && Array.isArray(parsed.volumes) && Array.isArray(parsed.chapters)) {
      return { version: 1, volumes: parsed.volumes, chapters: parsed.chapters }
    }
  } catch {
    /* 首次使用或文件损坏 */
  }
  return { version: 1, volumes: [], chapters: [] }
}

async function writeMeta(projectId: string, meta: MetaFile): Promise<void> {
  await ensureDir(projectDir(projectId))
  await fs.writeFile(metaFile(projectId), JSON.stringify(meta, null, 2), 'utf-8')
}

/** 用章节元数据重算作品总字数（索引冗余字段的兜底/校验来源） */
function sumWords(chapters: ChapterMeta[]): number {
  return chapters.reduce((s, c) => s + (c.wordCount ?? 0), 0)
}

/** 把作品统计回写到索引 */
async function syncProjectStats(projectId: string): Promise<NovelProjectMeta | null> {
  const meta = await readMeta(projectId)
  const idx = await readProjectIndex()
  const target = idx.projects.find((p) => p.id === projectId)
  if (!target) return null
  target.wordCount = sumWords(meta.chapters)
  target.chapterCount = meta.chapters.length
  target.updatedAt = Date.now()
  await writeProjectIndex(idx)
  return target
}

/* ------------------------------ 作品 CRUD ------------------------------ */

export interface CreateProjectInput {
  title: string
  genre?: string
  synopsis?: string
  targetWords?: number
}

export async function listProjects(): Promise<NovelProjectMeta[]> {
  const idx = await readProjectIndex()
  return [...idx.projects].sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function createProject(input: CreateProjectInput): Promise<NovelProject> {
  const now = Date.now()
  const id = randomUUID()
  const meta: NovelProjectMeta = {
    id,
    title: input.title.trim() || '未命名作品',
    genre: input.genre?.trim() ?? '',
    synopsis: input.synopsis?.trim() ?? '',
    targetWords: input.targetWords ?? 0,
    wordCount: 0,
    chapterCount: 0,
    createdAt: now,
    updatedAt: now
  }

  const idx = await readProjectIndex()
  idx.projects.push(meta)
  await writeProjectIndex(idx)

  // 新作品默认带一个分卷，避免"必须先建卷才能建章"的空转
  const volume: Volume = {
    id: randomUUID(),
    projectId: id,
    index: 0,
    title: '第一卷',
    summary: ''
  }
  await writeMeta(id, { version: 1, volumes: [volume], chapters: [] })
  await ensureDir(chaptersDir(id))

  return { meta, volumes: [volume], chapters: [] }
}

export async function getProject(projectId: string): Promise<NovelProject | null> {
  const idx = await readProjectIndex()
  const meta = idx.projects.find((p) => p.id === projectId)
  if (!meta) return null
  const { volumes, chapters } = await readMeta(projectId)
  return {
    meta: { ...meta, wordCount: sumWords(chapters), chapterCount: chapters.length },
    volumes: [...volumes].sort((a, b) => a.index - b.index),
    chapters: [...chapters].sort((a, b) => a.index - b.index)
  }
}

export async function updateProject(
  projectId: string,
  patch: Partial<Pick<NovelProjectMeta, 'title' | 'genre' | 'synopsis' | 'targetWords'>>
): Promise<NovelProjectMeta | null> {
  const idx = await readProjectIndex()
  const target = idx.projects.find((p) => p.id === projectId)
  if (!target) return null
  if (patch.title !== undefined) target.title = patch.title.trim() || target.title
  if (patch.genre !== undefined) target.genre = patch.genre
  if (patch.synopsis !== undefined) target.synopsis = patch.synopsis
  if (patch.targetWords !== undefined) target.targetWords = patch.targetWords
  target.updatedAt = Date.now()
  await writeProjectIndex(idx)
  return target
}

/** 删除作品：索引条目 + 整个作品目录（含所有章节正文） */
export async function removeProject(projectId: string): Promise<boolean> {
  const idx = await readProjectIndex()
  const next = idx.projects.filter((p) => p.id !== projectId)
  if (next.length === idx.projects.length) return false
  await writeProjectIndex({ version: 1, projects: next })
  await fs.rm(projectDir(projectId), { recursive: true, force: true }).catch(() => undefined)
  return true
}

/* ------------------------------ 分卷 CRUD ------------------------------ */

export async function createVolume(
  projectId: string,
  title: string,
  summary = ''
): Promise<Volume[]> {
  const meta = await readMeta(projectId)
  const volume: Volume = {
    id: randomUUID(),
    projectId,
    index: meta.volumes.length,
    title: title.trim() || `第 ${meta.volumes.length + 1} 卷`,
    summary
  }
  meta.volumes.push(volume)
  await writeMeta(projectId, meta)
  await syncProjectStats(projectId)
  return meta.volumes
}

export async function updateVolume(
  projectId: string,
  volumeId: string,
  patch: Partial<Pick<Volume, 'title' | 'summary'>>
): Promise<Volume[]> {
  const meta = await readMeta(projectId)
  const v = meta.volumes.find((x) => x.id === volumeId)
  if (!v) return meta.volumes
  if (patch.title !== undefined) v.title = patch.title
  if (patch.summary !== undefined) v.summary = patch.summary
  await writeMeta(projectId, meta)
  await syncProjectStats(projectId)
  return meta.volumes
}

export async function removeVolume(
  projectId: string,
  volumeId: string,
  /** 卷内章节的处置：一并删除，或移入第一个剩余分卷 */
  mode: 'delete-chapters' | 'move-to-first' = 'move-to-first'
): Promise<Volume[]> {
  const meta = await readMeta(projectId)
  const target = meta.volumes.find((v) => v.id === volumeId)
  if (!target) return meta.volumes

  const orphans = meta.chapters.filter((c) => c.volumeId === volumeId)
  const rest = meta.volumes.filter((v) => v.id !== volumeId)

  if (mode === 'delete-chapters') {
    for (const c of orphans) {
      await fs.rm(chapterFile(projectId, c.id), { force: true }).catch(() => undefined)
    }
    meta.chapters = meta.chapters.filter((c) => c.volumeId !== volumeId)
  } else if (rest.length > 0) {
    // 移入第一个剩余分卷，挂在其末尾
    const dest = rest[0]
    const tail = meta.chapters.filter((c) => c.volumeId === dest.id).length
    orphans.forEach((c, i) => {
      c.volumeId = dest.id
      c.index = tail + i
    })
  } else {
    // 最后一个卷：不允许删除（作品至少要有一个卷，否则章节无处挂载）
    return meta.volumes
  }

  meta.volumes = rest.map((v, i) => ({ ...v, index: i }))
  meta.chapters.sort((a, b) => a.index - b.index)
  await writeMeta(projectId, meta)
  await syncProjectStats(projectId)
  return meta.volumes
}

/* ------------------------------ 章节 CRUD ------------------------------ */

export interface CreateChapterInput {
  projectId: string
  volumeId: string
  title?: string
  summary?: string
  wordGoal?: number
}

export async function createChapter(input: CreateChapterInput): Promise<ChapterMeta | null> {
  const meta = await readMeta(input.projectId)
  if (!meta.volumes.some((v) => v.id === input.volumeId)) return null

  const n = meta.chapters.filter((c) => c.volumeId === input.volumeId).length
  const chapter: ChapterMeta = {
    id: randomUUID(),
    projectId: input.projectId,
    volumeId: input.volumeId,
    index: n,
    title: input.title?.trim() || `第 ${n + 1} 章`,
    summary: input.summary ?? '',
    status: 'outline',
    wordGoal: input.wordGoal ?? 3000,
    wordCount: 0,
    updatedAt: Date.now()
  }

  meta.chapters.push(chapter)
  await writeMeta(input.projectId, meta)
  await ensureDir(chaptersDir(input.projectId))
  await fs.writeFile(chapterFile(input.projectId, chapter.id), '', 'utf-8')
  await syncProjectStats(input.projectId)
  return chapter
}

export async function getChapter(
  projectId: string,
  chapterId: string
): Promise<Chapter | null> {
  const meta = await readMeta(projectId)
  const c = meta.chapters.find((x) => x.id === chapterId)
  if (!c) return null
  let content = ''
  try {
    content = await fs.readFile(chapterFile(projectId, chapterId), 'utf-8')
  } catch {
    /* 正文文件缺失时按空章处理 */
  }
  return { ...c, content }
}

export interface UpdateChapterInput {
  title?: string
  summary?: string
  status?: ChapterStatus
  wordGoal?: number
  /** 传了才写正文；不传只改元数据，避免"改标题"也要重传整篇正文 */
  content?: string
}

export async function updateChapter(
  projectId: string,
  chapterId: string,
  patch: UpdateChapterInput
): Promise<ChapterMeta | null> {
  const meta = await readMeta(projectId)
  const c = meta.chapters.find((x) => x.id === chapterId)
  if (!c) return null

  if (patch.title !== undefined) c.title = patch.title
  if (patch.summary !== undefined) c.summary = patch.summary
  if (patch.status !== undefined) c.status = patch.status
  if (patch.wordGoal !== undefined) c.wordGoal = patch.wordGoal

  if (patch.content !== undefined) {
    await ensureDir(chaptersDir(projectId))
    await fs.writeFile(chapterFile(projectId, chapterId), patch.content, 'utf-8')
    c.wordCount = countWords(patch.content)
    // 写了正文就从"细纲"自动推进到"初稿"，省去作者手动改状态
    if (c.status === 'outline' && c.wordCount > 0) c.status = 'draft'
  }
  c.updatedAt = Date.now()

  await writeMeta(projectId, meta)
  await syncProjectStats(projectId)
  return c
}

export async function removeChapter(
  projectId: string,
  chapterId: string
): Promise<ChapterMeta[]> {
  const meta = await readMeta(projectId)
  const target = meta.chapters.find((c) => c.id === chapterId)
  if (!target) return meta.chapters

  await fs.rm(chapterFile(projectId, chapterId), { force: true }).catch(() => undefined)
  meta.chapters = meta.chapters.filter((c) => c.id !== chapterId)
  // 同卷内重排 index，避免删除后留下空洞
  const siblings = meta.chapters.filter((c) => c.volumeId === target.volumeId)
  siblings.sort((a, b) => a.index - b.index).forEach((c, i) => {
    c.index = i
  })

  await writeMeta(projectId, meta)
  await syncProjectStats(projectId)
  return meta.chapters
}

/**
 * 章节排序：支持卷内移动与跨卷移动。
 *
 * 传入目标卷 + 目标位置，服务端统一重排两个受影响卷的 index。
 * 只信客户端传来的顺序会丢失"跨卷"语义（卷 A 拿走一个，卷 B 的空洞不会自动补）。
 */
export async function reorderChapter(
  projectId: string,
  chapterId: string,
  toVolumeId: string,
  toIndex: number
): Promise<ChapterMeta[]> {
  const meta = await readMeta(projectId)
  const moving = meta.chapters.find((c) => c.id === chapterId)
  if (!moving) return meta.chapters
  if (!meta.volumes.some((v) => v.id === toVolumeId)) return meta.chapters

  const fromVolumeId = moving.volumeId

  // 从原卷摘出
  const fromList = meta.chapters
    .filter((c) => c.volumeId === fromVolumeId && c.id !== chapterId)
    .sort((a, b) => a.index - b.index)
  fromList.forEach((c, i) => {
    c.index = i
  })

  // 插入目标卷
  const toList = meta.chapters
    .filter((c) => c.volumeId === toVolumeId && c.id !== chapterId)
    .sort((a, b) => a.index - b.index)
  const clamped = Math.max(0, Math.min(toIndex, toList.length))
  toList.splice(clamped, 0, moving)
  toList.forEach((c, i) => {
    c.index = i
    c.volumeId = toVolumeId
  })

  await writeMeta(projectId, meta)
  await syncProjectStats(projectId)
  return meta.chapters
}

/**
 * 导出辅助：按 projectId + chapterId 直接取正文。
 * 不要用 collectChapters 再 find——一本书几百章时逐个来源都全量扫一遍是 O(n²) 的文件读取。
 */
export async function readChapterContent(
  projectId: string,
  chapterId: string
): Promise<{ title: string; content: string } | null> {
  const meta = await readMeta(projectId)
  const c = meta.chapters.find((x) => x.id === chapterId)
  if (!c) return null
  try {
    return { title: c.title, content: await fs.readFile(chapterFile(projectId, chapterId), 'utf-8') }
  } catch {
    return null
  }
}

/* ------------------------------ 导出辅助 ------------------------------ */

/**
 * 按作品 → 卷 → 章的顺序列出全部章节正文，供导出成书使用。
 * 分卷标题作为分隔（不进正文，避免污染章节内容）。
 */
export async function collectChapters(
  projectId: string
): Promise<Array<{ id: string; title: string; content: string; volumeTitle: string }>> {
  const project = await getProject(projectId)
  if (!project) return []
  const out: Array<{ id: string; title: string; content: string; volumeTitle: string }> = []
  for (const v of project.volumes) {
    for (const c of project.chapters.filter((x) => x.volumeId === v.id)) {
      try {
        const content = await fs.readFile(chapterFile(projectId, c.id), 'utf-8')
        out.push({ id: c.id, title: c.title, content, volumeTitle: v.title })
      } catch {
        /* 正文缺失的章节跳过 */
      }
    }
  }
  return out
}
