/* 大数据量基准：验证 Analytics/DataLab 导入链路的耗时是否已消除卡死
 * 运行：node --experimental-strip-types tests/bench-csv.ts
 */
import { parseCsvToTable } from '../src/renderer/src/utils/csv.ts'
import { capChartData } from '../src/renderer/src/utils/chart.ts'

function genCsv(rows: number): string {
  const cats = ['华东', '华北', '华南', '西南', '西北', '东北', '华中', '港澳台']
  const out: string[] = ['订单号,地区,销售额,成本,数量']
  for (let i = 0; i < rows; i++) {
    // 订单号唯一 → 高基数 X 轴（最坏情况）
    out.push(`ORD${(1000000 + i).toString(36).toUpperCase()},${cats[i % cats.length]},${100 + (i % 900)},${50 + (i % 400)},${1 + (i % 20)}`)
  }
  return out.join('\n')
}

/** 复刻 Analytics 的聚合逻辑（已移除 vals 数组） */
function aggregate(rows: Array<Record<string, string | number>>, xCol: string, yCol: string) {
  const map = new Map<string, { sum: number; count: number }>()
  for (const row of rows) {
    const xv = String(row[xCol] ?? '')
    const yv = Number(row[yCol])
    if (isNaN(yv)) continue
    const e = map.get(xv) ?? { sum: 0, count: 0 }
    e.sum += yv
    e.count++
    map.set(xv, e)
  }
  return [...map.entries()].map(([name, e]) => ({ name, value: Number(e.sum.toFixed(4)) }))
}

function ms(t0: number): string {
  return (performance.now() - t0).toFixed(0) + 'ms'
}

for (const N of [50_000, 200_000]) {
  const csv = genCsv(N)
  console.log(`\n===== ${N.toLocaleString()} 行 · ${(csv.length / 1024 / 1024).toFixed(2)} MB =====`)

  let t = performance.now()
  const parsed = parseCsvToTable(csv)
  console.log(`解析 CSV            : ${ms(t)}  (${parsed.rows.length.toLocaleString()} 行, 数值列 ${parsed.numericColumns.join('/')})`)

  // 最坏情况：X 轴取唯一列
  t = performance.now()
  const hiRaw = aggregate(parsed.rows, '订单号', '销售额')
  console.log(`聚合(高基数 唯一列) : ${ms(t)}  → ${hiRaw.length.toLocaleString()} 个类目`)
  t = performance.now()
  const hiCapped = capChartData(hiRaw, 60, true)
  console.log(`  capChartData      : ${ms(t)}  → 截断为 ${hiCapped.length} 个类目`)

  // 常规情况：X 轴取低基数列
  t = performance.now()
  const loRaw = aggregate(parsed.rows, '地区', '销售额')
  console.log(`聚合(低基数 8 类)   : ${ms(t)}  → ${loRaw.length} 个类目`)

  // 原始模式：每行一个点（X 轴唯一列）
  t = performance.now()
  const rawPoints = parsed.rows.map((r) => ({ name: String(r['订单号'] ?? ''), value: Number(r['销售额']) }))
  const rawCapped = capChartData(rawPoints, 60, false)
  console.log(`原始模式 N 点       : ${ms(t)}  → 截断为 ${rawCapped.length} 个点`)
}
