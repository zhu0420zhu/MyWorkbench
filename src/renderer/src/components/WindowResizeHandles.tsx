import { useCallback, useEffect, useState } from 'react'
import type { WindowResizeEdge } from '../../../preload/index.d'

/**
 * 无边框窗口的八向缩放热区。
 *
 * 系统原生边框被 frame:false 去掉后，窗口无法拖拽边缘改变大小，这里用 8 个
 * 6px 的透明热区补回：mousedown 通知主进程记录起点，之后每次 mousemove 由主进程
 * 依据光标屏幕坐标重新计算 bounds（用 send 而非 invoke，避免每次移动都等 Promise）。
 *
 * 最大化 / 全屏时窗口不可缩放，热区整体不渲染，避免遮挡标题栏与页面交互。
 */

const EDGES: WindowResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

const CURSOR: Record<WindowResizeEdge, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize'
}

/** 热区布局：边=6px 贴边，角=14px 见方且压在边的上层 */
function styleFor(edge: WindowResizeEdge): React.CSSProperties {
  const T = 6
  const C = 14
  const isCorner = edge.length === 2
  const size = isCorner ? C : T
  const base: React.CSSProperties = { position: 'fixed', zIndex: 2147483000 }
  const vertical = edge.includes('n') ? { top: 0, height: size } : edge.includes('s') ? { bottom: 0, height: size } : {}
  const horizontal = edge.includes('w') ? { left: 0, width: size } : edge.includes('e') ? { right: 0, width: size } : {}
  return { ...base, ...vertical, ...horizontal }
}

export default function WindowResizeHandles() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let alive = true
    const off = window.api.windowApi.onMaximizedChange((m) => {
      if (alive) setMaximized(m)
    })
    void window.api.windowApi.isMaximized().then((m) => {
      if (alive) setMaximized(m)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  const begin = useCallback((edge: WindowResizeEdge) => {
    window.api.windowApi.resizeBegin(edge)
    // 高频移动用 passive 监听，避免阻塞滚动/输入
    const onMove = (): void => window.api.windowApi.resizeMove()
    const onUp = (): void => {
      window.api.windowApi.resizeEnd()
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('blur', onUp)
    }
    window.addEventListener('mousemove', onMove, { passive: true })
    window.addEventListener('mouseup', onUp)
    // 拖到窗口外松手时 mousemove 仍在，但主进程可能收不到 mouseup
    window.addEventListener('blur', onUp)
  }, [])

  if (maximized) return null

  return (
    <>
      {EDGES.map((edge) => (
        <div
          key={edge}
          className="win-resize-handle"
          style={{ ...styleFor(edge), cursor: CURSOR[edge] }}
          onMouseDown={(e) => {
            if (e.button !== 0) return
            e.preventDefault()
            begin(edge)
          }}
        />
      ))}
    </>
  )
}
