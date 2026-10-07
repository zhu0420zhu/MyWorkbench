/**
 * 使用统计：模型调用 / 页面访问 / 各模块内容量
 * 落盘 userData/usage-stats.json，设置页「数据看板」展示
 */
import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { UsageStatsState } from '../shared/types'

const DEFAULT: UsageStatsState = {
  version: 1,
  models: {},
  pages: {},
  aiCalls: { chat: 0, complete: 0, rightClick: 0, agentRun: 0 },
  agents: {},
  issues: {},
  startedAt: Date.now(),
  lastActiveAt: Date.now()
}

function file(): string {
  return join(app.getPath('userData'), 'usage-stats.json')
}

let cache: UsageStatsState | null = null
let writeQueue: Promise<void> = Promise.resolve()

export async function loadUsageStats(): Promise<UsageStatsState> {
  if (cache) return cache
  try {
    const raw = JSON.parse(await fs.readFile(file(), 'utf-8')) as Partial<UsageStatsState>
    cache = {
      ...DEFAULT,
      ...raw,
      models: { ...(raw.models ?? {}) },
      pages: { ...(raw.pages ?? {}) },
      agents: { ...(raw.agents ?? {}) },
      issues: { ...(raw.issues ?? {}) },
      aiCalls: { ...DEFAULT.aiCalls, ...(raw.aiCalls ?? {}) }
    }
  } catch {
    cache = { ...DEFAULT }
  }
  return cache
}

async function persist(): Promise<void> {
  const state = cache
  if (!state) return
  writeQueue = writeQueue.then(async () => {
    try {
      await fs.mkdir(app.getPath('userData'), { recursive: true })
      await fs.writeFile(file(), JSON.stringify(state, null, 2), 'utf-8')
    } catch {
      /* ignore */
    }
  })
}

/** 记录一次模型调用（count=1，approxTokens 可选） */
export async function recordAiUsage(opts: {
  model: string
  kind?: 'chat' | 'complete' | 'rightClick'
  approxTokens?: number
  promptChars?: number
}): Promise<void> {
  const state = await loadUsageStats()
  const model = (opts.model || '未指定模型').trim() || '未指定模型'
  const kind = opts.kind ?? 'complete'
  const prev = state.models[model] ?? { calls: 0, approxTokens: 0, promptChars: 0, lastUsedAt: 0 }
  state.models[model] = {
    calls: prev.calls + 1,
    approxTokens: prev.approxTokens + (opts.approxTokens ?? 0),
    promptChars: prev.promptChars + (opts.promptChars ?? 0),
    lastUsedAt: Date.now()
  }
  state.aiCalls[kind] = (state.aiCalls[kind] ?? 0) + 1
  state.lastActiveAt = Date.now()
  cache = state
  void persist()
}

/** 记录页面访问 */
export async function recordPageVisit(page: string): Promise<void> {
  if (!page) return
  const state = await loadUsageStats()
  const prev = state.pages[page] ?? { visits: 0, lastVisitedAt: 0 }
  state.pages[page] = { visits: prev.visits + 1, lastVisitedAt: Date.now() }
  state.lastActiveAt = Date.now()
  cache = state
  void persist()
}

/** 按智能体 / 任务累计用量（Multica D5） */
export async function recordAgentRunUsage(opts: {
  agentId: string
  agentName?: string
  issueId: string
  approxTokens: number
  failed?: boolean
}): Promise<void> {
  const state = await loadUsageStats()
  const key = opts.agentName || opts.agentId
  const prev = state.agents[key] ?? { runs: 0, approxTokens: 0, failures: 0, lastRunAt: 0 }
  state.agents[key] = {
    runs: prev.runs + 1,
    approxTokens: prev.approxTokens + (opts.approxTokens || 0),
    failures: prev.failures + (opts.failed ? 1 : 0),
    lastRunAt: Date.now()
  }
  const ip = state.issues[opts.issueId] ?? { runs: 0, approxTokens: 0 }
  state.issues[opts.issueId] = {
    runs: ip.runs + 1,
    approxTokens: ip.approxTokens + (opts.approxTokens || 0)
  }
  state.aiCalls.agentRun = (state.aiCalls.agentRun ?? 0) + 1
  state.lastActiveAt = Date.now()
  cache = state
  void persist()
}

export async function resetUsageStats(): Promise<UsageStatsState> {
  cache = {
    ...DEFAULT,
    models: {},
    pages: {},
    agents: {},
    issues: {},
    aiCalls: { chat: 0, complete: 0, rightClick: 0, agentRun: 0 },
    startedAt: Date.now()
  }
  void persist()
  return cache
}

/** 粗略 token 估算（与项目其它模块一致：约 1.6 字/token 中英混合） */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.round(text.length / 1.6))
}
