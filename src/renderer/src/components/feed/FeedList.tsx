import { Empty, List } from 'antd'
import FeedItemCard from './FeedItemCard'
import type { FeedItem } from '@shared/types'

/**
 * 情报流列表：基于 antd List 渲染已筛选的 FeedItem[]，保留原热点列表的
 * 分页配置与前三名高亮逻辑。筛选（分类 / sourceKind）由 FeedCenter 负责。
 */
export interface FeedListProps {
  items: FeedItem[]
  /** 当前分类（仅用于排名 tooltip 文案） */
  category?: string
  onOpen: (item: FeedItem) => void
  onEdit: (item: FeedItem) => void
  onOpenSource: (url: string) => void
}

export default function FeedList({
  items,
  category = '全部',
  onOpen,
  onEdit,
  onOpenSource
}: FeedListProps) {
  if (items.length === 0) {
    return <Empty style={{ marginTop: 60 }} description="暂无情报，点击「刷新」获取" />
  }

  return (
    <List
      dataSource={items}
      pagination={{
        pageSize: 20,
        size: 'small',
        showSizeChanger: true,
        pageSizeOptions: [10, 20, 50],
        hideOnSinglePage: true
      }}
      renderItem={(item, idx) => (
        <List.Item
          style={{ cursor: 'pointer', padding: '10px 12px', borderRadius: 8, flexWrap: 'wrap' }}
        >
          <FeedItemCard
            item={item}
            index={idx}
            rankTitle={
              category === '全部'
                ? `热度排名第 ${idx + 1}`
                : `分类「${category}」内第 ${idx + 1} 名`
            }
            onOpen={onOpen}
            onEdit={onEdit}
            onOpenSource={onOpenSource}
          />
        </List.Item>
      )}
    />
  )
}
