import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PageKey } from './nav'

/** 氛境壁纸（桌面端氛围背景，参考 Linear / Arc / 现代 IDE 的环境层） */
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
  defaultPage: PageKey
  /** 浅色主题下 UI 表面背景色（菜单 / 对话框等浮层），HEX 格式 */
  surfaceBg: string
  /** 浅色主题下 UI 表面不透明度，取值范围 0–1（0=全透明，1=不透明） */
  surfaceOpacity: number
  wallpaperMode: WallpaperMode
  wallpaperColor: string
  wallpaperColor2: string
  wallpaperIntensity: number
  motionLevel: 'full' | 'subtle' | 'none'
  /** 自定义壁纸：userData/wallpapers 下的绝对路径 */
  wallpaperImage: string
  wallpaperImageFit: 'cover' | 'contain'
  /** 分区域壁纸 */
  wallpaperZones: WallpaperZones
}

export type WallpaperZoneKey = 'titlebar' | 'sider' | 'content'

export interface WallpaperZoneConfig {
  enabled: boolean
  mode: WallpaperMode | 'inherit'
  /** -1 = 跟随全局 */
  intensity: number
  /** 本区域独立壁纸图（mode=image 时优先） */
  image?: string
  /** 本区域自定义主色（mode=custom 时优先于全局） */
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

interface PrefsContextValue {
  prefs: Prefs
  update: (patch: Partial<Prefs>) => Promise<void>
}

const PrefsContext = createContext<PrefsContextValue>({
  prefs: DEFAULTS,
  update: async () => {}
})

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULTS)

  useEffect(() => {
    window.api.prefs
      .get()
      .then((p) => setPrefsState({ ...DEFAULTS, ...p, defaultPage: (p.defaultPage ?? 'dashboard') as PageKey }))
      .catch(() => undefined)
  }, [])

  const update = useCallback(
    async (patch: Partial<Prefs>): Promise<void> => {
      const next = { ...prefs, ...patch }
      setPrefsState(next)
      try {
        await window.api.prefs.set(next as never)
      } catch {
        /* ignore */
      }
    },
    [prefs]
  )

  const value = useMemo(() => ({ prefs, update }), [prefs, update])
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>
}

export function usePrefs() {
  return useContext(PrefsContext)
}

/** 壁纸预设（设置页展示 + App 应用共用） */
export const WALLPAPER_PRESETS: Array<{
  id: Exclude<WallpaperMode, 'custom'>
  label: string
  /** 设置页色块预览 */
  preview: string
  /** light / dark 下的基础底色（叠加 wallpaper 层之前） */
  lightBg: string
  darkBg: string
}> = [
  { id: 'theme', label: '跟随主题', preview: 'linear-gradient(135deg,#f6f1e6,#e8e0d0)', lightBg: '#f6f1e6', darkBg: '#171923' },
  { id: 'paper', label: '宣纸', preview: 'linear-gradient(160deg,#faf6ec,#e7dcc8)', lightBg: '#f7f2e7', darkBg: '#1c1b18' },
  { id: 'ink', label: '水墨', preview: 'linear-gradient(160deg,#2a2e38,#0e1016)', lightBg: '#e8eaef', darkBg: '#12141c' },
  { id: 'aurora', label: '极光', preview: 'radial-gradient(ellipse at 20% 20%,#5b8def,transparent),radial-gradient(ellipse at 80% 60%,#46d4e6,transparent),#1a1d2e', lightBg: '#eef3fb', darkBg: '#141828' },
  { id: 'mesh', label: '网格渐变', preview: 'linear-gradient(120deg,#c7d2fe,#fbcfe8,#a5f3fc)', lightBg: '#f3f4f8', darkBg: '#1b1d28' },
  { id: 'ocean', label: '深海', preview: 'linear-gradient(160deg,#0b3d4a,#0d1b24)', lightBg: '#e6f2f4', darkBg: '#0c1a22' },
  { id: 'sunset', label: '日落', preview: 'linear-gradient(160deg,#f6a06d,#c45c5c)', lightBg: '#fdf0e8', darkBg: '#241818' },
  { id: 'forest', label: '森野', preview: 'linear-gradient(160deg,#2f5d3a,#15241a)', lightBg: '#e9f2eb', darkBg: '#121c16' }
]

export function hexToRgbaSafe(hex: string | undefined, alpha: number): string {
  const a = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1
  const h = (hex ?? '').trim()
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(h)
  if (!m) return `rgba(40, 96, 125, ${a})`
  const v = m[1]
  const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}
