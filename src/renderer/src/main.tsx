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

  /**
   * 浅色主题下，菜单 / 对话框等浮层背景色与透明度可由用户配置：
   * - surfaceBg：表面背景色（HEX）
   * - surfaceOpacity：不透明度 0–1
   * 两者合成 rgba 同时作用于 antd 全局 token（colorBgElevated 菜单浮层 / colorBgContainer 对话框内容），
   * 保证浅色主题下各界面元素视觉统一。暗色主题保持原有设计值。
   */
  const surface = useMemo(() => {
    if (isDark) {
      return { elevated: '#20242F', container: '#20242F', mask: 'rgba(0, 0, 0, 0.45)' }
    }
    const bg = prefs.surfaceBg
    const op = Number.isFinite(prefs.surfaceOpacity) ? Math.min(1, Math.max(0, prefs.surfaceOpacity)) : 1
    const rgba = hexToRgba(bg, op)
    return { elevated: rgba, container: rgba, mask: 'rgba(0, 0, 0, 0.45)' }
  }, [isDark, prefs.surfaceBg, prefs.surfaceOpacity])

  // 把表面样式注入 CSS 变量，供自定义（非 antd token）组件复用
  useEffect(() => {
    const el = document.documentElement
    const op = isDark ? 1 : Number.isFinite(prefs.surfaceOpacity) ? Math.min(1, Math.max(0, prefs.surfaceOpacity)) : 1
    el.style.setProperty('--wb-surface-bg', surface.elevated)
    el.style.setProperty('--wb-surface-opacity', String(op))
  }, [surface, isDark, prefs.surfaceOpacity])

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: getAntdAlgorithm(isDark),
        token: {
          colorPrimary: resolveAccent(prefs.colorPrimary, isDark),
          /* 浅色国风 8px / 暗黑控制台 10px 圆角 */
          borderRadius: isDark ? 10 : 8,
          /* 底色对齐设计稿：浅色宣纸 / 暗色 #171923 系 */
          colorBgLayout: isDark ? '#171923' : '#F6F1E6',
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
