import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Checkbox,
  Empty,
  Input,
  List,
  Modal,
  Segmented,
  Skeleton,
  Spin,
  Switch,
  Tag,
  Typography,
  message
} from 'antd'
import { EditOutlined, FireOutlined, ReloadOutlined, CloseOutlined, ExportOutlined, ArrowRightOutlined, ArrowLeftOutlined, ThunderboltOutlined, ApartmentOutlined } from '@ant-design/icons'
import { categorize, HOT_CATEGORIES } from '../utils/category'
import AgentsPanel from '../components/AgentsPanel'
import type { HotEvent, HotNotifySettings, HotPlatformStatus, PublishJobInfo, PublishPlatformInfo, PublishStats } from '@shared/types'

interface CategorizedEvent extends HotEvent {
  category: string
}

const PLATFORM_NAMES: Record<string, string> = {
  weibo: '微博',
  zhihu: '知乎',
  bilibili: 'B站',
  douyin: '抖音',
  toutiao: '头条',
  baidu: '百度',
  tieba: '贴吧',
  douban: '豆瓣',
  juejin: '掘金',
  gongzhonghao: '公众号',
  csdn: 'CSDN',
  ithome: 'IT之家',
  sspai: '少数派',
  '36kr': '36氪',
  huxiu: '虎嗅',
  ifanr: '爱范儿',
  geekpark: '极客公园',
  github: 'GitHub'
}

const PLATFORM_COLORS: Record<string, string> = {
  weibo: 'red',
  zhihu: 'blue',
  bilibili: 'pink',
  douyin: 'magenta',
  toutiao: 'volcano',
  baidu: 'orange',
  tieba: 'cyan',
  douban: 'green',
  juejin: 'geekblue',
  gongzhonghao: 'green',
  csdn: 'purple',
  ithome: 'blue',
  sspai: 'cyan',
  '36kr': 'volcano',
  huxiu: 'orange',
  ifanr: 'magenta',
  geekpark: 'geekblue',
  github: 'purple'
}

export default function Hotspots({ initialTab }: { initialTab?: 'hotspots' | 'agents' } = {}) {
  const [tab, setTab] = useState<'hotspots' | 'agents'>(initialTab ?? 'hotspots')
  const [events, setEvents] = useState<CategorizedEvent[]>([])
  const [platforms, setPlatforms] = useState<HotPlatformStatus[]>([])
  const [loading, setLoading] = useState(false)
  const [category, setCategory] = useState('全部')
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  // 内置浏览器
  const [browserUrl, setBrowserUrl] = useState<string | null>(null)
  const webviewRef = useRef<any>(null)
  const [browserState, setBrowserState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [browserError, setBrowserError] = useState<string>('')

  // 内容编辑（P1 接入多平台分发）
  const [editOpen, setEditOpen] = useState(false)
  const [editEvent, setEditEvent] = useState<CategorizedEvent | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [editTargets, setEditTargets] = useState<string[]>([])
  // 发布面板状态
  const [publishPlatforms, setPublishPlatforms] = useState<PublishPlatformInfo[]>([])
  const [loginMap, setLoginMap] = useState<Record<string, boolean>>({})
  const [jobs, setJobs] = useState<PublishJobInfo[]>([])
  const [publishing, setPublishing] = useState(false)
  const [scheduleTime, setScheduleTime] = useState('')
  const [stats, setStats] = useState<PublishStats | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  // 公众号凭证
  const [gzhOpen, setGzhOpen] = useState(false)
  const [gzhAppId, setGzhAppId] = useState('')
  const [gzhSecret, setGzhSecret] = useState('')
  const [gzhInfo, setGzhInfo] = useState<{ appId: string; hasSecret: boolean }>({ appId: '', hasSecret: false })
  // 热点推送通知
  const [notify, setNotify] = useState<HotNotifySettings>({ enabled: false, intervalMinutes: 15, topCount: 10 })
  const [notifyStatus, setNotifyStatus] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const r = await window.api.hot.fetch()
      setEvents(r.events.map((e) => ({ ...e, category: categorize(e.title) })))
      setPlatforms(r.platforms)
      setUpdatedAt(Date.now())
    } catch (err) {
      message.error(`获取热点失败：${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadNotify = useCallback(async (): Promise<void> => {
    try {
      setNotify(await window.api.hot.notifierGet())
      const st = await window.api.hot.notifierStatus()
      setNotifyStatus(st.running ? `推送中（每 ${st.intervalMinutes} 分钟）· 已通知 ${st.lastNotified} 次` : '推送未开启')
    } catch {
      /* 忽略 */
    }
  }, [])

  useEffect(() => {
    load()
    void loadNotify()
  }, [load, loadNotify])

  // 监听内置浏览器加载状态（含失败兜底）
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv || !browserUrl) return
    const onStart = (): void => setBrowserState('loading')
    const onStop = (): void => setBrowserState('ok')
    const onFail = (_e: unknown, _code: number, desc: string, _url: string, isMainFrame?: boolean): void => {
      if (isMainFrame === false) return // 忽略子资源失败，避免误报
      setBrowserError(desc || '加载失败')
      setBrowserState('error')
    }
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-fail-load', onFail)
    return () => {
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-fail-load', onFail)
    }
  }, [browserUrl])

  const toggleNotify = async (enabled: boolean): Promise<void> => {
    const s = await window.api.hot.notifierSet({ ...notify, enabled })
    setNotify(s)
    const st = await window.api.hot.notifierStatus()
    setNotifyStatus(st.running ? `推送中（每 ${st.intervalMinutes} 分钟）` : '推送未开启')
  }

  const checkNow = async (): Promise<void> => {
    const r = await window.api.hot.notifierCheck()
    setNotifyStatus(`已检查：共 ${r.total} 条热点，新通知 ${r.notified} 条`)
    if (r.notified > 0) message.success(`发现 ${r.notified} 条新热点已通知`)
  }

  const openGzh = async (): Promise<void> => {
    setGzhInfo(await window.api.publish.gzhGet())
    setGzhAppId('')
    setGzhSecret('')
    setGzhOpen(true)
  }

  const saveGzh = async (): Promise<void> => {
    if (!gzhAppId.trim() || !gzhSecret.trim()) {
      message.warning('请填写 AppID 和 Secret')
      return
    }
    await window.api.publish.gzhSave({ appId: gzhAppId.trim(), secret: gzhSecret.trim() })
    setGzhOpen(false)
    message.success('公众号凭证已保存（safeStorage 加密）')
    void refreshPublishState()
  }


  const openSource = (url: string): void => {
    if (isValidHttpUrl(url)) void window.api.openExternal(url)
    else message.error('链接无效，无法在外部浏览器打开')
  }

  const openEvent = (e: CategorizedEvent): void => {
    const first = e.sources.find((s) => s.url) ?? e.sources[0]
    const url = first?.url ?? ''
    if (!isValidHttpUrl(url)) {
      message.error('该热点暂无可用的打开链接')
      return
    }
    setBrowserError('')
    setBrowserState('loading')
    setBrowserUrl(url)
  }

  const browserNav = (action: 'back' | 'forward' | 'reload'): void => {
    const wv = webviewRef.current
    if (!wv) return
    if (action === 'back') wv.goBack()
    else if (action === 'forward') wv.goForward()
    else wv.reload()
  }

  const refreshPublishState = useCallback(async (): Promise<void> => {
    try {
      const [platforms, login, jobList, st] = await Promise.all([
        window.api.publish.listPlatforms(),
        window.api.publish.checkAllLogin(),
        window.api.publish.listJobs(),
        window.api.publish.stats()
      ])
      setPublishPlatforms(platforms)
      setLoginMap(login)
      setJobs(jobList)
      setStats(st)
    } catch {
      /* 发布模块不可用时静默 */
    }
  }, [])

  const openEdit = (e: CategorizedEvent): void => {
    setEditEvent(e)
    setEditTitle(e.title)
    setEditContent(`【热点】${e.title}\n\n热度：${formatHot(e.hot)}\n来源：${e.sources.map((s) => PLATFORM_NAMES[s.platform] ?? s.platform).join(' / ')}`)
    setEditTargets([])
    setEditOpen(true)
    void refreshPublishState()
  }

  const doPublish = async (): Promise<void> => {
    if (editTargets.length === 0) {
      message.warning('请选择至少一个发布目标平台')
      return
    }
    let scheduledAt: number | undefined
    if (scheduleTime) {
      const t = new Date(scheduleTime).getTime()
      if (!Number.isNaN(t) && t > Date.now()) scheduledAt = t
      else {
        message.warning('预约时间需晚于当前时间，或留空立即发布')
        return
      }
    }
    setPublishing(true)
    try {
      const jobList = await window.api.publish.create({
        title: editTitle,
        content: editContent,
        targets: editTargets,
        contentId: editEvent?.id,
        scheduledAt
      })
      setJobs(jobList)
      setStats(await window.api.publish.stats())
      setScheduleTime('')
      message.success(scheduledAt ? `已排程：${new Date(scheduledAt).toLocaleString()} 发布` : '已提交发布任务，详见下方队列')
    } catch (err) {
      message.error(`发布失败：${(err as Error).message}`)
    } finally {
      setPublishing(false)
    }
  }

  const aiSummarize = async (): Promise<void> => {
    setAiBusy(true)
    try {
      const r = await window.api.publish.aiSummarize({ title: editTitle, content: editContent })
      if (r.ok && r.text) setEditContent(r.text)
      else message.warning(r.error ?? 'AI 摘要生成失败')
    } finally {
      setAiBusy(false)
    }
  }

  const aiRewrite = async (platformId: string, platformName: string): Promise<void> => {
    setAiBusy(true)
    try {
      const r = await window.api.publish.aiRewrite({ title: editTitle, content: editContent, platformId })
      if (r.ok && r.text) {
        setEditContent(r.text)
        message.success(`已按「${platformName}」风格改写`)
      } else message.warning(r.error ?? 'AI 改写失败')
    } finally {
      setAiBusy(false)
    }
  }

  const doLogin = async (platformId: string): Promise<void> => {
    await window.api.publish.login(platformId)
    message.info('请在打开的窗口完成登录，登录后返回点击「刷新登录状态」')
  }

  const retryJob = async (id: string): Promise<void> => {
    setJobs(await window.api.publish.retry(id))
  }


  const filtered = useMemo(
    () => (category === '全部' ? events : events.filter((i) => i.category === category)),
    [category, events]
  )
  const catCountsMap = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of events) m.set(e.category, (m.get(e.category) ?? 0) + 1)
    return m
  }, [events])
  const catCounts = useCallback(
    (cat: string): number => (cat === '全部' ? events.length : (catCountsMap.get(cat) ?? 0)),
    [events, catCountsMap]
  )
  const okCount = platforms.filter((p) => p.status === 'ok').length

  return (
    <div className="dashboard-page">
      <div className="page-header">
        <Typography.Title level={4} style={{ margin: 0 }}>
          {tab === 'agents' ? (
            <>
              <ApartmentOutlined style={{ marginRight: 8 }} />
              多媒体 · 智能体
            </>
          ) : (
            <>
              <FireOutlined style={{ color: '#fa541c', marginRight: 8 }} />
              多媒体 · 全网热点
            </>
          )}
        </Typography.Title>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Segmented
            value={tab}
            onChange={(v) => setTab(v as 'hotspots' | 'agents')}
            options={[
              { label: '全网热点', value: 'hotspots' },
              { label: '智能体', value: 'agents' }
            ]}
          />
          {tab === 'hotspots' && (
            <>
              {updatedAt && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  更新于 {formatTime(updatedAt)}
                </Typography.Text>
              )}
              <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
                刷新
              </Button>
            </>
          )}
        </div>
      </div>

      {tab === 'agents' ? (
        <AgentsPanel />
      ) : (
        <>

      <div style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          热点推送：
        </Typography.Text>
        <Switch size="small" checked={notify.enabled} onChange={(v) => void toggleNotify(v)} checkedChildren="开" unCheckedChildren="关" />
        <Input
          aria-label="通知间隔（分钟）"
          size="small"
          type="number"
          placeholder="间隔分钟"
          value={String(notify.intervalMinutes)}
          onChange={(e) => setNotify((s) => ({ ...s, intervalMinutes: Number(e.target.value) || 15 }))}
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
        <Button size="small" onClick={() => void checkNow()}>
          立即检查
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {notifyStatus}
        </Typography.Text>
      </div>

      {platforms.length > 0 && (
        <div style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            数据源（{okCount}/{platforms.length}）：
          </Typography.Text>
          {platforms.map((p) => (
            <Tag
              key={p.id}
              color={p.status === 'ok' ? 'success' : 'error'}
              style={{ fontSize: 11, margin: 0 }}
              title={p.error}
            >
              {p.name} {p.status === 'ok' ? `· ${p.count}` : '· 失效'}
            </Tag>
          ))}
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        <Segmented
          value={category}
          onChange={(v) => setCategory(v as string)}
          options={HOT_CATEGORIES.map((c) => ({ label: `${c} ${catCounts(c)}`, value: c }))}
        />
      </div>

      {loading ? (
        <Skeleton active paragraph={{ rows: 10 }} />
      ) : filtered.length === 0 ? (
        <Empty style={{ marginTop: 60 }} description="暂无热点，点击「刷新」获取" />
      ) : (
        <List
          dataSource={filtered}
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
              onClick={() => openEvent(item)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%' }}>
                <span
                  title={category === '全部' ? `热度排名第 ${idx + 1}` : `分类「${category}」内第 ${idx + 1} 名`}
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
                    background: idx < 3 ? '#fa541c' : 'rgba(128,128,128,0.15)',
                    color: idx < 3 ? '#fff' : undefined
                  }}
                >
                  {idx + 1}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Typography.Text style={{ fontSize: 14 }} ellipsis>
                    {item.title}
                  </Typography.Text>
                  <div style={{ marginTop: 4, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    {item.hot > 0 && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        🔥 {formatHot(item.hot)}
                      </Typography.Text>
                    )}
                    {item.sources.map((s) => (
                      <Tag
                        key={s.platform}
                        color={PLATFORM_COLORS[s.platform] ?? 'default'}
                        style={{ fontSize: 11, margin: 0, cursor: 'pointer' }}
                        onClick={(e) => {
                          e.stopPropagation()
                          openSource(s.url)
                        }}
                      >
                        {PLATFORM_NAMES[s.platform] ?? s.platform}
                      </Tag>
                    ))}
                  </div>
                </div>
                <Tag color="processing" style={{ flexShrink: 0 }}>
                  {item.category}
                </Tag>
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  onClick={(e) => {
                    e.stopPropagation()
                    openEdit(item)
                  }}
                  title="编辑并发布"
                >
                  编辑发布
                </Button>
              </div>
            </List.Item>
          )}
        />
      )}

      <Modal
        title="内容编辑 · 多平台一键分发"
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        footer={null}
        width={600}
      >
        {editEvent && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                标题
              </Typography.Text>
              <Input aria-label="热点标题" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
            </div>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  正文
                </Typography.Text>
                <Button
                  size="small"
                  type="link"
                  icon={<ThunderboltOutlined />}
                  loading={aiBusy}
                  onClick={() => void aiSummarize()}
                >
                  AI 摘要
                </Button>
              </div>
              <Input.TextArea aria-label="热点正文" value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={5} />
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  发布目标平台（点击平台名勾选）
                  {Object.values(loginMap).filter(Boolean).length > 0 && (
                    <Tag color="success" style={{ marginLeft: 8, fontSize: 11 }}>
                      已登录 {Object.values(loginMap).filter(Boolean).length} 个平台
                    </Tag>
                  )}
                </Typography.Text>
                <Button size="small" type="link" onClick={() => void refreshPublishState()}>
                  刷新登录状态
                </Button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                {publishPlatforms.map((p) => {
                  const logged = loginMap[p.id] === true
                  const selectable = p.status === 'ready'
                  return (
                    <div
                      key={p.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '4px 8px',
                        border: '1px solid rgba(128,128,128,.2)',
                        borderRadius: 6,
                        opacity: selectable ? 1 : 0.6
                      }}
                    >
                      <Checkbox
                        checked={editTargets.includes(p.id)}
                        disabled={!selectable}
                        onChange={(e) =>
                          setEditTargets((list) =>
                            e.target.checked ? [...list, p.id] : list.filter((x) => x !== p.id)
                          )
                        }
                      />
                      <Typography.Text style={{ fontSize: 13 }}>{p.name}</Typography.Text>
                      <Tag
                        color={p.status === 'ready' ? 'green' : 'orange'}
                        style={{ fontSize: 11, margin: 0 }}
                      >
                        {p.status === 'ready' ? '可发布' : '待适配'}
                      </Tag>
                      {logged ? (
                        <Tag color="success" style={{ fontSize: 11, margin: 0 }}>
                          已登录
                        </Tag>
                      ) : (
                        <Button
                          size="small"
                          type="link"
                          style={{ fontSize: 11, padding: 0 }}
                          onClick={() => void doLogin(p.id)}
                        >
                          去登录
                        </Button>
                      )}
                      <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 'auto' }}>
                        {p.modeLabel}
                      </Typography.Text>
                      {p.status === 'ready' && (
                        <Button
                          size="small"
                          type="link"
                          icon={<ThunderboltOutlined />}
                          style={{ fontSize: 11, padding: 0 }}
                          loading={aiBusy}
                          onClick={() => void aiRewrite(p.id, p.name)}
                        >
                          AI 改写
                        </Button>
                      )}
                      {p.id === 'gongzhonghao' && (
                        <Button size="small" type="link" style={{ fontSize: 11, padding: 0 }} onClick={() => void openGzh()}>
                          配置
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                预约发布
              </Typography.Text>
              <Input
                aria-label="预约发布时间"
                size="small"
                type="datetime-local"
                value={scheduleTime}
                onChange={(e) => setScheduleTime(e.target.value)}
                style={{ width: 200 }}
              />
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                留空 = 立即发布
              </Typography.Text>
            </div>

            <Button type="primary" loading={publishing} onClick={() => void doPublish()} style={{ marginTop: 4 }}>
              提交发布
            </Button>

            {stats && (
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
                <Typography.Text strong style={{ fontSize: 12 }}>
                  发布统计
                </Typography.Text>
                <Tag color="success" style={{ margin: 0 }}>成功 {stats.success}</Tag>
                <Tag color="error" style={{ margin: 0 }}>失败 {stats.failed}</Tag>
                <Tag color="processing" style={{ margin: 0 }}>待发 {stats.pending}</Tag>
                <Tag color="warning" style={{ margin: 0 }}>已排程 {stats.scheduled}</Tag>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>共 {stats.total} 条</Typography.Text>
              </div>
            )}
            {jobs.length > 0 && (
              <div>
                <Typography.Text strong style={{ fontSize: 12 }}>
                  发布队列（最近 {Math.min(jobs.length, 8)} 条）
                </Typography.Text>
                <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {jobs.slice(0, 8).map((j) => (
                    <div
                      key={j.id}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}
                    >
                      <Tag style={{ margin: 0, width: 64, textAlign: 'center' }}>
                        {PLATFORM_NAMES[j.platformId] ?? j.platformId}
                      </Tag>
                      <Tag
                        color={
                          j.status === 'success'
                            ? 'success'
                            : j.status === 'failed'
                              ? 'error'
                              : j.status === 'running'
                                ? 'processing'
                                : 'default'
                        }
                        style={{ margin: 0, width: 56, textAlign: 'center' }}
                      >
                        {j.status}
                      </Tag>
                      <Typography.Text type="secondary" style={{ fontSize: 11 }} ellipsis={{ tooltip: j.error }}>
                        {j.error ?? j.title.slice(0, 30)}
                      </Typography.Text>
                      {j.status === 'failed' && (
                        <Button size="small" type="link" style={{ fontSize: 11, padding: 0 }} onClick={() => void retryJob(j.id)}>
                          重试
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        title="公众号凭证配置"
        open={gzhOpen}
        onCancel={() => setGzhOpen(false)}
        onOk={() => void saveGzh()}
        okText="保存"
        cancelText="取消"
        width={460}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            通过微信公众平台（mp.weixin.qq.com）→ 设置与开发 → 基本配置 获取 AppID 与 AppSecret。
            当前：{gzhInfo.appId || '未配置'}
            {gzhInfo.hasSecret ? '（已保存 Secret）' : ''}
          </Typography.Text>
          <Input aria-label="AppID" placeholder="AppID" value={gzhAppId} onChange={(e) => setGzhAppId(e.target.value)} />
          <Input.Password aria-label="AppSecret" placeholder="AppSecret" value={gzhSecret} onChange={(e) => setGzhSecret(e.target.value)} />
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            Secret 使用系统安全存储（safeStorage）加密保存，仅用于调用微信官方接口创建图文草稿。
          </Typography.Text>
        </div>
      </Modal>

      {browserUrl && (
        <div className="hot-browser">
          <div className="hot-browser-bar">
            <Button size="small" icon={<ArrowLeftOutlined />} onClick={() => browserNav('back')} title="后退" />
            <Button size="small" icon={<ArrowRightOutlined />} onClick={() => browserNav('forward')} title="前进" />
            <Button size="small" icon={<ReloadOutlined />} onClick={() => browserNav('reload')} title="刷新" />
            <Input
              size="small"
              value={browserUrl}
              onChange={(e) => setBrowserUrl(e.target.value)}
              onPressEnter={() => {
                const u = (browserUrl ?? '').trim()
                if (!isValidHttpUrl(u)) {
                  message.error('请输入有效的 http(s) 网址')
                  return
                }
                setBrowserError('')
                setBrowserState('loading')
                setBrowserUrl(u)
              }}
              placeholder="输入网址后回车跳转"
              style={{ flex: 1, minWidth: 120 }}
              aria-label="浏览器地址栏"
            />
            <Button size="small" icon={<ExportOutlined />} onClick={() => void openSource(browserUrl ?? '')} title="外部浏览器打开" />
            <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => setBrowserUrl(null)} title="关闭" />
          </div>
          <div style={{ position: 'relative', flex: 1, display: 'flex', minHeight: 0 }}>
            <webview ref={webviewRef} src={browserUrl} style={{ flex: 1, width: '100%' }} allowpopups partition="persist:hotspots" />
            {browserState === 'loading' && (
              <div style={BROWSER_OVERLAY}>
                <Spin />
                <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                  加载中…
                </Typography.Text>
              </div>
            )}
            {browserState === 'error' && (
              <div style={BROWSER_OVERLAY}>
                <Typography.Text type="danger">内容加载失败{browserError ? `：${browserError}` : ''}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12, marginTop: 4 }}>
                  部分站点会拦截内置浏览器，可改用外部浏览器打开。
                </Typography.Text>
                <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                  <Button size="small" icon={<ReloadOutlined />} onClick={() => browserNav('reload')}>
                    重试
                  </Button>
                  <Button size="small" icon={<ExportOutlined />} onClick={() => void openSource(browserUrl ?? '')}>
                    用浏览器打开
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      </>)}
    </div>
  )
}

function formatHot(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  return String(n)
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

/** 仅接受绝对 http(s) 链接，过滤空值/相对路径/非常规协议，避免内置浏览器静默打不开 */
function isValidHttpUrl(u: string): boolean {
  if (!u) return false
  try {
    const p = new URL(u)
    return p.protocol === 'http:' || p.protocol === 'https:'
  } catch {
    return false
  }
}

const BROWSER_OVERLAY: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'var(--bg-elevated, #fff)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
  zIndex: 2
}
