import '@ant-design/v5-patch-for-react-19'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { ThemeProvider, useTheme, getAntdAlgorithm, resolveAccent } from './theme/theme'
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
          colorBgContainer: isDark ? '#20242F' : '#FDFBF5'
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
