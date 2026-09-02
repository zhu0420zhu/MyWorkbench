/**
 * 一致性审计（P2-1，规则先行）。
 *
 * 先做**确定性、可复现**的规则检查，不依赖 LLM，这样每条问题都能解释、能一键修正：
 *   1. 别名归一化：正文用了别名（而非正式名）→ 建议统一为正式名，可一键替换。
 *   2. 实体重名：两个实体同名 / 同别名 → 冲突告警（需作者手动处理）。
 *
 * 纯逻辑见 `consistencyCore.ts`（不触 electron，可无头测试）；这里只负责取数与应用修正。
 * 暂未做"未登记专名"与"时间线/状态矛盾"：前者靠频率启发式噪声大、后者需 LLM 或结构化状态，
 * 二者放到"LLM 复核"阶段，避免给出不可信的误报砸掉审计的信任度。
 */
import { listEntities, getEntity, detectMentions } from './entities'
import { collectChapters, readChapterContent, updateChapter } from './store'
import { buildAliasIssues, findDuplicateEntities, normalizeAliasText } from './consistencyCore'
import type { ConsistencyIssue, ConsistencyReport } from '../../shared/types'

export async function auditProject(projectId: string): Promise<ConsistencyReport> {
  const entities = await listEntities(projectId)
  const chapters = await collectChapters(projectId)
  const issues: ConsistencyIssue[] = []

  /* ---- 规则 1：别名归一化 ---- */
  for (const ch of chapters) {
    if (!ch.content.trim()) continue
    const mentions = await detectMentions(projectId, ch.content)
    issues.push(...buildAliasIssues(ch.id, ch.title, mentions))
  }

  /* ---- 规则 2：实体重名 ---- */
  issues.push(...findDuplicateEntities(entities))

  return { projectId, issues, scannedChapters: chapters.length }
}

/**
 * 应用一条自动修正。目前仅支持别名归一化：把该章里该实体的所有别名替换为正式名。
 */
export async function applyConsistencyFix(
  projectId: string,
  issue: ConsistencyIssue
): Promise<boolean> {
  if (issue.kind !== 'alias-normalization' || !issue.entityId || !issue.chapterId) return false
  const ent = await getEntity(projectId, issue.entityId)
  if (!ent) return false
  const read = await readChapterContent(projectId, issue.chapterId)
  if (!read) return false
  const content = read.content
  if (!content) return false

  const next = normalizeAliasText(content, ent.name, ent.aliases ?? [])
  if (next === content) return false
  await updateChapter(projectId, issue.chapterId, { content: next })
  return true
}
