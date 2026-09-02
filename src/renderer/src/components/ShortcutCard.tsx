import { Button, Tooltip, theme } from 'antd'
import { DeleteOutlined, EditOutlined } from '@ant-design/icons'
import type { Shortcut } from '@shared/types'
import { ICON_MAP, DEFAULT_ICON } from '../constants/shortcuts'

interface Props {
  shortcut: Shortcut
  onOpen: (s: Shortcut) => void
  onEdit: (s: Shortcut) => void
  onRemove: (id: string) => void
}

export default function ShortcutCard({ shortcut, onOpen, onEdit, onRemove }: Props) {
  const { token } = theme.useToken()
  const Icon = ICON_MAP[shortcut.icon] ?? ICON_MAP[DEFAULT_ICON]

  return (
    <div
      className="shortcut-card"
      style={{ background: token.colorBgContainer, borderColor: token.colorBorderSecondary }}
      onClick={() => onOpen(shortcut)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(shortcut)
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`打开 ${shortcut.name}`}
      title={shortcut.type === 'command' ? shortcut.target : shortcut.target}
    >
      <div
        className="shortcut-icon"
        style={{ background: `${shortcut.color}1f`, color: shortcut.color }}
      >
        <Icon />
      </div>
      <div className="shortcut-name" style={{ color: token.colorText }}>
        {shortcut.name}
      </div>
      <div className="shortcut-actions">
        <Tooltip title="编辑">
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            onClick={(e) => {
              e.stopPropagation()
              onEdit(shortcut)
            }}
          />
        </Tooltip>
        <Tooltip title="删除">
          <Button
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={(e) => {
              e.stopPropagation()
              onRemove(shortcut.id)
            }}
          />
        </Tooltip>
      </div>
    </div>
  )
}
