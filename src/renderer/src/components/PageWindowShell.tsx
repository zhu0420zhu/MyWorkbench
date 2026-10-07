import { useEffect } from 'react'
import { theme as antdTheme } from 'antd'
import TitleBar from './TitleBar'
import WindowResizeHandles from './WindowResizeHandles'
import PageView from './PageView'
import WallpaperLayer from './WallpaperLayer'
import { pageLabel } from '../navItems'
import type { PageKey } from '../nav'
import { usePrefs } from '../prefs'

/**
 * 独立页面窗口外壳（?win=<page>）。
 *
 * 与主窗口共享同一套无边框窗口能力：
 *   - TitleBar：拖动 / 最小化 / 最大化还原 / 关闭（关闭只关本窗口，不退出应用）
 *   - WindowResizeHandles：八向边角拖拽缩放，尺寸按页面档案限制并记忆
 *   - PageView：与侧边栏导航完全相同的页面内容（含 id 参数）
 *   - WallpaperLayer：与主窗口同一套氛境壁纸与玻璃标题栏
 */
export default function PageWindowShell({ page, id }: { page: PageKey; id?: string }) {
  const { token } = antdTheme.useToken()
  const { prefs } = usePrefs()
  const wallpaperOn = (prefs.wallpaperMode || 'theme') !== 'theme'

  // 窗口标题跟随页面（任务栏 / Alt+Tab 显示用）
  useEffect(() => {
    document.title = `${pageLabel(page)} · 灵墨工作台`
  }, [page])

  return (
    <>
      <WallpaperLayer />
      <div className="app-root">
        <TitleBar title={pageLabel(page)} />
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
            background: wallpaperOn ? 'transparent' : 'var(--app-bg)'
          }}
        >
          <div key={page} className="page-enter" style={{ height: '100%' }}>
            <div
              className="page-window-surface"
              style={{
                height: '100%',
                minWidth: 0,
                color: token.colorText,
                background: wallpaperOn
                  ? (prefs.surfaceOpacity ?? 1) < 0.98
                    ? `color-mix(in srgb, ${token.colorBgContainer} ${Math.round((prefs.surfaceOpacity ?? 1) * 100)}%, transparent)`
                    : token.colorBgContainer
                  : token.colorBgContainer,
                backdropFilter: wallpaperOn ? 'blur(8px)' : undefined,
                WebkitBackdropFilter: wallpaperOn ? 'blur(8px)' : undefined,
                borderRadius: wallpaperOn ? 0 : 0
              }}
            >
              <PageView page={page} id={id} />
            </div>
          </div>
        </div>
        <WindowResizeHandles />
      </div>
    </>
  )
}
