import type { AiTool, McpToolInfo, WritingSkill } from '@shared/types'
import { BUILTIN_SKILLS } from '../ComposerInput'

/**
 * 写作引擎共享逻辑（短篇对话 / 长篇助手 共用）。
 * 抽离自 WorkshopChat，避免长/短篇各写一份工具构造与技能约束拼接。
 */

/** 由已选 MCP 工具构造 ai.chat 的 tools 入参（名称含 serverId::name） */
export function buildTools(enabledMcp: string[], mcpTools: McpToolInfo[]): AiTool[] {
  if (enabledMcp.length === 0) return []
  return mcpTools
    .filter((t) => enabledMcp.includes(`${t.serverId}::${t.name}`))
    .map((t) => ({
      type: 'function',
      function: {
        name: `${t.serverId}::${t.name}`,
        description: t.description ?? '',
        parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} }
      }
    }))
}

/**
 * 把已选技能约束追加到 system 末尾（[写作约束] 包裹）；
 * libSkills = 角色专属技能（写作技能库，选中角色时自动生效），以 [角色专属技能] 段落注入，
 * 模板节选 400 字符（与主进程 agentsHub runner 的注入口径一致）。两者都为空时原样返回。
 */
export function buildSystemWithSkills(
  system: string | undefined,
  skills: string[],
  libSkills: WritingSkill[] = []
): string | undefined {
  const skillHints = skills
    .map((k) => BUILTIN_SKILLS.find((s) => s.key === k)?.hint)
    .filter(Boolean)
    .join('\n')
  const libHints = libSkills
    .map((s) => `【${s.name}】${(s.template || s.description || '').slice(0, 400)}`)
    .join('\n')
  if (!skillHints && !libHints) return system
  const parts = [system]
  if (skillHints) parts.push(`[写作约束]\n${skillHints}`)
  if (libHints) parts.push(`[角色专属技能]\n${libHints}`)
  return parts.filter(Boolean).join('\n\n')
}
