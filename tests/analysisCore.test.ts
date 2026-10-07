// 无头测试：analysisCore —— 统计摘要 / 规则化结论 / 导出文本
// 运行：node --experimental-strip-types tests/analysisCore.test.ts
import {
  buildConclusions,
  buildMarkdownReport,
  buildStatsCsv,
  computeStats
} from '../src/renderer/src/utils/analysisCore.ts'

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error('  FAIL -', msg)
    process.exit(1)
  }
  console.log('  ok  -', msg)
}

const rows = [
  { 分类: 'A', 数值: 10, 备注: 'x' },
  { 分类: 'A', 数值: 20, 备注: 'y' },
  { 分类: 'B', 数值: '5.5', 备注: null },
  { 分类: 'B', 数值: 'abc', 备注: '' },
  { 分类: 'C', 数值: true, 备注: 'z' },
  { 分类: 'C', 数值: null, 备注: 'w' }
]

const stats = computeStats(rows, ['分类', '数值', '备注'])

function run(): void {
  console.log('=== analysisCore 统计摘要 ===')
  const val = stats.find((s) => s.column === '数值')
  assert(val !== undefined && val.numeric, '数值列判定为 numeric')
  assert(val.count === 5, '数值列有效值 = 5（10/20/5.5/abc/true；仅 null 缺失）')
  assert(val.missing === 1 && Math.abs(val.missingRate - 1 / 6) < 0.0001, '数值列缺失 = 1（null），缺失率 1/6')
  assert(val.min === 1 && val.max === 20, '极值：true→1 计入，min=1 max=20')
  assert(val.mean === (10 + 20 + 5.5 + 1) / 4, '均值 = 36.5/4 = 9.125')
  assert(val.median === 7.75, '中位数 = (5.5+10)/2 = 7.75')
  assert(val.std > 0, '标准差 > 0')

  const cat = stats.find((s) => s.column === '分类')
  assert(cat !== undefined && !cat.numeric, '文本列判定为非 numeric')
  assert(cat.count === 6 && cat.missing === 0, '文本列无缺失，有效值 6')

  const note = stats.find((s) => s.column === '备注')
  assert(note !== undefined && note.missing === 2, '备注列缺失 2（null + 空串）')

  console.log('=== analysisCore 规则化结论 ===')
  const chartData = [
    { name: 'A', value: 30 },
    { name: 'B', value: 5.5 },
    { name: 'C', value: 1 }
  ]
  const cs = buildConclusions({
    stats,
    totalRows: 6,
    xCol: '分类',
    yCol: '数值',
    aggregate: 'sum',
    chartData
  })
  assert(cs.length >= 2 && cs.length <= 6, '结论条数 2~6')
  assert(cs[0].kind === 'overview' && cs[0].text.includes('6 行'), '首条为概览，含总行数')
  const top = cs.find((c) => c.kind === 'top')
  assert(top !== undefined && top.text.includes('「A」'), 'Top 结论指向 A')
  const extreme = cs.find((c) => c.kind === 'extreme')
  assert(extreme !== undefined && extreme.text.includes('1 ~ 20'), '极值结论含 1 ~ 20')
  const missing = cs.find((c) => c.kind === 'missing')
  assert(missing !== undefined && missing.text.includes('备注'), '缺失结论指向备注列')

  // 趋势：日期 X 轴 + ≥3 数据点
  const trendRows = [
    { 日期: '2026-01', 值: 1 },
    { 日期: '2026-02', 值: 2 },
    { 日期: '2026-03', 值: 3 },
    { 日期: '2026-04', 值: 4 }
  ]
  const trendStats = computeStats(trendRows, ['日期', '值'])
  const trendChart = trendRows.map((r) => ({ name: String(r.日期), value: Number(r.值) }))
  const tc = buildConclusions({ stats: trendStats, totalRows: 4, xCol: '日期', yCol: '值', aggregate: 'sum', chartData: trendChart })
  const trend = tc.find((c) => c.kind === 'trend')
  assert(trend !== undefined && trend.text.includes('上升'), '日期轴趋势结论为上升')

  console.log('=== analysisCore 导出文本 ===')
  const md = buildMarkdownReport({
    title: '销售分析',
    totalRows: 6,
    xCol: '分类',
    yCol: '数值',
    aggregate: 'sum',
    stats,
    conclusions: cs,
    chartData
  })
  assert(md.includes('# 销售分析') && md.includes('## 分析结论') && md.includes('## 列统计摘要'), 'Markdown 含三大部分')
  assert(md.includes('| 分类 |') && md.includes('| A | 30 |'), 'Markdown 含统计表与 Top 表')

  const csv = buildStatsCsv(stats)
  assert(csv.startsWith('column,numeric,count') && csv.split('\n').length === 4, 'CSV 表头 + 3 列数据')

  console.log('\nanalysisCore 全部通过：统计语义、规则化结论、Markdown/CSV 导出文本均符合预期。')
}

run()
