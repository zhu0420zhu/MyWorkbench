import { Fragment, useEffect, useRef, useState } from 'react'
import { Empty, Input, Modal, Tag, Typography, type InputRef } from 'antd'
import {
  FileTextOutlined,
  SearchOutlined,
  StarOutlined,
  ThunderboltOutlined,
  AppstoreOutlined,
  RobotOutlined
} from '@ant-design/icons'
import type { SearchResult } from '@shared/types'

interface Props {
  open: boolean
  onClose: () => void
  onPick: (result: SearchResult) => void
}

const KIND_LABEL: Record<SearchResult['kind'], string> = {
  shortcut: '快捷方式',
  note: '笔记',
  automation: '自动化',
  page: '页面',
  command: '操作'
}

const KIND_ICON: Record<SearchResult['kind'], React.ReactNode> = {
  shortcut: <StarOutlined />,
  note: <FileTextOutlined />,
  automation: <ThunderboltOutlined />,
  page: <AppstoreOutlined />,
  command: <RobotOutlined />
}

const GROUP_OF: Record<SearchResult['kind'], string> = {
  page: '页面',
  command: '操作',
  shortcut: '数据',
  note: '数据',
  automation: '数据'
}

export default function SearchModal({ open, onClose, onPick }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [active, setActive] = useState(0)
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<InputRef>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setResults([])
    setActive(0)
    setSearching(false)
    const t = setTimeout(() => inputRef.current?.focus(), 60)
    return () => clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (!q) {
      // 空查询也列出常用启动项（页面 + 操作）
      const t = setTimeout(async () => {
        setSearching(true)
        try {
          const res = await window.api.searchAll('')
          setResults(res)
          setActive(0)
        } catch {
          /* ignore */
        } finally {
          setSearching(false)
        }
      }, 80)
      return () => clearTimeout(t)
    }
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const res = await window.api.searchAll(q)
        setResults(res)
        setActive(0)
      } catch {
        /* ignore */
      } finally {
        setSearching(false)
      }
    }, 120)
    return () => clearTimeout(t)
  }, [query, open])

  const handleKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, Math.max(results.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      if (results[active]) pick(results[active])
    }
  }

  const pick = (r: SearchResult): void => {
    onPick(r)
    onClose()
  }

  let lastGroup = ''

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={560}
      styles={{ content: { padding: 0, overflow: 'hidden' } }}
    >
      <Input
        aria-label="搜索"
        ref={inputRef}
        prefix={<SearchOutlined style={{ color: 'inherit', opacity: 0.6 }} />}
        placeholder="搜索页面、操作、快捷方式、笔记、自动化…（↑↓ 选择 · Enter 打开 · Esc 关闭）"
        variant="borderless"
        size="large"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKey}
        role="combobox"
        aria-expanded={results.length > 0}
        aria-controls="search-listbox"
        aria-activedescendant={results[active] ? `search-opt-${active}` : undefined}
        style={{ padding: '14px 16px', fontSize: 15 }}
      />
      <div id="search-listbox" role="listbox" aria-label="搜索结果" style={{ maxHeight: 400, overflowY: 'auto' }}>
        {searching ? (
          <div style={{ padding: '24px 0', textAlign: 'center' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              搜索中…
            </Typography.Text>
          </div>
        ) : results.length === 0 ? (
          <Empty
            description={query.trim() === '' ? '暂无启动项' : '没有匹配结果'}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            style={{ padding: 32 }}
          />
        ) : (
          results.map((r, i) => {
            const g = GROUP_OF[r.kind]
            const showHeader = g !== lastGroup
            lastGroup = g
            return (
              <Fragment key={r.kind + r.id}>
                {showHeader && <div className="search-group-title" role="presentation">{g}</div>}
                <div
                  id={`search-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={'search-item' + (i === active ? ' active' : '')}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(r)}
                >
                  <span className="search-item-icon">{KIND_ICON[r.kind]}</span>
                  <div className="search-item-main">
                    <div className="search-item-title">{r.title}</div>
                    <div className="search-item-sub">{r.subtitle}</div>
                  </div>
                  {r.shortcut ? (
                    <Tag className="search-shortcut" style={{ flexShrink: 0, marginInlineEnd: 0 }}>
                      {r.shortcut}
                    </Tag>
                  ) : (
                    <Tag style={{ flexShrink: 0, marginInlineEnd: 0 }}>{KIND_LABEL[r.kind]}</Tag>
                  )}
                </div>
              </Fragment>
            )
          })
        )}
      </div>
    </Modal>
  )
}
