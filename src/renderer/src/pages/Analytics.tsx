import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Checkbox,
  Collapse,
  Dropdown,
  Empty,
  Input,
  InputNumber,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  BarChartOutlined,
  ClearOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  FileExcelOutlined,
  FolderOpenOutlined,
  ReloadOutlined
} from '@ant-design/icons'
import * as echarts from 'echarts'
import { parseCsvToTable, type ParsedTable } from '../utils/csv'
import { encodingLabel, SUPPORTED_ENCODINGS } from '../utils/encoding'
import { parseCsvTableInWorker } from '../workers/parseClient'
import type {
  AggregateFilter,
  AggregateResult,
  ColumnStats,
  ConclusionItem,
  DataTable,
  FieldValue,
  TableMeta
} from '@shared/types'
import {
  buildConclusions,
  buildMarkdownReport,
  buildStatsCsv,
  computeStats,
  isDateLike as isDateLikeCol
} from '../utils/analysisCore'
import {
  buildCsvChartModel,
  chartModelFromGroups,
  type ChartModel,
  type CsvFilter,
  type DateGranularity,
  type SortDir
} from '../utils/analyticsChart'
import { useTheme, resolveAccent } from '../theme/theme'
import { usePrefs } from '../prefs'

type SourceMode = 'csv' | 'table' | 'kb'
type ChartType = 'line' | 'bar' | 'pie'
type Aggregate = 'raw' | 'sum' | 'avg' | 'count'

/** 筛选规则（CSV 用列名；数据库表用字段名，调用聚合时再转 fieldId） */
interface FilterRule {
  column: string
  op: CsvFilter['op']
  value: string
}

const FILTER_OPS: { label: string; value: CsvFilter['op'] }[] = [
  { label: '等于', value: 'eq' },
  { label: '不等于', value: 'neq' },
  { label: '包含', value: 'contains' },
  { label: '大于', value: 'gt' },
  { label: '大于等于', value: 'gte' },
  { label: '小于', value: 'lt' },
  { label: '小于等于', value: 'lte' },
  { label: '缺失', value: 'isMissing' }
]

/** 结论条目标签与着色（kind → antd Tag color） */
const CONCLUSION_LABEL: Record<ConclusionItem['kind'], string> = {
  overview: '概览',
  top: 'Top',
  extreme: '极值',
  trend: '趋势',
  missing: '缺失'
}
const CONCLUSION_COLOR: Record<ConclusionItem['kind'], string> = {
  overview: 'blue',
  top: 'green',
  extreme: 'orange',
  trend: 'purple',
  missing: 'red'
}

/** 列统计摘要表列定义 */
const STATS_COLUMNS: ColumnsType<ColumnStats> = [
  { title: '列', dataIndex: 'column', ellipsis: true },
  { title: '数值列', dataIndex: 'numeric', width: 72, render: (v: boolean) => (v ? '是' : '否') },
  { title: '有效', dataIndex: 'count', width: 64, align: 'right' },
  { title: '缺失', dataIndex: 'missing', width: 64, align: 'right' },
  {
    title: '缺失率',
    dataIndex: 'missingRate',
    width: 80,
    align: 'right',
    render: (v: number) => (v * 100).toFixed(1) + '%'
  },
  { title: '最小', dataIndex: 'min', width: 88, align: 'right', render: (v: number, r) => (r.numeric ? v : '-') },
  { title: '最大', dataIndex: 'max', width: 88, align: 'right', render: (v: number, r) => (r.numeric ? v : '-') },
  { title: '均值', dataIndex: 'mean', width: 88, align: 'right', render: (v: number, r) => (r.numeric ? v : '-') },
  { title: '中位数', dataIndex: 'median', width: 88, align: 'right', render: (v: number, r) => (r.numeric ? v : '-') },
  { title: '标准差', dataIndex: 'std', width: 88, align: 'right', render: (v: number, r) => (r.numeric ? v : '-') }
]

/** 可拖动分隔条：支持横向（row-resize）/纵向（col-resize） */
interface ResizeHandleProps {
  onResize: (delta: number) => void
  direction?: 'row' | 'col'
}

function ResizeHandle({ onResize, direction = 'row' }: ResizeHandleProps) {
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      let prev = direction === 'row' ? e.clientY : e.clientX
      const onMove = (ev: MouseEvent) => {
        const cur = direction === 'row' ? ev.clientY : ev.clientX
        onResize(cur - prev)
        prev = cur
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
      }
      document.body.style.cursor = direction === 'row' ? 'row-resize' : 'col-resize'
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [onResize, direction]
  )

  return (
    <div
      className={`analytics-resize-handle analytics-resize-handle-${direction}`}
      onMouseDown={handleMouseDown}
      title="拖动调整大小"
    />
  )
}

export default function Analytics() {
  const { isDark } = useTheme()
  const { prefs } = usePrefs()
  const accent = resolveAccent(prefs.colorPrimary, isDark)

  // 分析页三个区域（图表 / 结论 / 预览）的可拖动高度
  const [chartHeight, setChartHeight] = useState(() => {
    try {
      return Math.max(200, Math.min(600, Number(localStorage.getItem('analytics.chartHeight') ?? 320)))
    } catch {
      return 320
    }
  })
  const [previewHeight, setPreviewHeight] = useState(() => {
    try {
      return Math.max(160, Math.min(500, Number(localStorage.getItem('analytics.previewHeight') ?? 240)))
    } catch {
      return 240
    }
  })

  const [sourceMode, setSourceMode] = useState<SourceMode>('csv')
  const [csvEncoding, setCsvEncoding] = useState(() => localStorage.getItem('analytics.importEncoding') || 'auto')
  const [csvText, setCsvText] = useState('')
  // 大文件导入不再塞进受控 TextArea：几 MB 的文本域会让每次按键都重解析全文并拖垮主线程
  // parsed 由 Web Worker 解析后回传，主线程不再同步解析大文件
  const [csvFile, setCsvFile] = useState<{
    name: string
    bytes: Uint8Array
    text: string
    encoding: string
    resolvedEncoding: string
    parsed: ParsedTable
  } | null>(null)
  const [importing, setImporting] = useState(false)
  const MAX_INLINE_CSV = 200_000
  const [tables, setTables] = useState<TableMeta[]>([])
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null)
  const [selectedTable, setSelectedTable] = useState<DataTable | null>(null)
  // P0：知识库数据表（数据型资产登记后落 userData/kb/tables/lingmo.db），与分析场景共享聚合引擎
  const [kbTables, setKbTables] = useState<TableMeta[]>([])
  const [selectedKbTableId, setSelectedKbTableId] = useState<string | null>(null)
  const [selectedKbTable, setSelectedKbTable] = useState<DataTable | null>(null)
  const [kbTableLoading, setKbTableLoading] = useState(false)

  // 表模式 / 知识库表模式共用解析：按当前 sourceMode 选数据来源
  const isTableMode = sourceMode === 'table'
  const isKbMode = sourceMode === 'kb'
  const curTable = isKbMode ? selectedKbTable : selectedTable
  const curTableId = isKbMode ? selectedKbTableId : selectedTableId
  const curTables = isKbMode ? kbTables : tables
  const curSetTableId = isKbMode ? setSelectedKbTableId : setSelectedTableId
  const curApi = isKbMode ? window.api.kbData : window.api.tables
  const [tableLoading, setTableLoading] = useState(false)
  // 表模式：列选择与聚合一律用 fieldId（字段可重名，聚合契约只认 id）
  const [xFieldId, setXFieldId] = useState<string | null>(null)
  const [yFieldId, setYFieldId] = useState<string | null>(null)
  // 表模式图表数据：主进程 SQL 聚合（topN 截断载荷），不与全表读取互相阻塞
  const [aggResult, setAggResult] = useState<AggregateResult | null>(null)
  const [aggLoading, setAggLoading] = useState(false)

  const [chartType, setChartType] = useState<ChartType>('bar')
  const [xCol, setXCol] = useState<string | null>(null)
  const [yCol, setYCol] = useState<string | null>(null)
  const [aggregate, setAggregate] = useState<Aggregate>('sum')
  // 预览行数可手工输入；上限 1000 行，防止 antd Table 一次渲染上万行卡死
  const PREVIEW_MAX = 1000
  const [previewCount, setPreviewCount] = useState(10)
  // 图表类目上限（Top-N）：高基数 X 轴（如每行唯一值）会渲染上万柱/标签导致卡死
  const [catLimit, setCatLimit] = useState(60)

  // ---- 黄色框：多维分析维度 ----
  const [filters, setFilters] = useState<FilterRule[]>([])
  const [colorBy, setColorBy] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [stack, setStack] = useState(false)
  const [normalize, setNormalize] = useState(false)
  const [yAxisType, setYAxisType] = useState<'value' | 'log'>('value')
  const [showLabels, setShowLabels] = useState(false)
  const [showAvgLine, setShowAvgLine] = useState(false)
  const [dateGranularity, setDateGranularity] = useState<DateGranularity>('auto')

  // ---- 绿色框：结论可编辑 / 删除 / 隐藏 ----
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set())
  const [customText, setCustomText] = useState<Record<string, string>>({})
  const [editingId, setEditingId] = useState<string | null>(null)
  const [kindFilter, setKindFilter] = useState<ConclusionItem['kind'] | 'all'>('all')

  const chartRef = useRef<HTMLDivElement>(null)
  const chartInstance = useRef<echarts.ECharts | null>(null)

  // 加载数据库表
  useEffect(() => {
    window.api.tables
      .list()
      .then(setTables)
      .catch(() => undefined)
  }, [])

  // 选中表后按 id 取完整表（列表只返回摘要，不含行；用于字段选择器 + 预览 + 统计）
  useEffect(() => {
    if (!selectedTableId) {
      setSelectedTable(null)
      setTableLoading(false)
      return
    }
    let cancelled = false
    setTableLoading(true)
    window.api.tables
      .get(selectedTableId)
      .then((t) => {
        if (!cancelled) setSelectedTable(t)
      })
      .catch(() => {
        if (!cancelled) setSelectedTable(null)
      })
      .finally(() => {
        if (!cancelled) setTableLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedTableId])

  // 加载知识库表
  useEffect(() => {
    window.api.kbData
      .listTables()
      .then(setKbTables)
      .catch(() => undefined)
  }, [])

  // 选中知识库表后按 id 取完整表（列表只返回摘要，不含行；用于字段选择器 + 预览 + 统计）
  useEffect(() => {
    if (!selectedKbTableId) {
      setSelectedKbTable(null)
      setKbTableLoading(false)
      return
    }
    let cancelled = false
    setKbTableLoading(true)
    window.api.kbData
      .getTable(selectedKbTableId)
      .then((t) => {
        if (!cancelled) setSelectedKbTable(t)
      })
      .catch(() => {
        if (!cancelled) setSelectedKbTable(null)
      })
      .finally(() => {
        if (!cancelled) setKbTableLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedKbTableId])

  const handleImportFile = async (): Promise<void> => {
    try {
      const file = await window.api.pickBufferFile()
      if (!file) return
      setImporting(true)
      setSourceMode('csv')
      // 让「载入中」先上屏；解析在 Worker 中进行，主线程保持响应
      await new Promise((r) => setTimeout(r, 0))
      const { text, resolvedEncoding, table } = await parseCsvTableInWorker(file.data, csvEncoding)
      setCsvFile({ name: file.name, bytes: file.data, text, encoding: csvEncoding, resolvedEncoding, parsed: table })
      if (text.length > MAX_INLINE_CSV) {
        setCsvText('')
        message.success(
          `已载入 ${file.name}（${(text.length / 1024).toFixed(0)} KB，编码 ${encodingLabel(resolvedEncoding)}，直接分析）`
        )
      } else {
        setCsvText(text)
        message.success(`已导入 ${file.name}（编码 ${encodingLabel(resolvedEncoding)}）`)
      }
    } catch (err) {
      message.error('导入失败' + (err instanceof Error ? `：${err.message}` : ''))
    } finally {
      setImporting(false)
    }
  }

  // 编码切换的时序保护：连续快速切换时只应用最后一次的结果
  const reencodeSeq = useRef(0)
  const handleEncodingChange = async (nextEncoding: string): Promise<void> => {
    setCsvEncoding(nextEncoding)
    localStorage.setItem('analytics.importEncoding', nextEncoding)
    if (!csvFile) return
    const seq = ++reencodeSeq.current
    try {
      const { text, resolvedEncoding, table } = await parseCsvTableInWorker(csvFile.bytes, nextEncoding)
      if (seq !== reencodeSeq.current) return
      setCsvFile((prev) => (prev ? { ...prev, text, encoding: nextEncoding, resolvedEncoding, parsed: table } : prev))
      // 小文件内容进了编辑框，编码变更时同步刷新编辑框
      if (csvText !== '') setCsvText(text)
    } catch {
      if (seq === reencodeSeq.current) message.error('按所选编码重新解码失败')
    }
  }

  // 数据：CSV 或数据库表 → ParsedTable
  const parsed: ParsedTable = useMemo(() => {
    if (sourceMode === 'csv') {
      // 文件导入的解析结果由 Worker 预先算好，这里直接用
      if (csvFile) return csvFile.parsed
      return csvText.trim() ? parseCsvToTable(csvText) : { columns: [], rows: [], numericColumns: [] }
    }
    const t = selectedTable
    if (!t || t.fields.length === 0) return { columns: [], rows: [], numericColumns: [] }
    const columns = t.fields.map((f) => f.name)
    const rows = t.rows.map((r) => {
      const rec: Record<string, string | number> = {}
      t.fields.forEach((f) => {
        const v = r.values[f.id]
        rec[f.name] = typeof v === 'boolean' ? (v ? '是' : '否') : v ?? ''
      })
      return rec
    })
    const numericColumns = t.fields
      .filter((f) => f.type === 'number' || f.type === 'text')
      .filter((col) => {
        const vals = rows.map((r) => r[col.name])
        const nums = vals.filter((v) => typeof v === 'string' && v !== '' && isFinite(Number(v)))
        return nums.length >= Math.max(1, vals.length * 0.6)
      })
      .map((f) => f.name)
    return { columns, rows, numericColumns }
  }, [sourceMode, csvText, csvFile, curTable])

  const xName =
    isTableMode || isKbMode ? curTable?.fields.find((f) => f.id === xFieldId)?.name ?? null : xCol
  const yName =
    isTableMode || isKbMode ? curTable?.fields.find((f) => f.id === yFieldId)?.name ?? null : yCol

  // 默认列选择：切换数据源后旧列名失效时自动重置
  useEffect(() => {
    if (parsed.columns.length === 0) {
      setXCol(null)
      setYCol(null)
      return
    }
    setXCol((cur) => (cur && parsed.columns.includes(cur) ? cur : parsed.columns[0]))
    setYCol((cur) => {
      if (cur && parsed.columns.includes(cur)) return cur
      return (
        parsed.numericColumns.find((c) => c !== (xCol ?? parsed.columns[0])) ??
        parsed.columns[Math.min(1, parsed.columns.length - 1)]
      )
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed])

  // 表模式：表加载完成后默认选前两个字段（优先数值字段作为 Y）
  useEffect(() => {
    if (!isTableMode && !isKbMode) return
    const t = curTable
    if (!t || t.fields.length === 0) {
      setXFieldId(null)
      setYFieldId(null)
      return
    }
    setXFieldId((cur) => (cur && t.fields.some((f) => f.id === cur) ? cur : t.fields[0].id))
    setYFieldId((cur) => {
      if (cur && t.fields.some((f) => f.id === cur)) return cur
      return (
        t.fields.find((f) => (f.type === 'number' || f.type === 'text') && f.id !== xFieldId)?.id ??
        t.fields[Math.min(1, t.fields.length - 1)].id
      )
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTable, sourceMode])

  // 表模式聚合通道：图表数据走主进程 SQL 聚合（GROUP BY + LIMIT，载荷 ≤ topN），
  // 与全表读取（预览/统计）解耦——切换 X/Y/聚合/类目上限/筛选只发一条轻量 IPC。
  useEffect(() => {
    if ((!isTableMode && !isKbMode) || !curTableId || !xFieldId) {
      setAggResult(null)
      return
    }
    if (aggregate !== 'count' && !yFieldId) {
      setAggResult(null)
      return
    }
    let cancelled = false
    setAggResult(null)
    setAggLoading(true)
    const aggFilters: AggregateFilter[] | undefined =
      filters.length > 0 && curTable
        ? filters.map((f) => ({
            fieldId: curTable.fields.find((ff) => ff.name === f.column)?.id ?? f.column,
            op: f.op,
            value: f.value
          }))
        : undefined
    curApi
      .aggregate({
        tableId: curTableId,
        xFieldId,
        yFieldId: aggregate === 'count' ? null : yFieldId,
        agg: aggregate,
        topN: catLimit,
        sampleRows: aggregate === 'raw' ? previewCount : undefined,
        filters: aggFilters
      })
      .then((r) => {
        if (!cancelled) setAggResult(r)
      })
      .catch(() => {
        if (!cancelled) {
          setAggResult(null)
          message.error('聚合失败：请检查所选列')
        }
      })
      .finally(() => {
        if (!cancelled) setAggLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sourceMode, curTableId, xFieldId, yFieldId, aggregate, catLimit, previewCount, filters, curTable, isKbMode])

  // 多维图表模型：CSV 模式在渲染层构建（含筛选/分组/排序/日期分桶）；
  // 数据库表模式用 SQL 聚合分组，仅支持排序/堆叠等渲染期变换（分组/日期分桶需原始行，表模式禁用）。
  const model: ChartModel = useMemo(() => {
    if (isTableMode || isKbMode) {
      if (!aggResult) return { categories: [], series: [], isGrouped: false }
      return chartModelFromGroups(aggResult.groups, sortDir, catLimit)
    }
    if (!xCol || parsed.rows.length === 0) return { categories: [], series: [], isGrouped: false }
    return buildCsvChartModel({
      rows: parsed.rows,
      xCol,
      yCol,
      agg: aggregate,
      colorBy: sourceMode === 'csv' ? colorBy : null,
      sortDir,
      catLimit,
      dateGranularity: sourceMode === 'csv' && isDateLikeCol(xCol) ? dateGranularity : 'auto',
      filters
    })
  }, [sourceMode, parsed, aggResult, xCol, yCol, aggregate, colorBy, sortDir, catLimit, dateGranularity, filters])

  // 整体点序列（用于 Top/趋势/占比结论，跨分组求和）
  const overallPoints = useMemo(
    () =>
      model.categories.map((c, i) => ({
        name: c,
        value: model.series.reduce((s, ser) => s + ser.data[i], 0)
      })),
    [model]
  )

  // 按分组维度（colorBy）拆分的每组数据，供多维度结论
  const groupedData = useMemo(() => {
    if (!model.isGrouped) return undefined
    return model.series.map((s) => ({
      group: s.name,
      points: model.categories.map((c, i) => ({ name: c, value: s.data[i] }))
    }))
  }, [model])

  // 列统计摘要（纯规则，无 AI）：一次遍历算全列，供结论区与导出
  const stats = useMemo(() => {
    if (parsed.columns.length === 0) return []
    return computeStats(parsed.rows, parsed.columns)
  }, [parsed])

  // 结论区（规则化、随配置联动、多维思考）：概览 / Top / 极值 / 趋势 / 分组对比 / 缺失
  const conclusions = useMemo(() => {
    return buildConclusions({
      stats,
      totalRows: parsed.rows.length,
      xCol: xName,
      yCol: yName,
      aggregate,
      chartData: overallPoints,
      filters: filters.map((f) => ({ column: f.column, op: f.op, value: f.value })),
      colorBy: sourceMode === 'csv' ? colorBy : null,
      sortDir,
      catLimit,
      groupedData
    })
  }, [stats, parsed.rows.length, xName, yName, aggregate, overallPoints, filters, colorBy, sourceMode, sortDir, catLimit, groupedData])

  // 结论显示态：先按类型过滤，再剔除隐藏，最后套用用户自定义文本
  const displayedConclusions = useMemo(() => {
    return conclusions
      .filter((c) => kindFilter === 'all' || c.kind === kindFilter)
      .filter((c) => !hiddenIds.has(c.id))
      .map((c) => (customText[c.id] != null ? { ...c, text: customText[c.id] } : c))
  }, [conclusions, kindFilter, hiddenIds, customText])

  const isGrouped = model.isGrouped
  const hasDate = sourceMode === 'csv' && xCol != null && isDateLikeCol(xCol)

  // 渲染图表
  useEffect(() => {
    if (!chartRef.current) return
    if (!chartInstance.current) {
      chartInstance.current = echarts.init(chartRef.current)
    }
    const chart = chartInstance.current
    const option: echarts.EChartsOption = { animation: false }
    if (model.categories.length === 0) {
      chart.clear()
      const hasAxes =
        isTableMode || isKbMode
          ? Boolean(xFieldId && (aggregate === 'count' || yFieldId))
          : Boolean(xCol && (aggregate === 'count' || yCol))
      const hint = aggLoading
        ? '聚合计算中…'
        : parsed.rows.length > 0 && hasAxes
          ? '聚合结果为空：Y 轴列不包含数值，请更换 Y 轴，或将聚合改为「计数」'
          : '暂无数据'
      chart.setOption(
        { title: { text: hint, left: 'center', top: 'center', textStyle: { fontWeight: 'normal', fontSize: 13 } } },
        true
      )
      return
    }
    if (chartType === 'pie') {
      const pieData = model.categories.map((c, i) => ({
        name: c,
        value: model.series.reduce((s, ser) => s + ser.data[i], 0)
      }))
      option.tooltip = { trigger: 'item' }
      option.legend = { type: 'scroll', bottom: 0 }
      let data = pieData
      if (normalize) {
        const tot = pieData.reduce((s, d) => s + d.value, 0)
        data = pieData.map((d) => ({ name: d.name, value: tot > 0 ? Number(((d.value / tot) * 100).toFixed(2)) : 0 }))
      }
      option.series = [
        {
          type: 'pie',
          radius: ['35%', '70%'],
          data,
          label: { formatter: normalize ? '{b}: {d}%' : '{b}: {c}' }
        }
      ]
    } else {
      option.tooltip = { trigger: 'axis' }
      option.grid = { left: 48, right: 24, top: 32, bottom: 48 }
      option.xAxis = {
        type: 'category',
        data: model.categories,
        axisLabel: { interval: 'auto', hideOverlap: true, rotate: model.categories.length > 12 ? 30 : 0 }
      }
      option.yAxis = { type: yAxisType }
      const rowTotals = model.categories.map((_, i) => model.series.reduce((sum, ser) => sum + ser.data[i], 0))
      option.series = model.series.map((ser) => {
        let data: number[] = ser.data
        if (normalize && isGrouped) {
          data = ser.data.map((v, i) => (rowTotals[i] > 0 ? Number(((v / rowTotals[i]) * 100).toFixed(2)) : 0))
        }
        return {
          name: ser.name,
          type: chartType,
          data,
          stack: stack && isGrouped ? 'total' : undefined,
          itemStyle: isGrouped ? undefined : { color: accent },
          smooth: chartType === 'line',
          label: showLabels ? { show: true, position: 'top', fontSize: 10, formatter: '{c}' } : undefined,
          markLine:
            showAvgLine && !isGrouped
              ? {
                  silent: true,
                  symbol: 'none',
                  data: [{ type: 'average', name: '均值' }],
                  lineStyle: { color: '#faad14', type: 'dashed' }
                }
              : undefined
        }
      })
    }
    chart.setOption(option, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, chartType, accent, stack, normalize, yAxisType, showLabels, showAvgLine, aggLoading, sourceMode])

  // 容器尺寸变化 + 卸载释放图表实例
  useEffect(() => {
    const onResize = (): void => chartInstance.current?.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chartInstance.current?.dispose()
      chartInstance.current = null
    }
  }, [])

  // 拖动调整图表/预览高度后：持久化 + 触发 ECharts 自适应
  useEffect(() => {
    localStorage.setItem('analytics.chartHeight', String(chartHeight))
    chartInstance.current?.resize()
  }, [chartHeight])

  useEffect(() => {
    localStorage.setItem('analytics.previewHeight', String(previewHeight))
  }, [previewHeight])

  /* ---------- 导出分析结果（另存为） ---------- */
  const handleExport = async (kind: 'md' | 'png' | 'csv'): Promise<void> => {
    try {
      if (kind === 'png') {
        const url = chartInstance.current?.getDataURL({
          type: 'png',
          pixelRatio: 2,
          backgroundColor: isDark ? '#1f1f1f' : '#ffffff'
        })
        if (!url) {
          message.warning('图表尚未渲染，无法导出图片')
          return
        }
        const b64 = url.slice(url.indexOf(',') + 1)
        const bin = atob(b64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        await window.api.exportBuffer(`分析图表-${Date.now()}.png`, bytes)
        message.success('图表已导出')
        return
      }
      if (kind === 'md') {
        const md = buildMarkdownReport({
          title: '数据分析报告',
          totalRows: parsed.rows.length,
          xCol: xName ?? '',
          yCol: yName ?? '',
          aggregate,
          stats,
          conclusions,
          chartData: overallPoints
        })
        await window.api.exportText(`分析报告-${Date.now()}.md`, md)
      } else {
        await window.api.exportText(`分析统计-${Date.now()}.csv`, buildStatsCsv(stats))
      }
      message.success('导出完成')
    } catch (err) {
      message.error('导出失败：' + (err as Error).message)
    }
  }

  const previewColumns = parsed.columns.slice(0, 6).map((c) => ({ title: c, dataIndex: c, ellipsis: true }))

  // 筛选器列选项
  const filterColumnOptions =
    sourceMode === 'csv'
      ? parsed.columns.map((c) => ({ label: c, value: c }))
      : (isKbMode ? selectedKbTable?.fields : selectedTable?.fields)?.map((f) => ({ label: f.name, value: f.name })) ?? []

  return (
    <div className="analytics-page">
      <div className="page-header">
        <Typography.Title level={4} style={{ margin: 0 }}>
          数据分析
        </Typography.Title>
        <Segmented
          value={sourceMode}
          onChange={(v) => setSourceMode(v as SourceMode)}
          options={[
            { label: 'CSV 数据', value: 'csv', icon: <FileExcelOutlined /> },
            { label: '数据库表', value: 'table', icon: <BarChartOutlined /> },
            { label: '知识库表', value: 'kb', icon: <DatabaseOutlined /> }
          ]}
        />
      </div>

      <div className="analytics-source">
        {sourceMode === 'csv' ? (
          <>
            {csvFile ? (
              <Space wrap style={{ marginBottom: 8 }}>
                <Tag icon={<FileExcelOutlined />} color="processing">
                  {csvFile.name}
                </Tag>
                <Select
                  aria-label="文件编码"
                  size="small"
                  style={{ width: 120 }}
                  value={csvFile.encoding}
                  onChange={handleEncodingChange}
                  options={SUPPORTED_ENCODINGS}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {csvFile.encoding === 'auto'
                    ? `识别为 ${encodingLabel(csvFile.resolvedEncoding)} · `
                    : `编码 ${encodingLabel(csvFile.resolvedEncoding)} · `}
                  {parsed.rows.length} 行
                  {csvFile.text.length > MAX_INLINE_CSV ? ' · 文件较大，未载入编辑框以免卡顿' : ' · 已载入编辑框'}
                </Typography.Text>
                <Button size="small" icon={<ClearOutlined />} onClick={() => setCsvFile(null)}>
                  移除文件
                </Button>
              </Space>
            ) : null}
            {(!csvFile || csvFile.text.length <= MAX_INLINE_CSV) && (
              <Input.TextArea
                aria-label="CSV 数据"
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                placeholder={'粘贴 CSV 数据（首行为表头）：\n月份,销售额,成本\n1月,120,80\n2月,150,95\n3月,110,70'}
                autoSize={{ minRows: 5, maxRows: 10 }}
                style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}
              />
            )}
            {!csvFile && (
              <Space style={{ marginTop: 8 }}>
                <Button size="small" icon={<FolderOpenOutlined />} onClick={handleImportFile} loading={importing}>
                  导入 CSV 文件…
                </Button>
                <Button size="small" icon={<ClearOutlined />} onClick={() => setCsvText('')} disabled={!csvText}>
                  清空
                </Button>
              </Space>
            )}
          </>
        ) : (
          <Select
            aria-label={isKbMode ? '选择知识库表' : '选择数据库表'}
            placeholder={isKbMode ? '选择知识库表' : '选择数据库表'}
            style={{ width: 320 }}
            value={curTableId ?? undefined}
            onChange={curSetTableId}
            options={curTables.map((t) => ({ label: `${t.name}（${t.rowCount} 行）`, value: t.id }))}
            loading={isKbMode ? kbTableLoading : tableLoading}
            showSearch
            optionFilterProp="label"
          />
        )}
      </div>

      {parsed.columns.length > 0 && (
        <div className="analytics-config">
          <Space wrap>
            <span>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                X 轴：
              </Typography.Text>
              {isTableMode || isKbMode ? (
                <Select
                  aria-label="X 轴字段"
                  size="small"
                  style={{ width: 150 }}
                  value={xFieldId ?? undefined}
                  onChange={setXFieldId}
                  options={curTable?.fields.map((f) => ({ label: f.name, value: f.id })) ?? []}
                />
              ) : (
                <Select
                  aria-label="X 轴列"
                  size="small"
                  style={{ width: 150 }}
                  value={xCol ?? undefined}
                  onChange={setXCol}
                  options={parsed.columns.map((c) => ({ label: c, value: c }))}
                />
              )}
            </span>
            <span>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Y 轴：
              </Typography.Text>
              {sourceMode !== 'csv' ? (
                <Select
                  aria-label="Y 轴字段"
                  size="small"
                  style={{ width: 150 }}
                  value={yFieldId ?? undefined}
                  onChange={setYFieldId}
                  disabled={aggregate === 'count'}
                  options={curTable?.fields.map((f) => ({ label: f.name, value: f.id })) ?? []}
                />
              ) : (
                <Select
                  aria-label="Y 轴列"
                  size="small"
                  style={{ width: 150 }}
                  value={yCol ?? undefined}
                  onChange={setYCol}
                  disabled={aggregate === 'count'}
                  options={parsed.columns.map((c) => ({ label: c, value: c }))}
                />
              )}
              {aggregate === 'count' && (
                <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>
                  计数无需 Y 轴
                </Typography.Text>
              )}
            </span>
            <span>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                聚合：
              </Typography.Text>
              <Select
                aria-label="聚合方式"
                size="small"
                style={{ width: 110 }}
                value={aggregate}
                onChange={setAggregate}
                options={[
                  { label: '求和', value: 'sum' },
                  { label: '平均', value: 'avg' },
                  { label: '计数', value: 'count' },
                  { label: '原始', value: 'raw' }
                ]}
              />
            </span>
            <span>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                图表：
              </Typography.Text>
              <Segmented
                size="small"
                value={chartType}
                onChange={(v) => setChartType(v as ChartType)}
                options={[
                  { label: '折线', value: 'line' },
                  { label: '柱状', value: 'bar' },
                  { label: '饼图', value: 'pie' }
                ]}
              />
            </span>
            <span>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                显示：
              </Typography.Text>
              <Select
                aria-label="类目数量上限"
                size="small"
                style={{ width: 96 }}
                value={catLimit}
                onChange={setCatLimit}
                options={[
                  { label: 'Top 20', value: 20 },
                  { label: 'Top 60', value: 60 },
                  { label: 'Top 100', value: 100 },
                  { label: 'Top 200', value: 200 }
                ]}
              />
            </span>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {parsed.rows.length} 行数据
            </Typography.Text>
          </Space>

          {/* 更多维度：筛选 / 颜色分组 / 排序 / 堆叠 / 对数轴 / 标签 / 均值线 / 时间粒度 */}
          <Collapse
            size="small"
            className="analytics-advanced"
            items={[
              {
                key: 'advanced',
                label: '更多维度（筛选 / 分组 / 排序 / 外观）',
                children: (
                  <Space direction="vertical" style={{ width: '100%' }} size={10}>
                    {/* 行级筛选 */}
                    <div>
                      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                        行级筛选（按条件过滤后再聚合）
                      </Typography.Text>
                      {filters.map((f, i) => (
                        <Space key={i} wrap style={{ marginBottom: 4 }}>
                          <Select
                            aria-label="筛选列"
                            size="small"
                            style={{ width: 130 }}
                            value={f.column}
                            placeholder="列"
                            onChange={(v) =>
                              setFilters((prev) => prev.map((x, j) => (j === i ? { ...x, column: v } : x)))
                            }
                            options={filterColumnOptions}
                            showSearch
                            optionFilterProp="label"
                          />
                          <Select
                            aria-label="筛选算子"
                            size="small"
                            style={{ width: 96 }}
                            value={f.op}
                            onChange={(v) => setFilters((prev) => prev.map((x, j) => (j === i ? { ...x, op: v } : x)))}
                            options={FILTER_OPS}
                          />
                          <Input
                            aria-label="筛选值"
                            size="small"
                            style={{ width: 120 }}
                            value={f.value}
                            placeholder="值"
                            disabled={f.op === 'isMissing'}
                            onChange={(e) =>
                              setFilters((prev) => prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
                            }
                          />
                          <Button
                            size="small"
                            type="text"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={() => setFilters((prev) => prev.filter((_, j) => j !== i))}
                          />
                        </Space>
                      ))}
                      <Button
                        size="small"
                        icon={<EditOutlined />}
                        onClick={() => setFilters((prev) => [...prev, { column: '', op: 'eq', value: '' }])}
                      >
                        添加筛选条件
                      </Button>
                    </div>
                    {/* 外观与维度 */}
                    <Space wrap>
                      <span>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          颜色分组：
                        </Typography.Text>
                        <Select
                          aria-label="颜色分组维度"
                          size="small"
                          style={{ width: 150 }}
                          value={colorBy ?? undefined}
                          onChange={(v) => setColorBy(v ?? null)}
                          disabled={isTableMode || isKbMode}
                          placeholder={isTableMode || isKbMode ? '表/知识库模式需原始行' : '选择分组列'}
                          options={
                            sourceMode === 'csv'
                              ? parsed.columns.filter((c) => c !== xCol).map((c) => ({ label: c, value: c }))
                              : []
                          }
                        />
                      </span>
                      <span>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          排序：
                        </Typography.Text>
                        <Select
                          aria-label="排序方式"
                          size="small"
                          style={{ width: 110 }}
                          value={sortDir}
                          onChange={(v) => setSortDir(v as SortDir)}
                          options={[
                            { label: '值降序', value: 'desc' },
                            { label: '值升序', value: 'asc' },
                            { label: '原序', value: 'none' }
                          ]}
                        />
                      </span>
                      <span>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          Y 轴：
                        </Typography.Text>
                        <Select
                          aria-label="Y 轴类型"
                          size="small"
                          style={{ width: 96 }}
                          value={yAxisType}
                          onChange={(v) => setYAxisType(v as 'value' | 'log')}
                          options={[
                            { label: '线性', value: 'value' },
                            { label: '对数', value: 'log' }
                          ]}
                        />
                      </span>
                      <Checkbox checked={stack} onChange={(e) => setStack(e.target.checked)} disabled={!isGrouped}>
                        堆叠
                      </Checkbox>
                      <Checkbox checked={normalize} onChange={(e) => setNormalize(e.target.checked)}>
                        百分比
                      </Checkbox>
                      <Checkbox checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)}>
                        数据标签
                      </Checkbox>
                      <Checkbox checked={showAvgLine} onChange={(e) => setShowAvgLine(e.target.checked)} disabled={isGrouped}>
                        均值线
                      </Checkbox>
                      {hasDate && (
                        <span>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            时间粒度：
                          </Typography.Text>
                          <Select
                            aria-label="时间粒度"
                            size="small"
                            style={{ width: 96 }}
                            value={dateGranularity}
                            onChange={(v) => setDateGranularity(v as DateGranularity)}
                            options={[
                              { label: '原始', value: 'auto' },
                              { label: '按年', value: 'year' },
                              { label: '按月', value: 'month' },
                              { label: '按周', value: 'week' },
                              { label: '按日', value: 'day' }
                            ]}
                          />
                        </span>
                      )}
                    </Space>
                  </Space>
                )
              }
            ]}
          />
        </div>
      )}

      <div className="analytics-body">
        {parsed.columns.length > 0 ? (
          <>
            <div className="analytics-chart" ref={chartRef} style={{ height: chartHeight }} />
            <ResizeHandle
              onResize={(d) => setChartHeight((h) => Math.max(200, Math.min(600, h + d)))}
            />
            {stats.length > 0 && parsed.rows.length > 0 && (
              <>
                <div className="analytics-conclusions">
                <div className="analytics-conclusions-header">
                  <Space size={8} wrap>
                    <Typography.Text strong style={{ fontSize: 12 }}>
                      分析结论
                    </Typography.Text>
                    <Select
                      aria-label="结论类型筛选"
                      size="small"
                      style={{ width: 110 }}
                      value={kindFilter}
                      onChange={(v) => setKindFilter(v as ConclusionItem['kind'] | 'all')}
                      options={[
                        { label: '全部', value: 'all' },
                        { label: '概览', value: 'overview' },
                        { label: 'Top', value: 'top' },
                        { label: '极值', value: 'extreme' },
                        { label: '趋势', value: 'trend' },
                        { label: '缺失', value: 'missing' }
                      ]}
                    />
                  </Space>
                  <Space size={4}>
                    <Button
                      size="small"
                      icon={<ReloadOutlined />}
                      title="重置编辑/删除"
                      onClick={() => {
                        setHiddenIds(new Set())
                        setCustomText({})
                        setEditingId(null)
                      }}
                    >
                      重置
                    </Button>
                    <Dropdown
                      menu={{
                        items: [
                          { key: 'md', label: '导出报告 (Markdown)' },
                          { key: 'png', label: '导出图表 (PNG)' },
                          { key: 'csv', label: '导出统计 (CSV)' }
                        ],
                        onClick: ({ key }) => void handleExport(key as 'md' | 'png' | 'csv')
                      }}
                    >
                      <Button size="small" icon={<DownloadOutlined />}>
                        导出分析结果
                      </Button>
                    </Dropdown>
                  </Space>
                </div>
                {displayedConclusions.length > 0 && (
                  <div className="analytics-conclusions-list">
                    {displayedConclusions.map((c) => (
                      <div key={c.id} className={`analytics-conclusion analytics-conclusion-${c.kind}`}>
                        <Tag color={CONCLUSION_COLOR[c.kind]} style={{ marginRight: 6 }}>
                          {CONCLUSION_LABEL[c.kind]}
                        </Tag>
                        {editingId === c.id ? (
                          <Input
                            size="small"
                            autoFocus
                            defaultValue={c.text}
                            onPressEnter={(e) => {
                              const v = (e.target as HTMLInputElement).value.trim()
                              if (v) setCustomText((prev) => ({ ...prev, [c.id]: v }))
                              setEditingId(null)
                            }}
                            onBlur={(e) => {
                              const v = e.target.value.trim()
                              if (v) setCustomText((prev) => ({ ...prev, [c.id]: v }))
                              setEditingId(null)
                            }}
                            style={{ flex: 1 }}
                          />
                        ) : (
                          <span
                            className="analytics-conclusion-text"
                            title="点击编辑"
                            onClick={() => setEditingId(c.id)}
                          >
                            {c.text}
                          </span>
                        )}
                        <Button
                          size="small"
                          type="text"
                          className="analytics-conclusion-act"
                          icon={<EditOutlined />}
                          title="编辑"
                          onClick={() => setEditingId(c.id)}
                        />
                        <Button
                          size="small"
                          type="text"
                          danger
                          className="analytics-conclusion-act"
                          icon={<DeleteOutlined />}
                          title="删除此条"
                          onClick={() =>
                            setHiddenIds((prev) => {
                              const next = new Set(prev)
                              next.add(c.id)
                              return next
                            })
                          }
                        />
                      </div>
                    ))}
                  </div>
                )}
                <Table
                  size="small"
                  dataSource={stats.map((s, i) => ({ key: i, ...s }))}
                  columns={STATS_COLUMNS}
                  pagination={false}
                  scroll={{ x: 'max-content' }}
                />
              </div>
              <ResizeHandle
                onResize={(d) => setPreviewHeight((h) => Math.max(160, Math.min(500, h + d)))}
              />
            </>
          )}
          <div className="analytics-preview" style={{ height: previewHeight }}>
              <Space align="center" style={{ marginBottom: 8 }}>
                <Typography.Text strong style={{ fontSize: 12 }}>
                  数据预览（前
                </Typography.Text>
                <InputNumber
                  aria-label="预览行数"
                  size="small"
                  min={1}
                  max={PREVIEW_MAX}
                  value={previewCount}
                  onChange={(v) => setPreviewCount(Math.min(PREVIEW_MAX, Math.max(1, Math.round(Number(v) || 1))))}
                  style={{ width: 72 }}
                />
                <Typography.Text strong style={{ fontSize: 12 }}>
                  行）
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  最多 {PREVIEW_MAX} 行，仅影响下方预览表，不影响图表统计
                </Typography.Text>
              </Space>
              <Table
                size="small"
                dataSource={parsed.rows.slice(0, previewCount).map((r, i) => ({ key: i, ...r }))}
                columns={previewColumns}
                pagination={false}
                scroll={{ x: 'max-content' }}
              />
            </div>
          </>
        ) : (
          <Empty
            style={{ marginTop: 60 }}
            description={sourceMode === 'csv' ? '粘贴 CSV 数据开始分析' : isKbMode ? '选择知识库表开始分析' : '选择数据库表开始分析'}
          />
        )}
      </div>
    </div>
  )
}
