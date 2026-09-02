import { Button, Tag, Typography } from 'antd'
import { EditOutlined, GlobalOutlined } from '@ant-design/icons'
import { formatHot, platformColor, sourceLabel } from './feedUtils'
import type { FeedItem } from '@shared/types'

/**
 * 单条情报卡片：排名 + sourceKind 徽标 + 标题 + 来源 Tag + 分类 Tag + 热度 + 动作。
 * 动作：「打开浏览器」（内置 SourceBrowser）/「编辑发布」（PublishDrawer）。
 */
export interface FeedItemCardProps {
  item: FeedItem
  /** 当前列表内的序号（0 基），用于排名高亮 */
  index: number
  /** 排名 tooltip 文案，如「热度排名第 3」 */
  rankTitle?: string
  /** 点击条目/「打开浏览器」→ 内置浏览器打开 */
  onOpen: (item: FeedItem) => void
  /** 点击「编辑发布」→ 打开发布抽屉 */
  onEdit: (item: FeedItem) => void
  /** 点击来源 Tag → 外部浏览器打开该来源链接 */
  onOpenSource: (url: string) => void
}

/** sourceKind → 徽标文案与颜色 */
const KIND_BADGE: Record<FeedItem['sourceKind'], { label: string; color: string }> = {
  hot: { label: '🔥 热点', color: 'volcano' },
  agent: { label: '🤖 智能体', color: 'geekblue' }
}

export default function FeedItemCard({
  item,
  index,
  rankTitle,
  onOpen,
  onEdit,
  onOpenSource
}: FeedItemCardProps) {
  const badge = KIND_BADGE[item.sourceKind]

  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%' }}
      onClick={() => onOpen(item)}
    >
      <span
        title={rankTitle ?? `第 ${index + 1} 名`}
        style={{
          width: 26,
          height: 26,
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 700,
          fontSize: 13,
          flexShrink: 0,
          background: index < 3 ? '#fa541c' : 'rgba(128,128,128,0.15)',
          color: index < 3 ? '#fff' : undefined
        }}
      >
        {index + 1}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Tag color={badge.color} style={{ fontSize: 11, margin: 0, flexShrink: 0 }}>
            {badge.label}
          </Tag>
          <Typography.Text style={{ fontSize: 14 }} ellipsis>
            {item.title}
          </Typography.Text>
        </div>
        <div
          style={{ marginTop: 4, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}
        >
          {item.hot > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              🔥 {formatHot(item.hot)}
            </Typography.Text>
          )}
          {item.meta && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {item.meta}
            </Typography.Text>
          )}
          {item.sources.map((s) => (
            <Tag
              key={`${s.platform}-${s.url}`}
              color={platformColor(s.platform)}
              style={{ fontSize: 11, margin: 0, cursor: 'pointer' }}
              onClick={(e) => {
                e.stopPropagation()
                onOpenSource(s.url)
              }}
            >
              {sourceLabel(s)}
            </Tag>
          ))}
        </div>
      </div>
      <Tag color="processing" style={{ flexShrink: 0 }}>
        {item.category}
      </Tag>
      <Button
        size="small"
        icon={<GlobalOutlined />}
        onClick={(e) => {
          e.stopPropagation()
          onOpen(item)
        }}
        title="在内置浏览器打开"
      >
        打开浏览器
      </Button>
      <Button
        size="small"
        icon={<EditOutlined />}
        onClick={(e) => {
          e.stopPropagation()
          onEdit(item)
        }}
        title="编辑并发布"
      >
        编辑发布
      </Button>
    </div>
  )
}
