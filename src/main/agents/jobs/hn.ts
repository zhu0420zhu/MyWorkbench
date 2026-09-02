/* ============================================================
 * 常驻智能体 — Hacker News 首页简报
 * 移植自 awesome-llm-apps 的 Always-on Agents / HN Briefing。
 * 复用：公开 Algolia HN API（无需 Key），fetch 可注入便于测试。
 * ============================================================ */

import type { AgentRunResult, AgentResultItem } from '../../../shared/types.ts'

interface HnHit {
  title?: string
  url?: string
  objectID?: string
  points?: number
  author?: string
}

/** 抓取 HN 首页热点（默认 10 条） */
export async function fetchHnBriefing(
  fetchImpl: typeof fetch = fetch,
  limit = 10
): Promise<AgentRunResult> {
  const url = `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${limit}`
  try {
    const res = await fetchImpl(url)
    if (!res.ok) return { ok: false, summary: '', items: [], error: `HTTP ${res.status}` }
    const json = (await res.json()) as { hits?: HnHit[] }
    const hits = json.hits ?? []
    const items: AgentResultItem[] = hits
      .filter((h) => h.title)
      .map((h) => ({
        title: h.title as string,
        url: h.url || (h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : undefined),
        meta: `${h.points ?? 0} 分 · ${h.author ?? ''}`
      }))
    return {
      ok: true,
      summary: `Hacker News 首页 ${items.length} 条热点`,
      items
    }
  } catch (err) {
    return { ok: false, summary: '', items: [], error: (err as Error).message }
  }
}
