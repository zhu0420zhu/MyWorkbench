/**
 * 游戏 UI 设计内置模块注册表。
 *
 * 命名空间：@gameui（electron.vite 别名 → src/modules/gameUi），
 * 与项目其余模块（@renderer / @shared）隔离，避免命名冲突。
 *
 * 三个子项目均来自 GitHub 用户 guiguiyan930-source，已按原目录结构
 * 落入 src/modules/gameUi/<repo>/，此处仅做「导入 + 注册 + 暴露调用入口」。
 *
 * - prototype-interaction-game-ui：原型交互生成（提示词技能）
 * - game-ui-page-generator：整页生成（提示词技能）
 * - game-ui-design-workflow：端到端设计工作流（含雪碧图拆分等可调用的 Python 工具）
 *
 * 技能正文通过 Vite `?raw` 内联打包，运行时直接可读，无需额外 IO。
 */

import prototypeSkill from '@gameui/prototype-interaction-game-ui/SKILL.md?raw'
import pageGenSkill from '@gameui/game-ui-page-generator/SKILL.md?raw'
import workflowSkill from '@gameui/game-ui-design-workflow/skills/game-ui-workflow/SKILL.md?raw'

export type GameUiModuleKind = 'prompt' | 'workflow'

export interface GameUiStep {
  n: number
  title: string
  goal: string
}

export interface GameUiModule {
  /** 稳定 id，命名空间下唯一 */
  id: string
  /** 展示标题 */
  title: string
  /** 副标题 */
  subtitle: string
  /** 模块类型：prompt=提示词技能，workflow=多阶段工作流 */
  kind: GameUiModuleKind
  /** 一句话说明 */
  description: string
  /** 原始技能正文（SKILL.md / README，已内联打包） */
  skillText: string
  /** workflow 专属：阶段概览 */
  steps?: GameUiStep[]
  /** 内置可调用工具标识 */
  tool?: 'sprite-splitter'
  /** 来源仓库（归属说明，避免与本体功能混淆） */
  source: string
}

export const gameUiModules: GameUiModule[] = [
  {
    id: 'prototype-interaction-game-ui',
    title: '原型交互生成',
    subtitle: 'Prototype → Game UI',
    kind: 'prompt',
    description: '把原型图 / 低保真草图 / 玩法描述拆成功能模型，再套用目标风格，输出可直接生图的完整游戏 UI 提示词（两步法）。',
    skillText: prototypeSkill,
    source: 'github.com/guiguiyan930-source/prototype-interaction-game-ui'
  },
  {
    id: 'game-ui-page-generator',
    title: '整页生成',
    subtitle: 'Game UI Page Generator',
    kind: 'prompt',
    description: '根据游戏类型、风格、页面功能与比例，产出单页游戏 UI 方案与可复制的图像生成提示词（首页 / 任务 / 商城 / 背包等）。',
    skillText: pageGenSkill,
    source: 'github.com/guiguiyan930-source/game-ui-page-generator'
  },
  {
    id: 'game-ui-design-workflow',
    title: '设计工作流',
    subtitle: 'Game UI Design Workflow',
    kind: 'workflow',
    description: '从策划 PRD、UI 规范、页面延展到组件拆解、雪碧图拆分打包、Atlas 与引擎 JSON 交付的端到端工作流；内置雪碧图拆分工具。',
    skillText: workflowSkill,
    tool: 'sprite-splitter',
    source: 'github.com/guiguiyan930-source/game-ui-design-workflow',
    steps: [
      { n: 1, title: '策划与 PRD', goal: '产出并批准 gdd.md / prd.md / interaction.md（未批准不进入生图）。' },
      { n: 2, title: '原型生成视觉', goal: '用基准页面验证构图与信息层级，保存为未批准版本。' },
      { n: 3, title: 'UI 风格切换', goal: '保持结构不变生成风格候选，选定后批准样式契约与基准页。' },
      { n: 4, title: 'UI 页面延展', goal: '先输出屏幕地图并确认范围，再按批次逐页生成。' },
      { n: 5, title: 'UI 组件拆解', goal: '仅拆已批准页面，每个组件与状态单独交付。' },
      { n: 6, title: '雪碧图拆分打包', goal: '把组件合图切成单元素透明 PNG，生成 manifest 与 ZIP。' },
      { n: 7, title: 'Atlas 与引擎交付', goal: '语义命名、9-slice、打包 Atlas 并生成 Godot / Unity / Cocos JSON。' }
    ]
  }
]

export function getGameUiModule(id: string): GameUiModule | undefined {
  return gameUiModules.find((m) => m.id === id)
}
