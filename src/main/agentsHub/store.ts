/**
 * 智能体任务中心存储（对标 Multica）
 * userData/agents-hub.json 单文件：workspace / agents / squads / issues / runs / inbox / autopilots
 */
import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type {
  AgentHubSnapshot,
  AgentMemory,
  AgentRoleBrief,
  AutopilotBrief,
  CodeSymbol,
  DutySlot,
  EvoApp,
  ExperienceCard,
  GoalBrief,
  ImChannel,
  InboxItem,
  IssueBrief,
  IssueComment,
  IssueStatus,
  PlanBrief,
  RunBrief,
  SandboxRun,
  SquadBrief,
  WorkspaceBrief,
  WorkspaceDir
} from '../../shared/types.ts'

interface HubState {
  version: 2
  workspace: WorkspaceBrief
  agents: AgentRoleBrief[]
  squads: SquadBrief[]
  issues: IssueBrief[]
  runs: RunBrief[]
  inbox: InboxItem[]
  autopilots: AutopilotBrief[]
  plans: PlanBrief[]
  goals: GoalBrief[]
  duty: DutySlot[]
  apps: EvoApp[]
  workspaces: WorkspaceDir[]
  experiences: ExperienceCard[]
  memories: AgentMemory[]
  imChannels: ImChannel[]
  sandboxRuns: SandboxRun[]
  codeIndex: CodeSymbol[]
}

function file(): string {
  return join(app.getPath('userData'), 'agents-hub.json')
}

function defaultState(): HubState {
  const now = Date.now()
  return {
    version: 2,
    workspace: { id: 'default', name: '默认工作区', createdAt: now },
    agents: [],
    squads: [],
    issues: [],
    runs: [],
    inbox: [],
    autopilots: [],
    plans: [],
    goals: [],
    duty: [],
    apps: [],
    workspaces: [],
    experiences: [],
    memories: [],
    imChannels: [],
    sandboxRuns: [],
    codeIndex: []
  }
}

let cache: HubState | null = null
let queue: Promise<void> = Promise.resolve()

export async function loadHub(): Promise<HubState> {
  if (cache) return cache
  try {
    const raw = JSON.parse(await fs.readFile(file(), 'utf-8')) as Partial<HubState>
    cache = {
      ...defaultState(),
      ...raw,
      agents: raw.agents ?? [],
      squads: raw.squads ?? [],
      issues: raw.issues ?? [],
      runs: raw.runs ?? [],
      inbox: raw.inbox ?? [],
      autopilots: raw.autopilots ?? [],
      plans: raw.plans ?? [],
      goals: raw.goals ?? [],
      duty: raw.duty ?? [],
      apps: raw.apps ?? [],
      workspaces: raw.workspaces ?? [],
      experiences: raw.experiences ?? [],
      memories: raw.memories ?? [],
      imChannels: raw.imChannels ?? [],
      sandboxRuns: raw.sandboxRuns ?? [],
      codeIndex: raw.codeIndex ?? [],
      workspace: raw.workspace ?? defaultState().workspace
    }
  } catch {
    cache = defaultState()
  }
  return cache
}

async function persist(): Promise<void> {
  const st = cache
  if (!st) return
  queue = queue.then(async () => {
    try {
      await fs.mkdir(app.getPath('userData'), { recursive: true })
      await fs.writeFile(file(), JSON.stringify(st, null, 2), 'utf-8')
    } catch {
      /* ignore */
    }
  })
}

export async function snapshotHub(): Promise<AgentHubSnapshot> {
  const st = await loadHub()
  return {
    workspace: st.workspace,
    agents: st.agents,
    squads: st.squads,
    issues: [...st.issues].sort((a, b) => b.updatedAt - a.updatedAt),
    runs: [...st.runs].sort((a, b) => b.startedAt - a.startedAt).slice(0, 100),
    inbox: [...st.inbox].sort((a, b) => b.createdAt - a.createdAt),
    autopilots: st.autopilots,
    runtimes: detectRuntimes(),
    plans: [...st.plans].sort((a, b) => b.updatedAt - a.updatedAt),
    goals: [...st.goals].sort((a, b) => b.updatedAt - a.updatedAt),
    duty: st.duty,
    apps: st.apps,
    workspaces: st.workspaces,
    experiences: [...st.experiences].sort((a, b) => b.createdAt - a.createdAt),
    memories: [...st.memories].sort((a, b) => b.createdAt - a.createdAt),
    imChannels: st.imChannels,
    sandboxRuns: [...st.sandboxRuns].slice(0, 50)
  }
}

/** 本机 Agent CLI 探测（Multica C1：26 种 CLI 的精简探测集） */
export function detectRuntimes(): Array<{ id: string; label: string; available: boolean; path?: string }> {
  const list = [
    { id: 'claude', label: 'Claude Code' },
    { id: 'codex', label: 'OpenAI Codex' },
    { id: 'kimi', label: 'Kimi' },
    { id: 'qwen', label: 'Qwen Code' },
    { id: 'grok', label: 'Grok' },
    { id: 'opencode', label: 'OpenCode' },
    { id: 'copilot', label: 'Copilot CLI' },
    { id: 'cursor-agent', label: 'Cursor Agent' },
    { id: 'mcode', label: 'MiniMax Code' },
    { id: 'traecli', label: 'Trae CLI' }
  ]
  const { execSync } = require('node:child_process') as typeof import('node:child_process')
  return list.map((r) => {
    try {
      const cmd = process.platform === 'win32' ? `where.exe ${r.id}` : `command -v ${r.id}`
      const out = execSync(cmd, { encoding: 'utf-8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)[0]
      return { ...r, available: !!out, path: out }
    } catch {
      return { ...r, available: false }
    }
  })
}

/* ---------------- agents ---------------- */
export async function listAgents(): Promise<AgentRoleBrief[]> {
  const st = await loadHub()
  return st.agents
}

export async function upsertAgent(input: Partial<AgentRoleBrief> & { name: string }): Promise<AgentRoleBrief> {
  const st = await loadHub()
  const now = Date.now()
  if (input.id) {
    const i = st.agents.findIndex((a) => a.id === input.id)
    if (i >= 0) {
      st.agents[i] = { ...st.agents[i], ...input, updatedAt: now }
      await persist()
      return st.agents[i]
    }
  }
  const a: AgentRoleBrief = {
    id: input.id || randomUUID(),
    name: input.name,
    description: input.description ?? '',
    brain: input.brain ?? 'ai',
    cliCommand: input.cliCommand,
    skillIds: input.skillIds ?? [],
    squadId: input.squadId,
    visibility: input.visibility ?? 'private',
    createdAt: now,
    updatedAt: now
  }
  st.agents.push(a)
  await persist()
  return a
}

export async function removeAgent(id: string): Promise<void> {
  const st = await loadHub()
  st.agents = st.agents.filter((a) => a.id !== id)
  st.squads = st.squads.map((s) => ({ ...s, memberIds: s.memberIds.filter((m) => m !== id), leaderId: s.leaderId === id ? undefined : s.leaderId }))
  await persist()
}

/** 绑定技能到角色（Multica D2） */
export async function bindAgentSkills(agentId: string, skillIds: string[]): Promise<AgentRoleBrief | null> {
  const st = await loadHub()
  const a = st.agents.find((x) => x.id === agentId)
  if (!a) return null
  a.skillIds = [...new Set(skillIds)]
  a.updatedAt = Date.now()
  await persist()
  return a
}

/* ---------------- squads ---------------- */
export async function listSquads(): Promise<SquadBrief[]> {
  const st = await loadHub()
  return st.squads
}

export async function upsertSquad(input: Partial<SquadBrief> & { name: string }): Promise<SquadBrief> {
  const st = await loadHub()
  if (input.id) {
    const i = st.squads.findIndex((s) => s.id === input.id)
    if (i >= 0) {
      st.squads[i] = { ...st.squads[i], ...input }
      await persist()
      return st.squads[i]
    }
  }
  const s: SquadBrief = {
    id: input.id || randomUUID(),
    name: input.name,
    leaderId: input.leaderId,
    memberIds: input.memberIds ?? [],
    createdAt: Date.now()
  }
  st.squads.push(s)
  await persist()
  return s
}

/* ---------------- issues ---------------- */
export async function listIssues(): Promise<IssueBrief[]> {
  const st = await loadHub()
  return [...st.issues].sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function createIssue(input: {
  title: string
  body?: string
  assigneeId?: string
  squadId?: string
  repoPath?: string
  labels?: string[]
  status?: IssueStatus
}): Promise<IssueBrief> {
  const st = await loadHub()
  const now = Date.now()
  const issue: IssueBrief = {
    id: randomUUID(),
    workspaceId: st.workspace.id,
    title: input.title,
    body: input.body ?? '',
    status: input.status ?? (input.assigneeId ? 'ready' : 'backlog'),
    assigneeId: input.assigneeId,
    squadId: input.squadId,
    blockedBy: [],
    repoPath: input.repoPath,
    labels: input.labels ?? [],
    comments: [],
    createdAt: now,
    updatedAt: now
  }
  st.issues.unshift(issue)
  await persist()
  return issue
}

export async function updateIssue(
  id: string,
  patch: Partial<Pick<IssueBrief, 'title' | 'body' | 'status' | 'assigneeId' | 'squadId' | 'repoPath' | 'labels' | 'blockedBy'>>
): Promise<IssueBrief | null> {
  const st = await loadHub()
  const i = st.issues.findIndex((x) => x.id === id)
  if (i < 0) return null
  st.issues[i] = { ...st.issues[i], ...patch, updatedAt: Date.now() }
  if (patch.status === 'done' && !st.issues[i].completedAt) st.issues[i].completedAt = Date.now()
  await persist()
  return st.issues[i]
}

export async function addIssueComment(issueId: string, author: string, kind: IssueComment['kind'], body: string): Promise<IssueComment | null> {
  const st = await loadHub()
  const i = st.issues.findIndex((x) => x.id === issueId)
  if (i < 0) return null
  const c: IssueComment = { id: randomUUID(), author, kind, body, at: Date.now() }
  st.issues[i].comments.push(c)
  st.issues[i].updatedAt = Date.now()
  await persist()
  return c
}

export async function removeIssue(id: string): Promise<void> {
  const st = await loadHub()
  st.issues = st.issues.filter((x) => x.id !== id)
  st.issues = st.issues.map((x) => ({ ...x, blockedBy: x.blockedBy.filter((b) => b !== id) }))
  await persist()
}

/* ---------------- runs ---------------- */
export async function appendRun(run: RunBrief): Promise<void> {
  const st = await loadHub()
  st.runs.unshift(run)
  if (st.runs.length > 200) st.runs.length = 200
  await persist()
}

export async function updateRun(id: string, patch: Partial<RunBrief>): Promise<void> {
  const st = await loadHub()
  const i = st.runs.findIndex((r) => r.id === id)
  if (i < 0) return
  st.runs[i] = { ...st.runs[i], ...patch }
  await persist()
}

export async function listRuns(issueId?: string): Promise<RunBrief[]> {
  const st = await loadHub()
  const runs = issueId ? st.runs.filter((r) => r.issueId === issueId) : st.runs
  return [...runs].sort((a, b) => b.startedAt - a.startedAt)
}

/* ---------------- inbox ---------------- */
export async function pushInbox(item: Omit<InboxItem, 'id' | 'createdAt' | 'read'>): Promise<InboxItem> {
  const st = await loadHub()
  const it: InboxItem = { ...item, id: randomUUID(), read: false, createdAt: Date.now() }
  st.inbox.unshift(it)
  if (st.inbox.length > 200) st.inbox.length = 200
  await persist()
  return it
}

export async function markInboxRead(id: string, read = true): Promise<void> {
  const st = await loadHub()
  const it = st.inbox.find((x) => x.id === id)
  if (it) {
    it.read = read
    await persist()
  }
}

export async function clearInbox(): Promise<void> {
  const st = await loadHub()
  st.inbox = []
  await persist()
}

/* ---------------- autopilots ---------------- */
export async function listAutopilots(): Promise<AutopilotBrief[]> {
  const st = await loadHub()
  return st.autopilots
}

export async function upsertAutopilot(input: Partial<AutopilotBrief> & { name: string }): Promise<AutopilotBrief> {
  const st = await loadHub()
  const now = Date.now()
  if (input.id) {
    const i = st.autopilots.findIndex((a) => a.id === input.id)
    if (i >= 0) {
      st.autopilots[i] = {
        ...st.autopilots[i],
        ...input,
        nextRunAt: input.enabled === false ? undefined : now + (input.intervalMinutes ?? st.autopilots[i].intervalMinutes) * 60_000
      }
      await persist()
      return st.autopilots[i]
    }
  }
  const ap: AutopilotBrief = {
    id: input.id || randomUUID(),
    name: input.name,
    intervalMinutes: Math.max(5, input.intervalMinutes ?? 60),
    enabled: input.enabled !== false,
    kind: input.kind ?? 'report',
    prompt: input.prompt ?? '汇总今日任务进展，输出要点报告。',
    label: input.label ?? 'autopilot',
    createdAt: now,
    nextRunAt: now + Math.max(5, input.intervalMinutes ?? 60) * 60_000
  }
  st.autopilots.push(ap)
  await persist()
  return ap
}

export async function removeAutopilot(id: string): Promise<void> {
  const st = await loadHub()
  st.autopilots = st.autopilots.filter((a) => a.id !== id)
  await persist()
}

export async function touchAutopilot(id: string, lastRunAt: number): Promise<void> {
  const st = await loadHub()
  const a = st.autopilots.find((x) => x.id === id)
  if (!a) return
  a.lastRunAt = lastRunAt
  a.nextRunAt = lastRunAt + a.intervalMinutes * 60_000
  await persist()
}

export async function renameWorkspace(name: string): Promise<WorkspaceBrief> {
  const st = await loadHub()
  st.workspace = { ...st.workspace, name: name || st.workspace.name }
  await persist()
  return st.workspace
}

/* ---------------- EvoFlow 扩展 CRUD ---------------- */
export async function upsertPlan(input: Partial<PlanBrief> & { title: string }): Promise<PlanBrief> {
  const st = await loadHub()
  const now = Date.now()
  if (input.id) {
    const i = st.plans.findIndex((p) => p.id === input.id)
    if (i >= 0) {
      st.plans[i] = { ...st.plans[i], ...input, updatedAt: now }
      await persist()
      return st.plans[i]
    }
  }
  const p: PlanBrief = {
    id: input.id || randomUUID(),
    issueId: input.issueId,
    goalId: input.goalId,
    title: input.title,
    steps: input.steps ?? [],
    status: input.status ?? 'draft',
    createdAt: now,
    updatedAt: now
  }
  st.plans.unshift(p)
  await persist()
  return p
}

export async function listPlans(): Promise<PlanBrief[]> {
  const st = await loadHub()
  return st.plans
}

export async function upsertGoal(input: Partial<GoalBrief> & { title: string }): Promise<GoalBrief> {
  const st = await loadHub()
  const now = Date.now()
  if (input.id) {
    const i = st.goals.findIndex((g) => g.id === input.id)
    if (i >= 0) {
      st.goals[i] = { ...st.goals[i], ...input, updatedAt: now }
      await persist()
      return st.goals[i]
    }
  }
  const g: GoalBrief = {
    id: input.id || randomUUID(),
    title: input.title,
    description: input.description ?? '',
    status: input.status ?? 'idle',
    workspaceDir: input.workspaceDir,
    stages: input.stages ?? [{ id: 's1', title: '阶段 1', done: false }],
    createdAt: now,
    updatedAt: now
  }
  st.goals.unshift(g)
  await persist()
  return g
}

export async function setDuty(slots: DutySlot[]): Promise<DutySlot[]> {
  const st = await loadHub()
  st.duty = slots
  await persist()
  return st.duty
}

export async function upsertApp(input: Partial<EvoApp> & { name: string }): Promise<EvoApp> {
  const st = await loadHub()
  const now = Date.now()
  if (input.id) {
    const i = st.apps.findIndex((a) => a.id === input.id)
    if (i >= 0) {
      st.apps[i] = { ...st.apps[i], ...input }
      await persist()
      return st.apps[i]
    }
  }
  const appItem: EvoApp = {
    id: input.id || randomUUID(),
    name: input.name,
    description: input.description ?? '',
    nodes: input.nodes ?? [{ id: 'n1', title: '步骤 1', prompt: input.description || input.name }],
    intervalMinutes: input.intervalMinutes ?? 0,
    enabled: input.enabled ?? true,
    imChannelId: input.imChannelId,
    createdAt: now
  }
  st.apps.push(appItem)
  await persist()
  return appItem
}

export async function listApps(): Promise<EvoApp[]> {
  const st = await loadHub()
  return st.apps
}

export async function upsertWorkspaceDir(input: Partial<WorkspaceDir> & { name: string; path: string }): Promise<WorkspaceDir> {
  const st = await loadHub()
  if (input.id) {
    const i = st.workspaces.findIndex((w) => w.id === input.id)
    if (i >= 0) {
      st.workspaces[i] = { ...st.workspaces[i], ...input }
      await persist()
      return st.workspaces[i]
    }
  }
  const w: WorkspaceDir = { id: input.id || randomUUID(), name: input.name, path: input.path, createdAt: Date.now() }
  st.workspaces.push(w)
  await persist()
  return w
}

export async function addExperience(e: Omit<ExperienceCard, 'id' | 'createdAt'>): Promise<ExperienceCard> {
  const st = await loadHub()
  const card: ExperienceCard = { ...e, id: randomUUID(), createdAt: Date.now() }
  st.experiences.unshift(card)
  await persist()
  return card
}

export async function addMemory(m: Omit<AgentMemory, 'id' | 'createdAt'>): Promise<AgentMemory> {
  const st = await loadHub()
  const mem: AgentMemory = { ...m, id: randomUUID(), createdAt: Date.now() }
  st.memories.unshift(mem)
  await persist()
  return mem
}

export async function upsertImChannel(input: Partial<ImChannel> & { name: string; webhookUrl: string }): Promise<ImChannel> {
  const st = await loadHub()
  if (input.id) {
    const i = st.imChannels.findIndex((c) => c.id === input.id)
    if (i >= 0) {
      st.imChannels[i] = { ...st.imChannels[i], ...input }
      await persist()
      return st.imChannels[i]
    }
  }
  const c: ImChannel = {
    id: input.id || randomUUID(),
    name: input.name,
    kind: input.kind ?? 'webhook',
    webhookUrl: input.webhookUrl,
    enabled: input.enabled !== false
  }
  st.imChannels.push(c)
  await persist()
  return c
}

export async function appendSandboxRun(r: SandboxRun): Promise<void> {
  const st = await loadHub()
  st.sandboxRuns.unshift(r)
  if (st.sandboxRuns.length > 50) st.sandboxRuns.length = 50
  await persist()
}

export async function setCodeIndex(symbols: CodeSymbol[]): Promise<CodeSymbol[]> {
  const st = await loadHub()
  st.codeIndex = symbols
  await persist()
  return symbols
}

export async function getCodeIndex(): Promise<CodeSymbol[]> {
  const st = await loadHub()
  return st.codeIndex
}
