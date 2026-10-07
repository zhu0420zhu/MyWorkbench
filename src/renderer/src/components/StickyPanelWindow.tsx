import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, Typography, theme as antdTheme } from 'antd'
import { CloseOutlined, CompressOutlined, PushpinOutlined } from '@ant-design/icons'
import Stickies from '../pages/Stickies'

type PanelMode = 'collapsed' | 'expanded'

/**
 * 便利贴悬浮面板窗（主窗口最小化时自动弹出）。
 *
 * 双形态：
 * - collapsed：约文件夹大小的紧凑图标（整窗可拖动、显示贴纸数量），点击展开
 * - expanded：完整便利贴页面，复用同一 Stickies 组件与同一套 CSS，1:1 保真不压缩
 *
 * 流畅性：主进程先广播形态 → 渲染层立即换 UI（CSS 入场动画）→ 稍后窗口尺寸动画，
 * 内容先就位再缩放，避免「窗口先变形、内容后跟上」的割裂感。
 */
export default function StickyPanelWindow() {
  const { token } = antdTheme.useToken()
  const [mode, setMode] = useState<PanelMode | null>(null)
  const [count, setCount] = useState(0)

  // 初始形态 + 主进程形态广播
  useEffect(() => {
    let alive = true
    window.api.stickies
      .panelMode()
      .then((m) => {
        if (alive) setMode(m)
      })
      .catch(() => {
        if (alive) setMode('collapsed')
      })
    const off = window.api.stickies.onPanelMode((m) => setMode(m))
    return () => {
      alive = false
      off()
    }
  }, [])

  // 折叠态需要展示贴纸数量（便利贴变更时同步）
  const loadCount = useCallback(() => {
    window.api.stickies
      .list()
      .then((l) => setCount(l.length))
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    loadCount()
    return window.api.stickies.onStickyUpdate(() => loadCount())
  }, [loadCount])

  // 窗口为 transparent，确保折叠态不出现方角底色
  useEffect(() => {
    const prevHtml = document.documentElement.style.background
    const prevBody = document.body.style.background
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    return () => {
      document.documentElement.style.background = prevHtml
      document.body.style.background = prevBody
    }
  }, [])

  const toggle = useCallback((next: PanelMode) => {
    // 乐观更新：立刻切 UI，主进程随后驱动窗口尺寸动画
    setMode(next)
    void window.api.stickies.panelSetMode(next)
  }, [])

  // 展开态按 Esc 收起为折叠图标（输入框内不响应，避免打断打字）
  const lastToggleAt = useRef(0)
  useEffect(() => {
    if (mode !== 'expanded') return
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (e.key === 'Escape') {
        // 防抖：窗口尺寸动画期间忽略重复按键
        const now = Date.now()
        if (now - lastToggleAt.current < 350) return
        lastToggleAt.current = now
        toggle('collapsed')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, toggle])

  if (mode === null) {
    // 首帧：未知形态，渲染空白避免闪一下错尺寸的内容
    return <div style={{ height: '100vh', background: 'transparent' }} />
  }

  /* ---------------- 折叠态：紧凑图标 ---------------- */
  if (mode === 'collapsed') {
    return (
      <div
        className="sticky-panel-drag"
        style={{
          height: '100vh',
          background: 'transparent',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer'
        }}
        onClick={() => toggle('expanded')}
        title="点击展开便利贴"
      >
        <div
          className="sticky-panel-pop sticky-panel-icon"
          style={{
            width: 104,
            height: 104,
            borderRadius: 22,
            background: token.colorBgElevated,
            border: `1px solid ${token.colorBorderSecondary}`,
            boxShadow: '0 8px 24px rgba(0,0,0,.28)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            transition: 'transform .15s ease, box-shadow .15s ease'
          }}
        >
          <Badge count={count} size="small" offset={[10, -6]}>
            <PushpinOutlined style={{ fontSize: 30, color: token.colorPrimary }} />
          </Badge>
          <Typography.Text style={{ fontSize: 12, color: token.colorTextSecondary }}>
            便利贴
          </Typography.Text>
        </div>
      </div>
    )
  }

  /* ---------------- 展开态：完整便利贴 ---------------- */
  return (
    <div
      className="sticky-panel-fade"
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--wb-surface-bg, ' + token.colorBgLayout + ')'
      }}
    >
      {/* 拖拽条：无边框窗口拖动区域 · 玻璃标题 */}
      <div
        className="sticky-panel-drag titlebar-glass"
        style={{
          height: 34,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 6px 0 14px',
          borderBottom: `1px solid ${token.colorSplit}`,
          userSelect: 'none'
        }}
      >
        <Typography.Text strong style={{ fontSize: 13 }}>
          <PushpinOutlined style={{ marginRight: 6, color: token.colorPrimary }} />
          便利贴 · 悬浮
        </Typography.Text>
        <div style={{ display: 'flex', gap: 2 }}>
          <Button
            className="sticky-panel-nodrag"
            type="text"
            size="small"
            icon={<CompressOutlined />}
            title="收起为桌面图标（还原主窗口后自动收起整个悬浮窗）"
            onClick={() => toggle('collapsed')}
          />
          <Button
            className="sticky-panel-nodrag"
            type="text"
            size="small"
            icon={<CloseOutlined />}
            title="关闭悬浮窗"
            onClick={() => window.api.windowApi.close()}
          />
        </div>
      </div>
      {/* 内容区：完整便利贴页面。
          minWidth 让窗口放大过程中按展开态宽度布局，避免卡片网格反复重排。 */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 520,
          overflow: 'auto',
          padding: '10px 16px 20px'
        }}
      >
        <Stickies />
      </div>
    </div>
  )
}
