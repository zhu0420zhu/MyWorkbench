/**
 * 设定卡编辑抽屉
 *
 * **保存策略：改了就存，不提供"取消"**。
 * 没做设定卡的版本历史，一旦误触"取消"作者得重打一遍设定；而误存最多是再改一次。
 * 因此所有关闭路径（点 X / 点遮罩 / 切换别的卡 / 切章节）统一走 flush ——
 * 并且 flush 的目标是**进入该次 effect 时捕获的 entityId**，不能读"当前选中卡"，
 * 否则切换实体时会把旧卡的内容写进新卡（章节编辑器踩过同一个坑）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Checkbox,
  Drawer,
  Empty,
  Input,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
  message
} from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import type {
  ChapterMeta,
  EntityKind,
  EntityMeta,
  EntityRelation,
  EntityState
} from '@shared/types'
import { ENTITY_KIND_META } from '@shared/types'

interface EntityDrawerProps {
  projectId: string
  /** null = 抽屉关闭 */
  entityId: string | null
  /** 全部实体：关系的目标候选 */
  entities: EntityMeta[]
  chapters: ChapterMeta[]
  chapterId: string | null
  chapterTitle: string
  onClose: () => void
  onSaved: (meta: EntityMeta) => void
}

interface FormState {
  name: string
  kind: EntityKind
  aliases: string[]
  tagline: string
  content: string
  pinned: boolean
}

const KINDS: EntityKind[] = ['character', 'location', 'faction', 'item', 'concept', 'event']

export default function EntityDrawer({
  projectId,
  entityId,
  entities,
  chapters,
  chapterId,
  chapterTitle,
  onClose,
  onSaved
}: EntityDrawerProps) {
  const [form, setForm] = useState<FormState | null>(null)
  const [states, setStates] = useState<EntityState[]>([])
  const [relations, setRelations] = useState<EntityRelation[]>([])
  const [loading, setLoading] = useState(false)
  const [aliasInput, setAliasInput] = useState('')

  // ---- 关系新建行 ----
  const [relTarget, setRelTarget] = useState<string | undefined>(undefined)
  const [relLabel, setRelLabel] = useState('')
  const [relBidi, setRelBidi] = useState(true)

  const dirtyRef = useRef(false)
  const formRef = useRef<FormState | null>(null)
  formRef.current = form
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const patch = useCallback((p: Partial<FormState>) => {
    dirtyRef.current = true
    setForm((prev) => (prev ? { ...prev, ...p } : prev))
  }, [])

  /* ---------------- 载入 ---------------- */

  useEffect(() => {
    if (!entityId) {
      setForm(null)
      setStates([])
      setRelations([])
      return
    }
    setLoading(true)
    void (async () => {
      try {
        const [full, st, rel] = await Promise.all([
          window.api.novel.getEntity(projectId, entityId),
          window.api.novel.listStates(projectId, entityId),
          window.api.novel.listRelations(projectId)
        ])
        if (!aliveRef.current) return
        const next: FormState = full
          ? {
              name: full.name,
              kind: full.kind,
              aliases: full.aliases,
              tagline: full.tagline,
              content: full.content,
              pinned: full.pinned
            }
          : { name: '', kind: 'character', aliases: [], tagline: '', content: '', pinned: false }
        setForm(next)
        dirtyRef.current = false
        setStates(st)
        setRelations(rel)
        setAliasInput('')
        setRelTarget(undefined)
        setRelLabel('')
        setRelBidi(true)
      } catch {
        if (aliveRef.current) message.error('设定卡加载失败')
      } finally {
        if (aliveRef.current) setLoading(false)
      }
    })()
  }, [projectId, entityId])

  /* ---------------- 保存 ---------------- */

  const saveNow = useCallback(
    async (targetId: string, data: FormState): Promise<void> => {
      const updated = await window.api.novel.updateEntity(projectId, targetId, {
        name: data.name,
        kind: data.kind,
        aliases: data.aliases,
        tagline: data.tagline,
        content: data.content,
        pinned: data.pinned
      })
      if (updated && aliveRef.current) onSaved(updated)
    },
    [projectId, onSaved]
  )

  const saveRef = useRef(saveNow)
  saveRef.current = saveNow

  // 兜底保存失败只提示一次：快速切换实体 / 连续失败时不刷屏，成功保存后复位
  const autoSaveErrNotifiedRef = useRef(false)

  // 切换实体 / 卸载时兜底保存：用进入 effect 时捕获的 id，不读"当前选中"
  useEffect(() => {
    if (!entityId) return
    const idAtMount = entityId
    return () => {
      if (idAtMount && dirtyRef.current && formRef.current) {
        void saveRef
          .current(idAtMount, formRef.current)
          .then(() => {
            autoSaveErrNotifiedRef.current = false
          })
          .catch(() => {
            if (!autoSaveErrNotifiedRef.current) {
              autoSaveErrNotifiedRef.current = true
              message.error('自动保存失败，请重试')
            }
          })
      }
    }
  }, [entityId])

  const handleClose = useCallback(async () => {
    if (entityId && dirtyRef.current && formRef.current) {
      try {
        await saveRef.current(entityId, formRef.current)
      } catch {
        message.error('保存失败')
        return
      }
    }
    dirtyRef.current = false
    onClose()
  }, [entityId, onClose])

  /* ---------------- 别名 ---------------- */

  const addAlias = useCallback(() => {
    const v = aliasInput.trim()
    if (!v) return
    setForm((prev) => {
      if (!prev) return prev
      if (prev.name === v || prev.aliases.includes(v)) return prev
      dirtyRef.current = true
      return { ...prev, aliases: [...prev.aliases, v] }
    })
    setAliasInput('')
  }, [aliasInput])

  /* ---------------- 动态状态 ---------------- */

  const addState = useCallback(async () => {
    if (!entityId || !chapterId) {
      message.warning('请先选中一个章节')
      return
    }
    const created = await window.api.novel.setState({
      projectId,
      entityId,
      chapterId,
      text: '（待填写）'
    })
    if (created && aliveRef.current) setStates((prev) => [...prev, created])
  }, [projectId, entityId, chapterId])

  const saveState = useCallback(
    async (s: EntityState, patchText?: string, patchChapter?: string) => {
      const updated = await window.api.novel.setState({
        projectId,
        id: s.id,
        entityId: s.entityId,
        chapterId: patchChapter ?? s.chapterId,
        text: patchText ?? s.text
      })
      if (updated && aliveRef.current) {
        setStates((prev) => prev.map((x) => (x.id === s.id ? updated : x)))
      }
    },
    [projectId]
  )

  const deleteState = useCallback(
    async (id: string) => {
      const left = await window.api.novel.removeState(projectId, id)
      if (aliveRef.current) setStates(left.filter((s) => s.entityId === entityId))
    },
    [projectId, entityId]
  )

  /* ---------------- 关系 ---------------- */

  const myRelations = useMemo(
    () => (entityId ? relations.filter((r) => r.fromId === entityId || r.toId === entityId) : []),
    [relations, entityId]
  )

  const addRelation = useCallback(async () => {
    if (!entityId || !relTarget || !relLabel.trim()) {
      message.warning('请选择对象并填写关系')
      return
    }
    const rel = await window.api.novel.upsertRelation({
      projectId,
      fromId: entityId,
      toId: relTarget,
      label: relLabel.trim(),
      bidirectional: relBidi
    })
    if (rel && aliveRef.current) {
      const all = await window.api.novel.listRelations(projectId)
      if (aliveRef.current) setRelations(all)
      setRelTarget(undefined)
      setRelLabel('')
    }
  }, [projectId, entityId, relTarget, relLabel, relBidi])

  const deleteRelation = useCallback(
    async (id: string) => {
      const left = await window.api.novel.removeRelation(projectId, id)
      if (aliveRef.current) setRelations(left)
    },
    [projectId]
  )

  const chapterOptions = useMemo(
    () => chapters.map((c) => ({ label: c.title || '未命名章节', value: c.id })),
    [chapters]
  )

  const nameOf = useCallback(
    (id: string) => entities.find((e) => e.id === id)?.name ?? '（已删除）',
    [entities]
  )

  return (
    <Drawer
      open={Boolean(entityId)}
      onClose={() => void handleClose()}
      width={420}
      destroyOnHidden
      title={form?.name ? `设定卡 · ${form.name}` : '设定卡'}
      extra={
        <Space size={6}>
          <Popconfirm
            title="删除这张设定卡？"
            description="相关关系与动态状态会一并清除，无法恢复。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={async () => {
              if (!entityId) return
              dirtyRef.current = false
              await window.api.novel.removeEntity(projectId, entityId)
              onClose()
            }}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
          <Button size="small" type="primary" onClick={() => void handleClose()}>
            完成
          </Button>
        </Space>
      }
    >
      {loading || !form ? (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Spin />
        </div>
      ) : (
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          {/* ---- 基础 ---- */}
          <Field label="名称">
            <Input
              aria-label="实体名称"
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="如：萧炎"
            />
          </Field>
          <Field label="类型">
            <Select
              aria-label="实体类型"
              value={form.kind}
              onChange={(v) => patch({ kind: v })}
              options={KINDS.map((k) => ({ label: ENTITY_KIND_META[k].label, value: k }))}
              style={{ width: 140 }}
            />
          </Field>
          <Field
            label="别名"
            hint="正文中出现任一别名即视为指代它。长别名优先匹配，不必担心互相包含。"
          >
            <Space size={4} wrap style={{ marginBottom: 4 }}>
              {form.aliases.length === 0 && (
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  暂无别名
                </Typography.Text>
              )}
              {form.aliases.map((a) => (
                <Tag
                  key={a}
                  closable
                  onClose={() =>
                    patch({ aliases: form.aliases.filter((x) => x !== a) })
                  }
                  style={{ fontSize: 11 }}
                >
                  {a}
                </Tag>
              ))}
            </Space>
            <Space size={4}>
              <Input
                size="small"
                aria-label="添加别名"
                value={aliasInput}
                onChange={(e) => setAliasInput(e.target.value)}
                onPressEnter={addAlias}
                placeholder="输入别名后回车"
                style={{ width: 200 }}
              />
              <Button size="small" icon={<PlusOutlined />} onClick={addAlias}>
                添加
              </Button>
            </Space>
          </Field>
          <Field label="一句话简介" hint="会进上下文摘要，写短一点">
            <Input
              aria-label="一句话简介"
              value={form.tagline}
              onChange={(e) => patch({ tagline: e.target.value })}
              placeholder="如：萧家天才，三年斗气停滞"
            />
          </Field>
          <Field label="钉住" hint="钉住的实体始终进入上下文编排，不依赖是否在本章出场">
            <Switch size="small" checked={form.pinned} onChange={(v) => patch({ pinned: v })} />
          </Field>
          <Field label="设定正文">
            <Input.TextArea
              aria-label="设定正文"
              value={form.content}
              onChange={(e) => patch({ content: e.target.value })}
              autoSize={{ minRows: 6, maxRows: 20 }}
              placeholder="外貌 / 性格 / 出身 / 能力 / 禁忌…"
            />
          </Field>

          {/* ---- 动态状态 ---- */}
          <Section
            title="动态状态"
            hint={`随剧情推进的当前处境。写第 N 章时只取"从第 N 章及之前起效"的最新一条。`}
            action={
              <Button size="small" icon={<PlusOutlined />} onClick={() => void addState()}>
                新增
              </Button>
            }
          >
            {states.length === 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                还没有状态记录。人物受伤、地点易主、物品转手都该记一条。
              </Typography.Text>
            ) : (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {states.map((s) => (
                  <div
                    key={s.id}
                    style={{
                      border: '1px solid var(--border-color, rgba(128,128,128,.2))',
                      borderRadius: 6,
                      padding: 8
                    }}
                  >
                    <Space size={4} style={{ width: '100%', marginBottom: 4 }}>
                      <Typography.Text style={{ fontSize: 11, flexShrink: 0 }}>起效自</Typography.Text>
                      <Select
                        size="small"
                        aria-label="状态生效章节"
                        value={s.chapterId}
                        onChange={(v) => void saveState(s, undefined, v)}
                        options={chapterOptions}
                        style={{ flex: 1, minWidth: 0 }}
                      />
                      <Button
                        size="small"
                        type="text"
                        danger
                        aria-label="删除状态"
                        icon={<DeleteOutlined />}
                        onClick={() => void deleteState(s.id)}
                      />
                    </Space>
                    <Input.TextArea
                      size="small"
                      aria-label="状态描述"
                      defaultValue={s.text}
                      onBlur={(e) => {
                        if (e.target.value !== s.text) void saveState(s, e.target.value)
                      }}
                      autoSize={{ minRows: 2, maxRows: 8 }}
                      placeholder="如：被废掉斗气，右手留下旧伤"
                    />
                  </div>
                ))}
              </Space>
            )}
          </Section>

          {/* ---- 关系 ---- */}
          <Section title="关系">
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              {myRelations.length === 0 ? (
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  还没有关系边
                </Typography.Text>
              ) : (
                myRelations.map((r) => (
                  <div
                    key={r.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
                  >
                    <Tag
                      color={ENTITY_KIND_META[
                        entities.find((e) => e.id === (r.fromId === entityId ? r.toId : r.fromId))
                          ?.kind ?? 'concept'
                      ].color}
                      style={{ fontSize: 11, marginInlineEnd: 0 }}
                    >
                      {r.fromId === entityId ? nameOf(r.toId) : nameOf(r.fromId)}
                    </Tag>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {r.bidirectional ? '⟷' : (r.fromId === entityId ? '→' : '←')} {r.label}
                    </Typography.Text>
                    <Button
                      size="small"
                      type="text"
                      danger
                      aria-label="删除关系"
                      icon={<DeleteOutlined />}
                      onClick={() => void deleteRelation(r.id)}
                      style={{ marginLeft: 'auto' }}
                    />
                  </div>
                ))
              )}
            </Space>
            <Space size={4} style={{ marginTop: 8, width: '100%' }}>
              <Select
                size="small"
                aria-label="关系对象"
                placeholder="对象"
                value={relTarget}
                onChange={setRelTarget}
                options={entities
                  .filter((e) => e.id !== entityId)
                  .map((e) => ({ label: e.name, value: e.id }))}
                style={{ flex: 1, minWidth: 0 }}
                showSearch
                optionFilterProp="label"
              />
              <Input
                size="small"
                aria-label="关系描述"
                value={relLabel}
                onChange={(e) => setRelLabel(e.target.value)}
                placeholder="关系"
                style={{ width: 84 }}
              />
              <Checkbox
                checked={relBidi}
                onChange={(e) => setRelBidi(e.target.checked)}
                style={{ fontSize: 11, whiteSpace: 'nowrap' }}
              >
                双向
              </Checkbox>
              <Button size="small" onClick={() => void addRelation()}>
                加
              </Button>
            </Space>
          </Section>

          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            当前章节：{chapterTitle || '未选择'}
          </Typography.Text>
        </Space>
      )}
    </Drawer>
  )
}

/* ------------------------------ 小组件 ------------------------------ */

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div style={{ marginBottom: 4 }}>
        <Typography.Text style={{ fontSize: 12, fontWeight: 500 }}>{label}</Typography.Text>
        {hint && (
          <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>
            {hint}
          </Typography.Text>
        )}
      </div>
      {children}
    </div>
  )
}

function Section({
  title,
  hint,
  action,
  children
}: {
  title: string
  hint?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div
      style={{
        borderTop: '1px solid var(--border-color, rgba(128,128,128,.15))',
        paddingTop: 10
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 6,
          flexWrap: 'wrap'
        }}
      >
        <Typography.Text style={{ fontSize: 12, fontWeight: 600 }}>{title}</Typography.Text>
        <div style={{ marginLeft: 'auto' }}>{action}</div>
      </div>
      {hint && (
        <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 6 }}>
          {hint}
        </Typography.Text>
      )}
      {children}
    </div>
  )
}
