/* 常驻智能体 — 统一出口与单例注册 */
import { AgentScheduler } from './scheduler.ts'
import { fetchHnBriefing } from './jobs/hn.ts'
import { fetchReleaseRadar } from './jobs/releaseRadar.ts'

let _instance: AgentScheduler | null = null

/** 获取 AgentScheduler 全局单例（注册默认作业：HN 简报 / Release Radar） */
export function getAgentScheduler(): AgentScheduler {
  if (!_instance) {
    _instance = new AgentScheduler()
    _instance.register({
      id: 'hn-briefing',
      name: 'Hacker News 简报',
      description: '定时抓取 HN 首页热点（无需 API Key）',
      run: () => fetchHnBriefing()
    })
    _instance.register({
      id: 'release-radar',
      name: 'Release Radar',
      description: '定时检查 GitHub 仓库新版本发布',
      run: (repos) => fetchReleaseRadar(repos ?? [])
    })
  }
  return _instance
}
