import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'

/** 环境壁纸模式（对齐 Linear / Arc 等桌面端氛围背景思路，非二次产品语言） */
export type WallpaperMode =
  | 'theme'
  | 'paper'
  | 'ink'
  | 'aurora'
  | 'mesh'
  | 'ocean'
  | 'sunset'
  | 'forest'
  | 'custom'
  | 'image'

export interface Prefs {
  colorPrimary: string
  defaultPage: string
  /** 浅色主题下 UI 表面背景色（菜单 / 对话框等浮层），HEX 格式 */
  surfaceBg: string
  /** 浅色主题下 UI 表面不透明度，取值范围 0–1（0=全透明，1=不透明） */
  surfaceOpacity: number
  /** 氛境壁纸模式 */
  wallpaperMode?: WallpaperMode
  /** custom 模式主色 */
  wallpaperColor?: string
  /** custom 模式辅助色 */
  wallpaperColor2?: string
  /** 壁纸层强度 0–1 */
  wallpaperIntensity?: number
  /** 动效档位：full / subtle / none */
  motionLevel?: 'full' | 'subtle' | 'none'
  /** 自定义壁纸图：已复制到 userData/wallpapers/ 的绝对路径 */
  wallpaperImage?: string
  /** 图片铺满方式 */
  wallpaperImageFit?: 'cover' | 'contain'
  /** 分区域壁纸：标题栏 / 侧栏 / 内容区可独立开关与模式 */
  wallpaperZones?: WallpaperZones
}

/** 单个区域的壁纸配置 */
export interface WallpaperZoneConfig {
  enabled: boolean
  /** inherit = 跟随全局 wallpaperMode */
  mode: WallpaperMode | 'inherit'
  /** 区域强度 0–1；-1 表示跟随全局 */
  intensity: number
  /** 该区域独立壁纸图路径（mode=image 时优先于全局 wallpaperImage） */
  image?: string
  /** 本区域自定义主色 */
  color?: string
  /** 本区域自定义辅色 */
  color2?: string
}

export interface WallpaperZones {
  titlebar: WallpaperZoneConfig
  sider: WallpaperZoneConfig
  content: WallpaperZoneConfig
}

const DEFAULT_ZONE: WallpaperZoneConfig = { enabled: true, mode: 'inherit', intensity: -1 }

const DEFAULTS: Prefs = {
  colorPrimary: '#4f6ef7',
  defaultPage: 'dashboard',
  surfaceBg: '#FDFBF5',
  surfaceOpacity: 1,
  wallpaperMode: 'theme',
  wallpaperColor: '#28607D',
  wallpaperColor2: '#46D4E6',
  wallpaperIntensity: 0.85,
  motionLevel: 'full',
  wallpaperImage: '',
  wallpaperImageFit: 'cover',
  wallpaperZones: {
    titlebar: { ...DEFAULT_ZONE },
    sider: { ...DEFAULT_ZONE },
    content: { ...DEFAULT_ZONE }
  }
}

function file(): string {
  return join(app.getPath('userData'), 'preferences.json')
}

export async function getPrefs(): Promise<Prefs> {
  try {
    const raw = await fs.readFile(file(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<Prefs>
    return {
      ...DEFAULTS,
      ...parsed,
      wallpaperZones: {
        titlebar: { ...DEFAULT_ZONE, ...(parsed.wallpaperZones?.titlebar ?? {}) },
        sider: { ...DEFAULT_ZONE, ...(parsed.wallpaperZones?.sider ?? {}) },
        content: { ...DEFAULT_ZONE, ...(parsed.wallpaperZones?.content ?? {}) }
      }
    }
  } catch {
    return DEFAULTS
  }
}

export async function setPrefs(p: Prefs): Promise<Prefs> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(file(), JSON.stringify({ ...DEFAULTS, ...p }, null, 2), 'utf-8')
  return { ...DEFAULTS, ...p }
}
