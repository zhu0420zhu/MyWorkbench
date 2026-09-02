/**
 * 一致性审计的纯逻辑核心（不依赖 electron，可无头测试）。
 *
 * 规则本身与"读文件 / 调 detectMentions"解耦：electron 侧负责取数，
 * 这里只吃"实体列表 + 章节正文 + 实体提及"并产出问题，或做别名归一化的文本替换。
 */
import type { ConsistencyIssue, EntityMention, EntityMeta } from '../../shared/types'

/**
 * 把正文里某实体的别名统一替换为正式名。
 * - 跳过"是正式名子串"的别名（如别名"林"是"林动"子串，不能改，否则"林动"→"林动动"）。
 * - 长别名先替换，避免短别名先替换后把长别名拆坏。
 */
export function normalizeAliasText(content: string, name: string, aliases: string[]): string {
  const list = (aliases ?? [])
    .filter((a) => a && a !== name && !name.includes(a))
    .sort((a, b) => b.length - a.length)
  let next = content
  for (const a of list) {
    if (!next.includes(a)) continue
    next = next.split(a).join(name)
  }
  return next
}

/** 实体重名：两个实体共享名称或别名 → 冲突告警 */
export function findDuplicateEntities(entities: EntityMeta[]): ConsistencyIssue[] {
  const nameMap = new Map<string, string[]>()
  const aliasMap = new Map<string, string[]>()
  const push = (m: Map<string, string[]>, k: string, id: string): void => {
    const arr = m.get(k)
    if (arr) arr.push(id)
    else m.set(k, [id])
  }
  for (const e of entities) {
    push(nameMap, e.name, e.id)
    for (const al of e.aliases ?? []) push(aliasMap, al, e.id)
  }
  const issues: ConsistencyIssue[] = []
  for (const [key, ids] of [...nameMap, ...aliasMap]) {
    const uniq = [...new Set(ids)]
    if (uniq.length < 2) continue
    const isAlias = aliasMap.has(key)
    const names = uniq.map((id) => entities.find((e) => e.id === id)?.name ?? id).join('、')
    issues.push({
      id: `duplicate-entity:${key}`,
      kind: 'duplicate-entity',
      severity: 'error',
      message: `存在重复的${isAlias ? '别名' : '名称'}"${key}"：${names}。`,
      chapterId: '',
      chapterTitle: '',
      matched: key,
      autoFixable: false
    })
  }
  return issues
}

/** 单章内对某个实体只报一次别名归一化问题 */
export function buildAliasIssues(
  chapterId: string,
  chapterTitle: string,
  mentions: EntityMention[]
): ConsistencyIssue[] {
  const out: ConsistencyIssue[] = []
  const seen = new Set<string>()
  for (const m of mentions) {
    if (m.matched === m.name) continue
    if (seen.has(m.entityId)) continue
    seen.add(m.entityId)
    out.push({
      id: `alias-normalization:${chapterId}:${m.entityId}`,
      kind: 'alias-normalization',
      severity: 'warn',
      message: `《${chapterTitle}》里用了别名"${m.matched}"，设定库正式名为"${m.name}"，建议统一。`,
      chapterId,
      chapterTitle,
      matched: m.matched,
      suggestion: m.name,
      autoFixable: true,
      entityId: m.entityId
    })
  }
  return out
}
