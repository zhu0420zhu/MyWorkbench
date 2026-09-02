import type { ComponentType, CSSProperties } from 'react'
import {
  GithubOutlined,
  ChromeOutlined,
  FileTextOutlined,
  FolderOutlined,
  CodeOutlined,
  CloudOutlined,
  MailOutlined,
  SearchOutlined,
  PlayCircleOutlined,
  StarOutlined,
  GlobalOutlined,
  HomeOutlined,
  RocketOutlined,
  DatabaseOutlined
} from '@ant-design/icons'

export const ICON_MAP: Record<string, ComponentType<{ style?: CSSProperties }>> = {
  github: GithubOutlined,
  chrome: ChromeOutlined,
  file: FileTextOutlined,
  folder: FolderOutlined,
  code: CodeOutlined,
  cloud: CloudOutlined,
  mail: MailOutlined,
  search: SearchOutlined,
  play: PlayCircleOutlined,
  star: StarOutlined,
  globe: GlobalOutlined,
  home: HomeOutlined,
  rocket: RocketOutlined,
  database: DatabaseOutlined
}

export const ICON_KEYS = Object.keys(ICON_MAP)

export const COLORS = [
  '#28607D',
  '#46D4E6',
  '#13c2c2',
  '#52c41a',
  '#faad14',
  '#fa541c',
  '#eb2f96',
  '#722ed1'
]

export const DEFAULT_ICON = 'star'
export const DEFAULT_COLOR = COLORS[0]
