import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { theme as antdTheme } from 'antd'

interface ThemeContextValue {
  isDark: boolean
  toggle: () => void
}

const ThemeContext = createContext<ThemeContextValue>({ isDark: true, toggle: () => {} })

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem('wb-theme')
    return saved ? saved === 'dark' : true
  })

  useEffect(() => {
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light'
    localStorage.setItem('wb-theme', isDark ? 'dark' : 'light')
  }, [isDark])

  // 仅在切换主题的那一瞬给表层加过渡类，避免日常 hover 也跟着动画（见 main.css .theme-anim）
  const toggle = useCallback(() => {
    const el = document.documentElement
    el.classList.add('theme-anim')
    window.setTimeout(() => el.classList.remove('theme-anim'), 360)
    setIsDark((d) => !d)
  }, [])

  const value = useMemo(() => ({ isDark, toggle }), [isDark, toggle])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  return useContext(ThemeContext)
}

export function getAntdAlgorithm(isDark: boolean) {
  return isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm
}

/** 旧版默认主色（历史存档里未主动选择时的值），命中则回落到新主题默认色 */
const LEGACY_DEFAULT_PRIMARY = '#4f6ef7'
/** 轻量国风（浅色）默认主色：石青 */
export const LIGHT_PRIMARY = '#28607D'
/** 暗黑控制台（深色）默认主色：冷青蓝 */
export const DARK_PRIMARY = '#46D4E6'

/**
 * 解析实际生效主色：用户显式选择的颜色优先；
 * 旧默认色（#4f6ef7）视为"从未选择"，按主题回落到设计稿默认色。
 */
export function resolveAccent(colorPrimary: string | undefined, isDark: boolean): string {
  const c = (colorPrimary ?? '').trim().toLowerCase()
  if (c && c !== LEGACY_DEFAULT_PRIMARY) return colorPrimary as string
  return isDark ? DARK_PRIMARY : LIGHT_PRIMARY
}
