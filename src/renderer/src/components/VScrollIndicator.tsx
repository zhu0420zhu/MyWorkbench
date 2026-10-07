import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 垂直移动条（自定义滚动指示条）。
 *
 * 覆盖在滚动容器右侧：拖动滑块 / 点击轨道跳转；滚轮与触摸滚动由容器原生处理，
 * 本组件只把 scrollTop 实时映射到滑块位置。内容未溢出时自动隐藏（含 pointer-events）。
 * 鼠标与触摸统一走 Pointer Events（滑块设 touch-action: none），桌面端 / 触屏均可用。
 *
 * 用法：容器外层套 position:relative 的包裹元素，把滚动元素（overflow-y:auto）
 * 通过 querySelector 传入 target。
 */
export default function VScrollIndicator({ target, inset = 4 }: { target: HTMLElement | null; inset?: number }) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [bar, setBar] = useState<{ h: number; y: number; visible: boolean }>({ h: 0, y: 0, visible: false })
  const dragRef = useRef<{ startY: number; startTop: number; range: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const measure = useCallback(() => {
    const el = target
    const track = trackRef.current
    if (!el || !track) return
    const trackH = track.clientHeight
    if (trackH <= 0) return
    const maxScroll = el.scrollHeight - el.clientHeight
    if (maxScroll <= 1) {
      setBar((b) => (b.visible ? { ...b, visible: false } : b))
      return
    }
    const ratio = el.clientHeight / el.scrollHeight
    const h = Math.max(36, Math.round(trackH * Math.min(1, ratio)))
    const y = Math.round(((trackH - h) * el.scrollTop) / maxScroll)
    setBar({ h, y, visible: true })
  }, [target])

  useEffect(() => {
    if (!target) return
    measure()
    // 容器与内容尺寸变化（分组展开收起、窗口缩放）都重新测量
    const ro = new ResizeObserver(() => measure())
    ro.observe(target)
    if (target.firstElementChild) ro.observe(target.firstElementChild)
    target.addEventListener('scroll', measure, { passive: true })
    return () => {
      ro.disconnect()
      target.removeEventListener('scroll', measure)
    }
  }, [target, measure])

  const onThumbPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    const el = target
    const track = trackRef.current
    if (!el || !track) return
    const maxScroll = el.scrollHeight - el.clientHeight
    const movable = track.clientHeight - bar.h
    if (movable <= 0 || maxScroll <= 0) return
    dragRef.current = { startY: e.clientY, startTop: el.scrollTop, range: maxScroll / movable }
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onThumbPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    const el = target
    if (!d || !el) return
    el.scrollTop = d.startTop + (e.clientY - d.startY) * d.range
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    dragRef.current = null
    setDragging(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  const onTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const el = target
    const track = trackRef.current
    if (!el || !track) return
    const rect = track.getBoundingClientRect()
    const maxScroll = el.scrollHeight - el.clientHeight
    const movable = track.clientHeight - bar.h
    if (movable <= 0 || maxScroll <= 0) return
    // 点击轨道：把滑块中心挪到点击处（对应内容位置就近跳转）
    const want = e.clientY - rect.top - bar.h / 2
    el.scrollTop = (want / movable) * maxScroll
  }

  return (
    <div
      ref={trackRef}
      className={`vscroll-track${bar.visible ? '' : ' is-hidden'}`}
      style={{ top: inset, bottom: inset }}
      onPointerDown={onTrackPointerDown}
      aria-hidden="true"
    >
      <div
        className={`vscroll-thumb${dragging ? ' is-drag' : ''}`}
        style={{ height: bar.h, transform: `translateY(${bar.y}px)` }}
        onPointerDown={onThumbPointerDown}
        onPointerMove={onThumbPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </div>
  )
}
