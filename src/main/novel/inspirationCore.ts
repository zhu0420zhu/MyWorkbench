/**
 * 灵感工作台 / 写作 Skill 包：纯逻辑核心（不依赖 electron，可在无头环境跑测试）
 *
 * 只做两件事：
 *  1. 把 Skill 模板里的占位符（{{context}} / {{input}}）替换成实际内容；
 *  2. 提供 7 个内置写作 Skill 的种子数据（首次启动播种进磁盘）。
 *
 * 渲染进程不会 import 本文件（它不引 electron，但主进程才是唯一写盘方）。
 * 把"模板渲染"这一纯函数单独放出来，是为了让无头测试能直接验证占位符替换。
 */
import type { WritingSkill } from '../../shared/types'

/** 占位符：当前章上下文 */
const RE_CONTEXT = /\{\{\s*context\s*\}\}/g
/** 占位符：作者额外输入（如要润色的台词、要设计的人物名） */
const RE_INPUT = /\{\{\s*input\s*\}\}/g

/**
 * 把 prompt 模板里的占位符替换为实际内容。
 * - {{context}} → 当前章上下文（设定/前文/设定库）
 * - {{input}}   → 作者的额外输入（可为空，替换成空串）
 * 两个占位符都可重复出现、可带或不带空格。
 */
export function buildSkillPrompt(template: string, context: string, input?: string): string {
  return (template ?? '')
    .replace(RE_CONTEXT, context ?? '')
    .replace(RE_INPUT, input ?? '')
}

/**
 * 7 个内置写作 Skill。每次启动若 skills 索引不存在则播种进 userData。
 * id 用稳定 slug，便于"按 id 识别内置"与"去重播种"。
 */
export function seedBuiltinSkills(): WritingSkill[] {
  const now = Date.now()
  const wrap = (
    id: string,
    name: string,
    description: string,
    template: string
  ): WritingSkill => ({
    id,
    name,
    description,
    template,
    builtin: true,
    createdAt: now,
    updatedAt: now
  })

  return [
    wrap(
      'builtin-writer-block',
      '卡文救援',
      '写不下去时，给出几条把笔接上的推进思路',
      '你是一位经验丰富的小说写作陪练。作者正卡在某个段落，需要继续往下写。\n' +
        '\n【当前章节上下文（设定 / 前文 / 设定库，供你参考）】\n<CONTEXT>\n{{context}}\n</CONTEXT>\n' +
        '\n{{input}}\n' +
        '\n请针对「如何把这一段接下去」给出 3 条推进思路，每条包含：一个明确的小目标、一句可落笔的开头、以及一处要照应的伏笔或人物动机。不替作者写完，只帮他把笔接上。只输出思路，不要寒暄。'
    ),
    wrap(
      'builtin-chapter-hook',
      '章节钩子',
      '为当前章设计几个不同风格的强力开头',
      '你是一位擅长开篇的小说家。请基于以下章节上下文，为当前章设计 3 个不同风格的强力开头钩子（悬念式 / 冲突式 / 情绪式），每条钩子单独成段、可直接用作章节开头。\n' +
        '\n【当前章节上下文】\n<CONTEXT>\n{{context}}\n</CONTEXT>\n' +
        '\n{{input}}'
    ),
    wrap(
      'builtin-character-profile',
      '人物小传',
      '补全或深化一个人物小传',
      '你是一位人物塑造教练。请基于以下作品上下文，帮作者补全或深化一个人物小传，涵盖：核心欲望与恐惧、性格矛盾、说话方式、与他人的关键关系、以及能推动情节的秘密或短板。\n' +
        '\n【作品上下文】\n<CONTEXT>\n{{context}}\n</CONTEXT>\n' +
        '\n{{input}}（若已给出人物名/设定片段请据此延展；未给出则基于上下文提炼一个最能制造冲突的人物）'
    ),
    wrap(
      'builtin-satisfying-beat',
      '爽点设计',
      '为当前情节设计让读者拍案叫绝的爆点',
      '你是一位擅长设计「爽点」的网文编剧。请基于以下上下文，为当前情节设计 2-3 个让读者拍案叫绝的「爽点」爆点：可以是打脸反派、能力觉醒、身份揭露、或因果关系收束。每条说明：触发条件、情绪曲线、以及它如何呼应前文伏笔。\n' +
        '\n【作品上下文】\n<CONTEXT>\n{{context}}\n</CONTEXT>\n' +
        '\n{{input}}'
    ),
    wrap(
      'builtin-dialogue-polish',
      '对话润色',
      '让给定对话更自然、有潜台词、带张力',
      '你是一位对话质感极佳的小说编辑。下面是要润色的对话或台词草稿。请在保持人物性格与情节不变的前提下，让对话更自然、有潜台词、带张力，去掉说明性台词和书面腔。只输出润色后的对话。\n' +
        '\n【作品上下文（仅供参考人设与关系）】\n<CONTEXT>\n{{context}}\n</CONTEXT>\n' +
        '\n【待润色对话】\n{{input}}'
    ),
    wrap(
      'builtin-suspense',
      '悬念铺设',
      '指出当前情节最适合铺设悬念的位置与写法',
      '你是一位悬念大师。请基于以下上下文，指出当前情节里最适合铺设悬念的 2-3 个位置，并给出具体的留白 / 误导 / 信息差写法，让读者的好奇心被吊住。\n' +
        '\n【作品上下文】\n<CONTEXT>\n{{context}}\n</CONTEXT>\n' +
        '\n{{input}}'
    ),
    wrap(
      'builtin-ending-hook',
      '收尾钩子',
      '为当前章设计几个收尾钩子',
      '你是一位擅长章节结尾的小说家。请为当前章设计 3 个收尾钩子（惊变式 / 悬念式 / 情感式），每个钩子单独成段、可直接用作本章最后一句话，并在其后用括号注明它吊起了读者对什么的期待。\n' +
        '\n【作品上下文】\n<CONTEXT>\n{{context}}\n</CONTEXT>\n' +
        '\n{{input}}'
    )
  ]
}
