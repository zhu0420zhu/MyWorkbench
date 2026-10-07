import { useCallback, useEffect, useState } from 'react'
import { Button, Checkbox, Drawer, Input, Modal, Tag, Typography, message } from 'antd'
import { ThunderboltOutlined } from '@ant-design/icons'
import { PLATFORM_NAMES, formatHot, sourceLabel } from './feedUtils'
import type { FeedItem, PublishJobInfo, PublishPlatformInfo, PublishStats } from '@shared/types'

/**
 * 编辑发布抽屉（原「多媒体页」的「内容编辑 · 多平台一键分发」Modal）。
 * 逻辑原样保留：标题/正文编辑、AI 摘要、按平台 AI 改写、发布目标勾选、
 * 预约发布、公众号凭证配置、发布队列与统计。
 * 仅复用 window.api.publish.*，不修改 publish 模块本身。
 */
export interface PublishDrawerProps {
  open: boolean
  /** 待发布的情报条目；null 时不渲染表单内容 */
  item: FeedItem | null
  onClose: () => void
}

/** 由情报条目生成正文初稿（热点/智能体分别加不同前缀） */
function buildDraft(item: FeedItem): string {
  const kindLabel = item.sourceKind === 'agent' ? '智能体' : '热点'
  const sources = item.sources.map((s) => sourceLabel(s)).join(' / ')
  const lines: string[] = [`【${kindLabel}】${item.title}`, '']
  if (item.hot > 0) lines.push(`热度：${formatHot(item.hot)}`)
  if (item.meta) lines.push(`信息：${item.meta}`)
  lines.push(`来源：${sources}`)
  return lines.join('\n')
}

export default function PublishDrawer({ open, item, onClose }: PublishDrawerProps) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [targets, setTargets] = useState<string[]>([])
  // 发布面板状态
  const [platforms, setPlatforms] = useState<PublishPlatformInfo[]>([])
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
  const [gzhInfo, setGzhInfo] = useState<{ appId: string; hasSecret: boolean }>({
    appId: '',
    hasSecret: false
  })

  const refreshPublishState = useCallback(async (): Promise<void> => {
    try {
      const [list, login, jobList, st] = await Promise.all([
        window.api.publish.listPlatforms(),
        window.api.publish.checkAllLogin(),
        window.api.publish.listJobs(),
        window.api.publish.stats()
      ])
      setPlatforms(list)
      setLoginMap(login)
      setJobs(jobList)
      setStats(st)
    } catch {
      /* 发布模块不可用时静默 */
    }
  }, [])

  // 打开时按当前条目重置表单，并拉取发布状态
  useEffect(() => {
    if (!open || !item) return
    setTitle(item.title)
    setContent(buildDraft(item))
    setTargets([])
    setScheduleTime('')
    void refreshPublishState()
  }, [open, item, refreshPublishState])

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
    try {
      await window.api.publish.gzhSave({ appId: gzhAppId.trim(), secret: gzhSecret.trim() })
      setGzhOpen(false)
      message.success('公众号凭证已保存（本机加密存储）')
      void refreshPublishState()
    } catch (err) {
      message.error('凭证保存失败：' + ((err as Error).message || '未知'))
    }
  }

  const doPublish = async (): Promise<void> => {
    if (targets.length === 0) {
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
        title,
        content,
        targets,
        contentId: item?.id,
        scheduledAt
      })
      setJobs(jobList)
      setStats(await window.api.publish.stats())
      setScheduleTime('')
      message.success(
        scheduledAt
          ? `已排程：${new Date(scheduledAt).toLocaleString()} 发布`
          : '已提交发布任务，详见下方队列'
      )
    } catch (err) {
      message.error(`发布失败：${(err as Error).message}`)
    } finally {
      setPublishing(false)
    }
  }

  const aiSummarize = async (): Promise<void> => {
    setAiBusy(true)
    try {
      const r = await window.api.publish.aiSummarize({ title, content })
      if (r.ok && r.text) setContent(r.text)
      else message.warning(r.error ?? 'AI 摘要生成失败')
    } finally {
      setAiBusy(false)
    }
  }

  const aiRewrite = async (platformId: string, platformName: string): Promise<void> => {
    setAiBusy(true)
    try {
      const r = await window.api.publish.aiRewrite({ title, content, platformId })
      if (r.ok && r.text) {
        setContent(r.text)
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

  const loggedCount = Object.values(loginMap).filter(Boolean).length

  return (
    <>
      <Drawer title="内容编辑 · 多平台一键分发" open={open} onClose={onClose} width={620}>
        {item && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                标题
              </Typography.Text>
              <Input
                aria-label="情报标题"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div>
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
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
              <Input.TextArea
                aria-label="情报正文"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={5}
              />
            </div>

            <div>
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  发布目标平台（点击平台名勾选）
                  {loggedCount > 0 && (
                    <Tag color="success" style={{ marginLeft: 8, fontSize: 11 }}>
                      已登录 {loggedCount} 个平台
                    </Tag>
                  )}
                </Typography.Text>
                <Button size="small" type="link" onClick={() => void refreshPublishState()}>
                  刷新登录状态
                </Button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                {platforms.map((p) => {
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
                        checked={targets.includes(p.id)}
                        disabled={!selectable}
                        onChange={(e) =>
                          setTargets((list) =>
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
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 11, marginLeft: 'auto' }}
                      >
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
                        <Button
                          size="small"
                          type="link"
                          style={{ fontSize: 11, padding: 0 }}
                          onClick={() => void openGzh()}
                        >
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

            <Button
              type="primary"
              loading={publishing}
              onClick={() => void doPublish()}
              style={{ marginTop: 4 }}
            >
              提交发布
            </Button>

            {stats && (
              <div
                style={{
                  display: 'flex',
                  gap: 12,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  fontSize: 12
                }}
              >
                <Typography.Text strong style={{ fontSize: 12 }}>
                  发布统计
                </Typography.Text>
                <Tag color="success" style={{ margin: 0 }}>
                  成功 {stats.success}
                </Tag>
                <Tag color="error" style={{ margin: 0 }}>
                  失败 {stats.failed}
                </Tag>
                <Tag color="processing" style={{ margin: 0 }}>
                  待发 {stats.pending}
                </Tag>
                <Tag color="warning" style={{ margin: 0 }}>
                  已排程 {stats.scheduled}
                </Tag>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  共 {stats.total} 条
                </Typography.Text>
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
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 11 }}
                        ellipsis={{ tooltip: j.error }}
                      >
                        {j.error ?? j.title.slice(0, 30)}
                      </Typography.Text>
                      {j.status === 'failed' && (
                        <Button
                          size="small"
                          type="link"
                          style={{ fontSize: 11, padding: 0 }}
                          onClick={() => void retryJob(j.id)}
                        >
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
      </Drawer>

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
          <Input
            aria-label="AppID"
            placeholder="AppID"
            value={gzhAppId}
            onChange={(e) => setGzhAppId(e.target.value)}
          />
          <Input.Password
            aria-label="AppSecret"
            placeholder="AppSecret"
            value={gzhSecret}
            onChange={(e) => setGzhSecret(e.target.value)}
          />
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            Secret 使用系统安全存储加密保存（不可用时降级本地弱加密），仅用于调用微信官方接口创建图文草稿。
          </Typography.Text>
        </div>
      </Modal>
    </>
  )
}
