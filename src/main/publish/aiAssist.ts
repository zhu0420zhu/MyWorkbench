/* AI 内容整合（P2）：热点摘要生成 + 多平台风格改写，复用现有 AI 配置（非流式） */
import { complete } from '../ai.ts'
import type { AiChatMessage } from '../../shared/types'

export interface AiAssistResult {
  ok: boolean
  text?: string
  error?: string
}

/** 生成热点摘要（100 字内，适合作为发布正文） */
export async function summarizeContent(title: string, content: string): Promise<AiAssistResult> {
  const messages: AiChatMessage[] = [
    {
      role: 'user',
      content: `请为以下热点内容生成一段简洁摘要（100 字以内，适合作为发布正文开头，不出现"摘要"字样）：\n标题：${title}\n内容：${content}`
    }
  ]
  return complete(messages)
}

/** 按平台风格改写内容（保持事实，语气贴合平台，300 字内） */
export async function rewriteForPlatform(
  title: string,
  content: string,
  platformName: string
): Promise<AiAssistResult> {
  const messages: AiChatMessage[] = [
    {
      role: 'user',
      content: `请把以下内容改写为适合在「${platformName}」平台发布的形式，保持事实不变，语气符合该平台用户习惯，控制在 300 字内，直接输出正文：\n标题：${title}\n内容：${content}`
    }
  ]
  return complete(messages)
}
