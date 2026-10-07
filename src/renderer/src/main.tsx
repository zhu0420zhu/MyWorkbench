import '@ant-design/v5-patch-for-react-19'
import React, { useEffect, useMemo } from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { ThemeProvider, useTheme, getAntdAlgorithm, resolveAccent, hexToRgba } from './theme/theme'
import { NavProvider, type NavTarget } from './nav'
import { PrefsProvider, usePrefs } from './prefs'
import './assets/main.css'

/**
 * 独立页面窗口（?win=xxx）内部的跨页跳转不切换自身内容，
 * 而是交给主窗口打开并聚焦，避免"写作窗口里点文本工具后窗口内容漂移"。
 */
const isPageWindow = new URLSearchParams(window.location.search).has('win')
const detachNavigate = (t: NavTarget): void => {
  void window.api.windowApi.navigateInMain(t.page, t.id)
}

function Root() {
  const { isDark } = useTheme()
  const { prefs } = usePrefs()

  const surface = useMemo(() => {
    if (isDark) {
      return { elevated: '#20242F', container: '#20242F', mask: 'rgba(0, 0, 0, 0.45)' }
    }
    const bg = prefs.surfaceBg
    const op = Number.isFinite(prefs.surfaceOpacity) ? Math.min(1, Math.max(0, prefs.surfaceOpacity)) : 1
    const rgba = hexToRgba(bg, op)
    return { elevated: rgba, container: rgba, mask: 'rgba(0, 0, 0, 0.45)' }
  }, [isDark, prefs.surfaceBg, prefs.surfaceOpacity])

  // 表面 / 壁纸 / 动效 → CSS 变量
  useEffect(() => {
    const el = document.documentElement
    const op = isDark ? 1 : Number.isFinite(prefs.surfaceOpacity) ? Math.min(1, Math.max(0, prefs.surfaceOpacity)) : 1
    el.style.setProperty('--wb-surface-bg', surface.elevated)
    el.style.setProperty('--wb-surface-opacity', String(op))
    el.style.setProperty('--wp-opacity', String(Math.min(1, Math.max(0, prefs.wallpaperIntensity ?? 0.85))))
    el.style.setProperty('--wp-c1', prefs.wallpaperColor || '#28607D')
    el.style.setProperty('--wp-c2', prefs.wallpaperColor2 || '#46D4E6')
    el.dataset.motion = prefs.motionLevel || 'full'
  }, [
    surface,
    isDark,
    prefs.surfaceOpacity,
    prefs.wallpaperIntensity,
    prefs.wallpaperColor,
    prefs.wallpaperColor2,
    prefs.motionLevel
  ])

  const layoutBg = useMemo(() => {
    const mode = prefs.wallpaperMode || 'theme'
    if (mode === 'theme') return isDark ? '#171923' : '#F6F1E6'
    // 壁纸模式：布局必须近透明，否则 antd Layout 会盖住氛围层
    return isDark ? 'rgba(14,16,22,0.35)' : 'rgba(243,239,230,0.28)'
  }, [prefs.wallpaperMode, isDark])

  // 壁纸开关标记：供 CSS 让内容区透明、侧栏玻璃更透
  const wallpaperOn = (prefs.wallpaperMode || 'theme') !== 'theme'

  useEffect(() => {
    const el = document.documentElement
    if (wallpaperOn) el.dataset.wpOn = '1'
    else delete el.dataset.wpOn
  }, [wallpaperOn])

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: getAntdAlgorithm(isDark),
        token: {
          colorPrimary: resolveAccent(prefs.colorPrimary, isDark),
          borderRadius: isDark ? 10 : 8,
          colorBgLayout: layoutBg,
          colorBgContainer: surface.container,
          colorBgElevated: surface.elevated,
          colorBgMask: surface.mask
        }
      }}
    >
      <App />
    </ConfigProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <PrefsProvider>
          <NavProvider onNavigate={isPageWindow ? detachNavigate : undefined}>
            <Root />
          </NavProvider>
        </PrefsProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
