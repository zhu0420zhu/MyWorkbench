/**
 * 一致性审计抽屉（P2-1）。
 *
 * 从顶栏「一致性审计」按钮打开，跑规则后把问题按严重程度列出。
 * 别名归一化类问题可一键"应用修正"——直接把该章里的别名替换成正式名；
 * 其余问题（如实体重名）给出说明，由作者手动处理。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Drawer,
  Empty,
  Space,
  Spin,
  Tag,
  Typography,
  message
} from 'antd'
import {
  CheckCircleOutlined,
  LoadingOutlined,
  WarningOutlined
} from '@ant-design/icons'
import type { ConsistencyIssue, ConsistencyIssueKind, ConsistencyReport } from '@shared/types'

interface ConsistencyDrawerProps {
  projectId: string | null
  open: boolean
  onClose: () => void
  /** 应用修正后回调：让外层刷新作品与编辑器正文 */
  onApplied: () => void
}

const KIND_LABEL: Record<ConsistencyIssueKind, string> = {
  'alias-normalization': '别名归一化',
  'unregistered-name': '未登记专名',
  'duplicate-entity': '实体重名'
}

const SEVERITY_META: Record<string, { color: string; label: string }> = {
  error: { color: 'red', label: '错误' },
  warn: { color: 'orange', label: '建议' },
  info: { color: 'blue', label: '提示' }
}

export default function ConsistencyDrawer({
  projectId,
  open,
  onClose,
  onApplied
}: ConsistencyDrawerProps) {
  const [report, setReport] = useState<ConsistencyReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [applyingId, setApplyingId] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const run = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const r = await window.api.novel.auditProject(projectId)
      if (aliveRef.current) setReport(r)
    } catch {
      if (aliveRef.current) message.error('审计失败')
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [projectId])

  // 打开即审计一次
  useEffect(() => {
    if (open && projectId) void run()
    // 仅跟随开关；手动"重新审计"由按钮触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId])

  const apply = useCallback(
    async (issue: ConsistencyIssue) => {
      if (!projectId) return
      setApplyingId(issue.id)
      try {
        const ok = await window.api.novel.applyConsistencyFix(projectId, issue)
        if (ok) {
          message.success('已应用修正')
          onApplied()
          await run()
        } else {
          message.warning('没有可替换的别名（可能已统一）')
        }
      } catch {
        message.error('应用修正失败')
      } finally {
        setApplyingId(null)
      }
    },
    [projectId, onApplied, run]
  )

  const sorted = useMemo(() => {
    if (!report) return []
    const order = { error: 0, warn: 1, info: 2 } as Record<string, number>
    return [...report.issues].sort(
      (a, b) => order[a.severity] - order[b.severity] || a.kind.localeCompare(b.kind)
    )
  }, [report])

  const counts = useMemo(() => {
    const c = { error: 0, warn: 0, info: 0 } as Record<string, number>
    for (const i of report?.issues ?? []) c[i.severity] += 1
    return c
  }, [report])

  return (
    <Drawer
      title="一致性审计"
      width={460}
      open={open}
      onClose={onClose}
      destroyOnHidden
      extra={
        <Button size="small" onClick={() => void run()} disabled={loading}>
          重新审计
        </Button>
      }
    >
      {loading && !report ? (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
        </div>
      ) : !report ? (
        <Empty description="暂无审计结果" />
      ) : report.issues.length === 0 ? (
        <Empty
          description={
            <span>
              <CheckCircleOutlined style={{ color: '#52c41a', marginRight: 6 }} />
              未发现一致性问题（已扫描 {report.scannedChapters} 章）
            </span>
          }
        />
      ) : (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message={`扫描 ${report.scannedChapters} 章，发现 ${report.issues.length} 处`}
            description={
              <Space size={4}>
                <Tag color="red">错误 {counts.error}</Tag>
                <Tag color="orange">建议 {counts.warn}</Tag>
                <Tag color="blue">提示 {counts.info}</Tag>
              </Space>
            }
          />
          {sorted.map((it) => {
            const sev = SEVERITY_META[it.severity]
            return (
              <div
                key={it.id}
                style={{
                  border: '1px solid var(--border-color, rgba(128,128,128,.2))',
                  borderRadius: 8,
                  padding: 10
                }}
              >
                <Space size={6} style={{ width: '100%', marginBottom: 4 }}>
                  <Tag color={sev.color}>{sev.label}</Tag>
                  <Tag>{KIND_LABEL[it.kind]}</Tag>
                  {it.chapterTitle && (
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      《{it.chapterTitle}》
                    </Typography.Text>
                  )}
                </Space>
                <div style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 8 }}>{it.message}</div>
                {it.autoFixable && (
                  <Button
                    size="small"
                    type="primary"
                    icon={applyingId === it.id ? <LoadingOutlined /> : <WarningOutlined />}
                    loading={applyingId === it.id}
                    onClick={() => void apply(it)}
                  >
                    应用修正
                  </Button>
                )}
              </div>
            )
          })}
        </Space>
      )}
    </Drawer>
  )
}
