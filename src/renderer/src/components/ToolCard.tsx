import type { ReactNode } from 'react'

export interface ToolCardMeta {
  key: string
  title: string
  desc: string
  icon: ReactNode
  category: string
}

export function ToolCard({
  active,
  title,
  desc,
  icon,
  category,
  onClick
}: {
  active: boolean
  title: string
  desc: string
  icon: ReactNode
  category: string
  onClick: () => void
}) {
  return (
    <button type="button" className={`mt-card${active ? ' is-active' : ''}`} onClick={onClick}>
      <div className="mt-card-top">
        <span className="mt-card-icon">{icon}</span>
        <span className="mt-card-tag">{category}</span>
      </div>
      <div className="mt-card-title">{title}</div>
      <div className="mt-card-desc">{desc}</div>
    </button>
  )
}

export function ToolCardGrid({
  items,
  activeKey,
  onSelect
}: {
  items: ToolCardMeta[]
  activeKey: string
  onSelect: (key: string) => void
}) {
  return (
    <div className="mt-grid">
      {items.map((t) => (
        <ToolCard
          key={t.key}
          active={activeKey === t.key}
          title={t.title}
          desc={t.desc}
          icon={t.icon}
          category={t.category}
          onClick={() => onSelect(t.key)}
        />
      ))}
    </div>
  )
}
