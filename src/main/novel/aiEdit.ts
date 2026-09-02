/**
 * 编辑器内 AI 动作（P1-3）：选区驱动的改写 / 续写。
 *
 * 只做"一次请求 → 一段文本"的纯粹变换，差异对比与接受/拒绝都在渲染层做。
 * 这样可以让作者始终保持最终决定权，AI 不会悄悄改坏正文。
 */
import { complete } from '../ai'
import type { AiEditAction, AiEditInput, AiEditResult } from '../../shared/types'

/** 各动作的指令模板。selectedText / beforeText / afterText 由调用方拼进占位符。 */
function instruction(action: AiEditAction, hasContext: boolean): string {
  const ctx = hasContext
    ? '\n\n【背景设定（仅作参考，不要重复、不要因此改变情节走向）】\n<CONTEXT>\n'
    : ''
  const tail = hasContext ? '\n</CONTEXT>\n' : ''
  switch (action) {
    case 'continue':
      return (
        '你是一位经验丰富的小说续写助手。请根据【前文】与【后文】的语境，从【续写锚点】之后自然地往下写，' +
        '保持相同的人物性格、叙事视角、文风与节奏。' +
        '只输出新增的续写内容，不要复述已有文字，不要加任何解释或引号。' +
        ctx +
        '\n【前文】\n<BEFORE>\n' +
        tail +
        '\n【续写锚点】\n<SELECTED>\n' +
        '\n【后文】\n<AFTER>'
      )
    case 'polish':
      return (
        '请润色【原文】，修正语病与不通顺之处，保持原意、人物与文风不变，使行文更流畅自然。' +
        '只输出润色后的文本，不要加解释或引号。' +
        ctx +
        '\n【原文】\n<SELECTED>\n' +
        tail
      )
    case 'expand':
      return (
        '请扩写【原文】，在不改变核心情节与人设的前提下，补充细节、感官描写或人物心理活动，使内容更丰满。' +
        '只输出扩写后的文本。' +
        ctx +
        '\n【原文】\n<SELECTED>\n' +
        tail
      )
    case 'condense':
      return (
        '请缩写【原文】，保留关键信息与情节推进，删去冗余铺陈，使节奏更紧凑。' +
        '只输出缩写后的文本。' +
        ctx +
        '\n【原文】\n<SELECTED>\n' +
        tail
      )
    case 'restyle':
      return (
        '请改写【原文】的文风，使其更具文学性与画面感，避免口水话与空洞的书面腔，但保持人设与情节不变。' +
        '只输出改写后的文本。' +
        ctx +
        '\n【原文】\n<SELECTED>\n' +
        tail
      )
    case 'deai':
      return (
        '请去除【原文】的"AI 味"：减少套路化表达、空洞排比与过度书面化的连接词，' +
        '改成更自然、带作者个人语气的中文叙事。保持人设与情节不变。' +
        '只输出修改后的文本。' +
        ctx +
        '\n【原文】\n<SELECTED>\n' +
        tail
      )
  }
}

function buildPrompt(input: AiEditInput): string {
  const ctxText = input.contextPrompt?.trim()
  const hasContext = !!ctxText
  let p = instruction(input.action, hasContext)
  if (hasContext) {
    p = p.replace('<CONTEXT>\n', `<CONTEXT>\n${ctxText}\n`)
  }
  p = p
    .replace('<BEFORE>\n', input.beforeText ? `${input.beforeText}\n` : '(无)\n')
    .replace('<SELECTED>\n', `${input.selectedText}\n`)
    .replace('<AFTER>', input.afterText ?? '(无)')
  return p
}

export async function runAiEdit(input: AiEditInput): Promise<AiEditResult> {
  const text = (input.selectedText ?? '').trim()
  if (!text && input.action !== 'continue') {
    return { ok: false, error: '没有可处理的选中文本' }
  }
  const prompt = buildPrompt(input)
  try {
    const r = await complete([{ role: 'user', content: prompt }])
    if (!r.ok) return { ok: false, error: r.error ?? 'AI 调用失败' }
    return { ok: true, text: (r.text ?? '').trim() }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
