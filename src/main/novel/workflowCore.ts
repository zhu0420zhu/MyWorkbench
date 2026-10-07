/**
 * 写作工作流：纯逻辑核心（不依赖 electron）
 *
 * 对标开源成熟流派（见 交付说明-窗口交互与竞品差距分析 / kb 调研）：
 *   - oh-story / 网文快写流：开书 → 金手指 → 人设 → 分卷 → 章纲 → 正文 → 钩子 → 自查
 *   - 雪花创作法（NovelForge）：一句话 → 段落 → 角色 → 一页大纲 → 三幕 → 场景
 *   - 三幕结构：建置 / 对抗 / 解决
 *   - 英雄之旅（Vela）：12 阶段经典环
 *   - 去 AI 味润色：删套话 → 调节奏 → 个性化声音
 *
 * 新建作品时默认挂载「webnovel-fast」，并自动播种所引用的 Skill。
 */
import type { NovelWorkflow, NovelWorkflowStep, WritingSkill } from '../../shared/types'

export const DEFAULT_WORKFLOW_ID = 'webnovel-fast'

function step(
  id: string,
  title: string,
  hint: string,
  skillId?: string,
  produce?: NovelWorkflowStep['produce']
): NovelWorkflowStep {
  return { id, title, hint, skillId, produce: produce ?? 'none' }
}

/** 5 套内置工作流 */
export function builtinWorkflows(): NovelWorkflow[] {
  return [
    {
      id: 'webnovel-fast',
      name: '网文快写流',
      description: '对标 oh-story / 起点番茄连载节奏：三章定生死，按卷推进，每章收钩子。适合日更网文。',
      tags: ['网文', '玄幻', '都市', '系统', '无限', '默认'],
      steps: [
        step(
          'setup',
          '开书三件套',
          '确认书名、题材、一句话梗概、目标字数。没有灵感可点「AI 帮写」生成候选。',
          'wf-book-setup',
          'synopsis'
        ),
        step(
          'core-hook',
          '金手指与核心冲突',
          '主角凭什么赢？和谁作对？一句话说清全书最大钩子。',
          'wf-core-hook',
          'inspiration'
        ),
        step(
          'protagonist',
          '主角人设卡',
          '建立主角实体：欲望、恐惧、能力边界、说话方式。后续章节自动注入。',
          'builtin-character-profile',
          'entity'
        ),
        step(
          'volume-outline',
          '第一卷大纲',
          '把全书拆成卷；写清第一卷 3–5 个大事件与卷末高潮。',
          'wf-volume-outline',
          'volume'
        ),
        step(
          'golden3',
          '黄金三章',
          '第 1–3 章细纲：冲突前置、金手指出场、第一个小爽点。决定追读率。',
          'wf-golden3',
          'chapter-outline'
        ),
        step(
          'draft-loop',
          '正文循环',
          '按章写正文。卡文用「卡文救援」，写完用「章节钩子」收尾。',
          'builtin-writer-block',
          'chapter'
        ),
        step(
          'hook',
          '章末钩子',
          '每章最后一句必须吊住读者：惊变 / 悬念 / 情感三选一。',
          'builtin-ending-hook',
          'none'
        ),
        step(
          'audit',
          '一致性自查',
          '跑一遍设定库审计：人名、时间线、伏笔是否对得上。',
          'wf-consistency-pass',
          'none'
        )
      ]
    },
    {
      id: 'snowflake',
      name: '雪花创作法',
      description: 'Randy Ingermanson 经典方法，NovelForge 采用：从一句话种子不断分形扩写，结构最稳。',
      tags: ['结构', '长篇', '传统', '文学'],
      steps: [
        step('seed', '一句话种子', '用一句话（约 15 字）说清谁、要什么、阻碍是什么。', 'wf-snowflake-seed', 'synopsis'),
        step('expand5', '扩成一段', '把一句话扩成约 5 句：起因、发展、转折、高潮、结局。', 'wf-snowflake-para', 'synopsis'),
        step('chars', '角色清单', '列出主角 + 反派 + 关键配角各 1–3 人，写清目标与冲突。', 'builtin-character-profile', 'entity'),
        step('page', '一页大纲', '把一段扩成一页（约 500 字）三幕大纲。', 'wf-three-act', 'synopsis'),
        step('char-arc', '角色弧光', '每个主要角色写 1 页：起点状态 → 转变 → 终点状态。', 'builtin-character-profile', 'entity'),
        step('scene-list', '场景列表', '把一页大纲拆成 20–40 个场景（地点 + 目标 + 冲突）。', 'wf-scene-list', 'inspiration'),
        step('write', '场景落笔', '按场景列表写正文；每场景只服务一个目标。', 'builtin-writer-block', 'chapter'),
        step('revise', '对照修订', '写完回头对照一页大纲，删掉游离场景、补上缺失节拍。', 'wf-pacing-check', 'none')
      ]
    },
    {
      id: 'three-act',
      name: '三幕结构',
      description: '好莱坞经典三幕：建置 25% / 对抗 50% / 解决 25%。适合强情节、影视化向作品。',
      tags: ['结构', '情节', '影视'],
      steps: [
        step('world', '第一幕 · 建置', '介绍日常世界、主角缺陷、引发事件。到情节点 I 结束。', 'wf-three-act', 'synopsis'),
        step('act2a', '第二幕 · 上半', '新世界规则、盟友与敌人、小胜与代价。', 'wf-three-act', 'inspiration'),
        step('mid', '中点', '虚假胜利或虚假失败，赌注升高，主角从被动转主动。', 'wf-midpoint', 'inspiration'),
        step('act2b', '第二幕 · 下半', '代价加重、盟友危机、逼近最深的洞穴。到情节点 II。', 'wf-three-act', 'inspiration'),
        step('act3', '第三幕 · 解决', '高潮对决 + 结局余波。缺陷必须被克服或付出代价。', 'wf-three-act', 'synopsis'),
        step('hook-polish', '节拍打磨', '检查每一幕结尾是否有强钩子；中点是否真正升高赌注。', 'wf-pacing-check', 'none')
      ]
    },
    {
      id: 'hero-journey',
      name: '英雄之旅',
      description: 'Campbell / Vogler 12 阶段，Vela 自动大纲采用。适合奇幻、冒险、成长向。',
      tags: ['奇幻', '冒险', '成长', '神话'],
      steps: [
        step('ordinary', '平凡世界', '展示英雄的日常与缺陷。', 'wf-hero-journey', 'chapter-outline'),
        step('call', '冒险召唤 + 拒绝', '出现打破日常的事件；英雄先拒绝。', 'wf-hero-journey', 'inspiration'),
        step('mentor', '遇见导师', '导师给出工具/知识/信念，英雄决定出发。', 'wf-hero-journey', 'entity'),
        step('threshold', '跨越第一道门槛', '进入新世界，没有回头路。', 'wf-hero-journey', 'chapter-outline'),
        step('tests', '考验 · 盟友 · 敌人', '学习新规则，结盟，识别真正敌人。', 'wf-hero-journey', 'inspiration'),
        step('ordeal', '磨难与报酬', '最深洞穴中的死而复生；获得「宝剑」。', 'wf-hero-journey', 'chapter-outline'),
        step('return', '归途与复活', '带着万能药回来；旧世界因他改变。', 'wf-hero-journey', 'synopsis'),
        step('polish', '主题收束', '确认「万能药」象征的主题在结尾被说清。', 'wf-theme-check', 'none')
      ]
    },
    {
      id: 'deai-polish',
      name: '去 AI 味润色',
      description: '弧光 / oh-story 技能包核心：删套话、打节奏、给声音。适合作文稿打磨，不单独开书。',
      tags: ['润色', '编辑', '去AI味'],
      steps: [
        step('strip', '删套话', '去掉「首先/其次/总之」「值得注意的是」等 AI 腔。', 'wf-deai-strip', 'none'),
        step('pace', '调节奏', '长短句交替；关键句独立成段；删掉解释性旁白。', 'wf-pacing-check', 'none'),
        step('voice', '个性化声音', '按人物身份改用词与句长；加入感官细节与口癖。', 'builtin-dialogue-polish', 'none'),
        step('climax', '情绪峰值', '检查高潮是否只有「告诉」没有「展示」；补动作与身体反应。', 'builtin-satisfying-beat', 'none')
      ]
    }
  ]
}

export function getWorkflow(id: string): NovelWorkflow | null {
  return builtinWorkflows().find((w) => w.id === id) ?? null
}

/** 按题材推荐工作流（新建作品时用；匹配不上则默认网文快写流） */
export function recommendWorkflowId(genre?: string): string {
  const g = (genre ?? '').trim()
  if (!g) return DEFAULT_WORKFLOW_ID
  const all = builtinWorkflows()
  for (const w of all) {
    if (w.tags.some((t) => g.includes(t) || t.includes(g))) return w.id
  }
  return DEFAULT_WORKFLOW_ID
}

/** 收集工作流引用的全部 skillId（去重） */
export function workflowSkillIds(w: NovelWorkflow): string[] {
  const ids = new Set<string>()
  for (const s of w.steps) if (s.skillId) ids.add(s.skillId)
  return [...ids]
}

function wrap(id: string, name: string, description: string, template: string, now: number): WritingSkill {
  return { id, name, description, template, builtin: true, createdAt: now, updatedAt: now }
}

/**
 * 工作流配套 Skill（与 inspirationCore 的 7 个基础 Skill 互补）。
 * 幂等：已有同 id 的 Skill 不会被覆盖（由 ensureWorkflowSkills 处理）。
 */
export function seedWorkflowSkills(): WritingSkill[] {
  const now = Date.now()
  return [
    wrap(
      'wf-book-setup',
      '开书三件套',
      '根据题材生成书名候选、一句话梗概、目标读者与卖点',
      '你是资深网文策划。根据作者给出的题材/方向，输出：\n' +
        '1. 5 个书名候选（有网感、能点开）\n' +
        '2. 一句话梗概（约 30 字：谁 + 要什么 + 阻碍）\n' +
        '3. 目标读者与平台气质（番茄/起点/晋江…）\n' +
        '4. 三条核心卖点\n\n' +
        '【作品上下文】\n<CONTEXT>\n{{context}}\n</CONTEXT>\n\n{{input}}\n' +
        '\n只输出结构化结果，不要寒暄。',
      now
    ),
    wrap(
      'wf-core-hook',
      '金手指与核心冲突',
      '设计金手指/系统与贯穿全书的核心冲突',
      '你是网文大纲教练。请设计：\n' +
        '1. 金手指（或核心优势）：是什么、限制是什么、如何升级\n' +
        '2. 核心反派/对立力量：动机与压迫感\n' +
        '3. 全书最大钩子（读者为什么追到百万字）\n' +
        '4. 第一个「小爽点」可在第几章兑现\n\n' +
        '【作品上下文】\n<CONTEXT>\n{{context}}\n</CONTEXT>\n\n{{input}}',
      now
    ),
    wrap(
      'wf-volume-outline',
      '分卷大纲',
      '把全书拆成 3–5 卷，写清每卷目标与卷末高潮',
      '你是长篇结构编辑。根据作品梗概，拆出 3–5 卷大纲。每卷包含：\n' +
        '- 卷名\n- 本卷目标（主角得到/失去什么）\n- 3–5 个大事件\n- 卷末高潮与钩子\n' +
        '- 本卷字数建议\n\n' +
        '【作品上下文】\n<CONTEXT>\n{{context}}\n</CONTEXT>\n\n{{input}}',
      now
    ),
    wrap(
      'wf-golden3',
      '黄金三章',
      '设计决定追读率的前三章细纲',
      '你是起点/番茄编辑。为本书设计「黄金三章」细纲：\n' +
        '第1章：冲突前置 + 金手指出场方式\n' +
        '第2章：第一次使用金手指，立刻兑现小爽点\n' +
        '第3章：更大的麻烦压来，章末强钩子\n' +
        '每章 150–250 字细纲，标明情绪曲线。\n\n' +
        '【作品上下文】\n<CONTEXT>\n{{context}}\n</CONTEXT>\n\n{{input}}',
      now
    ),
    wrap(
      'wf-snowflake-seed',
      '雪花 · 一句话种子',
      '压缩成 15 字左右的故事种子',
      '把作品压缩成一句话种子（约 15 字），格式：当【事件】发生，【主角】必须【目标】，否则【代价】。\n' +
        '给出 3 个候选，选最好的一个加粗说明理由。\n\n' +
        '【作品上下文】\n<CONTEXT>\n{{context}}\n</CONTEXT>\n\n{{input}}',
      now
    ),
    wrap(
      'wf-snowflake-para',
      '雪花 · 段落扩写',
      '把一句话扩成约 5 句的段落',
      '将一句话故事扩写成约 5 句的段落：起因、发展、转折、高潮、结局。保持因果链清晰，不引入新支线。\n\n' +
        '【作品上下文】\n<CONTEXT>\n{{context}}\n</CONTEXT>\n\n{{input}}',
      now
    ),
    wrap(
      'wf-three-act',
      '三幕规划',
      '按建置/对抗/解决规划情节',
      '按三幕结构规划情节：\n' +
        '第一幕（25%）：日常、缺陷、引发事件、情节点I\n' +
        '第二幕（50%）：新规则、中点升高赌注、情节点II\n' +
        '第三幕（25%）：高潮、缺陷克服、结局\n' +
        '输出可直接当细纲用的节拍列表。\n\n' +
        '【作品上下文】\n<CONTEXT>\n{{context}}\n</CONTEXT>\n\n{{input}}',
      now
    ),
    wrap(
      'wf-hero-journey',
      '英雄之旅节拍',
      '按 12 阶段展开当前阶段细纲',
      '按英雄之旅 12 阶段展开。若作者指定了阶段，只写该阶段；否则从「平凡世界」开始输出前 4 阶细纲。\n' +
        '每阶段：场景建议 + 内心变化 + 章末钩子。\n\n' +
        '【作品上下文】\n<CONTEXT>\n{{context}}\n</CONTEXT>\n\n{{input}}',
      now
    ),
    wrap(
      'wf-scene-list',
      '场景列表',
      '把大纲拆成可执行的场景清单',
      '把大纲拆成 20–40 个场景。每个场景一行：\n' +
        '[地点] [POV] 目标｜冲突｜结果（转/败/胜）\n' +
        '结果为「转」的场景要能钩住下一场景。\n\n' +
        '【作品上下文】\n<CONTEXT>\n{{context}}\n</CONTEXT>\n\n{{input}}',
      now
    ),
    wrap(
      'wf-midpoint',
      '中点设计',
      '设计虚假胜利/失败与赌注升高',
      '为当前情节设计「中点」：虚假胜利或虚假失败二选一。说明：赌注如何升高、主角如何从被动转主动、它如何呼应卷首伏笔。\n\n' +
        '【作品上下文】\n<CONTEXT>\n{{context}}\n</CONTEXT>\n\n{{input}}',
      now
    ),
    wrap(
      'wf-deai-strip',
      '删 AI 套话',
      '去掉模板腔与空洞过渡',
      '删掉 AI 套话与空洞过渡（首先/其次/总之/值得注意的是/综上所述等）。保留事实与动作，不改变情节。只输出修订后的文本。\n\n' +
        '【待处理文本】\n{{input}}\n\n【作品上下文】\n<CONTEXT>\n{{context}}\n</CONTEXT>',
      now
    ),
    wrap(
      'wf-pacing-check',
      '节奏诊断',
      '诊断拖沓/过赶并给出改法',
      '诊断下列文本的节奏：指出拖沓段、过赶段、可删的解释性旁白；给出「长句变短 / 短句成段 / 插入动作」的具体改法清单。不要重写全文。\n\n' +
        '【文本】\n{{input}}\n\n【作品上下文】\n<CONTEXT>\n{{context}}\n</CONTEXT>',
      now
    ),
    wrap(
      'wf-theme-check',
      '主题收束',
      '检查主题是否在结尾说清',
      '用一句话写出本书主题。检查当前结尾是否让主题「被体验到」而不是「被说出」。给出 2 个更含蓄的收束写法。\n\n' +
        '【作品上下文】\n<CONTEXT>\n{{context}}\n</CONTEXT>\n\n{{input}}',
      now
    ),
    wrap(
      'wf-consistency-pass',
      '设定自查',
      '输出应核对的人名/时间线/伏笔清单',
      '根据上下文输出「作者自查清单」：\n' +
        '1. 人名/称谓是否前后一致\n2. 时间线是否倒挂\n3. 已埋未收的伏笔\n4. 能力设定是否越界\n' +
        '只列清单与可疑点，不改正文。\n\n' +
        '【作品上下文】\n<CONTEXT>\n{{context}}\n</CONTEXT>\n\n{{input}}',
      now
    )
  ]
}

/** 去 AI 味：可被 deai-polish 与通用润色复用 */
export function allWorkflowSkillIds(): Set<string> {
  const s = new Set<string>()
  for (const w of builtinWorkflows()) for (const id of workflowSkillIds(w)) s.add(id)
  // 基础包里工作流也会引用的
  s.add('builtin-writer-block')
  s.add('builtin-character-profile')
  s.add('builtin-ending-hook')
  s.add('builtin-dialogue-polish')
  s.add('builtin-satisfying-beat')
  return s
}
