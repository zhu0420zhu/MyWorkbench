import AutoWorkbench from '../pages/AutoWorkbench'
import Notes from '../pages/Notes'
import DataLab from '../pages/DataLab'
import Boards from '../pages/Boards'
import TextTools from '../pages/TextTools'
import FileTools from '../pages/FileTools'
import KnowledgeBase from '../pages/KnowledgeBase'
import Stickies from '../pages/Stickies'
import FeedCenter from '../pages/FeedCenter'
import Settings from '../pages/Settings'
import Writing from '../pages/Writing'
import Copywriting from '../pages/Copywriting'
import GameUI from '../pages/GameUI'
import Novel from '../pages/Novel'
import Analytics from '../pages/Analytics'
import type { PageKey } from '../nav'

/**
 * 页面路由表：主窗口与独立窗口共用同一份映射，
 * 保证"在新窗口打开"得到的页面与主窗口内完全一致（含 id / action 参数）。
 *
 * 融合后：
 *   - AI 助手 并入 自动工作台（dashboard）
 *   - 全网热点 与 智能体 收敛为统一情报流（hotspots → FeedCenter）
 *   - 'ai' / 'agents' 旧入口仍保留路由，用于 deep-link / 全局搜索兼容，
 *     其中 'agents' 直接进入情报流（不再切换到独立智能体 Tab）
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
    case 'knowledge':
      return <KnowledgeBase />
    case 'agents':
    case 'hotspots':
      return <FeedCenter />
    case 'stickies':
      return <Stickies />
    case 'writing':
      return <Writing />
    case 'copywriting':
      return <Copywriting />
    case 'gameui':
      return <GameUI />
    case 'novel':
      return <Novel openChapterId={id} />
    case 'analytics':
      return <Analytics />
    case 'settings':
      return <Settings />
    default:
      return <AutoWorkbench />
  }
}
