import { useEffect, useState, type ReactNode } from 'react'

export interface CollapsibleMenuNode {
  /** 唯一键，用于选中态匹配 */
  key: string
  label: string
  icon?: ReactNode
  /** 点击叶子项的回调（导航等） */
  onClick?: () => void
  /** 可选的右侧徽标 */
  badge?: ReactNode
}

export interface CollapsibleMenuGroup {
  key: string
  label: string
  /** 分组主题色，用于色标条 */
  accent?: string
  children: CollapsibleMenuNode[]
}

export interface CollapsibleMenuProps {
  groups: CollapsibleMenuGroup[]
  /** 当前选中叶子键（高亮用） */
  activeKey?: string
  /** 受控：是否全部收起（仅显示顶层分组入口）。不传则内部自管。 */
  collapsed?: boolean
  defaultCollapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
  /** 窄栏模式：仅显示图标（用于侧边栏收起为 64px 时） */
  rail?: boolean
  className?: string
}

function Chevron() {
  return (
    <svg className="cm-chevron-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M4 6l4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * 可伸缩（折叠/展开）菜单组件。
 * - 顶层分组入口常驻；点击分组标题可独立展开/收起其子项。
 * - 通过主触发按钮（受控 collapsed）可一键「全部收起」仅留顶层入口。
 * - 收起时子项不占用额外空间（CSS grid-template-rows 0fr），并带平滑过渡。
 * - 窄屏 / 侧边栏收起时可用 rail 模式仅展示图标。
 */
export default function CollapsibleMenu({
  groups,
  activeKey,
  collapsed: collapsedProp,
  defaultCollapsed = false,
  onCollapsedChange,
  rail = false,
  className
}: CollapsibleMenuProps) {
  const isControlled = collapsedProp !== undefined
  const [internalCollapsed, setInternalCollapsed] = useState(defaultCollapsed)
  const collapsed = isControlled ? collapsedProp : internalCollapsed

  // 每个分组的展开态（仅当 master 未全部收起时生效）
  // 默认全收起；从 localStorage 恢复用户记忆
  const STORAGE_KEY = 'cm-expanded'
  const loadExpanded = (): Set<string> => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return new Set()
      const arr = JSON.parse(raw) as unknown
      if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === 'string'))
      return new Set()
    } catch {
      return new Set()
    }
  }
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(loadExpanded)

  // 持久化展开态（master 全收起为临时态，不写入记忆）
  useEffect(() => {
    if (collapsed) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...expandedKeys]))
    } catch {
      /* ignore */
    }
  }, [expandedKeys, collapsed])

  // 动态分组：仅清理已不存在的分组 key，不自动展开新分组（保持默认收起）
  useEffect(() => {
    setExpandedKeys((prev) => {
      const valid = new Set(groups.map((g) => g.key))
      let changed = false
      for (const k of prev) {
        if (!valid.has(k)) {
          prev.delete(k)
          changed = true
        }
      }
      return changed ? new Set(prev) : prev
    })
  }, [groups])

  const setCollapsed = (v: boolean) => {
    if (!isControlled) setInternalCollapsed(v)
    onCollapsedChange?.(v)
  }

  const toggleGroup = (key: string) => {
    if (collapsed) {
      // 顶层收起态下点击任意分组标题：展开该分组并退出全收起
      setCollapsed(false)
      setExpandedKeys((prev) => new Set(prev).add(key))
      return
    }
    setExpandedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const isOpen = (key: string) => !collapsed && expandedKeys.has(key)

  if (rail) {
    // 窄栏：扁平图标列表，分组以细色标分隔
    return (
      <nav className={`cm cm-rail${className ? ' ' + className : ''}`} aria-label="可折叠菜单">
        {groups.map((g) => (
          <div key={g.key} className="cm-rail-group">
            {g.children.map((c) => (
              <button
                key={c.key}
                type="button"
                className={`cm-rail-item${activeKey === c.key ? ' is-active' : ''}`}
                title={c.label}
                aria-label={c.label}
                aria-current={activeKey === c.key ? 'page' : undefined}
                onClick={c.onClick}
              >
                <span className="cm-rail-icon" style={{ color: activeKey === c.key ? g.accent : undefined }}>
                  {c.icon}
                </span>
              </button>
            ))}
          </div>
        ))}
      </nav>
    )
  }

  return (
    <nav
      className={`cm${collapsed ? ' cm-collapsed-all' : ''}${className ? ' ' + className : ''}`}
      aria-label="可折叠菜单"
    >
      <div className="cm-groups">
        {groups.map((g) => {
          const open = isOpen(g.key)
          return (
            <section key={g.key} className={`cm-group ${open ? 'is-open' : 'is-closed'}`}>
              <button
                type="button"
                className="cm-group-title"
                onClick={() => toggleGroup(g.key)}
                aria-expanded={open}
                aria-controls={`cm-children-${g.key}`}
              >
                <span className="cm-accent" style={{ background: g.accent ?? 'var(--accent, #28607D)' }} />
                <span className="cm-group-label">{g.label}</span>
                <span className="cm-chevron" aria-hidden="true">
                  <Chevron />
                </span>
              </button>
              <div className="cm-children" id={`cm-children-${g.key}`} aria-hidden={!open}>
                <div className="cm-children-inner">
                  {g.children.map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      className={`cm-item${activeKey === c.key ? ' is-active' : ''}`}
                      onClick={c.onClick}
                      aria-current={activeKey === c.key ? 'page' : undefined}
                    >
                      {c.icon && <span className="cm-item-icon">{c.icon}</span>}
                      <span className="cm-item-label">{c.label}</span>
                      {c.badge != null && <span className="cm-item-badge">{c.badge}</span>}
                    </button>
                  ))}
                </div>
              </div>
            </section>
          )
        })}
      </div>
    </nav>
  )
}
