import type { AiTool, McpToolInfo } from '@shared/types'
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

/** 把已选技能约束追加到 system 末尾（[写作约束] 包裹）；无技能时原样返回 */
export function buildSystemWithSkills(system: string | undefined, skills: string[]): string | undefined {
  const skillHints = skills
    .map((k) => BUILTIN_SKILLS.find((s) => s.key === k)?.hint)
    .filter(Boolean)
    .join('\n')
  if (!skillHints) return system
  return [system, `[写作约束]\n${skillHints}`].filter(Boolean).join('\n\n')
}
