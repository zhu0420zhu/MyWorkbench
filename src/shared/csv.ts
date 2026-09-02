/* 灵墨工作台 · CSV / 分隔符解析（纯函数，主进程 / 渲染层共享，无第三方依赖）
 *
 * 从 renderer/src/utils/csv.ts 与 renderer/src/utils/ioFormats.ts 下沉而来，
 * 解析语义与原有实现完全一致，仅做位置迁移，便于主进程数据资产登记复用。
 */

export interface ParsedTable {
  columns: string[]
  rows: Array<Record<string, string | number>>
  numericColumns: string[]
}

/** 无引号分隔符快速解析：按行 slice + 原生 split，比逐字符拼接快数倍 */
function parseDelimitedFast(text: string, delim: string): string[][] {
  const rows: string[][] = []
  const len = text.length
  // 兼容 CR-only（旧 Mac）行尾：整篇没有 \n 但有 \r 时改用 \r 切行
  const nl = text.indexOf('\n') === -1 && text.indexOf('\r') !== -1 ? '\r' : '\n'
  let pos = 0
  while (pos < len) {
    let end = text.indexOf(nl, pos)
    if (end === -1) end = len
    let stop = end
    if (nl === '\n' && stop > pos && text.charCodeAt(stop - 1) === 13) stop--
    if (stop > pos) {
      const cells = text.slice(pos, stop).split(delim)
      if (cells.some((c) => c.trim() !== '')) rows.push(cells)
    }
    pos = end + 1
  }
  return rows
}

/** 通用分隔符解析（支持引号转义），delim 可为 ',' 或 '\t' 等 */
export function parseDelimited(text: string, delim: string): string[][] {
  // 快速路径：整篇不含引号时无需处理转义，直接走切片解析
  if (text.indexOf('"') === -1) return parseDelimitedFast(text, delim)
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delim) {
      row.push(cur)
      cur = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cur)
      cur = ''
      if (row.some((c) => c.trim() !== '')) rows.push(row)
      row = []
    } else {
      cur += ch
    }
  }
  row.push(cur)
  if (row.some((c) => c.trim() !== '')) rows.push(row)
  return rows
}

/** 兼容旧调用：parseCsv(text) === parseDelimited(text, ',') */
export function parseCsv(text: string): string[][] {
  return parseDelimited(text, ',')
}

/** 解析 CSV（首行表头），自动把可数值化的列转 number */
export function parseCsvToTable(text: string): ParsedTable {
  const raw = parseDelimited(text, ',')
  if (raw.length < 2) return { columns: [], rows: [], numericColumns: [] }
  const columns = raw[0].map((c) => c.trim() || `列${raw[0].indexOf(c) + 1}`)
  const colCount = columns.length
  const rows: ParsedTable['rows'] = []
  for (let i = 1; i < raw.length; i++) {
    const cells = raw[i]
    if (cells.length === 1 && cells[0].trim() === '') continue
    const record: Record<string, string | number> = {}
    for (let j = 0; j < colCount; j++) {
      const v = cells[j] ?? ''
      record[columns[j]] = v.trim()
    }
    rows.push(record)
  }
  // 数值列检测：计数 + 达标即返回，避免为每列都 map/filter 出与行数等长的临时数组
  const rowCount = rows.length
  const numThreshold = Math.max(1, rowCount * 0.6)
  const numericColumns = columns.filter((col) => {
    let n = 0
    for (let i = 0; i < rowCount; i++) {
      const v = rows[i][col]
      if (typeof v === 'string' && v !== '' && isFinite(Number(v))) {
        if (++n >= numThreshold) return true
      }
    }
    return false
  })
  // 转数值
  for (const row of rows) {
    for (const col of numericColumns) {
      const v = row[col]
      if (typeof v === 'string' && v !== '' && isFinite(Number(v))) {
        row[col] = Number(v)
      }
    }
  }
  return { columns, rows, numericColumns }
}
