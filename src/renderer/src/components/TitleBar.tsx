import { useEffect, useMemo, useState } from 'react'
import { CloseOutlined, ExportOutlined, MinusOutlined } from '@ant-design/icons'
import { Tooltip, theme as antdTheme } from 'antd'
import type { PageKey } from '../nav'
import { useTheme } from '../theme/theme'
import { useZoneChrome, zoneWallpaperBackground } from './WallpaperLayer'

interface TitleBarProps {
  /** 标题文字：主窗口为产品名，独立窗口为页面名 */
  title?: string
  /** 主窗口当前页面：传入后显示「在新窗口打开」，把该页分离为独立窗口 */
  page?: PageKey
  /** 目标 id（笔记 id / 白板 id），与 page 一起用于独立窗口定位 */
  pageId?: string
}

export default function TitleBar({ title = '灵墨工作台', page, pageId }: TitleBarProps) {
  const [maximized, setMaximized] = useState(false)
  const { token } = antdTheme.useToken()
  const { isDark } = useTheme()
  const zone = useZoneChrome('titlebar')
  const [imgUrl, setImgUrl] = useState('')

  useEffect(() => {
    const off = window.api.windowApi.onMaximizedChange((m) => setMaximized(m))
    return off
  }, [])

  useEffect(() => {
    let alive = true
    const path = zone.imagePath
    if (!zone.enabled || zone.mode !== 'image' || !path) {
      setImgUrl('')
      return
    }
    void window.api.prefs
      .wallpaperUrl(path)
      .then((u) => {
        if (alive) setImgUrl(u)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [zone.enabled, zone.mode, zone.imagePath])

  const zoneBg = useMemo(() => {
    if (!zone.enabled) return undefined
    return zoneWallpaperBackground(zone.mode, isDark, zone.c1, zone.c2, zone.mode === 'image' ? imgUrl : undefined)
  }, [zone, isDark, imgUrl])

  return (
    <div
      className="titlebar titlebar-glass"
      data-wp-zone={zone.enabled ? zone.mode : 'off'}
      style={{
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: zone.enabled && zoneBg && zoneBg !== 'transparent' ? zoneBg : undefined,
        opacity: zone.enabled ? Math.max(0.55, zone.opacity) : undefined,
        backgroundSize: zone.mode === 'image' ? 'cover' : undefined,
        backgroundPosition: 'center'
      }}
    >
      <div className="titlebar-drag">
        <span className="titlebar-title" style={{ color: token.colorTextSecondary }}>
          {title}
        </span>
      </div>
      <div className="titlebar-controls">
        {page && (
          <Tooltip title="在新窗口打开（可独立缩放、尺寸自动记忆）">
            <button
              className="tb-btn"
              onClick={() => void window.api.windowApi.openPageWindow(page, pageId)}
              aria-label="在新窗口打开"
            >
              <ExportOutlined />
            </button>
          </Tooltip>
        )}
        <button
          className="tb-btn"
          onClick={() => window.api.windowApi.minimize()}
          title="最小化"
          aria-label="最小化"
        >
          <MinusOutlined />
        </button>
        <button
          className="tb-btn"
          onClick={() => window.api.windowApi.toggleMaximize()}
          title={maximized ? '还原' : '最大化'}
          aria-label={maximized ? '还原' : '最大化'}
        >
          {maximized ? <span className="tb-restore" /> : <span className="tb-max" />}
        </button>
        <button
          className="tb-btn tb-close"
          onClick={() => window.api.windowApi.close()}
          title="关闭"
          aria-label="关闭"
        >
          <CloseOutlined />
        </button>
      </div>
    </div>
  )
}
