import type { ReactNode } from 'react'
import {
  DashboardOutlined,
  FileTextOutlined,
  SettingOutlined,
  DatabaseOutlined,
  BgColorsOutlined,
  ToolOutlined,
  FolderOpenOutlined,
  AppstoreOutlined,
  FireOutlined,
  BookOutlined,
  PushpinOutlined,
  FormOutlined,
  NotificationOutlined,
  FileSearchOutlined,
  ThunderboltOutlined,
  // AppstoreOutlined,
  BarChartOutlined,
  BuildOutlined
} from '@ant-design/icons'
import { pageLabelOf } from '@shared/pageMeta'
import type { PageKey } from './nav'

/**
 * 导航元数据：侧边栏菜单、独立窗口标题、命令面板共用一份。
 *
 * 中文名不在这里硬编码，统一取自 `@shared/pageMeta` 的 PAGE_LABELS——
 * 同一份名表还被主进程的窗口标题（pageWindows.ts）、命令面板（search.ts）、
 * 设置默认页（Settings.tsx）引用，避免各处人工同步导致漂移。
 */
export interface NavMeta {
  key: PageKey
  icon: ReactNode
  label: string
}

/**
 * 有侧边栏入口的页面及其图标（顺序即默认展示顺序）。
 * 隐藏页不在此列，但仍可通过 PAGE_LABELS 取到中文名。
 */
const NAV_DEFS: Array<{ key: PageKey; icon: ReactNode }> = [
  { key: 'dashboard', icon: <DashboardOutlined /> },
  { key: 'knowledge', icon: <BookOutlined /> },
  { key: 'filetools', icon: <FolderOpenOutlined /> },
  { key: 'docs', icon: <FileSearchOutlined /> },
  { key: 'writing', icon: <FormOutlined /> },
  { key: 'copywriting', icon: <NotificationOutlined /> },
  { key: 'notes', icon: <FileTextOutlined /> },
  { key: 'stickies', icon: <PushpinOutlined /> },
  { key: 'texttools', icon: <ToolOutlined /> },
  // 开发工具箱：独立侧栏入口（此前仅内嵌在文件工具页的「开发工具箱」分组里）
  { key: 'toolbox', icon: <BuildOutlined /> },
  // 暂时隐藏游戏UI设计入口（页面代码保留，恢复时取消注释）
  // { key: 'gameui', icon: <AppstoreOutlined /> },
  { key: 'database', icon: <DatabaseOutlined /> },
  { key: 'boards', icon: <BgColorsOutlined /> },
  { key: 'hotspots', icon: <FireOutlined /> },
  { key: 'agents', icon: <ThunderboltOutlined /> },
  { key: 'settings', icon: <SettingOutlined /> },
  { key: 'analytics', icon: <BarChartOutlined /> }
]

export const NAV: NavMeta[] = NAV_DEFS.map(({ key, icon }) => ({
  key,
  icon,
  label: pageLabelOf(key)
}))

/**
 * page key → 中文名。
 *
 * 走 PAGE_LABELS 全量映射，**不要**改成「在 NAV 里查、查不到回退 key」——
 * NAV 只含侧边栏收录页，隐藏页（如 ai）会因此显示成英文 key。
 */
export function pageLabel(page: string): string {
  return pageLabelOf(page)
}
