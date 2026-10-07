/**
 * 智能体执行器：AI 脑 + CLI 脑 + 重试 + 依赖门控 + 审核门
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { AgentRoleBrief, IssueBrief, RunBrief, RunLogEvent } from '../../shared/types.ts'
import { complete } from '../ai.ts'
import { recordAgentRunUsage } from '../usageStats.ts'
import {
  addIssueComment,
  appendRun,
  detectRuntimes,
  loadHub,
  pushInbox,
  updateIssue,
  updateRun,
  upsertPlan,
  upsertGoal,
  upsertApp
} from './store.ts'
import { writeExperienceFromRun } from './assets.ts'
import { dispatchToIm } from './im.ts'
import { runSandboxCommand } from './sandbox.ts'

const MAX_OUTPUT = 8000

function log(ev: RunLogEvent[]): (level: RunLogEvent['level'], message: string) => void {
  return (level, message) => {
    ev.push({ t: Date.now(), level, message })
  }
}

async function readRepoContext(repoPath?: string): Promise<string> {
  if (!repoPath) return ''
  try {
    const st = await fs.stat(repoPath)
    if (st.isFile()) {
      const txt = await fs.readFile(repoPath, 'utf-8')
      return `\n\n【绑定文件】${repoPath}\n${txt.slice(0, 4000)}`
    }
    // 目录：列文件名 + 读 README
    const names = (await fs.readdir(repoPath)).slice(0, 40)
    let readme = ''
    for (const n of ['README.md', 'readme.md', 'README.zh.md']) {
      try {
        readme = await fs.readFile(join(repoPath, n), 'utf-8')
        break
      } catch {
        /* continue */
      }
    }
    return `\n\n【绑定仓库】${repoPath}\n文件：${names.join(', ')}\n${readme ? readme.slice(0, 3000) : ''}`
  } catch {
    return ''
  }
}

function skillsHint(agent: AgentRoleBrief, skillTemplates: string[]): string {
  if (!skillTemplates.length) return ''
  return `\n\n【已装备技能摘要】\n${skillTemplates.slice(0, 3).join('\n---\n')}`
}

async function loadSkillTexts(skillIds: string[]): Promise<string[]> {
  if (!skillIds.length) return []
  try {
    const raw = await fs.readFile(join(app.getPath('userData'), 'novel', 'skills', 'index.json'), 'utf-8')
    const parsed = JSON.parse(raw) as { skills: Array<{ id: string; name: string; template: string }> }
    return parsed.skills
      .filter((s) => skillIds.includes(s.id))
      .map((s) => `技能「${s.name}」：${s.template.slice(0, 400)}`)
  } catch {
    return []
  }
}

async function runCliAgent(cmd: string, prompt: string, events: RunLogEvent[], push: ReturnType<typeof log>): Promise<string> {
  push('tool', `调用 CLI：${cmd}`)
  return new Promise((resolve) => {
    const child = execFile(cmd, ['-p', prompt], { timeout: 180_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        push('error', String(err.message).slice(0, 400))
        if (stderr) push('warn', String(stderr).slice(0, 400))
        // 回退 AI 脑
        resolve('')
        return
      }
      if (stderr) push('info', String(stderr).slice(0, 200))
      resolve(String(stdout || '').slice(0, MAX_OUTPUT))
    })
    child.stdout?.on('data', (d: Buffer) => push('info', d.toString().slice(0, 200)))
  })
}

export interface RunIssueOptions {
  maxAttempts?: number
  force?: boolean
  source?: 'manual' | 'chat' | 'autopilot' | 'retry'
}

/**
 * 执行任务：依赖门控 → 组上下文 → 跑 Agent → 评论/审核门/重试
 */
export async function runIssue(issueId: string, opts: RunIssueOptions = {}): Promise<{ ok: boolean; runId?: string; error?: string }> {
  const hub = await loadHub()
  const issue = hub.issues.find((i) => i.id === issueId)
  if (!issue) return { ok: false, error: '任务不存在' }

  // 依赖门控（Multica B6）
  const blockers = issue.blockedBy
    .map((id) => hub.issues.find((x) => x.id === id))
    .filter(Boolean) as IssueBrief[]
  const blocked = blockers.filter((b) => b.status !== 'done')
  if (blocked.length && !opts.force) {
    await pushInbox({
      kind: 'blocked',
      title: `任务被依赖阻塞：${issue.title}`,
      body: `等待完成：${blocked.map((b) => b.title).join('、')}`,
      issueId
    })
    return { ok: false, error: '存在未完成的前置任务' }
  }

  let agent = hub.agents.find((a) => a.id === issue.assigneeId)
  if (!agent) {
    // 队长派活：小队 leader 或默认建一个 AI 角色
    const squad = hub.squads.find((s) => s.id === issue.squadId)
    agent = hub.agents.find((a) => a.id === squad?.leaderId) ?? hub.agents[0]
  }
  if (!agent) {
    agent = {
      id: 'auto-writer',
      name: '默认写手',
      description: '通用任务执行',
      brain: 'ai',
      skillIds: [],
      visibility: 'private',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  }

  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3)
  const events: RunLogEvent[] = []
  const push = log(events)
  const started = Date.now()
  const runId = randomUUID()
  const skillTexts = await loadSkillTexts(agent.skillIds)
  const repoCtx = await readRepoContext(issue.repoPath)

  const prompt = [
    `你是智能体「${agent.name}」。${agent.description || ''}`,
    '请完成下面的任务，直接输出结果正文，不要寒暄。',
    skillsHint(agent, skillTexts),
    repoCtx,
    `\n【任务】${issue.title}\n【说明】${issue.body}`,
    issue.comments.length ? `\n【讨论】\n${issue.comments.slice(-5).map((c) => `${c.author}: ${c.body}`).join('\n')}` : ''
  ].join('\n')

  push('info', `开始执行（第 1/${maxAttempts} 次）brain=${agent.brain}`)
  await updateIssue(issueId, { status: 'running' })

  let lastError = ''
  let output = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const run: RunBrief = {
      id: attempt === 1 ? runId : `${runId}-${attempt}`,
      issueId,
      agentId: agent.id,
      status: 'running',
      attempt,
      maxAttempts,
      startedAt: Date.now(),
      inputPreview: prompt.slice(0, 200),
      events: [...events],
      approxTokens: 0
    }
    await appendRun(run)
    try {
      let text = ''
      if (agent.brain === 'cli' && agent.cliCommand) {
        const rt = detectRuntimes().find((r) => r.id === agent.cliCommand)
        if (rt?.available) {
          text = await runCliAgent(rt.id, prompt, events, push)
        } else {
          push('warn', `CLI ${agent.cliCommand} 不可用，回退 AI 脑`)
        }
      }
      if (!text) {
        push('tool', 'AI complete…')
        const r = await complete([{ role: 'user', content: prompt }], { usageKind: 'complete' })
        if (!r.ok) throw new Error(r.error || 'AI 调用失败')
        text = (r.text || '').trim()
      }
      output = text.slice(0, MAX_OUTPUT)
      const approx = Math.round((prompt.length + output.length) / 1.6)
      await updateRun(run.id, {
        status: 'success',
        output,
        endedAt: Date.now(),
        durationMs: Date.now() - run.startedAt,
        events: [...events],
        approxTokens: approx
      })
      await addIssueComment(issueId, agent.name, 'agent', output.slice(0, 2000) || '(空结果)')
      // 审核门（Multica B3）：不自动 done，进 review 交给人
      await updateIssue(issueId, { status: 'review' })
      await pushInbox({
        kind: 'review',
        title: `待审核：${issue.title}`,
        body: `${agent.name} 已完成，共约 ${approx} tokens。请到任务看板确认。`,
        issueId,
        runId: run.id
      })
      await recordAgentRunUsage({
        agentId: agent.id,
        agentName: agent.name,
        issueId,
        approxTokens: approx
      })
      // EvoFlow 资产中心：经验 + 反思 + 画像
      void writeExperienceFromRun({ agent, issue, output })
      push('info', '完成，已进入待审核')
      return { ok: true, runId: run.id }
    } catch (err) {
      lastError = (err as Error).message
      push('error', `第 ${attempt} 次失败：${lastError}`)
      await updateRun(run.id, {
        status: 'failed',
        error: lastError,
        endedAt: Date.now(),
        events: [...events],
        durationMs: Date.now() - run.startedAt
      })
      await recordAgentRunUsage({
        agentId: agent.id,
        agentName: agent.name,
        issueId,
        approxTokens: 0,
        failed: true
      })
      // 自动重试（Multica D7 / B7）
      if (attempt < maxAttempts) {
        push('info', `自动重试 ${attempt + 1}/${maxAttempts}…`)
        await new Promise((r) => setTimeout(r, 800 * attempt))
        continue
      }
      await updateIssue(issueId, { status: 'failed' })
      await pushInbox({
        kind: 'failed',
        title: `执行失败：${issue.title}`,
        body: lastError,
        issueId
      })
      return { ok: false, runId: run.id, error: lastError }
    }
  }
  return { ok: false, error: lastError || '未能完成' }
}

/** 人工审核：通过 → done；驳回 → ready 可重跑 */
export async function reviewIssue(issueId: string, approve: boolean, note?: string): Promise<void> {
  await updateIssue(issueId, { status: approve ? 'done' : 'ready' })
  await addIssueComment(issueId, '我', 'human', note || (approve ? '审核通过' : '驳回，请修改后重跑'))
}

/** EvoFlow A1：生成 Plan（可修订） */
export async function generatePlan(opts: {
  title: string
  detail?: string
  issueId?: string
  goalId?: string
}): Promise<{ ok: boolean; planId?: string; error?: string }> {
  const r = await complete(
    [
      {
        role: 'user',
        content: `你是计划助手。把下面目标拆成 5-8 个可执行步骤，每步一行「标题 | 说明」。不要其它文字。\n【目标】${opts.title}\n${opts.detail || ''}`
      }
    ],
    { usageKind: 'complete' }
  )
  if (!r.ok) return { ok: false, error: r.error || '计划生成失败' }
  const steps = (r.text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      const [t, d] = l.split('|').map((x) => x.trim())
      return { id: `p${i + 1}`, title: (t || l).replace(/^[-*\d.]+\s*/, '').slice(0, 40), detail: d || l, done: false }
    })
  const plan = await upsertPlan({
    title: opts.title,
    issueId: opts.issueId,
    goalId: opts.goalId,
    steps: steps.length ? steps : [{ id: 'p1', title: opts.title, detail: opts.detail || '', done: false }],
    status: 'draft'
  })
  await pushInbox({
    kind: 'plan',
    title: `计划待修订：${opts.title}`,
    body: `已生成 ${plan.steps.length} 步，修订后点「执行计划」`,
    issueId: opts.issueId
  })
  return { ok: true, planId: plan.id }
}

/** EvoFlow A1：按 Plan 逐步执行（每步建 issue 并跑） */
export async function executePlan(planId: string): Promise<{ ok: boolean; error?: string }> {
  const hub = await loadHub()
  const plan = hub.plans.find((p) => p.id === planId)
  if (!plan) return { ok: false, error: '计划不存在' }
  await upsertPlan({ ...plan, status: 'executing' })
  for (const step of plan.steps) {
    if (step.done) continue
    const issue = await (await import('./store.ts')).createIssue({
      title: `${plan.title} · ${step.title}`,
      body: step.detail,
      labels: ['plan'],
      status: 'ready'
    })
    const r = await runIssue(issue.id, { source: 'manual', maxAttempts: 2 })
    if (r.ok) {
      step.done = true
      await upsertPlan({ ...plan, steps: [...plan.steps], status: 'executing' })
    }
  }
  await upsertPlan({ ...plan, status: 'done' })
  return { ok: true }
}

/** EvoFlow A2：推进 Goal 当前阶段 */
export async function advanceGoal(goalId: string): Promise<{ ok: boolean; error?: string }> {
  const hub = await loadHub()
  const goal = hub.goals.find((g) => g.id === goalId)
  if (!goal) return { ok: false, error: '目标不存在' }
  const stage = goal.stages.find((s) => !s.done)
  if (!stage) {
    await upsertGoal({ ...goal, status: 'done' })
    return { ok: true }
  }
  await upsertGoal({ ...goal, status: 'running' })
  const issue = await (await import('./store.ts')).createIssue({
    title: `${goal.title} · ${stage.title}`,
    body: goal.description,
    labels: ['goal'],
    status: 'ready',
    repoPath: goal.workspaceDir
  })
  const r = await runIssue(issue.id, { source: 'manual', maxAttempts: 2 })
  if (r.ok) {
    stage.done = true
    await upsertGoal({ ...goal, stages: [...goal.stages], status: goal.stages.every((s) => s.done || s === stage) ? 'done' : 'running' })
  } else {
    await upsertGoal({ ...goal, status: 'paused' })
  }
  return r
}

/** EvoFlow A5：跑应用节点链 */
export async function runApp(appId: string): Promise<{ ok: boolean; error?: string; output?: string }> {
  const hub = await loadHub()
  const appItem = hub.apps.find((a) => a.id === appId)
  if (!appItem) return { ok: false, error: '应用不存在' }
  let last = ''
  for (const node of appItem.nodes) {
    const issue = await (await import('./store.ts')).createIssue({
      title: `${appItem.name} · ${node.title}`,
      body: node.prompt,
      labels: ['app'],
      status: 'ready'
    })
    const r = await runIssue(issue.id, { maxAttempts: 2 })
    if (!r.ok) return { ok: false, error: r.error }
    last = node.title
  }
  // IM 派发
  if (appItem.imChannelId) {
    const ch = hub.imChannels.find((c) => c.id === appItem.imChannelId)
    if (ch) await dispatchToIm(ch, `应用完成：${appItem.name}`, `全部节点已跑完（${last}）`)
  }
  return { ok: true, output: last }
}
