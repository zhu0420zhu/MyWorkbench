import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Input, Select, Space, Typography, message } from 'antd'
import {
  NotificationOutlined,
  FireOutlined,
  ThunderboltOutlined,
  SendOutlined
} from '@ant-design/icons'
import { useNav } from '../nav'
import type { PublishPlatformInfo } from '@shared/types'

export default function Copywriting() {
  const { navigate } = useNav()
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [platforms, setPlatforms] = useState<PublishPlatformInfo[]>([])
  const [platformId, setPlatformId] = useState<string>('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.api.publish
      .listPlatforms()
      .then((list) => {
        setPlatforms(list)
        const first = list.find((p) => p.status === 'ready')
        if (first) setPlatformId(first.id)
      })
      .catch(() => {
        /* 发布模块不可用时静默，改写按钮禁用 */
      })
  }, [])

  const aiSummarize = useCallback(async () => {
    if (!title.trim() && !content.trim()) {
      message.warning('请先输入标题或正文')
      return
    }
    setBusy(true)
    try {
      const r = await window.api.publish.aiSummarize({ title, content })
      if (r.ok && r.text) {
        setContent(r.text)
        message.success('已生成摘要')
      } else {
        message.warning(r.error ?? 'AI 摘要生成失败（可能未配置模型）')
      }
    } finally {
      setBusy(false)
    }
  }, [title, content])

  const aiRewrite = useCallback(async () => {
    if (!title.trim() && !content.trim()) {
      message.warning('请先输入标题或正文')
      return
    }
    if (!platformId) {
      message.warning('请选择目标平台')
      return
    }
    setBusy(true)
    try {
      const r = await window.api.publish.aiRewrite({ title, content, platformId })
      if (r.ok && r.text) {
        setContent(r.text)
        const name = platforms.find((p) => p.id === platformId)?.name ?? '目标平台'
        message.success(`已按「${name}」风格改写`)
      } else {
        message.warning(r.error ?? 'AI 改写失败（可能未配置模型）')
      }
    } finally {
      setBusy(false)
    }
  }, [title, content, platformId, platforms])

  return (
    <div className="hub-page">
      <div className="page-header">
        <Typography.Title level={4} style={{ margin: 0 }}>
          <NotificationOutlined style={{ marginRight: 8 }} />
          文案
        </Typography.Title>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          营销 / 推广类文案 · 聚合热点创作分发与 AI 文案工具，原有功能保持独立可用
        </Typography.Text>
      </div>

      <div className="hub-section-title">营销文案工作流</div>
      <div className="hub-grid">
        <Card
          hoverable
          className="hub-card"
          onClick={() => navigate({ page: 'hotspots' })}
        >
          <div className="hub-card-icon">
            <FireOutlined />
          </div>
          <div className="hub-card-title">热点创作分发</div>
          <div className="hub-card-desc">
            聚合全网热点，编辑内容，AI 摘要 + 按平台风格改写，多平台一键分发
          </div>
        </Card>
      </div>

      <div className="hub-section-title">AI 文案小工具</div>
      <Card size="small" className="hub-composer">
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <Input
            aria-label="标题（可选）"
            placeholder="标题（可选）"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            allowClear
          />
          <Input.TextArea
            aria-label="文案正文"
            placeholder="输入 / 粘贴文案正文，用下方按钮做 AI 摘要或按平台改写"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={6}
          />
          <Space wrap>
            <Button icon={<ThunderboltOutlined />} loading={busy} onClick={() => void aiSummarize()}>
              AI 摘要
            </Button>
            <Select
              aria-label="选择平台"
              value={platformId || undefined}
              onChange={setPlatformId}
              placeholder="选择平台"
              style={{ minWidth: 150 }}
              options={platforms.map((p) => ({
                label: `${p.name}（${p.status === 'ready' ? '可发布' : '待适配'}）`,
                value: p.id,
                disabled: p.status !== 'ready'
              }))}
            />
            <Button
              icon={<ThunderboltOutlined />}
              loading={busy}
              disabled={platforms.length === 0}
              onClick={() => void aiRewrite()}
            >
              按平台改写
            </Button>
            <Button type="primary" icon={<SendOutlined />} onClick={() => navigate({ page: 'hotspots' })}>
              去多平台分发
            </Button>
          </Space>
        </Space>
      </Card>
    </div>
  )
}
