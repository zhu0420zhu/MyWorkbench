/**
 * 雪碧图拆分（TypeScript 移植，零外部依赖）。
 *
 * 移植自 guiguiyan930-source/game-ui-design-workflow 的
 * scripts/split_sprite_sheet.py，使其可在 Electron 渲染进程内直接调用，
 * 无需 Python 运行时。算法保持一致：Alpha / 背景差分生成前景掩码 →
 * 连通域（并查集）检测独立元素 → 收紧并留白 → 逐元素切出透明 PNG。
 *
 * 仅依赖传入的 RGBA 像素数组，不触碰 DOM；画布导出由调用方完成。
 */

export type SplitMode = 'auto' | 'alpha' | 'background'

export interface SplitSettings {
  mode: SplitMode
  alphaThreshold: number
  backgroundTolerance: number
  connectGap: number
  minArea: number
  padding: number
  prefix: string
}

export interface SplitElement {
  id: string
  /** [x, y, width, height] 在原始雪碧图中的像素盒 */
  bbox: [number, number, number, number]
  dimensions: [number, number]
  /** 切出元素的 RGBA 像素（已留白、已按背景模式套用透明） */
  data: Uint8ClampedArray<ArrayBuffer>
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function defaultSplitSettings(): SplitSettings {
  return {
    mode: 'auto',
    alphaThreshold: 8,
    backgroundTolerance: 24,
    connectGap: 2,
    minArea: 64,
    padding: 4,
    prefix: 'element'
  }
}

function sampleBackground(rgba: Uint8ClampedArray, width: number, height: number): [number, number, number] {
  const stepX = Math.max(1, Math.floor(width / 128))
  const stepY = Math.max(1, Math.floor(height / 128))
  const r: number[] = []
  const g: number[] = []
  const b: number[] = []
  for (let x = 0; x < width; x += stepX) {
    r.push(rgba[(0 * width + x) * 4])
    g.push(rgba[(0 * width + x) * 4 + 1])
    b.push(rgba[(0 * width + x) * 4 + 2])
    r.push(rgba[((height - 1) * width + x) * 4])
    g.push(rgba[((height - 1) * width + x) * 4 + 1])
    b.push(rgba[((height - 1) * width + x) * 4 + 2])
  }
  for (let y = 0; y < height; y += stepY) {
    r.push(rgba[(y * width + 0) * 4])
    g.push(rgba[(y * width + 0) * 4 + 1])
    b.push(rgba[(y * width + 0) * 4 + 2])
    r.push(rgba[(y * width + (width - 1)) * 4])
    g.push(rgba[(y * width + (width - 1)) * 4 + 1])
    b.push(rgba[(y * width + (width - 1)) * 4 + 2])
  }
  const median = (arr: number[]): number => {
    const s = [...arr].sort((a, c) => a - c)
    return s[Math.floor(s.length / 2)]
  }
  return [median(r), median(g), median(b)]
}

function makeForegroundMask(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  settings: SplitSettings
): { mask: Uint8Array; mode: 'alpha' | 'background'; background: [number, number, number] | null } {
  const alpha = new Uint8Array(width * height)
  let alphaMin = 255
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3]
    alpha[i] = a
    if (a < alphaMin) alphaMin = a
  }
  let mode: 'alpha' | 'background' = settings.mode === 'background' ? 'background' : 'alpha'
  if (settings.mode === 'auto') mode = alphaMin < 255 ? 'alpha' : 'background'

  if (mode === 'alpha') {
    const mask = new Uint8Array(width * height)
    for (let i = 0; i < width * height; i++) mask[i] = alpha[i] > settings.alphaThreshold ? 255 : 0
    return { mask, mode, background: null }
  }

  const bg = sampleBackground(rgba, width, height)
  const mask = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const dr = Math.abs(rgba[i * 4] - bg[0])
    const dg = Math.abs(rgba[i * 4 + 1] - bg[1])
    const db = Math.abs(rgba[i * 4 + 2] - bg[2])
    const diff = Math.max(dr, dg, db)
    const visible = alpha[i] > settings.alphaThreshold
    mask[i] = diff > settings.backgroundTolerance && visible ? 255 : 0
  }
  return { mask, mode, background: bg }
}

/** 棋盘距离膨胀（最大滤波），用于弥合元素内细缝 */
function dilate(mask: Uint8Array, width: number, height: number, gap: number): Uint8Array {
  if (gap <= 0) return mask
  const out = new Uint8Array(width * height)
  const size = gap * 2 + 1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let hit = false
      for (let dy = -gap; dy <= gap && !hit; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -gap; dx <= gap; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= width) continue
          if (mask[ny * width + nx] === 255) {
            hit = true
            break
          }
        }
      }
      out[y * width + x] = hit ? 255 : 0
    }
  }
  void size
  return out
}

/** 连通域检测：逐行扫描、按重叠合并（并查集），返回按 [top,left] 排序的盒 */
function connectedBoxes(mask: Uint8Array, width: number, height: number, minArea: number): Array<[number, number, number, number]> {
  const parents: number[] = []
  const newLabel = (): number => {
    const label = parents.length
    parents.push(label)
    return label
  }
  const find = (label: number): number => {
    while (parents[label] !== label) {
      parents[label] = parents[parents[label]]
      label = parents[label]
    }
    return label
  }
  const union = (left: number, right: number): void => {
    const rl = find(left)
    const rr = find(right)
    if (rl !== rr) parents[rr] = rl
  }

  const runs: Array<[number, number, number, number]> = []
  let previous: Array<[number, number, number]> = []
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width
    const current: Array<[number, number, number]> = []
    let x = 0
    while (x < width) {
      while (x < width && mask[rowOffset + x] === 0) x++
      if (x >= width) break
      const start = x
      while (x < width && mask[rowOffset + x] !== 0) x++
      const end = x
      const overlaps = previous.filter(([ps, pe]) => ps < end && start < pe)
      const label = overlaps.length ? overlaps[0][2] : newLabel()
      for (let k = 1; k < overlaps.length; k++) union(label, overlaps[k][2])
      current.push([start, end, label])
      runs.push([y, start, end, label])
    }
    previous = current
  }

  const stats: Record<number, [number, number, number, number, number]> = {}
  for (const [y, start, end, label] of runs) {
    const root = find(label)
    if (!stats[root]) stats[root] = [start, y, end, y + 1, end - start]
    else {
      const item = stats[root]
      item[0] = Math.min(item[0], start)
      item[1] = Math.min(item[1], y)
      item[2] = Math.max(item[2], end)
      item[3] = Math.max(item[3], y + 1)
      item[4] += end - start
    }
  }

  return Object.values(stats)
    .filter((s) => s[4] >= minArea)
    .map((s) => [s[0], s[1], s[2], s[3]] as [number, number, number, number])
    .sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]))
}

function tightenAndPad(
  box: [number, number, number, number],
  mask: Uint8Array,
  width: number,
  height: number,
  padding: number
): [number, number, number, number] | null {
  const [bx, by, bx2, by2] = box
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = by; y < by2; y++) {
    for (let x = bx; x < bx2; x++) {
      if (mask[y * width + x] === 255) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return [
    Math.max(0, minX - padding),
    Math.max(0, minY - padding),
    Math.min(width, maxX + 1 + padding),
    Math.min(height, maxY + 1 + padding)
  ]
}

export function splitSpriteSheet(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  settings: SplitSettings,
  semanticNames?: string[]
): SplitElement[] {
  const { mask: originalMask, mode } = makeForegroundMask(rgba, width, height, settings)
  let detectionMask = originalMask
  if (settings.connectGap > 0) detectionMask = dilate(originalMask, width, height, settings.connectGap)

  const boxes = connectedBoxes(detectionMask, width, height, settings.minArea)
  if (semanticNames && semanticNames.length !== boxes.length) {
    throw new Error(`语义命名数量(${semanticNames.length}) 与检测到的元素数(${boxes.length}) 不一致`)
  }

  const items: SplitElement[] = []
  boxes.forEach((box, idx) => {
    const cropBox = tightenAndPad(box, originalMask, width, height, settings.padding)
    if (!cropBox) return
    const [cx, cy, cx2, cy2] = cropBox
    const cw = cx2 - cx
    const ch = cy2 - cy
    const data = new Uint8ClampedArray(cw * ch * 4)
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const sx = cx + x
        const sy = cy + y
        const si = (sy * width + sx) * 4
        const di = (y * cw + x) * 4
        data[di] = rgba[si]
        data[di + 1] = rgba[si + 1]
        data[di + 2] = rgba[si + 2]
        if (mode === 'background') data[di + 3] = originalMask[sy * width + sx]
        else data[di + 3] = rgba[si + 3]
      }
    }
    let id = `${settings.prefix}-${String(idx + 1).padStart(3, '0')}`
    if (semanticNames && semanticNames[idx]) {
      const name = semanticNames[idx]
      if (!ID_PATTERN.test(name)) throw new Error(`语义命名必须用 kebab-case：${name}`)
      id = name
    }
    if (items.some((it) => it.id === id)) throw new Error(`重复的元素 id：${id}`)
    items.push({ id, bbox: [cx, cy, cw, ch], dimensions: [cw, ch], data })
  })

  if (items.length === 0) throw new Error('未检测到任何雪碧图元素，请调整模式或阈值')
  return items
}
