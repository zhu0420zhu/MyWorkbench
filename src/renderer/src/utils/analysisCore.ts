/* 灵墨工作台 · 数据分析核心（纯规则逻辑，无 DOM / 无 electron，可无头测试）
 *
 * 职责：
 * 1. computeStats —— 逐列统计摘要（缺失率 / 极值 / 均值 / 中位数 / 标准差）；
 * 2. buildConclusions —— 纯规则结论生成（不调 AI）：概览 / Top / 极值 / 趋势 / 缺失；
 * 3. 导出文本构建 —— Markdown 报告、统计 CSV（PNG 走图表实例 getDataURL，不在本模块）。
 *
 * 数值语义与 tablesCore / 渲染层一致：number、boolean（true→1/false→0）、
 * 非空且可转数字的字符串计为数值；null/undefined/空串计为缺失。
 */
import type { ColumnStats, ConclusionItem } from '../../../shared/types'

type RawValue = string | number | boolean | null | undefined

/** 与 tablesCore.isNumericValue / 渲染层 isFinite(Number(v)) 对齐的数值判定 */
function toNumber(v: RawValue): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** 缺失判定：null / undefined / 空串 */
function isMissing(v: RawValue): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
}

export function computeStats(rows: Array<Record<string, RawValue>>, columns: string[]): ColumnStats[] {
  const stats: ColumnStats[] = []
  for (const col of columns) {
    let count = 0
    let missing = 0
    let sum = 0
    let min = Infinity
    let max = -Infinity
    const nums: number[] = []
    for (const row of rows) {
      const v = row[col]
      if (isMissing(v)) {
        missing++
        continue
      }
      count++
      const n = toNumber(v)
      if (n !== null) {
        sum += n
        if (n < min) min = n
        if (n > max) max = n
        nums.push(n)
      }
    }
    const numeric = nums.length > 0
    const mean = numeric ? sum / nums.length : 0
    let median = 0
    let std = 0
    if (numeric) {
      const sorted = nums.slice().sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
      const variance = nums.reduce((acc, n) => acc + (n - mean) ** 2, 0) / nums.length
      std = Math.sqrt(variance)
    }
    stats.push({
      column: col,
      numeric,
      count,
      missing,
      missingRate: rows.length > 0 ? Number((missing / rows.length).toFixed(4)) : 0,
      min: numeric ? min : 0,
      max: numeric ? max : 0,
      mean: Number(mean.toFixed(4)),
      median: Number(median.toFixed(4)),
      std: Number(std.toFixed(4))
    })
  }
  return stats
}

/* ---------- 规则化结论 ---------- */

export interface ConclusionInput {
  stats: ColumnStats[]
  totalRows: number
  xCol?: string | null
  yCol?: string | null
  aggregate?: 'sum' | 'avg' | 'count' | 'raw' | string
  /** 聚合后的图表数据（已截断的 Top-N 亦可），用于 Top 占比 / 趋势判断 */
  chartData?: Array<{ name: string; value: number }>
  /** 多维分析输入：随黄色框配置联动 */
  filters?: Array<{ column: string; op: string; value: string }>
  colorBy?: string | null
  sortDir?: 'desc' | 'asc' | 'none'
  catLimit?: number
  /** 按 colorBy 分组后的每组数据：用于多维度分组对比结论 */
  groupedData?: Array<{ group: string; points: Array<{ name: string; value: number }> }>
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return Number.isInteger(n) ? String(n) : Number(n.toFixed(2)).toString()
}

export function isDateLike(name: string): boolean {
  return /(年|月|日|日期|date|time|时间)/i.test(name) || /^\d{4}[-/.年]\d{1,2}/.test(name)
}

function meanOf(pts: Array<{ value: number }>): number {
  return pts.length === 0 ? 0 : pts.reduce((s, p) => s + p.value, 0) / pts.length
}

/**
 * 纯规则结论（随配置联动、多维思考）。
 * 顺序：概览 → Top → 极值/离散 → 趋势 → 分组对比 → 缺失。
 * 全部确定性规则，无 AI 调用，任何输入都不会抛错。
 * id 按「kind + 同组出现序号」生成（如 top / extreme-1 / extreme-2），重算后保持稳定，
 * 供结论区的删除/编辑/隐藏状态可靠定位。
 */
export function buildConclusions(input: ConclusionInput): ConclusionItem[] {
  const { stats, totalRows, xCol, yCol, aggregate, chartData, filters, colorBy, sortDir, groupedData } = input
  const items: ConclusionItem[] = []
  const seen: Record<string, number> = {}
  const push = (kind: ConclusionItem['kind'], text: string): void => {
    seen[kind] = (seen[kind] ?? 0) + 1
    items.push({ kind, text, id: seen[kind] === 1 ? kind : `${kind}-${seen[kind]}` })
  }
  const aggLabel =
    aggregate === 'avg' ? '均值' : aggregate === 'count' ? '数量' : aggregate === 'raw' ? '数值' : '总和'
  const top = chartData && chartData.length > 0 ? chartData[0] : null

  if (totalRows > 0) {
    const parts = [`共分析 ${totalRows} 行数据`]
    if (xCol) parts.push(`按「${xCol}」${colorBy ? `在「${colorBy}」分组下` : ''}分组`)
    if (filters && filters.length > 0) parts.push(`已应用 ${filters.length} 个筛选条件`)
    if (chartData && chartData.length > 0) parts.push(`共 ${chartData.length} 个类目`)
    if (sortDir && sortDir !== 'desc') parts.push(sortDir === 'asc' ? '按值升序排列' : '按原序排列')
    push('overview', parts.join('，') + '。')
  }

  if (top && chartData) {
    const total = chartData.reduce((s, d) => s + d.value, 0)
    const pct = total > 0 ? ((top.value / total) * 100).toFixed(1) : '0.0'
    push(
      'top',
      `${xCol ?? '类目'}中${aggLabel}最高的是「${top.name}」（${aggLabel} ${fmt(top.value)}，占 Top 类目合计的 ${pct}%）`
    )
  }

  const yStat = stats.find((s) => s.column === yCol && s.numeric)
  if (yStat && yStat.count > 0 && yStat.min !== yStat.max) {
    push(
      'extreme',
      `「${yStat.column}」取值区间 ${fmt(yStat.min)} ~ ${fmt(yStat.max)}，均值 ${fmt(yStat.mean)}，中位数 ${fmt(yStat.median)}`
    )
  }
  if (yStat && yStat.count > 1 && yStat.std > 0) {
    const range = yStat.max - yStat.min
    if (range > 0 && yStat.std / range > 0.4) {
      push(
        'extreme',
        `「${yStat.column}」分布较分散（标准差 ${fmt(yStat.std)}，约为值域的 ${((yStat.std / range) * 100).toFixed(0)}%），个别值可能显著偏离整体`
      )
    }
  }

  if (chartData && chartData.length >= 3 && xCol && isDateLike(xCol)) {
    const pts = chartData.slice(0, 60)
    const seg = Math.max(1, Math.floor(pts.length * 0.3))
    const head = pts.slice(0, seg)
    const tail = pts.slice(Math.max(0, pts.length - seg))
    const headAvg = meanOf(head)
    const tailAvg = meanOf(tail)
    const dir = tailAvg > headAvg * 1.05 ? '上升' : tailAvg < headAvg * 0.95 ? '下降' : '平稳'
    push(
      'trend',
      dir === '平稳'
        ? `按时间顺序整体趋势平稳（首段均值 ${fmt(headAvg)} ≈ 末段均值 ${fmt(tailAvg)}）`
        : `按时间顺序整体呈${dir}趋势（首段均值 ${fmt(headAvg)} → 末段均值 ${fmt(tailAvg)}）`
    )
  }

  // 多维度：按 colorBy 分组对比（各组 Top 及其在整体中的占比）
  if (groupedData && groupedData.length > 1) {
    const overall = chartData ?? []
    const overallTotal = overall.reduce((s, d) => s + d.value, 0)
    for (const g of groupedData.slice(0, 3)) {
      if (g.points.length === 0) continue
      const sorted = [...g.points].sort((a, b) => b.value - a.value)
      const gTop = sorted[0]
      const gTotal = g.points.reduce((s, p) => s + p.value, 0)
      const share = overallTotal > 0 ? ((gTotal / overallTotal) * 100).toFixed(1) : '0.0'
      push(
        'overview',
        `分组「${g.group}」共 ${g.points.length} 个类目，${aggLabel}合计 ${fmt(gTotal)}（占整体 ${share}%），其中「${gTop.name}」最高（${fmt(gTop.value)}）`
      )
    }
  }

  const missingCols = stats.filter((s) => s.missingRate > 0.2)
  if (missingCols.length > 0) {
    const worst = missingCols.slice().sort((a, b) => b.missingRate - a.missingRate)[0]
    push('missing', `「${worst.column}」缺失率 ${(worst.missingRate * 100).toFixed(0)}%（${worst.missing}/${totalRows} 行），建议补全或关注`)
  } else if (stats.length > 0 && stats.every((s) => s.missing === 0)) {
    push('overview', '各列数据完整，无缺失值')
  }

  return items
}

/* ---------- 导出文本构建 ---------- */

export interface MarkdownReportInput {
  title: string
  totalRows: number
  xCol?: string | null
  yCol?: string | null
  aggregate?: string
  stats: ColumnStats[]
  conclusions: ConclusionItem[]
  chartData?: Array<{ name: string; value: number }>
}

export function buildMarkdownReport(input: MarkdownReportInput): string {
  const { title, totalRows, xCol, yCol, aggregate, stats, conclusions, chartData } = input
  const lines: string[] = []
  lines.push(`# ${title}`)
  lines.push('')
  lines.push(`- 数据量：${totalRows} 行`)
  if (xCol) lines.push(`- X 轴：${xCol}`)
  if (yCol) lines.push(`- Y 轴：${yCol}`)
  if (aggregate) lines.push(`- 聚合：${aggregate}`)
  lines.push('')
  lines.push('## 分析结论')
  lines.push('')
  if (conclusions.length === 0) {
    lines.push('（无结论）')
  } else {
    for (const c of conclusions) lines.push(`- ${c.text}`)
  }
  lines.push('')
  lines.push('## 列统计摘要')
  lines.push('')
  lines.push('| 列 | 数值列 | 有效值 | 缺失 | 缺失率 | 最小值 | 最大值 | 均值 | 中位数 | 标准差 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const s of stats) {
    lines.push(
      `| ${s.column} | ${s.numeric ? '是' : '否'} | ${s.count} | ${s.missing} | ${(s.missingRate * 100).toFixed(1)}% | ${fmt(s.min)} | ${fmt(s.max)} | ${fmt(s.mean)} | ${fmt(s.median)} | ${fmt(s.std)} |`
    )
  }
  if (chartData && chartData.length > 0) {
    lines.push('')
    lines.push('## Top 类目')
    lines.push('')
    lines.push('| 类目 | 值 |')
    lines.push('| --- | --- |')
    for (const d of chartData.slice(0, 100)) lines.push(`| ${d.name} | ${fmt(d.value)} |`)
  }
  lines.push('')
  return lines.join('\n')
}

export function buildStatsCsv(stats: ColumnStats[]): string {
  const header = 'column,numeric,count,missing,missingRate,min,max,mean,median,std'
  const rows = stats.map((s) =>
    [
      s.column,
      s.numeric ? 1 : 0,
      s.count,
      s.missing,
      s.missingRate,
      s.min,
      s.max,
      s.mean,
      s.median,
      s.std
    ].join(',')
  )
  return [header, ...rows].join('\n')
}
