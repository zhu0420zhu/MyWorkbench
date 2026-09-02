/* ============================================================
 * 常驻智能体 — Release Radar（GitHub 新版本雷达）
 * 移植自 awesome-llm-apps 的 Always-on Agents / Release Radar。
 * 复用：公开 GitHub Releases API（无需 Key，限频 60/h，周期运行足够），
 *       fetch 可注入便于测试；对比上次已知版本，报告新发布。
 * ============================================================ */

import type { AgentRunResult, AgentResultItem } from '../../../shared/types.ts'

interface GithubRelease {
  tag_name?: string
  html_url?: string
  published_at?: string
}

export interface ReleaseRadarResult extends AgentRunResult {
  /** 相较上次已知版本新发布的条目（用于通知/高亮） */
  newReleases?: Array<{ repo: string; tag: string; url?: string }>
}

/** 检查给定仓库列表的最新 release，并与 lastKnown 对比找出新版本 */
export async function fetchReleaseRadar(
  repos: string[],
  fetchImpl: typeof fetch = fetch,
  lastKnown: Record<string, string> = {}
): Promise<ReleaseRadarResult> {
  const items: AgentResultItem[] = []
  const news: Array<{ repo: string; tag: string; url?: string }> = []
  let okAll = true

  for (const repo of repos) {
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=1`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'lingmo-workbench' }
      })
      if (!res.ok) {
        okAll = false
        continue
      }
      const arr = (await res.json()) as GithubRelease[]
      const rel = arr[0]
      if (!rel || !rel.tag_name) continue
      const tag = rel.tag_name
      items.push({
        title: `${repo} ${tag}`,
        url: rel.html_url,
        meta: rel.published_at ? new Date(rel.published_at).toLocaleDateString() : ''
      })
      if (lastKnown[repo] && lastKnown[repo] !== tag) {
        news.push({ repo, tag, url: rel.html_url })
      }
    } catch {
      okAll = false
    }
  }

  return {
    ok: okAll,
    summary: news.length
      ? `发现 ${news.length} 个新版本发布`
      : `已是最新（检查 ${repos.length} 个仓库）`,
    items,
    newReleases: news
  }
}
