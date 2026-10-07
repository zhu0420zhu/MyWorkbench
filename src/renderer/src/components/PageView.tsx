import AutoWorkbench from '../pages/AutoWorkbench'
import Notes from '../pages/Notes'
import DataLab from '../pages/DataLab'
import Boards from '../pages/Boards'
import TextTools from '../pages/TextTools'
import FileTools from '../pages/FileTools'
import Toolbox from '../pages/Toolbox'
import DocsViewer from '../pages/DocsViewer'
import KnowledgeBase from '../pages/KnowledgeBase'
import Stickies from '../pages/Stickies'
import FeedCenter from '../pages/FeedCenter'
import Settings from '../pages/Settings'
import Writing from '../pages/Writing'
import Copywriting from '../pages/Copywriting'
import GameUI from '../pages/GameUI'
import AgentHub from '../pages/AgentHub'
import Analytics from '../pages/Analytics'
import type { PageKey } from '../nav'

/**
 * 页面路由表：主窗口与独立窗口共用同一份映射，
 * 保证"在新窗口打开"得到的页面与主窗口内完全一致（含 id / action 参数）。
 *
 * 融合后：
 *   - AI 助手 并入 自动工作台（dashboard）
 *   - 全网热点 与 智能体 收敛为统一情报流（hotspots → FeedCenter）
 *   - 'ai' / 'agents'：ai→工作台；agents→智能体任务中心（Multica 对标）
 */
export interface PageViewProps {
  page: PageKey
  /** 目标 id：笔记 id / 自动化 id / 白板 id */
  id?: string
  /** 目标动作：如 new-note / new-automation，由页面自行消费 */
  action?: string
}

export default function PageView({ page, id, action }: PageViewProps) {
  switch (page) {
    case 'dashboard':
    case 'ai':
      return <AutoWorkbench openAutomationId={id} action={action} />
    case 'notes':
      return <Notes openNoteId={id} />
    case 'database':
      return <DataLab />
    case 'boards':
      return <Boards openBoardId={id} />
    case 'texttools':
      return <TextTools />
    case 'filetools':
      return <FileTools />
    case 'toolbox':
      return <Toolbox />
    case 'knowledge':
      return <KnowledgeBase />
    case 'hotspots':
      return <FeedCenter />
    case 'stickies':
      return <Stickies />
    case 'writing':
      return <Writing />
    case 'copywriting':
      return <Copywriting />
    case 'docs':
      return <DocsViewer />
    case 'gameui':
      return <GameUI />
    case 'agents':
      return <AgentHub />
    case 'novel':
      // 「长篇作品」已并入写作页（同一 WritingWorkspace）。保留本分支做重定向：
      // 历史跳转、独立窗口 ?win=novel、旧设置残留都不会白屏；novelMode 让长篇用户
      // 仍落在长篇三栏（章节树 / 正文 / 长篇工具），有 id 时直达指定章节。
      return <Writing openChapterId={id} novelMode />
    case 'analytics':
      return <Analytics />
    case 'settings':
      return <Settings />
    default:
      return <AutoWorkbench />
  }
}
