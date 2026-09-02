import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Layout, Button, Tooltip, theme as antdTheme, message } from 'antd'
import {
  SunOutlined,
  MoonOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SearchOutlined
} from '@ant-design/icons'
import TitleBar from './components/TitleBar'
import SearchModal from './components/SearchModal'
import CollapsibleMenu, { type CollapsibleMenuGroup } from './components/CollapsibleMenu'
import StickyPanelWindow from './components/StickyPanelWindow'
import PageWindowShell from './components/PageWindowShell'
import PageView from './components/PageView'
import WindowResizeHandles from './components/WindowResizeHandles'
import ConfirmCloseDialog from './components/ConfirmCloseDialog'
import { NAV } from './navItems'
import { useTheme, resolveAccent } from './theme/theme'
import { useNav, type PageKey } from './nav'
import { usePrefs } from './prefs'
import type { SearchResult, AppCommand } from '@shared/types'

const { Sider, Content } = Layout

/** 每个功能域一种主题色，作为分组色标，提升扫读效率 */
const GROUP_ACCENT: Record<string, string> = {
  '智能多媒体': '#378ADD',
  '内容创作': '#7F77DD',
  '智能工具': '#1D9E75',
  '系统': '#888780'
}

/** Alt+1..9 跳转顺序（高频页跨域速达） */
const ALT_PAGES: PageKey[] = [
  'dashboard',
  'knowledge',
  'filetools',
  'writing',
  'copywriting',
  'notes',
  'database',
  'analytics',
  'gameui',
  'settings'
]

export default function App() {
  // 三种窗口形态共用同一个 renderer 入口，靠 URL 参数区分：
  //   ?panel=stickies  → 便利贴悬浮面板窗（无侧栏/顶栏）
  //   ?win=<page>      → 页面独立窗口（写作 / 笔记 / 白板… 可独立缩放与记忆尺寸）
  //   无参数           → 主窗口
  const params = new URLSearchParams(window.location.search)
  if (params.get('panel') === 'stickies') {
    return <StickyPanelWindow />
  }
  const winPage = params.get('win')
  if (winPage) {
    return (
      <PageWindowShell page={winPage as PageKey} id={params.get('id') ?? undefined} />
    )
  }

  const [collapsed, setCollapsed] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [menuCollapsed, setMenuCollapsed] = useState(false)
  const { isDark, toggle } = useTheme()
  const { target, navigate } = useNav()
  const { prefs } = usePrefs()
  const { token } = antdTheme.useToken()

  // 主题色同步到 CSS 变量：antd token 之外的自定义样式（菜单选中态/徽标/色标/快捷卡片等）跟随用户主色；
  // 未显式选择时按主题回落到设计稿默认色（浅色石青 / 暗色冷青蓝）
  useEffect(() => {
    document.documentElement.style.setProperty('--accent', resolveAccent(prefs.colorPrimary, isDark))
  }, [prefs.colorPrimary, isDark])

  // 可伸缩菜单的分组模型：顶层分组入口 + 子项（点击导航）
  const MENU_GROUPS = useMemo<CollapsibleMenuGroup[]>(() => {
    const leaf = (key: PageKey) => {
      const m = NAV.find((n) => n.key === key)
      return { key, label: m?.label ?? key, icon: m?.icon, onClick: () => navigate({ page: key }) }
    }
    return [
      { key: 'g-ai', label: '智能多媒体', accent: GROUP_ACCENT['智能多媒体'], children: [leaf('dashboard'), leaf('knowledge'), leaf('hotspots')] },
      { key: 'g-content', label: '内容创作', accent: GROUP_ACCENT['内容创作'], children: [leaf('writing'), leaf('copywriting'), leaf('notes'), leaf('stickies'), leaf('boards'), leaf('gameui')] },
      { key: 'g-filedata', label: '智能工具', accent: GROUP_ACCENT['智能工具'], children: [leaf('filetools'), leaf('texttools'), leaf('database'), leaf('analytics')] },
      { key: 'g-system', label: '系统', accent: GROUP_ACCENT['系统'], children: [leaf('settings')] }
    ]
  }, [navigate])

  // 独立窗口发来的跳转请求：在主窗口打开对应页面并聚焦
  useEffect(() => {
    const off = window.api.windowApi.onMainNavigate(({ page, id }) => {
      navigate({ page: page as PageKey, id })
    })
    return off
  }, [navigate])

  // 应用个性化默认页（仅首次）
  const appliedDefault = useRef(false)
  useEffect(() => {
    if (!appliedDefault.current && prefs.defaultPage && prefs.defaultPage !== 'dashboard') {
      appliedDefault.current = true
      navigate({ page: prefs.defaultPage })
    }
  }, [prefs.defaultPage, navigate])

  // 应用内命令分发（命令面板 / 主页快捷入口共用）
  const runCommand = useCallback(
    (cmd: AppCommand): void => {
      switch (cmd) {
        case 'new-note':
          void (async () => {
            try {
              const list = await window.api.notes.create('新笔记')
              navigate({ page: 'notes', id: list[0]?.id })
            } catch {
              message.error('创建笔记失败')
            }
          })()
          break
        case 'new-automation':
          navigate({ page: 'dashboard', action: 'new-automation' })
          break
        case 'ai-chat':
          navigate({ page: 'dashboard', action: 'ai-chat' })
          break
        case 'filetools':
          navigate({ page: 'filetools' })
          break
        case 'knowledge':
          navigate({ page: 'knowledge' })
          break
        case 'toggle-theme':
          toggle()
          break
        case 'open-search':
          setSearchOpen(true)
          break
      }
    },
    [navigate, toggle]
  )

  // 全局快捷键：Ctrl+K 搜索 / Ctrl+N 新建笔记 / Ctrl+/ AI 问答 / Alt+1..9 跳转页面
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const k = e.key.toLowerCase()
      const el = e.target as HTMLElement | null
      const typing =
        !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement & { isContentEditable?: boolean }).isContentEditable === true)
      if ((e.ctrlKey || e.metaKey) && k === 'k') {
        e.preventDefault()
        setSearchOpen((s) => !s)
        return
      }
      if ((e.ctrlKey || e.metaKey) && k === 'n') {
        if (typing) return
        e.preventDefault()
        runCommand('new-note')
        return
      }
      if ((e.ctrlKey || e.metaKey) && k === '/') {
        if (typing) return
        e.preventDefault()
        runCommand('ai-chat')
        return
      }
      if (e.altKey && /^[1-9]$/.test(e.key)) {
        const pk = ALT_PAGES[Number(e.key) - 1]
        if (pk) {
          e.preventDefault()
          navigate({ page: pk })
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, runCommand])

  // 响应式：窗口宽度 < 900px 时自动收起侧边栏（用户仍可手动展开）
  useEffect(() => {
    const onResize = (): void => {
      if (window.innerWidth < 900) setCollapsed(true)
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const handlePick = (r: SearchResult): void => {
    switch (r.kind) {
      case 'shortcut':
        if (!r.target) return
        if (r.action === 'command') window.api.runCommand(r.target)
        else window.api.openExternal(r.target)
        break
      case 'note':
        navigate({ page: 'notes', id: r.id })
        break
      case 'automation':
        navigate({ page: 'dashboard', id: r.id })
        break
      case 'page':
        if (r.page) navigate({ page: r.page as PageKey })
        break
      case 'command':
        if (r.command) runCommand(r.command)
        break
    }
  }

  return (
    <div className="app-root">
      <TitleBar page={target.page} pageId={target.id} />
      <Layout style={{ flex: 1, minHeight: 0 }}>
        <Sider
          width={200}
          collapsedWidth={64}
          collapsed={collapsed}
          style={{
            background: token.colorBgContainer,
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            position: 'relative'
          }}
        >
          <div
            className="sider-brand"
            style={{
              height: 56,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 10px 0 16px',
              fontWeight: 600,
              fontSize: 15,
              color: token.colorText,
              letterSpacing: collapsed ? 0 : 1,
              flexShrink: 0
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {collapsed ? '灵' : '灵墨工作台'}
            </span>
            {!collapsed && (
              <Tooltip title={menuCollapsed ? '展开分组' : '收起分组'}>
                <Button
                  type="text"
                  size="small"
                  icon={menuCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                  onClick={() => setMenuCollapsed((v) => !v)}
                />
              </Tooltip>
            )}
          </div>
          <CollapsibleMenu
            groups={MENU_GROUPS}
            activeKey={target.page}
            collapsed={menuCollapsed}
            rail={collapsed}
          />
          <div
            className="sider-actions"
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              padding: 12,
              display: 'flex',
              gap: 8,
              justifyContent: 'center',
              borderTop: `1px solid ${token.colorSplit}`,
              flexDirection: collapsed ? 'column' : 'row'
            }}
          >
            <Tooltip title="全局搜索 (Ctrl+K)">
              <Button type="text" icon={<SearchOutlined />} onClick={() => setSearchOpen(true)} />
            </Tooltip>
            <Tooltip title={isDark ? '切换到浅色' : '切换到深色'}>
              <Button
                type="text"
                icon={isDark ? <SunOutlined /> : <MoonOutlined />}
                onClick={toggle}
              />
            </Tooltip>
            <Tooltip title={collapsed ? '展开侧边栏' : '收起侧边栏'}>
              <Button
                type="text"
                icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                onClick={() => setCollapsed((c) => !c)}
              />
            </Tooltip>
          </div>
        </Sider>
        <Layout style={{ background: 'var(--app-bg)' }}>
          <Content style={{ height: '100%', overflow: 'auto' }}>
            <div key={target.page} className="page-enter">
              <PageView page={target.page} id={target.id} action={target.action} />
            </div>
          </Content>
        </Layout>
      </Layout>
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} onPick={handlePick} />
      {/* 无边框窗口：八向边角拖拽缩放热区（最大化/全屏时组件内部自动不渲染） */}
      <WindowResizeHandles />
      {/* 关闭确认：最小化到后台 / 直接退出，可勾选不再提示 */}
      <ConfirmCloseDialog />
    </div>
  )
}

