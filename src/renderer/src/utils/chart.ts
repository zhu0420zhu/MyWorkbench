/* 灵墨工作台 · 图表数据截断工具
 * 导入数据后，若 X 轴类目基数过高（如每行一个唯一值），
 * ECharts 会强行渲染上万根柱 / 上万个坐标轴标签，导致主线程卡死。
 * 此处在聚合后对类目数做上限截断，多余的合并为「其他」，保证图表始终可渲染。
 */

export interface ChartPoint {
  name: string
  value: number
}

/** 类目数上限：超过则保留 Top-N 并合并剩余为「其他」 */
export const MAX_CHART_CATEGORIES = 60

/**
 * 截断图表数据。
 * @param data    聚合后的 {name, value} 列表
 * @param max     类目上限
 * @param aggregateRest 是否把被截断的项求和合并为「其他」；
 *                      原始（raw）模式下语义不符，传 false 仅取 Top-N。
 */
export function capChartData(data: ChartPoint[], max = MAX_CHART_CATEGORIES, aggregateRest = true): ChartPoint[] {
  if (data.length <= max) return data
  const sorted = [...data].sort((a, b) => b.value - a.value)
  const top = sorted.slice(0, max)
  if (!aggregateRest) return top
  const rest = sorted.slice(max)
  const restSum = rest.reduce((s, p) => s + p.value, 0)
  if (restSum !== 0) {
    top.push({ name: `其他 (${rest.length})`, value: Number(restSum.toFixed(4)) })
  }
  return top
}
