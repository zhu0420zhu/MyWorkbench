/* 写作工作流面板：新建作品自动挂载，逐步引导 + 一键跑 Skill */
import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Input,
  Modal,
  Progress,
  Select,
  Space,
  Tag,
  Typography,
  message
} from 'antd'
import {
  CheckCircleFilled,
  CheckCircleOutlined,
  CopyOutlined,
  PlayCircleOutlined,
  RocketOutlined,
  SyncOutlined
} from '@ant-design/icons'
import type { NovelWorkflow, ProjectWorkflowState, SkillRunResult } from '@shared/types'

const DEFAULT_WF = 'webnovel-fast'

interface Props {
  projectId: string
  currentChapterId: string | null
  reloadKey: number
}

export default function WorkflowPanel({ projectId, currentChapterId, reloadKey }: Props) {
  const [state, setState] = useState<ProjectWorkflowState | null>(null)
  const [all, setAll] = useState<NovelWorkflow[]>([])
  const [runningId, setRunningId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // 结果弹窗（自包含，不依赖 Skill 列表的 runTarget）
  const [resultOpen, setResultOpen] = useState(false)
  const [resultTitle, setResultTitle] = useState('')
  const [runResult, setRunResult] = useState<SkillRunResult | null>(null)
  const [userInput, setUserInput] = useState('')

  const reload = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const [st, list] = await Promise.all([
        window.api.novel.getWorkflow(projectId),
        window.api.novel.listWorkflows()
      ])
      setAll(list ?? [])
      if (st) {
        setState(st)
        return
      }
      // 旧作品无挂载 → 自动补挂默认「网文快写流」（傻瓜式）
      const r = await window.api.novel.switchWorkflow(projectId, DEFAULT_WF)
      if (r) {
        setState(r)
        message.info(`已为本作品挂载「${r.workflow.name}」工作流`)
      } else {
        setState(null)
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void reload()
  }, [reload, reloadKey])

  const toggle = async (stepId: string, done: boolean): Promise<void> => {
    const next = await window.api.novel.workflowStepDone(projectId, stepId, done)
    if (next) setState(next)
  }

  const runStep = async (skillId: string, title: string): Promise<void> => {
    setRunningId(skillId)
    setResultTitle(title)
    setRunResult(null)
    setResultOpen(true)
    try {
      const r = await window.api.novel.runSkill({
        projectId,
        skillId,
        chapterId: currentChapterId ?? undefined,
        userInput: userInput.trim() || undefined
      })
      setRunResult(r)
      if (r.ok) message.success(`「${title}」已完成`)
    } catch (err) {
      setRunResult({ ok: false, error: (err as Error).message })
    } finally {
      setRunningId(null)
    }
  }

  const copyResult = async (): Promise<void> => {
    if (!runResult?.text) return
    try {
      await navigator.clipboard.writeText(runResult.text)
      message.success('已复制')
    } catch {
      message.error('复制失败')
    }
  }

  const switchWf = async (id: string): Promise<void> => {
    const next = await window.api.novel.switchWorkflow(projectId, id)
    if (next) {
      setState(next)
      message.success(`已切换到「${next.workflow.name}」`)
    }
  }

  if (loading && !state) {
    return <div style={{ padding: 16, opacity: 0.6 }}>加载工作流…</div>
  }
  if (!state) {
    return (
      <Empty style={{ margin: '24px 0' }} description="暂无工作流。点下方按钮挂载「网文快写流」。">
        <Button type="primary" icon={<RocketOutlined />} onClick={() => void switchWf(DEFAULT_WF)}>
          挂载默认工作流
        </Button>
      </Empty>
    )
  }

  const { workflow, done, nextStepId } = state
  const doneSet = new Set(done)
  const pct = workflow.steps.length ? Math.round((done.length / workflow.steps.length) * 100) : 0

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <RocketOutlined style={{ color: 'var(--color-primary, #1677ff)' }} />
        <Typography.Text strong>{workflow.name}</Typography.Text>
        <Select
          size="small"
          style={{ minWidth: 140 }}
          value={workflow.id}
          onChange={(v) => void switchWf(v)}
          options={all.map((w) => ({ label: w.name, value: w.id }))}
        />
        <Tag color="blue" style={{ margin: 0 }}>
          {done.length}/{workflow.steps.length}
        </Tag>
      </div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        {workflow.description}
      </Typography.Paragraph>
      <Progress percent={pct} size="small" style={{ marginBottom: 12 }} />

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12, fontSize: 12 }}
        message="傻瓜式：按顺序点「运行」→ 看结果 → 勾选完成。新建作品已自动挂载本流。"
      />

      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        {workflow.steps.map((s, i) => {
          const isDone = doneSet.has(s.id)
          const isNext = s.id === nextStepId
          return (
            <div
              key={s.id}
              style={{
                padding: '8px 10px',
                borderRadius: 8,
                border: `1px solid ${isNext ? 'var(--color-primary, #1677ff)' : 'var(--border-color, rgba(128,128,128,.18))'}`,
                background: isDone
                  ? 'rgba(82,196,26,.06)'
                  : isNext
                    ? 'rgba(22,119,255,.06)'
                    : 'var(--bg-subtle, rgba(128,128,128,.04))'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <Checkbox
                  checked={isDone}
                  onChange={(e) => void toggle(s.id, e.target.checked)}
                  style={{ marginTop: 2 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <Typography.Text
                      strong
                      style={{ fontSize: 13, textDecoration: isDone ? 'line-through' : undefined }}
                    >
                      {i + 1}. {s.title}
                    </Typography.Text>
                    {isNext && (
                      <Tag color="processing" style={{ margin: 0, fontSize: 11 }}>
                        下一步
                      </Tag>
                    )}
                    {isDone && <CheckCircleFilled style={{ color: '#52c41a', fontSize: 12 }} />}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)', marginTop: 2, lineHeight: 1.5 }}>
                    {s.hint}
                  </div>
                  {s.skillId && (
                    <div style={{ marginTop: 6 }}>
                      <Button
                        size="small"
                        type={isNext ? 'primary' : 'default'}
                        icon={runningId === s.skillId ? <SyncOutlined spin /> : <PlayCircleOutlined />}
                        loading={runningId === s.skillId}
                        onClick={() => void runStep(s.skillId!, s.title)}
                      >
                        运行「{s.title}」
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </Space>

      {pct === 100 && (
        <Alert
          type="success"
          showIcon
          icon={<CheckCircleOutlined />}
          style={{ marginTop: 12 }}
          message="工作流已全部完成"
          description="可切换到其他流继续打磨，或进入「正文循环」持续连载。"
        />
      )}

      <Modal
        open={resultOpen}
        title={`工作流步骤：${resultTitle}`}
        footer={null}
        onCancel={() => setResultOpen(false)}
        width={640}
        destroyOnHidden
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Input.TextArea
            aria-label="额外输入"
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
            placeholder="额外输入（选填）：题材方向、人物名、要润色的段落…"
            autoSize={{ minRows: 2, maxRows: 5 }}
          />
          {runningId && (
            <Alert type="info" showIcon message="AI 生成中…（需已配置模型）" />
          )}
          {runResult && (
            <Alert
              type={runResult.ok ? 'success' : 'error'}
              showIcon
              message={runResult.ok ? '已生成' : runResult.error ?? '运行失败'}
            />
          )}
          {runResult?.ok && runResult.text && (
            <>
              <Button size="small" icon={<CopyOutlined />} onClick={() => void copyResult()}>
                复制结果
              </Button>
              <Input.TextArea
                aria-label="工作流运行结果"
                value={runResult.text}
                readOnly
                autoSize={{ minRows: 8, maxRows: 20 }}
              />
            </>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            上下文来自当前章节编排（设定 / 前文 / 实体）；未打开章节时退化为作品设定。
          </Typography.Text>
        </Space>
      </Modal>
    </div>
  )
}
