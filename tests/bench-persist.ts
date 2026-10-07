/* 落盘链路基准：模拟主进程 tables.ts 的 writeStore / readStore
 * 运行：node --experimental-strip-types tests/bench-persist.ts
 */
interface Store {
  version: number
  tables: Array<{ id: string; name: string; fields: unknown[]; rows: unknown[]; createdAt: number; updatedAt: number }>
}

function buildTable(rows: number, cols: number) {
  const fields = Array.from({ length: cols }, (_, i) => ({ id: 'f' + i, name: '列' + (i + 1), type: 'number' }))
  const data = Array.from({ length: rows }, (_, r) => {
    const values: Record<string, number | string> = {}
    for (let c = 0; c < cols; c++) values['f' + c] = c === 0 ? 'ORD' + r : 100 + ((r * (c + 1)) % 900)
    return { id: 'r' + r, values }
  })
  return { id: 't1', name: '导入数据', fields, rows: data, createdAt: Date.now(), updatedAt: Date.now() }
}

function fmt(ms: number): string {
  return ms.toFixed(0) + 'ms'
}

for (const [N, C] of [
  [50_000, 5],
  [200_000, 5],
  [200_000, 20]
] as Array<[number, number]>) {
  const store: Store = { version: 1, tables: [buildTable(N, C)] }
  console.log(`\n===== ${N.toLocaleString()} 行 × ${C} 列 =====`)

  let t = performance.now()
  const pretty = JSON.stringify(store, null, 2)
  const prettyMs = performance.now() - t
  console.log(`stringify(缩进 2，当前实现) : ${fmt(prettyMs)}  → ${(pretty.length / 1024 / 1024).toFixed(1)} MB`)

  t = performance.now()
  const compact = JSON.stringify(store)
  const compactMs = performance.now() - t
  console.log(`stringify(紧凑)             : ${fmt(compactMs)}  → ${(compact.length / 1024 / 1024).toFixed(1)} MB`)

  t = performance.now()
  JSON.parse(pretty)
  const parsePrettyMs = performance.now() - t
  t = performance.now()
  JSON.parse(compact)
  const parseCompactMs = performance.now() - t
  console.log(`parse(缩进 2 / 紧凑)        : ${fmt(parsePrettyMs)} / ${fmt(parseCompactMs)}`)

  // 导入一次实际发生的往返次数：create(update 全表) → update(全表) → list(全表)
  const roundTrips = 3
  console.log(
    `→ 单次导入预估总耗时       : ${fmt(prettyMs * roundTrips + parsePrettyMs * roundTrips)}（${roundTrips} 次全量写+读）`
  )
}
