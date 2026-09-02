import type { ReactNode } from 'react'
import {
  DashboardOutlined,
  FileTextOutlined,
  SettingOutlined,
  DatabaseOutlined,
  BgColorsOutlined,
  ToolOutlined,
  FolderOpenOutlined,
  FireOutlined,
  BookOutlined,
  PushpinOutlined,
  FormOutlined,
  NotificationOutlined,
  AppstoreOutlined,
  BarChartOutlined
} from '@ant-design/icons'
import type { PageKey } from './nav'

/**
 * 导航元数据：侧边栏菜单、独立窗口标题、命令面板共用一份，
 * 避免"独立窗口标题"与"侧边栏名称"两处维护不同步。
 */
export interface NavMeta {
  key: PageKey
  icon: ReactNode
  label: string
}

export const NAV: NavMeta[] = [
  { key: 'dashboard', icon: <DashboardOutlined />, label: '自动工作台' },
  { key: 'knowledge', icon: <BookOutlined />, label: '本地知识库' },
  { key: 'filetools', icon: <FolderOpenOutlined />, label: '文件工具' },
  { key: 'writing', icon: <FormOutlined />, label: '写作' },
  { key: 'copywriting', icon: <NotificationOutlined />, label: '文案' },
  { key: 'notes', icon: <FileTextOutlined />, label: '笔记' },
  { key: 'stickies', icon: <PushpinOutlined />, label: '便利贴' },
  { key: 'texttools', icon: <ToolOutlined />, label: '文本工具' },
  { key: 'gameui', icon: <AppstoreOutlined />, label: '游戏UI设计' },
  { key: 'database', icon: <DatabaseOutlined />, label: '数据整理' },
  { key: 'boards', icon: <BgColorsOutlined />, label: '白板' },
  { key: 'hotspots', icon: <FireOutlined />, label: '多媒体' },
  { key: 'settings', icon: <SettingOutlined />, label: '设置' },
  { key: 'analytics', icon: <BarChartOutlined />, label: '数据分析' }
]

/** page key → 中文名（未知 key 回退为 key 本身） */
export function pageLabel(page: string): string {
  return NAV.find((n) => n.key === page)?.label ?? page
}
