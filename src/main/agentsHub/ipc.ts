/**
 * 智能体任务中心 IPC + Autopilot 调度
 */
import { ipcMain } from 'electron'
import type { AgentRoleBrief, AutopilotBrief, SquadBrief } from '../../shared/types.ts'
import {
  addIssueComment,
  addExperience,
  addMemory,
  bindAgentSkills,
  clearInbox,
  createIssue,
  detectRuntimes,
  getCodeIndex,
  listAgents,
  listAutopilots,
  listIssues,
  listRuns,
  listSquads,
  markInboxRead,
  removeAgent,
  removeAutopilot,
  removeIssue,
  renameWorkspace,
  setCodeIndex,
  setDuty,
  snapshotHub,
  touchAutopilot,
  upsertAgent,
  upsertApp,
  upsertAutopilot,
  upsertGoal,
  upsertImChannel,
  upsertPlan,
  upsertSquad,
  upsertWorkspaceDir,
  updateIssue
} from './store.ts'
import { executePlan, generatePlan, advanceGoal, reviewIssue, runApp, runIssue } from './runner.ts'
import { buildCodeIndex, querySymbols } from './codeIndex.ts'
import { dispatchToIm, testImChannel } from './im.ts'
import { fetchCatalog, installResourcePack } from './market.ts'
import { runSandboxCommand } from './sandbox.ts'

let timer: ReturnType<typeof setInterval> | null = null

export function startAutopilotLoop(): void {
  if (timer) return
  timer = setInterval(
    () => {
      void tickAutopilots()
    },
    60_000
  )
}

export function stopAutopilotLoop(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** 分钟级检查到期 Autopilot → 生成报告 issue 并跑一次 */
async function tickAutopilots(): Promise<void> {
  const now = Date.now()
  const list = await listAutopilots()
  for (const ap of list) {
    if (!ap.enabled) continue
    if (ap.nextRunAt && ap.nextRunAt > now) continue
    try {
      const agents = await listAgents()
      const assigneeId = agents[0]?.id
      const issue = await createIssue({
        title: `${ap.name} · ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        body: ap.prompt,
        assigneeId,
        labels: [ap.label, 'autopilot'],
        status: assigneeId ? 'ready' : 'backlog'
      })
      await touchAutopilot(ap.id, now)
      if (assigneeId) void runIssue(issue.id, { source: 'autopilot', maxAttempts: 2 })
    } catch {
      /* ignore */
    }
  }
}

export function registerAgentsHubIpc(): void {
  ipcMain.handle('hub:snapshot', () => snapshotHub())
  ipcMain.handle('hub:runtimes', () => detectRuntimes())
  ipcMain.handle('hub:rename-workspace', (_e, name: string) => renameWorkspace(name))

  ipcMain.handle('hub:list-agents', () => listAgents())
  ipcMain.handle('hub:upsert-agent', (_e, input: Partial<AgentRoleBrief> & { name: string }) => upsertAgent(input))
  ipcMain.handle('hub:remove-agent', (_e, id: string) => removeAgent(id))
  ipcMain.handle('hub:bind-skills', (_e, agentId: string, skillIds: string[]) => bindAgentSkills(agentId, skillIds))

  ipcMain.handle('hub:list-squads', () => listSquads())
  ipcMain.handle('hub:upsert-squad', (_e, input: Partial<SquadBrief> & { name: string }) => upsertSquad(input))

  ipcMain.handle('hub:list-issues', () => listIssues())
  ipcMain.handle('hub:create-issue', (_e, input: Parameters<typeof createIssue>[0]) => createIssue(input))
  ipcMain.handle('hub:update-issue', (_e, id: string, patch: Parameters<typeof updateIssue>[1]) => updateIssue(id, patch))
  ipcMain.handle('hub:comment-issue', (_e, issueId: string, author: string, kind: 'human' | 'agent', body: string) =>
    addIssueComment(issueId, author, kind, body)
  )
  ipcMain.handle('hub:remove-issue', (_e, id: string) => removeIssue(id))
  ipcMain.handle('hub:run-issue', (_e, id: string, force?: boolean) =>
    runIssue(id, { force: !!force, source: 'manual' })
  )
  ipcMain.handle('hub:review-issue', (_e, id: string, approve: boolean, note?: string) => reviewIssue(id, approve, note))

  ipcMain.handle('hub:list-runs', (_e, issueId?: string) => listRuns(issueId))
  ipcMain.handle('hub:inbox-read', (_e, id: string, read?: boolean) => markInboxRead(id, read !== false))
  ipcMain.handle('hub:inbox-clear', () => clearInbox())

  ipcMain.handle('hub:list-autopilots', () => listAutopilots())
  ipcMain.handle('hub:upsert-autopilot', (_e, input: Partial<AutopilotBrief> & { name: string }) => upsertAutopilot(input))
  ipcMain.handle('hub:remove-autopilot', (_e, id: string) => removeAutopilot(id))

  // EvoFlow：Plan / Goal / Duty / Apps / Workspaces / Assets / Code / IM / Sandbox
  ipcMain.handle('hub:generate-plan', (_e, opts: { title: string; detail?: string; issueId?: string; goalId?: string }) =>
    generatePlan(opts)
  )
  ipcMain.handle('hub:execute-plan', (_e, planId: string) => executePlan(planId))
  ipcMain.handle('hub:upsert-plan', (_e, input: Parameters<typeof upsertPlan>[0]) => upsertPlan(input))
  ipcMain.handle('hub:upsert-goal', (_e, input: Parameters<typeof upsertGoal>[0]) => upsertGoal(input))
  ipcMain.handle('hub:advance-goal', (_e, goalId: string) => advanceGoal(goalId))
  ipcMain.handle('hub:set-duty', (_e, slots: Parameters<typeof setDuty>[0]) => setDuty(slots))
  ipcMain.handle('hub:upsert-app', (_e, input: Parameters<typeof upsertApp>[0]) => upsertApp(input))
  ipcMain.handle('hub:run-app', (_e, appId: string) => runApp(appId))
  ipcMain.handle('hub:upsert-workspace-dir', (_e, input: Parameters<typeof upsertWorkspaceDir>[0]) =>
    upsertWorkspaceDir(input)
  )
  ipcMain.handle('hub:add-experience', (_e, input: Parameters<typeof addExperience>[0]) => addExperience(input))
  ipcMain.handle('hub:add-memory', (_e, input: Parameters<typeof addMemory>[0]) => addMemory(input))
  ipcMain.handle('hub:upsert-im', (_e, input: Parameters<typeof upsertImChannel>[0]) => upsertImChannel(input))
  ipcMain.handle('hub:send-im', async (_e, channelId: string, title: string, body: string) => {
    const s = await snapshotHub()
    const ch = s.imChannels.find((c) => c.id === channelId)
    if (!ch) return { ok: false, error: '渠道不存在' }
    return dispatchToIm(ch, title, body)
  })
  ipcMain.handle('hub:code-index-build', async (_e, rootDir: string) => {
    const map = new Map<string, string>()
    const symbols = await buildCodeIndex(rootDir, map)
    await setCodeIndex(symbols)
    return symbols
  })
  ipcMain.handle('hub:code-index-query', async (_e, q: string) => querySymbols(await getCodeIndex(), q))
  ipcMain.handle('hub:sandbox-run', (_e, cwd: string, command: string, timeoutMs?: number) =>
    runSandboxCommand(cwd, command, timeoutMs)
  )
  ipcMain.handle('hub:test-im', (_e, channel: Parameters<typeof testImChannel>[0]) => testImChannel(channel))
  ipcMain.handle('hub:market-catalog', (_e, remoteUrl?: string) => fetchCatalog(remoteUrl))
  ipcMain.handle('hub:market-install', (_e, id: string) => installResourcePack(id))

  startAutopilotLoop()
}
