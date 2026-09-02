/**
 * 设定实体别名识别（纯逻辑，不依赖 electron —— 便于无头单测）
 *
 * **为什么要有别名表**：正文中人物很少被直呼全名——「萧炎」「炎帝」「萧家三少」
 * 指的都是同一个人。上下文编排若只按本名匹配，写第 N 章时会漏掉大量出场实体，
 * 召回的设定卡就不完整。
 *
 * **为什么必须长名优先**：若先匹配短名「炎」，会把「萧炎」里的「炎」吃掉并占位，
 * 导致「萧炎」永远匹配不到（或反过来重复计数）。因此把所有候选项按长度降序扫描，
 * 命中后在 mask 上占位，短名再扫到同一区间时自动跳过。
 *
 * **为什么用 mask 而不是字符串替换**：替换成等长占位符也可行，但每次替换都要
 * 生成新字符串（大正文下 O(n²) 内存拷贝）。Uint8Array 占位是原地 O(1)。
 */
import type { EntityKind, EntityMeta, EntityMention } from '../../shared/types'

export interface MatchCandidate {
  entityId: string
  name: string
  kind: EntityKind
  /** 本名 + 别名，已去重、去空白、按长度降序 */
  terms: string[]
}

/** 只转 ASCII 大写，避免 toLowerCase 改变字符数（如 'İ'.toLowerCase() 长度为 2）导致索引错位 */
function lowerAscii(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

/** 由实体列表构建匹配候选；本名自动并入别名，空串与纯空白丢弃 */
export function buildCandidates(entities: EntityMeta[]): MatchCandidate[] {
  const out: MatchCandidate[] = []
  for (const e of entities) {
    const terms = Array.from(
      new Set([e.name, ...(e.aliases ?? [])].map((t) => (t ?? '').trim()).filter(Boolean))
    ).sort((a, b) => b.length - a.length)
    if (!terms.length) continue
    out.push({ entityId: e.id, name: e.name, kind: e.kind, terms })
  }
  return out
}

/**
 * 在正文里识别实体提及。同一段文本只会被最长命中的那个别名认领一次，
 * 返回按出现次数降序。
 */
export function matchEntities(candidates: MatchCandidate[], text: string): EntityMention[] {
  if (!text || !candidates.length) return []

  const hay = lowerAscii(text)
  const mask = new Uint8Array(hay.length)

  // 打平后按长度降序：保证「萧炎」先于「炎」占位
  const pairs: Array<{ c: MatchCandidate; term: string }> = []
  for (const c of candidates) {
    for (const term of c.terms) pairs.push({ c, term: lowerAscii(term) })
  }
  pairs.sort((a, b) => b.term.length - a.term.length)

  interface Acc {
    name: string
    kind: EntityKind
    count: number
    matched: string
  }
  const acc = new Map<string, Acc>()

  for (const { c, term } of pairs) {
    if (!term) continue
    let from = 0
    for (;;) {
      const idx = hay.indexOf(term, from)
      if (idx < 0) break
      const end = idx + term.length
      let free = true
      for (let i = idx; i < end; i++) {
        if (mask[i]) {
          free = false
          break
        }
      }
      if (free) {
        for (let i = idx; i < end; i++) mask[i] = 1
        const prev = acc.get(c.entityId)
        if (prev) {
          prev.count += 1
        } else {
          acc.set(c.entityId, { name: c.name, kind: c.kind, count: 1, matched: term })
        }
      }
      from = end
    }
  }

  const mentions: EntityMention[] = []
  for (const [entityId, v] of acc) {
    mentions.push({
      entityId,
      name: v.name,
      kind: v.kind,
      // matched 记录实际命中的最长别名（首次命中即最长，因为按降序扫描）
      matched: v.matched,
      count: v.count
    })
  }
  mentions.sort((a, b) => b.count - a.count)
  return mentions
}
