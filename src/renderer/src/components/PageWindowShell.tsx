import { useEffect } from 'react'
import { theme as antdTheme } from 'antd'
import TitleBar from './TitleBar'
import WindowResizeHandles from './WindowResizeHandles'
import PageView from './PageView'
import { pageLabel } from '../navItems'
import type { PageKey } from '../nav'

/**
 * 独立页面窗口外壳（?win=<page>）。
 *
 * 与主窗口共享同一套无边框窗口能力：
 *   - TitleBar：拖动 / 最小化 / 最大化还原 / 关闭（关闭只关本窗口，不退出应用）
 *   - WindowResizeHandles：八向边角拖拽缩放，尺寸按页面档案限制并记忆
 *   - PageView：与侧边栏导航完全相同的页面内容（含 id 参数）
 */
export default function PageWindowShell({ page, id }: { page: PageKey; id?: string }) {
  const { token } = antdTheme.useToken()

  // 窗口标题跟随页面（任务栏 / Alt+Tab 显示用）
  useEffect(() => {
    document.title = `${pageLabel(page)} · 灵墨工作台`
  }, [page])

  return (
    <div className="app-root">
      <TitleBar title={pageLabel(page)} />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          background: 'var(--app-bg)'
        }}
      >
        <div key={page} className="page-enter" style={{ height: '100%' }}>
          <div
            style={{
              height: '100%',
              minWidth: 0,
              background: token.colorBgContainer,
              color: token.colorText
            }}
          >
            <PageView page={page} id={id} />
          </div>
        </div>
      </div>
      <WindowResizeHandles />
    </div>
  )
}
