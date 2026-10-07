/* 无头回归测试：多维图表模型 + 配置联动结论（纯逻辑，零 electron 依赖）
 * 覆盖：筛选、颜色分组多序列、排序、日期分桶、Top/分组对比结论、结论稳定 id。
 * 运行：npm run test:analytics
 */
import { buildCsvChartModel, chartModelFromGroups, bucketDate, isDateLike } from '../src/renderer/src/utils/analyticsChart.ts'
import { buildConclusions } from '../src/renderer/src/utils/analysisCore.ts'
import type { ColumnStats } from '../src/shared/types.ts'

let pass = 0
let fail = 0
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++
    console.log('  PASS', name)
  } else {
    fail++
    console.error('  FAIL', name)
  }
}

const rows = [
  { 月份: '2024-01', 区域: '华东', 销售额: '100', 成本: '60' },
  { 月份: '2024-02', 区域: '华东', 销售额: '150', 成本: '95' },
  { 月份: '2024-01', 区域: '华北', 销售额: '80', 成本: '50' },
  { 月份: '2024-02', 区域: '华北', 销售额: '120', 成本: '70' },
  { 月份: '2024-03', 区域: '华东', 销售额: '110', 成本: '65' }
]

// 1. 基础聚合（求和）按值降序
const m1 = buildCsvChartModel({
  rows,
  xCol: '月份',
  yCol: '销售额',
  agg: 'sum',
  colorBy: null,
  sortDir: 'desc',
  catLimit: 60,
  dateGranularity: 'auto',
  filters: []
})
check('基础聚合返回 3 个类目', m1.categories.length === 3)
check('降序：第一个类目值最大', m1.series[0].data[0] >= m1.series[0].data[1])

// 2. 颜色分组 → 多序列
const m2 = buildCsvChartModel({
  rows,
  xCol: '月份',
  yCol: '销售额',
  agg: 'sum',
  colorBy: '区域',
  sortDir: 'desc',
  catLimit: 60,
  dateGranularity: 'auto',
  filters: []
})
check('颜色分组产生 2 个序列', m2.series.length === 2)
check('颜色分组标记 isGrouped', m2.isGrouped === true)
check('华东序列类目数一致', m2.series.find((s) => s.name === '华东')?.data.length === 3)

// 3. 筛选：仅华东
const m3 = buildCsvChartModel({
  rows,
  xCol: '月份',
  yCol: '销售额',
  agg: 'sum',
  colorBy: null,
  sortDir: 'desc',
  catLimit: 60,
  dateGranularity: 'auto',
  filters: [{ column: '区域', op: 'eq', value: '华东' }]
})
const totalEast = rows.filter((r) => r.区域 === '华东').reduce((s, r) => s + Number(r.销售额), 0)
check('筛选仅华东：单序列合计正确', m3.series[0].data.reduce((s, v) => s + v, 0) === totalEast)

// 4. 日期分桶（按月已是最细，按年应合并）
const m4 = buildCsvChartModel({
  rows,
  xCol: '月份',
  yCol: '销售额',
  agg: 'sum',
  colorBy: null,
  sortDir: 'desc',
  catLimit: 60,
  dateGranularity: 'year',
  filters: []
})
check('按年分桶仅 1 个类目', m4.categories.length === 1 && m4.categories[0] === '2024')

// 5. 数据库表模式：从分组构建单序列 + 升序
const g = chartModelFromGroups(
  [
    { name: 'A', value: 30 },
    { name: 'B', value: 10 },
    { name: 'C', value: 20 }
  ],
  'asc',
  60
)
check('表模式升序：B(10) 居首', g.categories[0] === 'B' && g.series[0].data[0] === 10)

// 6. 日期分桶函数
check('bucketDate 年', bucketDate('2024-03-15', 'year') === '2024')
check('bucketDate 月', bucketDate('2024/03/15', 'month') === '2024-03')
check('bucketDate 日', bucketDate('2024年03月15日', 'day') === '2024-03-15')
check('isDateLike 中文', isDateLike('月份') && isDateLike('order_date'))

// 7. 结论：稳定 id + 分组对比
const stats: ColumnStats[] = [
  { column: '销售额', numeric: true, count: 5, missing: 0, missingRate: 0, min: 80, max: 150, mean: 112, median: 110, std: 35 }
]
const concl = buildConclusions({
  stats,
  totalRows: 5,
  xCol: '月份',
  yCol: '销售额',
  aggregate: 'sum',
  chartData: m1.categories.map((c, i) => ({ name: c, value: m1.series[0].data[i] })),
  filters: [],
  colorBy: '区域',
  sortDir: 'desc',
  catLimit: 60,
  groupedData: m2.series.map((s) => ({ group: s.name, points: m2.categories.map((c, i) => ({ name: c, value: s.data[i] })) }))
})
check('结论含分组对比（overview 含「分组」）', concl.some((c) => c.text.includes('分组')))
check('结论 id 稳定（top）', concl.find((c) => c.kind === 'top')?.id === 'top')
check('结论极值 id 稳定（extreme / extreme-2）', concl.filter((c) => c.kind === 'extreme').length >= 2 && concl.some((c) => c.id === 'extreme') && concl.some((c) => c.id === 'extreme-2'))

console.log(`\n结果：${pass} PASS / ${fail} FAIL`)
if (fail > 0) process.exit(1)
