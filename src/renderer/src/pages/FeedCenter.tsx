import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button,
  Input,
  Segmented,
  Skeleton,
  Switch,
  Tag,
  Typography,
  message
} from 'antd'
import { ApartmentOutlined, FireOutlined, ReloadOutlined } from '@ant-design/icons'
import { HOT_CATEGORIES } from '../utils/category'
import FeedList from '../components/feed/FeedList'
import SourceBrowser from '../components/feed/SourceBrowser'
import PublishDrawer from '../components/feed/PublishDrawer'
import SourceManager from '../components/feed/SourceManager'
import { formatTime, isValidHttpUrl, platformLabel } from '../components/feed/feedUtils'
import type {
  FeedItem,
  FeedNotifySettings,
  FeedSourceMeta,
  FeedSourceStatus
} from '@shared/types'

/**
 * 情报中心（取代原「多媒体」页）。
 * 把「全网热点」与「智能体」收敛为一条统一情报流：
 *   - 数据来自 window.api.feed.result()（16 热点平台 + 2 智能体任务合并去重）
 *   - 顶部按分类 / 来源类别筛选，数据源状态条展示各源 ok/error
 *   - 推送通知走 feed.notifyGet/Set/Check/Status
 *   - 「数据源」抽屉（SourceManager）统一管理启用/周期/立即运行/历史
 *   - 条目 → 内置浏览器（SourceBrowser）；编辑发布 → PublishDrawer（复用 publish.*）
 */
type KindFilter = 'all' | 'hot' | 'agent'

const KIND_OPTIONS: Array<{ label: string; value: KindFilter }> = [
  { label: '全部', value: 'all' },
  { label: '热点', value: 'hot' },
  { label: '智能体', value: 'agent' }
]

const DEFAULT_NOTIFY: FeedNotifySettings = {
  enabled: false,
  intervalMinutes: 15,
  topCount: 10,
  notifyAgents: true
}

export default function FeedCenter() {
  const [items, setItems] = useState<FeedItem[]>([])
  const [sourceStatuses, setSourceStatuses] = useState<FeedSourceStatus[]>([])
  const [sourceMetas, setSourceMetas] = useState<FeedSourceMeta[]>([])
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  // 筛选
  const [category, setCategory] = useState<string>('全部')
  const [kind, setKind] = useState<KindFilter>('all')
  // 子面板
  const [browserUrl, setBrowserUrl] = useState<string | null>(null)
  const [publishItem, setPublishItem] = useState<FeedItem | null>(null)
  const [publishOpen, setPublishOpen] = useState(false)
  const [managerOpen, setManagerOpen] = useState(false)
  // 推送通知
  const [notify, setNotify] = useState<FeedNotifySettings>(DEFAULT_NOTIFY)
  const [notifyStatus, setNotifyStatus] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const r = await window.api.feed.result()
      setItems(r.items)
      setSourceStatuses(r.sources)
      setUpdatedAt(r.updatedAt || Date.now())
    } catch (err) {
      message.error(`获取情报流失败：${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  // 数据源元信息只为了把 FeedSourceStatus.id 映射成中文展示名
  const loadSourceMetas = useCallback(async (): Promise<void> => {
    try {
      setSourceMetas(await window.api.feed.listSources())
    } catch {
      /* 名称映射失败时回退到 id */
    }
  }, [])

  const loadNotify = useCallback(async (): Promise<void> => {
    try {
      setNotify(await window.api.feed.notifyGet())
      const st = await window.api.feed.notifyStatus()
      setNotifyStatus(
        st.running
          ? `推送中（每 ${st.intervalMinutes} 分钟）· 已通知 ${st.lastNotified} 次`
          : '推送未开启'
      )
    } catch {
      /* 忽略 */
    }
  }, [])

  useEffect(() => {
    void load()
    void loadSourceMetas()
    void loadNotify()
  }, [load, loadSourceMetas, loadNotify])

  const patchNotify = async (patch: Partial<FeedNotifySettings>): Promise<void> => {
    try {
      const s = await window.api.feed.notifySet({ ...notify, ...patch })
      setNotify(s)
      const st = await window.api.feed.notifyStatus()
      setNotifyStatus(st.running ? `推送中（每 ${st.intervalMinutes} 分钟）` : '推送未开启')
    } catch (err) {
      message.error(`保存推送设置失败：${(err as Error).message}`)
    }
  }

  const checkNow = async (): Promise<void> => {
    try {
      const r = await window.api.feed.notifyCheck()
      setNotifyStatus(`已检查：共 ${r.total} 条情报，新通知 ${r.notified} 条`)
      if (r.notified > 0) message.success(`发现 ${r.notified} 条新情报已通知`)
    } catch (err) {
      message.error(`检查失败：${(err as Error).message}`)
    }
  }

  const openItem = (item: FeedItem): void => {
    const first = item.sources.find((s) => s.url) ?? item.sources[0]
    const url = item.url ?? first?.url ?? ''
    if (!isValidHttpUrl(url)) {
      message.error('该条目暂无可用的打开链接')
      return
    }
    setBrowserUrl(url)
  }

  const openSourceExternal = (url: string): void => {
    if (isValidHttpUrl(url)) void window.api.openExternal(url)
    else message.error('链接无效，无法在外部浏览器打开')
  }

  const openEdit = (item: FeedItem): void => {
    setPublishItem(item)
    setPublishOpen(true)
  }

  // 先按来源类别筛，再按分类筛（分类计数基于「来源类别筛选后」的集合）
  const kindFiltered = useMemo(
    () => (kind === 'all' ? items : items.filter((i) => i.sourceKind === kind)),
    [items, kind]
  )
  const filtered = useMemo(
    () => (category === '全部' ? kindFiltered : kindFiltered.filter((i) => i.category === category)),
    [category, kindFiltered]
  )
  const catCountsMap = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of kindFiltered) m.set(i.category, (m.get(i.category) ?? 0) + 1)
    return m
  }, [kindFiltered])
  const catCounts = useCallback(
    (cat: string): number => (cat === '全部' ? kindFiltered.length : (catCountsMap.get(cat) ?? 0)),
    [kindFiltered, catCountsMap]
  )

  const metaName = useCallback(
    (id: string): string => platformLabel(id, sourceMetas.find((m) => m.id === id)?.name),
    [sourceMetas]
  )
  const okCount = sourceStatuses.filter((s) => s.status === 'ok').length
  const hotTotal = useMemo(() => items.filter((i) => i.sourceKind === 'hot').length, [items])
  const agentTotal = useMemo(() => items.filter((i) => i.sourceKind === 'agent').length, [items])

  return (
    <div className="dashboard-page">
      <div className="page-header">
        <Typography.Title level={4} style={{ margin: 0 }}>
          <FireOutlined style={{ color: '#fa541c', marginRight: 8 }} />
          多媒体 · 情报流
        </Typography.Title>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {updatedAt && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              更新于 {formatTime(updatedAt)} · 热点 {hotTotal} / 智能体 {agentTotal}
            </Typography.Text>
          )}
          <Button icon={<ApartmentOutlined />} onClick={() => setManagerOpen(true)}>
            数据源
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        </div>
      </div>

      <div
        style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          情报推送：
        </Typography.Text>
        <Switch
          size="small"
          checked={notify.enabled}
          onChange={(v) => void patchNotify({ enabled: v })}
          checkedChildren="开"
          unCheckedChildren="关"
        />
        <Input
          aria-label="通知间隔（分钟）"
          size="small"
          type="number"
          placeholder="间隔分钟"
          value={String(notify.intervalMinutes)}
          onChange={(e) =>
            setNotify((s) => ({ ...s, intervalMinutes: Number(e.target.value) || 15 }))
          }
          style={{ width: 80 }}
          disabled={notify.enabled}
        />
        <Input
          aria-label="TopN 数量"
          size="small"
          type="number"
          placeholder="TopN"
          value={String(notify.topCount)}
          onChange={(e) => setNotify((s) => ({ ...s, topCount: Number(e.target.value) || 10 }))}
          style={{ width: 70 }}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          含智能体：
        </Typography.Text>
        <Switch
          size="small"
          checked={notify.notifyAgents}
          onChange={(v) => void patchNotify({ notifyAgents: v })}
          checkedChildren="开"
          unCheckedChildren="关"
        />
        <Button size="small" onClick={() => void checkNow()}>
          立即检查
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {notifyStatus}
        </Typography.Text>
      </div>

      {sourceStatuses.length > 0 && (
        <div
          style={{
            marginBottom: 12,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            alignItems: 'center'
          }}
        >
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            数据源（{okCount}/{sourceStatuses.length}）：
          </Typography.Text>
          {sourceStatuses.map((s) => (
            <Tag
              key={s.id}
              color={s.status === 'ok' ? 'success' : 'error'}
              style={{ fontSize: 11, margin: 0 }}
              title={s.error}
            >
              {metaName(s.id)} {s.status === 'ok' ? `· ${s.count}` : '· 失效'}
            </Tag>
          ))}
        </div>
      )}

      <div style={{ marginBottom: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Segmented
          value={kind}
          onChange={(v) => setKind(v as KindFilter)}
          options={KIND_OPTIONS.map((o) => ({
            label:
              o.value === 'all'
                ? `${o.label} ${items.length}`
                : `${o.label} ${o.value === 'hot' ? hotTotal : agentTotal}`,
            value: o.value
          }))}
        />
        <Segmented
          value={category}
          onChange={(v) => setCategory(v as string)}
          options={HOT_CATEGORIES.map((c) => ({ label: `${c} ${catCounts(c)}`, value: c }))}
        />
      </div>

      {loading ? (
        <Skeleton active paragraph={{ rows: 10 }} />
      ) : (
        <FeedList
          items={filtered}
          category={category}
          onOpen={openItem}
          onEdit={openEdit}
          onOpenSource={openSourceExternal}
        />
      )}

      <PublishDrawer open={publishOpen} item={publishItem} onClose={() => setPublishOpen(false)} />

      <SourceManager
        open={managerOpen}
        onClose={() => setManagerOpen(false)}
        onChanged={() => void loadSourceMetas()}
      />

      <SourceBrowser url={browserUrl} onClose={() => setBrowserUrl(null)} />
    </div>
  )
}
