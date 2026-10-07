/** 氛境壁纸层：按区域开关（内容区整屏层；标题栏/侧栏由各自 chrome 绘制） */
import { useEffect, useMemo, useState } from 'react'
import { usePrefs } from '../prefs'

export function resolveZoneMode(mode: string | undefined, globalMode: string): string {
  return !mode || mode === 'inherit' ? globalMode : mode
}

export function resolveZoneIntensity(zoneIntensity: number | undefined, globalIntensity: number): number {
  if (zoneIntensity == null || zoneIntensity < 0) return globalIntensity
  return Math.min(1, Math.max(0, zoneIntensity))
}

/** 把壁纸模式编译成 CSS background（标题栏/侧栏共用） */
export function zoneWallpaperBackground(
  mode: string,
  isDark: boolean,
  c1: string,
  c2: string,
  imageUrl?: string
): string {
  if (mode === 'theme' || !mode) return 'transparent'
  if (mode === 'image' && imageUrl) {
    return `url("${imageUrl}") center / cover no-repeat`
  }
  switch (mode) {
    case 'paper':
      return isDark
        ? 'linear-gradient(165deg, #1e1c18, #141310)'
        : 'linear-gradient(165deg, #f7f2e7, #ebe2d0)'
    case 'ink':
      return isDark
        ? 'radial-gradient(ellipse 90% 60% at 30% 0%, rgba(70,212,230,.08), transparent 55%), linear-gradient(165deg, #1a1d28, #0c0e14)'
        : 'linear-gradient(160deg, #e8eaef, #d5d9e2)'
    case 'aurora':
      return isDark
        ? 'radial-gradient(ellipse 70% 80% at 10% 0%, rgba(91,141,239,.4), transparent 60%), radial-gradient(ellipse 60% 80% at 90% 100%, rgba(70,212,230,.3), transparent 60%), linear-gradient(165deg,#141828,#0e101c)'
        : 'radial-gradient(ellipse 70% 80% at 10% 0%, rgba(91,141,239,.35), transparent 60%), linear-gradient(160deg,#eef3fb,#e4ebf7)'
    case 'mesh':
      return isDark
        ? 'radial-gradient(at 20% 30%, rgba(99,102,241,.35), transparent 50%), radial-gradient(at 80% 40%, rgba(236,72,153,.2), transparent 50%), #1b1d28'
        : 'radial-gradient(at 20% 30%, rgba(199,210,254,.8), transparent 50%), #f3f4f8'
    case 'ocean':
      return isDark
        ? 'linear-gradient(170deg,#0e2430,#081016)'
        : 'linear-gradient(170deg,#e6f2f4,#c5dde3)'
    case 'sunset':
      return isDark
        ? 'radial-gradient(ellipse 80% 100% at 80% 0%, rgba(246,160,109,.25), transparent 55%), linear-gradient(165deg,#2a1c18,#140e0c)'
        : 'radial-gradient(ellipse 80% 100% at 80% 0%, rgba(246,160,109,.4), transparent 55%), linear-gradient(160deg,#fdf0e8,#f5d0c0)'
    case 'forest':
      return isDark
        ? 'linear-gradient(165deg,#15241a,#0c120e)'
        : 'linear-gradient(165deg,#e9f2eb,#d2e4d6)'
    case 'custom':
      return isDark
        ? `radial-gradient(ellipse 80% 100% at 20% 0%, color-mix(in srgb, ${c2} 35%, transparent), transparent 60%), linear-gradient(165deg, color-mix(in srgb, ${c1} 40%, #12141c), color-mix(in srgb, ${c2} 15%, #0c0e14))`
        : `radial-gradient(ellipse 80% 100% at 20% 0%, color-mix(in srgb, ${c2} 40%, transparent), transparent 60%), linear-gradient(160deg, color-mix(in srgb, ${c1} 25%, #f7f5f0), color-mix(in srgb, ${c2} 20%, #f0ebe3))`
    default:
      return 'transparent'
  }
}

export default function WallpaperLayer() {
  const { prefs } = usePrefs()
  const contentZone = prefs.wallpaperZones?.content ?? { enabled: true, mode: 'inherit', intensity: -1, image: '' }
  const globalMode = prefs.wallpaperMode || 'theme'
  const mode = resolveZoneMode(contentZone.mode, globalMode) as string
  const enabled = contentZone.enabled !== false
  const motion = prefs.motionLevel || 'full'
  const [imageUrl, setImageUrl] = useState('')
  const contentImagePath = contentZone.image || prefs.wallpaperImage || ''
  const contentC1 = contentZone.color || prefs.wallpaperColor || '#28607D'
  const contentC2 = contentZone.color2 || prefs.wallpaperColor2 || '#46D4E6'

  useEffect(() => {
    let alive = true
    if (!enabled || mode !== 'image' || !contentImagePath) {
      setImageUrl('')
      return
    }
    void window.api.prefs
      .wallpaperUrl(contentImagePath)
      .then((url) => {
        if (alive) setImageUrl(url)
      })
      .catch(() => {
        if (alive) setImageUrl('')
      })
    return () => {
      alive = false
    }
  }, [enabled, mode, contentImagePath])

  const opacity = useMemo(
    () => resolveZoneIntensity(contentZone.intensity, prefs.wallpaperIntensity ?? 0.85),
    [contentZone.intensity, prefs.wallpaperIntensity]
  )

  if (!enabled || mode === 'theme') {
    // 内容区关闭壁纸时仍渲染空层，避免其他区域依赖 z-index 布局跳动
    return <div className="app-wallpaper" data-wp="theme" aria-hidden style={{ opacity: 0 }} />
  }

  return (
    <div className="app-wallpaper" data-wp={mode} aria-hidden style={{ opacity }}>
      <div
        className="wp-base"
        style={
          mode === 'image' && imageUrl
            ? {
                backgroundImage: `url("${imageUrl}")`,
                backgroundSize: prefs.wallpaperImageFit === 'contain' ? 'contain' : 'cover',
                backgroundPosition: 'center',
                backgroundRepeat: 'no-repeat'
              }
            : undefined
        }
      />
      {motion === 'full' && mode !== 'image' && (
        <>
          <div className="wp-orb wp-orb-1" />
          <div className="wp-orb wp-orb-2" />
        </>
      )}
    </div>
  )
}

/** 供标题栏/侧栏：解析该区域当前应显示的背景 CSS */
export function useZoneChrome(zone: 'titlebar' | 'sider') {
  const { prefs } = usePrefs()
  const z = prefs.wallpaperZones?.[zone] ?? {
    enabled: true,
    mode: 'inherit',
    intensity: -1,
    image: '',
    color: '',
    color2: ''
  }
  const globalMode = prefs.wallpaperMode || 'theme'
  const mode = resolveZoneMode(z.mode, globalMode)
  const enabled = z.enabled !== false && mode !== 'theme'
  const opacity = resolveZoneIntensity(z.intensity, prefs.wallpaperIntensity ?? 0.85)
  /** 本区域图片优先，否则回退全局壁纸图 */
  const imagePath = z.image || prefs.wallpaperImage || ''
  /** 本区域自定义色优先，否则全局 */
  const c1 = z.color || prefs.wallpaperColor || '#28607D'
  const c2 = z.color2 || prefs.wallpaperColor2 || '#46D4E6'
  return { enabled, mode, opacity, prefs, imagePath, c1, c2, zoneConfig: z }
}
