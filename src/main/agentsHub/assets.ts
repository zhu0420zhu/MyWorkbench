/**
 * 资产中心（EvoFlow B3）：经验卡 / 反思 / 画像 / 跨任务记忆
 * 执行完成后自动沉淀经验与反思。
 */
import type { AgentRoleBrief, IssueBrief } from '../../shared/types.ts'
import { complete } from '../ai.ts'
import { addExperience, addMemory } from './store.ts'

export async function writeExperienceFromRun(opts: {
  agent: AgentRoleBrief
  issue: IssueBrief
  output: string
}): Promise<void> {
  const title = opts.issue.title.slice(0, 40)
  await addExperience({
    title: `完成：${title}`,
    body: opts.output.slice(0, 500),
    tags: ['run', opts.agent.name],
    sourceIssueId: opts.issue.id
  })
  // 反思（可失败，不阻断）
  void (async () => {
    try {
      const r = await complete(
        [
          {
            role: 'user',
            content: `你是智能体「${opts.agent.name}」。请用 80 字内反思刚完成的任务「${opts.issue.title}」：做对了什么、下次改进什么。只输出反思正文。`
          }
        ],
        { usageKind: 'complete' }
      )
      if (r.ok && r.text) {
        await addMemory({
          agentId: opts.agent.id,
          kind: 'reflection',
          body: r.text.trim().slice(0, 400)
        })
      }
    } catch {
      /* ignore */
    }
  })()
  // 长期画像：偶尔更新
  void (async () => {
    try {
      const r = await complete(
        [
          {
            role: 'user',
            content: `根据角色说明「${opts.agent.description}」和近期任务「${opts.issue.title}」，用 60 字写该智能体的稳定画像（擅长什么、语气）。只输出画像。`
          }
        ],
        { usageKind: 'complete' }
      )
      if (r.ok && r.text) {
        await addMemory({
          agentId: opts.agent.id,
          kind: 'profile',
          body: r.text.trim().slice(0, 300)
        })
      }
    } catch {
      /* ignore */
    }
  })()
}

export async function rememberFacts(agentId: string, body: string): Promise<void> {
  await addMemory({ agentId, kind: 'memory', body: body.slice(0, 400) })
}
