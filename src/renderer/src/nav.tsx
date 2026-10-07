import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

export type PageKey =
  | 'dashboard'
  | 'notes'
  | 'ai'
  | 'database'
  | 'boards'
  | 'texttools'
  | 'filetools'
  | 'toolbox'
  | 'knowledge'
  | 'agents'
  | 'stickies'
  | 'hotspots'
  | 'settings'
  | 'writing'
  | 'copywriting'
  | 'docs'
  | 'gameui'
  | 'novel'
  | 'analytics'

export interface NavTarget {
  page: PageKey
  /** 附加目标 id：笔记 id / 自动化 id / 表 id / 白板 id */
  id?: string
  /** 附加动作指令：如 'new-note' / 'new-automation'，由目标页面消费 */
  action?: string
}

interface NavContextValue {
  target: NavTarget
  navigate: (target: NavTarget) => void
}

const NavContext = createContext<NavContextValue>({
  target: { page: 'dashboard' },
  navigate: () => {}
})

interface NavProviderProps {
  children: ReactNode
  /**
   * 外部接管导航：独立窗口传入后，内部跳转不再切换当前窗口内容，
   * 而是交给主窗口打开对应页面并聚焦（避免子窗口内容漂移）。
   */
  onNavigate?: (t: NavTarget) => void
}

export function NavProvider({ children, onNavigate }: NavProviderProps) {
  const [target, setTarget] = useState<NavTarget>({ page: 'dashboard' })
  const navigate = useCallback(
    (t: NavTarget) => {
      if (onNavigate) {
        onNavigate(t)
        return
      }
      setTarget(t)
    },
    [onNavigate]
  )
  const value = useMemo(() => ({ target, navigate }), [target, navigate])
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>
}

export function useNav() {
  return useContext(NavContext)
}


