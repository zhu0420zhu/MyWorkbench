/**
 * 实体关系图（弹窗）
 *
 * 刻意不做力导向布局：几十个节点时力导向会一直抖，作者根本没法点。
 * 默认按环形排布（稳定、可预期），节点可拖，位置存在内存里；刷新后回到环形。
 * 位置不落盘是刻意的——布局是临时视图，不是数据，存下来只会让后来的布局越来越乱。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Empty, Modal, Space, Tag, Typography } from 'antd'
import type { EntityMeta, EntityRelation } from '@shared/types'
import { ENTITY_KIND_META } from '@shared/types'

interface RelationGraphProps {
  projectId: string
  entities: EntityMeta[]
  open: boolean
  onClose: () => void
  /** 点节点 → 打开该实体卡 */
  onOpenEntity: (entityId: string) => void
  /** 关系变化后通知外部刷新 */
  onChanged: () => void
}

const W = 820
const H = 480

interface Pt {
  x: number
  y: number
}

export default function RelationGraph({
  projectId,
  entities,
  open,
  onClose,
  onOpenEntity,
  onChanged
}: RelationGraphProps) {
  const [relations, setRelations] = useState<EntityRelation[]>([])
  const [pos, setPos] = useState<Record<string, Pt>>({})
  const [hover, setHover] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null)

  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void window.api.novel
      .listRelations(projectId)
      .then((r) => {
        if (aliveRef.current) setRelations(r)
      })
      .catch(() => undefined)
  }, [open, projectId])

  /** 环形默认布局：半径随节点数微调，避免十几个点挤成一团 */
  const layout = useMemo(() => {
    const n = entities.length
    if (!n) return {}
    const cx = W / 2
    const cy = H / 2
    const r = Math.min(W, H) / 2 - Math.max(50, 90 - n * 2)
    const out: Record<string, Pt> = {}
    entities.forEach((e, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2
      out[e.id] = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) * 0.82 }
    })
    return out
  }, [entities])

  const pointOf = useCallback(
    (id: string): Pt => pos[id] ?? layout[id] ?? { x: W / 2, y: H / 2 },
    [pos, layout]
  )

  /** 屏幕坐标 → SVG 坐标（SVG 是等比缩放的，需要按实际渲染尺寸换算） */
  const toSvg = useCallback((clientX: number, clientY: number): Pt => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    return {
      x: ((clientX - rect.left) / rect.width) * W,
      y: ((clientY - rect.top) / rect.height) * H
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const p = toSvg(ev.clientX, ev.clientY)
      const nx = Math.max(60, Math.min(W - 60, p.x + d.dx))
      const ny = Math.max(30, Math.min(H - 30, p.y + d.dy))
      setPos((prev) => ({ ...prev, [d.id]: { x: nx, y: ny } }))
    }
    const onUp = () => {
      dragRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [open, toSvg])

  const onNodeDown = useCallback(
    (id: string) => (ev: React.PointerEvent) => {
      const p = toSvg(ev.clientX, ev.clientY)
      const cur = pointOf(id)
      dragRef.current = { id, dx: cur.x - p.x, dy: cur.y - p.y }
    },
    [pointOf, toSvg]
  )

  const deleteRelation = useCallback(
    async (id: string) => {
      const left = await window.api.novel.removeRelation(projectId, id)
      if (aliveRef.current) setRelations(left)
      onChanged()
    },
    [projectId, onChanged]
  )

  const nameOf = useCallback(
    (id: string) => entities.find((e) => e.id === id)?.name ?? '（已删除）',
    [entities]
  )

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={
        <Space>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            拖动可调整位置；点节点打开设定卡
          </Typography.Text>
          <Button onClick={() => setPos({})}>重置布局</Button>
          <Button type="primary" onClick={onClose}>
            关闭
          </Button>
        </Space>
      }
      width={880}
      title="实体关系图"
      destroyOnHidden
    >
      <div
        style={{
          border: '1px solid var(--border-color, rgba(128,128,128,.2))',
          borderRadius: 8,
          overflow: 'hidden',
          background: 'var(--graph-bg, rgba(128,128,128,.04))'
        }}
      >
        {entities.length === 0 ? (
          <div style={{ height: H, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={<span style={{ fontSize: 12 }}>还没有设定卡</span>}
            />
          </div>
        ) : (
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            style={{ width: '100%', height: H, display: 'block', touchAction: 'none' }}
          >
            <defs>
              <marker
                id="rg-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(128,128,128,.7)" />
              </marker>
            </defs>

            {/* 边先画，避免盖住节点 */}
            {relations.map((r) => {
              const a = pointOf(r.fromId)
              const b = pointOf(r.toId)
              const mx = (a.x + b.x) / 2
              const my = (a.y + b.y) / 2
              return (
                <g key={r.id}>
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke="rgba(128,128,128,.45)"
                    strokeWidth={hover === r.id ? 2 : 1}
                    markerEnd={r.bidirectional ? undefined : 'url(#rg-arrow)'}
                    onPointerEnter={() => setHover(r.id)}
                    onPointerLeave={() => setHover((h) => (h === r.id ? null : h))}
                    style={{ cursor: 'pointer' }}
                    onClick={() => void deleteRelation(r.id)}
                  />
                  <text
                    x={mx}
                    y={my - 3}
                    textAnchor="middle"
                    fontSize={11}
                    fill="var(--text-color, currentColor)"
                    opacity={0.75}
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {r.label}
                  </text>
                </g>
              )
            })}

            {entities.map((e) => {
              const p = pointOf(e.id)
              const color = ENTITY_KIND_META[e.kind].color
              return (
                <g
                  key={e.id}
                  transform={`translate(${p.x} ${p.y})`}
                  style={{ cursor: 'pointer' }}
                  onPointerDown={onNodeDown(e.id)}
                  onClick={() => onOpenEntity(e.id)}
                >
                  <circle r={22} fill={color} opacity={hover === e.id ? 0.95 : 0.8} />
                  <text
                    textAnchor="middle"
                    y={4}
                    fontSize={12}
                    fill="#fff"
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {e.name.slice(0, 4)}
                  </text>
                  <text
                    textAnchor="middle"
                    y={38}
                    fontSize={11}
                    fill="var(--text-color, currentColor)"
                    opacity={0.7}
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {e.name.length > 6 ? `${e.name.slice(0, 6)}…` : e.name}
                  </text>
                </g>
              )
            })}
          </svg>
        )}
      </div>

      {relations.length > 0 && (
        <div style={{ marginTop: 10, maxHeight: 120, overflowY: 'auto' }}>
          <Space size={6} wrap>
            {relations.map((r) => (
              <Tag
                key={r.id}
                closable
                onClose={() => void deleteRelation(r.id)}
                style={{ fontSize: 11 }}
              >
                {nameOf(r.fromId)} {r.bidirectional ? '⟷' : '→'} {nameOf(r.toId)} · {r.label}
              </Tag>
            ))}
          </Space>
        </div>
      )}

      {relations.length > 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 6 }}>
          点线条或标签上的 × 删除关系
        </Typography.Text>
      )}
    </Modal>
  )
}
