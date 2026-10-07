/* 数据整理导入路径基准：parseTextImport / buildTableFromRows
 * 运行：node --experimental-strip-types tests/bench-import.ts
 */
import { parseTextImport } from '../src/renderer/src/utils/ioFormats.ts'

function genCsv(rows: number, cols: number): string {
  const header = Array.from({ length: cols }, (_, i) => '列' + (i + 1))
  const out: string[] = [header.join(',')]
  for (let i = 0; i < rows; i++) {
    const cells: string[] = []
    for (let c = 0; c < cols; c++) cells.push(c === 0 ? 'ORD' + i : String(100 + ((i * (c + 1)) % 900)))
    out.push(cells.join(','))
  }
  return out.join('\n')
}

for (const [N, C] of [
  [50_000, 5],
  [200_000, 5],
  [200_000, 20]
] as Array<[number, number]>) {
  const csv = genCsv(N, C)
  const t = performance.now()
  const t0 = performance.now()
  const table = parseTextImport('bench', csv, 'csv')
  const dur = performance.now() - t0
  const kb = (csv.length / 1024 / 1024).toFixed(2)
  console.log(
    `${N.toLocaleString()} 行 × ${C} 列 (${kb} MB) → ${dur.toFixed(0)}ms | 表 ${table.rows.length.toLocaleString()} 行 / ${table.fields.length} 字段 (字段类型: ${table.fields.map((f) => f.type).join(',')})`
  )
  void t
}
