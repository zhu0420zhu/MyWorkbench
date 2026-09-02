/**
 * 伏笔追踪：纯逻辑核心（不依赖 electron，可在无头环境跑测试）
 *
 * 只做两件事：
 *  1. 把作品的「卷 → 章」排成正确的阅读顺序；
 *  2. 据此判断哪些「已埋下」的伏笔，到当前章已经跨过阈值却还没回收。
 *
 * 注意 `getProject().chapters` 只按 `index` 全局排序，会丢失「卷」的先后
 * （每卷的 index 都从 0 重新开始），所以排顺序必须同时看 volume 与 chapter。
 */
import type { ChapterMeta, Foreshadow, Volume } from '../../shared/types'

/** 按 卷序 → 卷内章序 排出正确的阅读顺序，返回章节元数据数组 */
export function buildChapterOrder(volumes: Volume[], chapters: ChapterMeta[]): ChapterMeta[] {
  const vols = [...volumes].sort((a, b) => a.index - b.index)
  const byVol = new Map<string, ChapterMeta[]>()
  for (const c of chapters) {
    const arr = byVol.get(c.volumeId)
    if (arr) arr.push(c)
    else byVol.set(c.volumeId, [c])
  }
  const out: ChapterMeta[] = []
  for (const v of vols) {
    const list = byVol.get(v.id) ?? []
    list.sort((a, b) => a.index - b.index)
    out.push(...list)
  }
  return out
}

/** 章节在正确阅读顺序中的位置（从 0 起），找不到返回 -1 */
export function chapterIndexInOrder(order: ChapterMeta[], chapterId: string): number {
  return order.findIndex((c) => c.id === chapterId)
}

/**
 * 计算「逾期未回收」的伏笔：
 * 状态为 planted、且从埋下章到当前章已跨越至少 threshold 章（不含埋下章自身）。
 *
 * @param threshold 阈值（章数）。例如 threshold=5 表示「埋下后过了 5 章还没回收」就提醒。
 */
export function detectOverdue(
  foreshadows: Foreshadow[],
  order: ChapterMeta[],
  currentChapterId: string,
  threshold: number
): Foreshadow[] {
  const curIdx = chapterIndexInOrder(order, currentChapterId)
  if (curIdx < 0) return []
  const out: Foreshadow[] = []
  for (const f of foreshadows) {
    if (f.status !== 'planted') continue
    const pIdx = chapterIndexInOrder(order, f.plantedChapterId)
    if (pIdx < 0) continue
    if (curIdx - pIdx >= threshold) out.push(f)
  }
  return out
}
