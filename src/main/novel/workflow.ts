/**
 * 写作工作流：挂载与进度（主进程 IO）
 *
 * 存储：
 *   - Skill 全局：userData/novel/skills/index.json（与 inspiration 共用，幂等播种）
 *   - 工作流挂载在作品 meta：workflowId / workflowDone[]
 *
 * 新建作品 → recommendWorkflowId(genre) → ensureWorkflowSkills → 写 meta
 * 作者在面板勾选步骤完成 → setWorkflowDone
 */
import type { NovelWorkflow, NovelProjectMeta, ProjectWorkflowState, WritingSkill } from '../../shared/types'
import { builtinWorkflows, getWorkflow, recommendWorkflowId, seedWorkflowSkills, DEFAULT_WORKFLOW_ID, workflowSkillIds } from './workflowCore'
import { mergeSkillsIfAbsent } from './inspiration'
import { getProject, updateProject } from './store'

/** 确保工作流引用的 Skill 都在全局技能库（缺则播种，已有不覆盖） */
export async function ensureWorkflowSkills(workflowId?: string): Promise<number> {
  const seeds = seedWorkflowSkills()
  if (!workflowId) return mergeSkillsIfAbsent(seeds)
  const wf = getWorkflow(workflowId)
  if (!wf) return 0
  const need = new Set(workflowSkillIds(wf))
  return mergeSkillsIfAbsent(seeds.filter((s) => need.has(s.id)))
}

/** 智能推荐 + 写入作品 meta（新建时调用） */
export async function attachWorkflowToProject(
  projectId: string,
  genre?: string,
  preferredId?: string
): Promise<NovelWorkflow | null> {
  const id = preferredId || recommendWorkflowId(genre)
  const wf = getWorkflow(id) ?? getWorkflow(DEFAULT_WORKFLOW_ID)
  if (!wf) return null
  await ensureWorkflowSkills(wf.id)
  await updateProject(projectId, { workflowId: wf.id, workflowDone: [] })
  return wf
}

/** 读取作品工作流状态（无挂载时返回 null） */
export async function getProjectWorkflow(projectId: string): Promise<ProjectWorkflowState | null> {
  const p = await getProject(projectId)
  if (!p) return null
  const wid = p.meta.workflowId
  if (!wid) return null
  const workflow = getWorkflow(wid)
  if (!workflow) return null
  return {
    workflow,
    done: p.meta.workflowDone ?? [],
    nextStepId: nextUndone(workflow, p.meta.workflowDone ?? [])
  }
}

function nextUndone(wf: NovelWorkflow, done: string[]): string | null {
  const set = new Set(done)
  return wf.steps.find((s) => !set.has(s.id))?.id ?? null
}

/** 列出全部内置工作流（新建作品选择器用） */
export function listWorkflows(): NovelWorkflow[] {
  return builtinWorkflows()
}

/** 勾选 / 取消勾选步骤完成 */
export async function setWorkflowStepDone(
  projectId: string,
  stepId: string,
  done: boolean
): Promise<ProjectWorkflowState | null> {
  const p = await getProject(projectId)
  if (!p?.meta.workflowId) return null
  const cur = new Set(p.meta.workflowDone ?? [])
  if (done) cur.add(stepId)
  else cur.delete(stepId)
  await updateProject(projectId, { workflowDone: [...cur] })
  return getProjectWorkflow(projectId)
}

/** 切换工作流（保留能对上的步骤进度） */
export async function switchProjectWorkflow(
  projectId: string,
  workflowId: string
): Promise<ProjectWorkflowState | null> {
  const wf = getWorkflow(workflowId)
  if (!wf) return null
  await ensureWorkflowSkills(wf.id)
  const p = await getProject(projectId)
  const old = new Set(p?.meta.workflowDone ?? [])
  const keep = wf.steps.filter((s) => old.has(s.id)).map((s) => s.id)
  await updateProject(projectId, { workflowId: wf.id, workflowDone: keep })
  return getProjectWorkflow(projectId)
}

/** 补种全部工作流 Skill（设置页「修复技能」入口） */
export async function seedAllWorkflowSkills(): Promise<number> {
  return ensureWorkflowSkills()
}

export type { NovelProjectMeta }
