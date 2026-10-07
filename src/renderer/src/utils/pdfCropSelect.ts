/**
 * 裁剪框选的纯几何换算（可无头测试）。
 *
 * 约定：
 *   - 框选以**百分比**表示（相对预览图左上角），与预览图的实际像素尺寸无关；
 *   - 边距以**当前单位**（mm 或 pt）表示，与面板的数值输入框一致；
 *   - 页面尺寸以 pt 表示（pdf-lib 的 getSize()）。
 *
 * 归一化规则：
 *   - 反向拖拽（右下 → 左上）与正向拖拽结果一致（先取 min/max）；
 *   - 拖到预览图外按边界截断；
 *   - 保留区小于最小可裁剪边长时，以选框中心为基准扩到最小尺寸。
 */

export interface MarginSet {
  top: number
  right: number
  bottom: number
  left: number
}

/** 保留区最小边长（pt）：更小的 CropBox 在 PDF 里没有意义 */
export const MIN_CROP_PT = 10

export function unitToPt(v: number, unit: 'mm' | 'pt'): number {
  return unit === 'mm' ? (v * 72) / 25.4 : v
}

export function ptToUnit(v: number, unit: 'mm' | 'pt'): number {
  const raw = unit === 'mm' ? (v * 25.4) / 72 : v
  return Math.round(raw * 10) / 10
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

/** 选框（百分比）→ 四边边距（当前单位） */
export function selectionToMargins(opts: {
  x0p: number
  y0p: number
  x1p: number
  y1p: number
  pageW: number
  pageH: number
  unit: 'mm' | 'pt'
}): MarginSet {
  const { pageW, pageH, unit } = opts
  let left = (Math.min(opts.x0p, opts.x1p) / 100) * pageW
  let right = pageW - (Math.max(opts.x0p, opts.x1p) / 100) * pageW
  let top = (Math.min(opts.y0p, opts.y1p) / 100) * pageH
  let bottom = pageH - (Math.max(opts.y0p, opts.y1p) / 100) * pageH
  left = clamp(left, 0, pageW)
  right = clamp(right, 0, pageW)
  top = clamp(top, 0, pageH)
  bottom = clamp(bottom, 0, pageH)
  if (pageW - left - right < MIN_CROP_PT) {
    const c = (left + (pageW - right)) / 2
    left = clamp(c - MIN_CROP_PT / 2, 0, pageW - MIN_CROP_PT)
    right = pageW - left - MIN_CROP_PT
  }
  if (pageH - top - bottom < MIN_CROP_PT) {
    const c = (top + (pageH - bottom)) / 2
    top = clamp(c - MIN_CROP_PT / 2, 0, pageH - MIN_CROP_PT)
    bottom = pageH - top - MIN_CROP_PT
  }
  return {
    top: ptToUnit(top, unit),
    right: ptToUnit(right, unit),
    bottom: ptToUnit(bottom, unit),
    left: ptToUnit(left, unit)
  }
}

/** 四边边距（当前单位）→ 选框（百分比），用于「改数值 → 选框同步移动」 */
export function marginsToSelection(opts: {
  margins: MarginSet
  pageW: number
  pageH: number
  unit: 'mm' | 'pt'
}): { left: number; top: number; width: number; height: number } {
  const { margins, pageW, pageH, unit } = opts
  const l = clamp((unitToPt(margins.left, unit) / pageW) * 100, 0, 100)
  const r = clamp((unitToPt(margins.right, unit) / pageW) * 100, 0, 100)
  const t = clamp((unitToPt(margins.top, unit) / pageH) * 100, 0, 100)
  const b = clamp((unitToPt(margins.bottom, unit) / pageH) * 100, 0, 100)
  return { left: l, top: t, width: Math.max(0, 100 - l - r), height: Math.max(0, 100 - t - b) }
}

/**
 * 把边距夹到「合法且可裁剪」的范围（导出前用）。
 * 例如用户手输的边距超过页面尺寸时，保证产出仍有 ≥ MIN_CROP_PT 的保留区。
 */
export function clampMarginsPt(
  margins: MarginSet,
  pageW: number,
  pageH: number,
  unit: 'mm' | 'pt'
): { l: number; r: number; t: number; b: number } {
  let l = clamp(unitToPt(margins.left, unit), 0, pageW)
  let r = clamp(unitToPt(margins.right, unit), 0, pageW)
  let t = clamp(unitToPt(margins.top, unit), 0, pageH)
  let b = clamp(unitToPt(margins.bottom, unit), 0, pageH)
  if (pageW - l - r < MIN_CROP_PT) {
    const over = MIN_CROP_PT - (pageW - l - r)
    const total = l + r || 1
    l = clamp(l - (over * l) / total, 0, pageW)
    r = clamp(pageW - MIN_CROP_PT - l, 0, pageW)
  }
  if (pageH - t - b < MIN_CROP_PT) {
    const over = MIN_CROP_PT - (pageH - t - b)
    const total = t + b || 1
    t = clamp(t - (over * t) / total, 0, pageH)
    b = clamp(pageH - MIN_CROP_PT - t, 0, pageH)
  }
  return { l, r, t, b }
}
