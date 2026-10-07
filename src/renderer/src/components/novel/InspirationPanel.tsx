import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import {
  Alert,
  Button,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
  message
} from 'antd'
import {
  BulbOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  ImportOutlined,
  PlusOutlined,
  PlayCircleOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import type {
  InspirationKind,
  InspirationNote,
  SkillExportBundle,
  SkillRunResult,
  WritingSkill
} from '@shared/types'
import WorkflowPanel from './WorkflowPanel'

/** 七种灵感类型的展示元数据 */
const KIND_META: Record<InspirationKind, { label: string; color: string }> = {
  idea: { label: '点子', color: 'geekblue' },
  plot: { label: '情节', color: 'green' },
  character: { label: '人物', color: 'red' },
  scene: { label: '场景', color: 'purple' },
  dialogue: { label: '对话', color: 'orange' },
  world: { label: '世界观', color: 'cyan' },
  other: { label: '杂记', color: 'default' }
}

const KIND_OPTIONS = (Object.keys(KIND_META) as InspirationKind[]).map((k) => ({
  value: k,
  label: KIND_META[k].label
}))

interface InspirationPanelProps {
  projectId: string
  /** 当前正在编辑的章节（Skill 运行时用于组装上下文） */
  currentChapterId: string | null
  /** 外部触发重新拉取 */
  reloadKey: number
}

export default function InspirationPanel({
  projectId,
  currentChapterId,
  reloadKey
}: InspirationPanelProps) {
  const [segment, setSegment] = useState<'workflow' | 'pool' | 'skill'>('workflow')
  const [inspirations, setInspirations] = useState<InspirationNote[]>([])
  const [skills, setSkills] = useState<WritingSkill[]>([])
  const [loading, setLoading] = useState(false)

  /* ------------------------------ 灵感池 ------------------------------ */

  const [createOpen, setCreateOpen] = useState(false)
  const [draftKind, setDraftKind] = useState<InspirationKind>('idea')
  const [draftContent, setDraftContent] = useState('')
  const [draftNote, setDraftNote] = useState('')

  const [editTarget, setEditTarget] = useState<InspirationNote | null>(null)
  const [editKind, setEditKind] = useState<InspirationKind>('idea')
  const [editContent, setEditContent] = useState('')
  const [editNote, setEditNote] = useState('')

  /* ------------------------------ Skill 包 ------------------------------ */

  const [skillEdit, setSkillEdit] = useState<WritingSkill | null>(null)
  const [skillName, setSkillName] = useState('')
  const [skillDesc, setSkillDesc] = useState('')
  const [skillTemplate, setSkillTemplate] = useState('')

  const [runTarget, setRunTarget] = useState<WritingSkill | null>(null)
  const [runInput, setRunInput] = useState('')
  const [runLoading, setRunLoading] = useState(false)
  const [runResult, setRunResult] = useState<SkillRunResult | null>(null)

  const reload = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const [ins, sk] = await Promise.all([
        window.api.novel.listInspirations(projectId),
        window.api.novel.listSkills()
      ])
      setInspirations(ins)
      setSkills(sk)
    } catch {
      message.error('加载灵感工作台失败')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void reload()
  }, [reload, reloadKey])

  /* ------------------------------ 灵感池操作 ------------------------------ */

  const handleCreate = async (): Promise<void> => {
    const c = draftContent.trim()
    if (!c) {
      message.warning('请填写灵感内容')
      return
    }
    const n = await window.api.novel.createInspiration({
      projectId,
      kind: draftKind,
      content: c,
      note: draftNote.trim() || undefined
    })
    if (n) {
      message.success('已收入灵感池')
      setCreateOpen(false)
      setDraftContent('')
      setDraftNote('')
      void reload()
    }
  }

  const openEdit = (n: InspirationNote): void => {
    setEditTarget(n)
    setEditKind(n.kind)
    setEditContent(n.content)
    setEditNote(n.note ?? '')
  }

  const saveEdit = async (): Promise<void> => {
    if (!editTarget) return
    const c = editContent.trim()
    if (!c) {
      message.warning('灵感内容不能为空')
      return
    }
    await window.api.novel.updateInspiration(projectId, editTarget.id, {
      kind: editKind,
      content: c,
      note: editNote.trim() || undefined
    })
    setEditTarget(null)
    void reload()
  }

  const removeInspiration = async (n: InspirationNote): Promise<void> => {
    await window.api.novel.removeInspiration(projectId, n.id)
    message.success('已删除')
    void reload()
  }

  /* ------------------------------ Skill 操作 ------------------------------ */

  const openCreateSkill = (): void => {
    setSkillEdit(null)
    setSkillName('')
    setSkillDesc('')
    setSkillTemplate('')
    setSkillEdit({} as WritingSkill) // 用非空标记打开"新建"弹窗
  }

  const openEditSkill = (s: WritingSkill): void => {
    setSkillEdit(s)
    setSkillName(s.name)
    setSkillDesc(s.description)
    setSkillTemplate(s.template)
  }

  const saveSkill = async (): Promise<void> => {
    const name = skillName.trim()
    const tpl = skillTemplate.trim()
    if (!name || !tpl) {
      message.warning('请填写 Skill 名称与 prompt 模板')
      return
    }
    if (skillEdit && skillEdit.id) {
      await window.api.novel.updateSkill(skillEdit.id, {
        name,
        description: skillDesc.trim(),
        template: tpl
      })
    } else {
      await window.api.novel.createSkill({ name, description: skillDesc.trim(), template: tpl })
    }
    setSkillEdit(null)
    void reload()
  }

  const removeSkill = async (s: WritingSkill): Promise<void> => {
    await window.api.novel.removeSkill(s.id)
    message.success('已删除 Skill')
    void reload()
  }

  const openRun = (s: WritingSkill): void => {
    setRunTarget(s)
    setRunInput('')
    setRunResult(null)
  }

  const runNow = async (): Promise<void> => {
    if (!runTarget) return
    setRunLoading(true)
    setRunResult(null)
    try {
      const r = await window.api.novel.runSkill({
        projectId,
        skillId: runTarget.id,
        chapterId: currentChapterId ?? undefined,
        userInput: runInput.trim() || undefined
      })
      setRunResult(r)
    } catch {
      setRunResult({ ok: false, error: '调用失败' })
    } finally {
      setRunLoading(false)
    }
  }

  const copyResult = async (): Promise<void> => {
    if (!runResult?.text) return
    try {
      await navigator.clipboard.writeText(runResult.text)
      message.success('已复制到剪贴板')
    } catch {
      message.warning('复制失败，请手动选择文本复制')
    }
  }

  const exportSkills = async (): Promise<void> => {
    const bundle = await window.api.novel.exportSkills()
    await window.api.exportText('writing-skills.json', JSON.stringify(bundle, null, 2))
  }

  const importSkills = async (): Promise<void> => {
    const picked = await window.api.pickTextFile()
    if (!picked) return
    try {
      const bundle = JSON.parse(picked.content) as SkillExportBundle
      const r = await window.api.novel.importSkills(bundle)
      if (r.ok) {
        message.success(`已导入 ${r.count} 个 Skill`)
        void reload()
      } else {
        message.error(r.error ?? '导入失败')
      }
    } catch {
      message.error('解析失败：不是合法的 Skill 包')
    }
  }

  /* ------------------------------ 渲染 ------------------------------ */

  const renderInspiration = (n: InspirationNote): ReactElement => (
    <div
      key={n.id}
      style={{
        padding: '8px 10px',
        borderRadius: 6,
        border: '1px solid var(--border-color, rgba(128,128,128,.18))',
        marginBottom: 8,
        background: 'var(--bg-subtle, rgba(128,128,128,.04))'
      }}
    >
      <div style={{ fontSize: 13, lineHeight: 1.6, wordBreak: 'break-word' }}>{n.content}</div>
      {n.note && (
        <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-secondary, #888)' }}>
          备注：{n.note}
        </div>
      )}
      <div style={{ marginTop: 6 }}>
        <Space size={4} wrap>
          <Tag color={KIND_META[n.kind].color} style={{ margin: 0 }}>
            {KIND_META[n.kind].label}
          </Tag>
          <Tooltip title="编辑">
            <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEdit(n)} />
          </Tooltip>
          <Popconfirm
            title="删除这条灵感？"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => void removeInspiration(n)}
          >
            <Button size="small" type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      </div>
    </div>
  )

  const renderSkill = (s: WritingSkill): ReactElement => (
    <div
      key={s.id}
      style={{
        padding: '8px 10px',
        borderRadius: 6,
        border: '1px solid var(--border-color, rgba(128,128,128,.18))',
        marginBottom: 8,
        background: 'var(--bg-subtle, rgba(128,128,128,.04))'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <ThunderboltOutlined style={{ color: 'var(--color-primary, #1677ff)' }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{s.name}</span>
        {s.builtin && (
          <Tag color="blue" style={{ margin: 0, fontSize: 11 }}>
            内置
          </Tag>
        )}
      </div>
      {s.description && (
        <div style={{ marginTop: 2, fontSize: 12, color: 'var(--text-secondary, #888)' }}>
          {s.description}
        </div>
      )}
      <div style={{ marginTop: 6 }}>
        <Space size={4} wrap>
          <Tooltip title="用当前章上下文运行">
            <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={() => openRun(s)}>
              运行
            </Button>
          </Tooltip>
          <Tooltip title="编辑模板">
            <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEditSkill(s)} />
          </Tooltip>
          <Popconfirm
            title={s.builtin ? '删除这个内置 Skill？' : '删除这个 Skill？'}
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => void removeSkill(s)}
          >
            <Button size="small" type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      </div>
    </div>
  )

  const renderPool = (): ReactElement => (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10 }}>
      {loading && inspirations.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="加载中…" />
      ) : inspirations.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="灵感池是空的。写作时冒出的点子、情节、人物、台词都可以随手记在这里。"
        />
      ) : (
        inspirations.map(renderInspiration)
      )}
    </div>
  )

  const renderSkills = (): ReactElement => (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10 }}>
      {loading && skills.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="加载中…" />
      ) : skills.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有 Skill。新建一个 prompt 模板，或导入别人分享的包。" />
      ) : (
        skills.map(renderSkill)
      )}
    </div>
  )

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: '8px 10px',
          borderBottom: '1px solid var(--border-color, rgba(128,128,128,.12))'
        }}
      >
        <Segmented
          size="small"
          block
          value={segment}
          onChange={(v) => setSegment(v as 'workflow' | 'pool' | 'skill')}
          options={[
            { label: '工作流', value: 'workflow' },
            { label: '灵感池', value: 'pool' },
            { label: '写作 Skill', value: 'skill' }
          ]}
        />
      </div>

      {segment === 'workflow' ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 10px' }}>
          <WorkflowPanel projectId={projectId} currentChapterId={currentChapterId} reloadKey={reloadKey} />
        </div>
      ) : segment === 'pool' ? (
        <>
          <div style={{ padding: '8px 10px' }}>
            <Button
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              block
              onClick={() => setCreateOpen(true)}
            >
              记一条灵感
            </Button>
          </div>
          {renderPool()}
        </>
      ) : (
        <>
          <div style={{ padding: '8px 10px' }}>
            <Space style={{ width: '100%' }} wrap>
              <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openCreateSkill}>
                新建 Skill
              </Button>
              <Button size="small" icon={<ExportOutlined />} onClick={() => void exportSkills()}>
                导出
              </Button>
              <Button size="small" icon={<ImportOutlined />} onClick={() => void importSkills()}>
                导入
              </Button>
            </Space>
          </div>
          {renderSkills()}
        </>
      )}

      {/* 记灵感弹窗 */}
      <Modal
        open={createOpen}
        title="记一条灵感"
        okText="收入"
        cancelText="取消"
        destroyOnHidden
        onCancel={() => setCreateOpen(false)}
        onOk={() => void handleCreate()}
      >
        <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
          <Select
            aria-label="灵感类型"
            value={draftKind}
            onChange={(v) => setDraftKind(v)}
            options={KIND_OPTIONS}
            style={{ width: 160 }}
          />
          <Input.TextArea
            aria-label="灵感内容"
            value={draftContent}
            onChange={(e) => setDraftContent(e.target.value)}
            placeholder="灵感内容：一句话点子、一段情节设想、一句台词…"
            autoSize={{ minRows: 3, maxRows: 6 }}
          />
          <Input
            aria-label="灵感备注"
            value={draftNote}
            onChange={(e) => setDraftNote(e.target.value)}
            placeholder="备注（选填）"
          />
        </Space>
      </Modal>

      {/* 编辑灵感弹窗 */}
      <Modal
        open={!!editTarget}
        title="编辑灵感"
        okText="保存"
        cancelText="取消"
        destroyOnHidden
        onCancel={() => setEditTarget(null)}
        onOk={() => void saveEdit()}
      >
        <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
          <Select
            aria-label="灵感类型"
            value={editKind}
            onChange={(v) => setEditKind(v)}
            options={KIND_OPTIONS}
            style={{ width: 160 }}
          />
          <Input.TextArea
            aria-label="灵感内容"
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            autoSize={{ minRows: 3, maxRows: 6 }}
          />
          <Input
            aria-label="灵感备注"
            value={editNote}
            onChange={(e) => setEditNote(e.target.value)}
            placeholder="备注（选填）"
          />
        </Space>
      </Modal>

      {/* 新建 / 编辑 Skill 弹窗 */}
      <Modal
        open={!!skillEdit}
        title={skillEdit && skillEdit.id ? '编辑 Skill' : '新建 Skill'}
        okText="保存"
        cancelText="取消"
        width={640}
        destroyOnHidden
        onCancel={() => setSkillEdit(null)}
        onOk={() => void saveSkill()}
      >
        <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
          <Input
            aria-label="Skill 名称"
            value={skillName}
            onChange={(e) => setSkillName(e.target.value)}
            placeholder="Skill 名称，如「卡文救援」"
          />
          <Input
            aria-label="Skill 说明"
            value={skillDesc}
            onChange={(e) => setSkillDesc(e.target.value)}
            placeholder="一句话说明这个 Skill 用来做什么（选填）"
          />
          <Input.TextArea
            aria-label="Skill 模板"
            value={skillTemplate}
            onChange={(e) => setSkillTemplate(e.target.value)}
            placeholder="prompt 模板。用 {{context}} 代表当前章上下文，{{input}} 代表作者额外输入。"
            autoSize={{ minRows: 6, maxRows: 14 }}
            style={{ fontFamily: 'monospace' }}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            模板里写 <code>{'{{context}}'}</code> 的地方会被当前章节上下文替换，<code>{'{{input}}'}</code> 会被运行时填写的「额外输入」替换。
          </Typography.Text>
        </Space>
      </Modal>

      {/* 运行 Skill 弹窗 */}
      <Modal
        open={!!runTarget}
        title={`运行：${runTarget?.name ?? ''}`}
        okText="运行"
        cancelText="关闭"
        confirmLoading={runLoading}
        destroyOnHidden
        onCancel={() => setRunTarget(null)}
        onOk={() => void runNow()}
      >
        <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
          <Input.TextArea
            aria-label="额外输入"
            value={runInput}
            onChange={(e) => setRunInput(e.target.value)}
            placeholder="额外输入（选填）：如要润色的台词、要设计的人物名。留空则只用章节上下文。"
            autoSize={{ minRows: 3, maxRows: 6 }}
          />
          {runResult && (
            <Alert
              type={runResult.ok ? 'success' : 'error'}
              showIcon
              message={runResult.ok ? '已生成' : runResult.error ?? '运行失败'}
            />
          )}
          {runResult?.ok && runResult.text && (
            <div>
              <div style={{ marginBottom: 4 }}>
                <Button size="small" icon={<CopyOutlined />} onClick={() => void copyResult()}>
                  复制结果
                </Button>
              </div>
              <Input.TextArea aria-label="运行结果" value={runResult.text} readOnly autoSize={{ minRows: 6, maxRows: 16 }} />
            </div>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            上下文来自当前章节：若已打开某章则使用其编排上下文，否则退化为仅作品设定。
          </Typography.Text>
        </Space>
      </Modal>
    </div>
  )
}
