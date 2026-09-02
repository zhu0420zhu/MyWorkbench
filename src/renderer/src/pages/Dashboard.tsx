import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Empty, message, Modal, Skeleton, Typography } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import type { Shortcut, ShortcutInput } from '@shared/types'
import ShortcutCard from '../components/ShortcutCard'
import ShortcutModal from '../components/ShortcutModal'

export default function Dashboard() {
  const [items, setItems] = useState<Shortcut[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Shortcut | null>(null)
  const [showTip, setShowTip] = useState(() => localStorage.getItem('wb-dash-tip') !== '1')

  const load = useCallback(async () => {
    try {
      const list = await window.api.shortcuts.list()
      setItems(list)
    } catch {
      message.error('加载快捷方式失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleSubmit = async (values: ShortcutInput) => {
    try {
      if (editing) {
        await window.api.shortcuts.update({ ...editing, ...values })
        message.success('已保存')
      } else {
        await window.api.shortcuts.add(values)
        message.success('已添加')
      }
      setModalOpen(false)
      setEditing(null)
      load()
    } catch {
      message.error('保存失败')
    }
  }

  const handleOpen = async (s: Shortcut): Promise<void> => {
    try {
      if (s.type === 'command') {
        window.api.runCommand(s.target)
        message.success('已执行命令')
      } else {
        const ok = await window.api.openExternal(s.target)
        if (ok) message.success('已打开')
        else message.error('打开失败')
      }
    } catch {
      message.error('打开失败')
    }
  }

  const handleRemove = async (id: string): Promise<void> => {
    Modal.confirm({
      title: '删除快捷卡片',
      content: '确定删除这张卡片吗？',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await window.api.shortcuts.remove(id)
          message.success('已删除')
          load()
        } catch {
          message.error('删除失败')
        }
      }
    })
  }

  return (
    <div className="dashboard-page">
      <div className="page-header">
        <Typography.Title level={4} style={{ margin: 0 }}>
          工作台
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
          添加卡片
        </Button>
      </div>

      {showTip && (
        <Alert
          type="info"
          showIcon
          closable
          style={{ marginBottom: 16 }}
          message="快速上手"
          description="Ctrl+K 全局搜索 · Ctrl+N 新建笔记 · Ctrl+/ 唤起 AI · Alt+1..9 快速跳转页面。点击卡片即可打开链接或执行命令。"
          onClose={() => {
            localStorage.setItem('wb-dash-tip', '1')
            setShowTip(false)
          }}
        />
      )}

      {loading ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : items.length === 0 ? (
        <Empty style={{ marginTop: 80 }} description="还没有快捷方式">
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
            添加第一张卡片
          </Button>
        </Empty>
      ) : (
        <div className="shortcut-grid">
          {items.map((s) => (
            <ShortcutCard
              key={s.id}
              shortcut={s}
              onOpen={handleOpen}
              onEdit={(s) => {
                setEditing(s)
                setModalOpen(true)
              }}
              onRemove={handleRemove}
            />
          ))}
        </div>
      )}

      <ShortcutModal
        open={modalOpen}
        editing={editing}
        onCancel={() => {
          setModalOpen(false)
          setEditing(null)
        }}
        onSubmit={handleSubmit}
      />
    </div>
  )
}
