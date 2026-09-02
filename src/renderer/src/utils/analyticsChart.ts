/* 灵墨工作台 · 图表数据模型构建（纯函数，无 DOM / 无 electron，可无头测试）
 *
 * 把「原始行（CSV）」或「已聚合分组（数据库表）」统一成 ECharts 渲染层消费的 ChartModel：
 *   { categories: string[]; series: { name: string; data: number[] }[]; isGrouped: boolean }
 *
 * 支持的多维维度（与黄色框配置一一对应）：
 *  - filters：行级筛选（仅 CSV 模式在渲染层过滤；数据库表模式走 SQL WHERE）
 *  - colorBy：第三维分组 → 多 series（仅 CSV 模式，需原始行）
 *  - sortDir：类目按值升/降/原序
 *  - dateGranularity：X 轴为日期列时按 年/月/周/日 重新分桶（仅 CSV 模式）
 *  - catLimit：类目上限（高基数截断，防 ECharts 卡死）
 */
import type { AggregateGroup } from '../../../shared/types'

export type Aggregate = 'raw' | 'sum' | 'avg' | 'count'
export type SortDir = 'desc' | 'asc' | 'none'
export type DateGranularity = 'auto' | 'year' | 'month' | 'week' | 'day'

export type RawValue = string | number | boolean | null | undefined

/** CSV 模式筛选条件（按列名，渲染层过滤） */
export interface CsvFilter {
  column: string
  op: 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'isMissing'
  value: string
}

export interface ChartModel {
  categories: string[]
  series: { name: string; data: number[] }[]
  isGrouped: boolean
}

function toNum(v: RawValue): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function isMissing(v: RawValue): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
}

function passCsvFilter(v: RawValue, f: CsvFilter): boolean {
  if (f.op === 'isMissing') return !isMissing(v)
  const s = v == null ? '' : String(v)
  switch (f.op) {
    case 'eq':
      return s === f.value
    case 'neq':
      return s !== f.value
    case 'contains':
      return s.includes(f.value)
    case 'gt': {
      const n = toNum(v)
      return n !== null && n > Number(f.value)
    }
    case 'gte': {
      const n = toNum(v)
      return n !== null && n >= Number(f.value)
    }
    case 'lt': {
      const n = toNum(v)
      return n !== null && n < Number(f.value)
    }
    case 'lte': {
      const n = toNum(v)
      return n !== null && n <= Number(f.value)
    }
    default:
      return true
  }
}

function passCsvFilters(row: Record<string, RawValue>, filters: CsvFilter[]): boolean {
  for (const f of filters) {
    if (!passCsvFilter(row[f.column], f)) return false
  }
  return true
}

/** 日期分桶：把 X 轴原始值按粒度归并（仅日期类列有意义） */
export function bucketDate(raw: string, gran: DateGranularity): string {
  const m = raw.trim().match(/^(\d{4})[-/.年](\d{1,2})?[-/.月]?(\d{1,2})?/)
  if (!m) return raw
  const y = m[1]
  const mo = m[2] ? m[2].padStart(2, '0') : '01'
  const d = m[3] ? m[3].padStart(2, '0') : '01'
  switch (gran) {
    case 'year':
      return y
    case 'month':
      return `${y}-${mo}`
    case 'day':
      return `${y}-${mo}-${d}`
    case 'week':
      // 以所在周的周一为标签（ISO 近似）
      try {
        const dt = new Date(`${y}-${mo}-${d}T00:00:00`)
        const day = (dt.getDay() + 6) % 7 // 周一=0
        const monday = new Date(dt)
        monday.setDate(dt.getDate() - day)
        const yy = monday.getFullYear()
        const mm = String(monday.getMonth() + 1).padStart(2, '0')
        const dd = String(monday.getDate()).padStart(2, '0')
        return `${yy}-${mm}-${dd}`
      } catch {
        return raw
      }
    default:
      return raw
  }
}

export function isDateLike(name: string): boolean {
  return /(年|月|日|日期|date|time|时间)/i.test(name) || /^\d{4}[-/.年]\d{1,2}/.test(name)
}

interface Acc {
  sum: number
  count: number
}

function aggValue(e: Acc, agg: Aggregate): number {
  if (agg === 'count') return e.count
  if (agg === 'sum') return e.sum
  if (agg === 'avg') return e.count > 0 ? e.sum / e.count : 0
  return e.sum
}

/** CSV 模式：从原始行构建多维图表模型 */
export function buildCsvChartModel(opts: {
  rows: Array<Record<string, RawValue>>
  xCol: string
  yCol: string | null
  agg: Aggregate
  colorBy: string | null
  sortDir: SortDir
  catLimit: number
  dateGranularity: DateGranularity
  filters: CsvFilter[]
}): ChartModel {
  const { rows, xCol, yCol, agg, colorBy, sortDir, catLimit, dateGranularity, filters } = opts
  // raw 模式无聚合：直接铺点（colorBy 在 raw 下退化为单序列，保留 X/Y 原始序列）
  if (agg === 'raw') {
    const cats: string[] = []
    const perGroup = new Map<string, number[]>()
    for (const row of rows) {
      if (!passCsvFilters(row, filters)) continue
      const x = String(row[xCol] ?? '')
      const y = yCol ? toNum(row[yCol]) : null
      if (y === null) continue
      if (!cats.includes(x)) cats.push(x)
      const g = colorBy ? String(row[colorBy] ?? '') : '__ALL__'
      const arr = perGroup.get(g) ?? []
      arr.push(y)
      perGroup.set(g, arr)
    }
    const series = [...perGroup.entries()].map(([name, data]) => ({ name, data: data.slice(0, cats.length) }))
    return { categories: cats, series, isGrouped: colorBy !== null && perGroup.size > 1 }
  }

  const grouped = new Map<string, Map<string, Acc>>()
  const allX = new Map<string, Acc>()
  const insertOrder: string[] = []
  for (const row of rows) {
    if (!passCsvFilters(row, filters)) continue
    let xRaw = String(row[xCol] ?? '')
    if (isDateLike(xCol) && dateGranularity !== 'auto') xRaw = bucketDate(xRaw, dateGranularity)
    if (!insertOrder.includes(xRaw)) insertOrder.push(xRaw)
    const g = colorBy ? String(row[colorBy] ?? '') : '__ALL__'
    const gMap = grouped.get(g) ?? new Map<string, Acc>()
    const xAcc = gMap.get(xRaw) ?? { sum: 0, count: 0 }
    const allAcc = allX.get(xRaw) ?? { sum: 0, count: 0 }
    if (agg === 'count') {
      xAcc.count++
      allAcc.count++
    } else {
      const y = yCol ? toNum(row[yCol]) : null
      if (y === null) continue
      xAcc.sum += y
      xAcc.count++
      allAcc.sum += y
      allAcc.count++
    }
    gMap.set(xRaw, xAcc)
    grouped.set(g, gMap)
    allX.set(xRaw, allAcc)
  }

  // 类目排序
  let categories = [...insertOrder]
  if (sortDir === 'desc' || sortDir === 'asc') {
    categories.sort((a, b) => {
      const va = aggValue(allX.get(a) ?? { sum: 0, count: 0 }, agg)
      const vb = aggValue(allX.get(b) ?? { sum: 0, count: 0 }, agg)
      return sortDir === 'desc' ? vb - va : va - vb
    })
  } else {
    // none：非日期保持插入序；日期类按字典序（即时间序）更直观
    if (isDateLike(xCol)) categories.sort()
  }

  // 类目上限截断
  if (categories.length > catLimit) {
    const kept = categories.slice(0, catLimit)
    categories = kept
  }

  // 构建 series（按分组名排序，保证图例稳定）
  const groupNames = [...grouped.keys()].sort()
  const series = groupNames.map((g) => {
    const gMap = grouped.get(g)!
    const data = categories.map((c) => {
      const e = gMap.get(c)
      return e ? Number(aggValue(e, agg).toFixed(4)) : 0
    })
    return { name: g === '__ALL__' ? '数值' : g, data }
  })

  return { categories, series, isGrouped: colorBy !== null && groupNames.length > 1 }
}

/** 数据库表模式：从 SQL 聚合分组构建单序列模型（colorBy/日期分桶在表模式由 SQL 处理或禁用） */
export function chartModelFromGroups(groups: AggregateGroup[], sortDir: SortDir, catLimit: number): ChartModel {
  let pts = groups.map((g) => ({ name: g.name, value: g.value }))
  if (sortDir === 'asc') pts = pts.sort((a, b) => a.value - b.value)
  else if (sortDir === 'desc') pts = pts.sort((a, b) => b.value - a.value)

  if (pts.length > catLimit) {
    const kept = pts.slice(0, catLimit)
    const restSum = pts.slice(catLimit).reduce((s, p) => s + p.value, 0)
    if (restSum !== 0) kept.push({ name: `其他 (${pts.length - catLimit})`, value: Number(restSum.toFixed(4)) })
    pts = kept
  }
  return {
    categories: pts.map((p) => p.name),
    series: [{ name: '数值', data: pts.map((p) => p.value) }],
    isGrouped: false
  }
}
