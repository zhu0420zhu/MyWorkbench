/**
 * 在线资源市场（EvoFlow C1）：拉取目录 / 安装 Skill·工作流·提示词包
 * 目录默认内置，可远程 JSON 覆盖；安装写入 novel/skills 或 hub
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ResourceCatalog, ResourcePack, WritingSkill } from '../../shared/types.ts'

function catalogFile(): string {
  return join(app.getPath('userData'), 'resource-market.json')
}

function cacheFile(): string {
  return join(app.getPath('userData'), 'resource-market-cache.json')
}

const BUILTIN: ResourcePack[] = [
  {
    id: 'skill-writing-basic',
    name: '写作基础技能包',
    description: '卡文救援、章节钩子、人物小传、对话润色等写作 Skill',
    kind: 'skill',
    version: '1.0.0',
    author: '灵墨',
    packageUrl: 'builtin:writing-basic',
    tags: ['写作', 'skill']
  },
  {
    id: 'wf-novel-pipeline',
    name: '长篇工作流包',
    description: '网文快写流 / 雪花 / 三幕 / 英雄之旅步骤模板',
    kind: 'workflow',
    version: '1.0.0',
    author: '灵墨',
    packageUrl: 'builtin:novel-workflow',
    tags: ['写作', 'workflow']
  },
  {
    id: 'prompt-agent-starter',
    name: '智能体提示词包',
    description: '计划助手 / 写手 / 审校 / 资料员常用 system 提示',
    kind: 'prompt',
    version: '1.0.0',
    author: '灵墨',
    packageUrl: 'builtin:agent-starter',
    tags: ['agent', 'prompt']
  },
  {
    id: 'ext-market-example',
    name: '扩展示例：报告模板',
    description: '周报/日报生成模板，可在 Autopilot 中引用',
    kind: 'extension',
    version: '0.1.0',
    author: '社区',
    packageUrl: 'builtin:report-templates',
    tags: ['报告']
  }
]

/** 内置包内容（安装到 Skill 库） */
const BUILTIN_SKILLS: Record<string, Array<Omit<WritingSkill, 'createdAt' | 'updatedAt'>>> = {
  'skill-writing-basic': [
    {
      id: 'mkt-hook',
      name: '市场版·开头钩子',
      description: '写三段不同风格开头',
      template: '根据上下文写 3 段开头钩子。\n{{context}}\n{{input}}',
      builtin: true
    },
    {
      id: 'mkt-polish',
      name: '市场版·段落润色',
      description: '润色段落',
      template: '润色下列段落。\n{{input}}',
      builtin: true
    }
  ],
  'prompt-agent-starter': [
    {
      id: 'mkt-planner',
      name: '计划助手提示词',
      description: '拆任务为可执行步骤',
      template: '把目标拆成 5-8 步，每步「标题 | 说明」。\n{{input}}',
      builtin: true
    }
  ]
}

async function readInstalled(): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await fs.readFile(catalogFile(), 'utf-8')) as { installed?: string[] }
    return new Set(raw.installed ?? [])
  } catch {
    return new Set()
  }
}

async function markInstalled(id: string): Promise<void> {
  const cur = await readInstalled()
  cur.add(id)
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(catalogFile(), JSON.stringify({ installed: [...cur] }, null, 2), 'utf-8')
}

export async function fetchCatalog(remoteUrl?: string): Promise<ResourceCatalog> {
  const installed = await readInstalled()
  let packs = BUILTIN
  const url = (remoteUrl || '').trim()
  if (url) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        const json = (await res.json()) as { packs?: ResourcePack[] }
        if (Array.isArray(json.packs) && json.packs.length) packs = [...json.packs, ...BUILTIN]
        await fs.writeFile(cacheFile(), JSON.stringify({ updatedAt: Date.now(), packs }, null, 2), 'utf-8')
      }
    } catch {
      /* 回退缓存/内置 */
      try {
        const raw = JSON.parse(await fs.readFile(cacheFile(), 'utf-8')) as ResourceCatalog
        if (raw.packs?.length) packs = raw.packs
      } catch {
        /* builtin */
      }
    }
  }
  return {
    updatedAt: Date.now(),
    packs: packs.map((p) => ({ ...p, installed: installed.has(p.id) }))
  }
}

export async function installResourcePack(id: string): Promise<{ ok: boolean; error?: string; count?: number }> {
  const cat = await fetchCatalog()
  const pack = cat.packs.find((p) => p.id === id)
  if (!pack) return { ok: false, error: '资源不存在' }
  const skills = BUILTIN_SKILLS[id]
  if (skills?.length) {
    const { mergeSkillsIfAbsent } = await import('../novel/inspiration.ts')
    const now = Date.now()
    const list = skills.map((s) => ({ ...s, createdAt: now, updatedAt: now }))
    const n = await mergeSkillsIfAbsent(list)
    await markInstalled(id)
    return { ok: true, count: n }
  }
  // workflow / prompt / extension：登记为经验卡，供 Agent 使用
  const { addExperience } = await import('./store.ts')
  await addExperience({
    title: `安装资源：${pack.name}`,
    body: pack.description + `\n来源：${pack.packageUrl}`,
    tags: ['market', pack.kind]
  })
  await markInstalled(id)
  return { ok: true, count: 1 }
}
