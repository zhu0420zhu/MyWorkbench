import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Checkbox,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  List,
  message,
  Modal,
  Radio,
  Segmented,
  Select,
  Skeleton,
  Table,
  Tag,
  Typography
} from 'antd'
import {
  DeleteOutlined,
  DownloadOutlined,
  FieldStringOutlined,
  ImportOutlined,
  PlusOutlined,
  TableOutlined
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import * as echarts from 'echarts'
import type { DataTable, FieldType, FieldValue, TableField, TableMeta, TableRow } from '@shared/types'
import { randomUUID } from '@shared/uuid'
import {
  FORMAT_EXT,
  tableToDelimited,
  tableToExcel,
  tableToJson,
  type ImportFormat
} from '../utils/ioFormats'
import { useTheme, resolveAccent } from '../theme/theme'
import { usePrefs } from '../prefs'
import { parseTextImportInWorker, parseExcelImportInWorker } from '../workers/parseClient'
import { capChartData } from '../utils/chart'

type View = 'table' | 'board' | 'chart'

/** 看板单列最多渲染的卡片数：大表全量渲染会一次性创建上万节点导致卡死 */
const MAX_BOARD_CARDS = 200

interface FieldFormValues {
  name: string
  type: FieldType
  options?: string[]
}

interface SidebarItemProps {
  t: TableMeta
  activeId: string | null
  onClick: (id: string) => void
  onRemove: (id: string) => void
}

/** 侧边栏表项：memo 化，避免点击/编辑时整表列表重渲染 */
const SidebarItem = memo(({ t, activeId, onClick, onRemove }: SidebarItemProps) => (
  <List.Item
    className={'automation-item' + (t.id === activeId ? ' active' : '')}
    onClick={() => onClick(t.id)}
  >
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="automation-item-name">{t.name}</div>
      <div className="automation-item-cmd">
        {t.fieldCount} 字段 · {t.rowCount} 行
      </div>
    </div>
    <Button
      type="text"
      size="small"
      danger
      icon={<DeleteOutlined />}
      title="删除表"
      aria-label="删除表"
      onClick={(e) => {
        e.stopPropagation()
        onRemove(t.id)
      }}
    />
  </List.Item>
))

export default function DataLab() {
  const { isDark } = useTheme()
  const { prefs } = usePrefs()
  const accent = resolveAccent(prefs.colorPrimary, isDark)
  const [tables, setTables] = useState<TableMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [active, setActive] = useState<DataTable | null>(null)
  const [tableLoading, setTableLoading] = useState(false)
  const [view, setView] = useState<View>('table')
  const [fieldModal, setFieldModal] = useState(false)
  const [editingField, setEditingField] = useState<TableField | null>(null)
  const [fieldForm] = Form.useForm<FieldFormValues>()
  // 导入大文件（尤其 Excel）是同步解析，没有加载态会让界面长时间无响应、被误认为卡死
  const [importing, setImporting] = useState(false)
  // 两阶段进度：parse=Worker 解析中 / write=SQLite 落库中（后者即 tables.import 单次 IPC）
  const [importPhase, setImportPhase] = useState<'parse' | 'write' | null>(null)

  // 单元格点击即编辑：未编辑时只渲染纯文本，避免宽表一次性挂载上万个可编辑控件导致卡死
  const [editing, setEditing] = useState<{ rowId: string; fieldId: string } | null>(null)
  const editBufferRef = useRef<FieldValue>(null)

  // 图表状态
  const [chartType, setChartType] = useState<'line' | 'bar' | 'pie'>('bar')
  const [xCol, setXCol] = useState<string | null>(null)
  const [yCol, setYCol] = useState<string | null>(null)
  const [aggregate, setAggregate] = useState<'sum' | 'avg' | 'count' | 'raw'>('sum')
  const chartRef = useRef<HTMLDivElement>(null)
  const chartInstance = useRef<echarts.ECharts | null>(null)

  // 当前表（完整行）：切换表时按 id 取，列表只存摘要，避免大表整表跨进程传输
  const loadedIdRef = useRef<string | null>(null)
  const activeRef = useRef<DataTable | null>(null)
  useEffect(() => {
    activeRef.current = active
  }, [active])

  useEffect(() => {
    if (!activeId) {
      loadedIdRef.current = null
      setActive(null)
      setTableLoading(false)
      return
    }
    // 已持有该表（如刚导入完 setActive(full) 又 setActiveId 触发本 effect）则跳过冗余回读
    if (loadedIdRef.current === activeId) {
      setTableLoading(false)
      return
    }
    let cancelled = false
    setTableLoading(true)
    window.api.tables
      .get(activeId)
      .then((t) => {
        if (cancelled) return
        loadedIdRef.current = activeId
        setActive(t)
      })
      .catch(() => {
        if (!cancelled) setActive(null)
      })
      .finally(() => {
        if (!cancelled) setTableLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeId])

  const load = useCallback(async () => {
    try {
      setTables(await window.api.tables.list())
    } catch {
      message.error('加载数据失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const persist = useCallback(async (next: DataTable) => {
    setTables((prev) => prev.map((t) => (t.id === next.id ? { ...t, fieldCount: next.fields.length, rowCount: next.rows.length, updatedAt: next.updatedAt } : t)))
    setActive(next)
    try {
      await window.api.tables.update(next)
    } catch {
      message.error('保存失败')
    }
  }, [])

  /* 单元格编辑：乐观更新 + 单元格级 400ms 防抖写盘（仅传 4 个标量，避免整表跨进程传输） */
  const cellPendingRef = useRef<{ rowId: string; fieldId: string; value: FieldValue } | null>(null)
  const cellTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const scheduleCellPersist = (rowId: string, fieldId: string, value: FieldValue): void => {
    if (!activeId) return
    cellPendingRef.current = { rowId, fieldId, value }
    clearTimeout(cellTimer.current)
    cellTimer.current = setTimeout(() => {
      const p = cellPendingRef.current
      cellPendingRef.current = null
      if (!p || !activeId) return
      void window.api.tables
        .updateCell(activeId, p.rowId, p.fieldId, p.value)
        .then(setTables)
        .catch(() => message.error('保存失败'))
    }, 400)
  }

  /* ---------- 导入 ---------- */
  const handleImport = async (format: ImportFormat): Promise<void> => {
    try {
      const file = await window.api.pickBufferFile()
      if (!file) return
      setImporting(true)
      setImportPhase('parse')
      // 先让「解析中」上屏，再执行同步解析
      await new Promise((r) => setTimeout(r, 0))
      // 全部格式的解码 + 解析都在 Worker 中进行，百万行/大工作簿导入期间主线程不冻结
      const parsed =
        format === 'excel'
          ? (await parseExcelImportInWorker(file.data, file.name)).table
          : (await parseTextImportInWorker(file.data, 'auto', file.name, format)).table
      const baseName = file.name.replace(/\.(csv|json|tsv|xlsx|xls)$/i, '')
      // 落库前让「写入中」上屏（大表 SQLite 写入是秒级重活）
      setImportPhase('write')
      await new Promise((r) => setTimeout(r, 0))
      // 单次 IPC + 主进程单事务落库：替代旧链路 create→update 的二次整表传输与二次写盘
      const res = await window.api.tables.import({
        name: baseName || '导入数据',
        fields: parsed.fields,
        rows: parsed.rows
      })
      const meta = res.metas.find((m) => m.id === res.id)
      // 不预置 loadedIdRef：让 activeId 变更 effect 回读新表（本地 SQLite 读回毫秒级）
      setTables(res.metas)
      setActiveId(res.id)
      message.success(`已导入：${file.name}（${meta?.rowCount ?? parsed.rows.length} 行）`)
      if ((meta?.rowCount ?? parsed.rows.length) > 20000) {
        message.warning('数据量较大，看板视图仅展示前 200 张卡片，完整数据请用表格视图分页查看')
      }
    } catch (err) {
      message.error('导入失败：' + (err as Error).message)
    } finally {
      setImporting(false)
      setImportPhase(null)
    }
  }

  /* ---------- 导出 ---------- */
  const handleExport = async (format: ImportFormat): Promise<void> => {
    if (!active) return
    try {
      if (format === 'excel') {
        const buf = tableToExcel(active)
        const saved = await window.api.exportBuffer(active.name + '.xlsx', new Uint8Array(buf))
        if (saved) message.success('已导出：' + saved)
      } else if (format === 'json') {
        const saved = await window.api.exportText(active.name + '.json', tableToJson(active))
        if (saved) message.success('已导出：' + saved)
      } else {
        const delim = format === 'tsv' ? '\t' : ','
        const saved = await window.api.exportText(active.name + '.' + FORMAT_EXT[format], tableToDelimited(active, delim))
        if (saved) message.success('已导出：' + saved)
      }
    } catch (err) {
      message.error('导出失败：' + (err as Error).message)
    }
  }

  /* ---------- 表操作 ---------- */
  const handleCreate = async (): Promise<void> => {
    try {
      const list = await window.api.tables.create('新表')
      setTables(list)
      if (list.length > 0) setActiveId(list[0].id)
    } catch {
      message.error('创建失败')
    }
  }

  const handleRemove = useCallback(async (id: string): Promise<void> => {
    const t = tables.find((x) => x.id === id)
    Modal.confirm({
      title: '删除数据表',
      content: `确定删除「${t?.name ?? '该表'}」吗？表中的所有数据将不可恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const list = await window.api.tables.remove(id)
          setTables(list)
          if (activeId === id) setActiveId(null)
          message.success('已删除')
        } catch {
          message.error('删除失败')
        }
      }
    })
  }, [tables, activeId])

  const removeRow = useCallback((rowId: string): void => {
    const cur = activeRef.current
    if (!cur) return
    Modal.confirm({
      title: '删除数据行',
      content: '确定删除该行吗？此操作不可撤销。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => {
        persist({ ...cur, rows: cur.rows.filter((r) => r.id !== rowId) })
        message.success('已删除')
      }
    })
  }, [])

  /* 表名重命名：乐观更新 + 400ms 防抖写盘 */
  const nameTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const handleRename = (name: string): void => {
    if (!active) return
    setTables((prev) => prev.map((t) => (t.id === active.id ? { ...t, name } : t)))
    clearTimeout(nameTimer.current)
    nameTimer.current = setTimeout(() => {
      void persist({ ...active, name })
    }, 400)
  }

  const updateCell = (rowId: string, fieldId: string, value: FieldValue): void => {
    if (!active) return
    const next: DataTable = {
      ...active,
      rows: active.rows.map((r) => (r.id === rowId ? { ...r, values: { ...r.values, [fieldId]: value } } : r))
    }
    setActive(next)
    scheduleCellPersist(rowId, fieldId, value)
  }

  const addRow = (): void => {
    if (!active) return
    persist({ ...active, rows: [...active.rows, { id: randomUUID(), values: {} }] })
  }

  const handleFieldSubmit = async (values: FieldFormValues): Promise<void> => {
    if (!active) return
    const field: TableField = {
      id: editingField?.id ?? randomUUID(),
      name: values.name.trim() || '未命名字段',
      type: values.type,
      options: values.type === 'select' ? values.options?.filter(Boolean) : undefined
    }
    const fields = editingField ? active.fields.map((f) => (f.id === field.id ? field : f)) : [...active.fields, field]
    persist({ ...active, fields })
    setFieldModal(false)
    setEditingField(null)
    message.success('字段已保存')
  }

  const removeField = (fieldId: string): void => {
    if (!active) return
    persist({
      ...active,
      fields: active.fields.filter((f) => f.id !== fieldId),
      rows: active.rows.map((r) => {
        const values = { ...r.values }
        delete values[fieldId]
        return { ...r, values }
      })
    })
  }

  /* ---------- 表格视图 ---------- */
  const commitEdit = (): void => {
    if (editing) updateCell(editing.rowId, editing.fieldId, editBufferRef.current)
    setEditing(null)
  }

  const renderCell = (field: TableField, row: TableRow) => {
    const value = row.values[field.id]
    const isEditing = editing?.rowId === row.id && editing?.fieldId === field.id
    const display = value === null || value === undefined || value === '' ? '' : String(value)

    if (isEditing) {
      switch (field.type) {
        case 'number':
          return (
            <InputNumber
              autoFocus
              aria-label={field.name}
              defaultValue={typeof value === 'number' ? value : undefined}
              onChange={(v) => {
                editBufferRef.current = v ?? null
              }}
              onBlur={commitEdit}
              onPressEnter={commitEdit}
              style={{ width: '100%' }}
              size="small"
            />
          )
        case 'select':
          return (
            <Select
              autoFocus
              aria-label={field.name}
              defaultValue={typeof value === 'string' ? value : undefined}
              onChange={(v) => {
                updateCell(row.id, field.id, v ?? null)
                setEditing(null)
              }}
              options={(field.options ?? []).map((o) => ({ label: o, value: o }))}
              allowClear
              size="small"
              style={{ minWidth: 120 }}
              placeholder="选择…"
            />
          )
        case 'checkbox':
          return <Checkbox autoFocus checked={value === true} onChange={(e) => updateCell(row.id, field.id, e.target.checked)} />
        case 'date':
        case 'text':
        default:
          return (
            <Input
              autoFocus
              aria-label={field.name}
              defaultValue={typeof value === 'string' ? value : ''}
              onBlur={(e) => {
                updateCell(row.id, field.id, e.target.value || null)
                setEditing(null)
              }}
              onPressEnter={(e) => {
                updateCell(row.id, field.id, e.currentTarget.value || null)
                setEditing(null)
              }}
              size="small"
            />
          )
      }
    }

    // 展示态
    if (field.type === 'checkbox') {
      return (
        <span
          className="cell-check"
          role="checkbox"
          aria-checked={value === true}
          aria-label={field.name}
          title="点击切换"
          onClick={(e) => {
            e.stopPropagation()
            updateCell(row.id, field.id, value === true ? false : true)
          }}
        >
          {value === true ? '✓' : ''}
        </span>
      )
    }
    return (
      <div
        className="cell-display"
        title="点击编辑"
        onClick={(e) => {
          e.stopPropagation()
          setEditing({ rowId: row.id, fieldId: field.id })
        }}
      >
        {display || <span className="cell-placeholder">—</span>}
      </div>
    )
  }

  const columns: ColumnsType<TableRow> = useMemo(() => {
    const cols: ColumnsType<TableRow> = (active?.fields ?? []).map((f) => ({
      title: (
        <span>
          {f.name}
          <Tag style={{ marginInlineStart: 4 }}>{f.type}</Tag>
        </span>
      ),
      dataIndex: ['values', f.id],
      key: f.id,
      render: (_: unknown, row: TableRow) => renderCell(f, row),
      ellipsis: true,
      sorter:
        f.type === 'number'
          ? (a: TableRow, b: TableRow) => Number(a.values[f.id] ?? 0) - Number(b.values[f.id] ?? 0)
          : f.type === 'date' || f.type === 'text' || f.type === 'select'
            ? (a: TableRow, b: TableRow) => String(a.values[f.id] ?? '').localeCompare(String(b.values[f.id] ?? ''))
            : undefined
    }))
    cols.push({
      title: '',
      key: '__ops',
      width: 48,
      fixed: 'right',
      render: (_: unknown, row: TableRow) => (
        <Button
          type="text"
          size="small"
          danger
          icon={<DeleteOutlined />}
          title="删除该行"
          aria-label="删除该行"
          onClick={() => removeRow(row.id)}
        />
      )
    })
    return cols
    // removeRow 已用 activeRef 保持最新 active，因此列定义不再依赖 active 引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.fields, editing, removeRow])

  /* ---------- 看板 ---------- */
  const groupField = active?.fields.find((f) => f.type === 'select') ?? null
  const groupOptions = useMemo(() => {
    if (!groupField || !active) return []
    const used = new Set<string>()
    active.rows.forEach((r) => {
      const v = r.values[groupField.id]
      if (typeof v === 'string' && v) used.add(v)
    })
    return [...new Set([...(groupField.options ?? []), ...used])]
  }, [groupField, active])

  const boardGroups = useMemo(() => {
    if (!groupField || !active) return []
    return groupOptions.map((opt) => ({ option: opt, rows: active.rows.filter((r) => r.values[groupField.id] === opt) }))
  }, [groupField, groupOptions, active])

  const firstTextField = active?.fields.find((f) => f.type === 'text')

  /* ---------- 图表 ---------- */
  const chartData = useMemo(() => {
    if (!active || !xCol || !yCol) return []
    const xField = active.fields.find((f) => f.name === xCol)
    const yField = active.fields.find((f) => f.name === yCol)
    if (!xField || !yField) return []
    const map = new Map<string, { sum: number; count: number }>()
    for (const r of active.rows) {
      const xv = String(r.values[xField.id] ?? '')
      const yv = Number(r.values[yField.id])
      if (isNaN(yv)) continue
      const e = map.get(xv) ?? { sum: 0, count: 0 }
      e.sum += yv
      e.count++
      map.set(xv, e)
    }
    if (aggregate === 'raw') {
      return active.rows.map((r) => {
        const yv = Number(r.values[yField.id])
        return isNaN(yv) ? null : { name: String(r.values[xField.id] ?? ''), value: yv }
      }).filter((x): x is { name: string; value: number } => x !== null)
    }
    return [...map.entries()].map(([name, e]) => {
      let value = e.sum
      if (aggregate === 'avg') value = e.sum / e.count
      else if (aggregate === 'count') value = e.count
      return { name, value: Number(value.toFixed(4)) }
    })
  }, [active, xCol, yCol, aggregate])

  useEffect(() => {
    if (!chartRef.current) return
    if (!chartInstance.current) chartInstance.current = echarts.init(chartRef.current)
    const chart = chartInstance.current
    if (chartData.length === 0) {
      chart.clear()
      chart.setOption({ title: { text: '暂无数据', left: 'center', top: 'center', textStyle: { fontWeight: 'normal' } } })
      return
    }
    // 高基数 X 轴会令 ECharts 渲染上万柱/标签导致卡死，截断类目。
    const data = capChartData(chartData, 60, aggregate !== 'raw')
    const xLabel = data.length > 12 ? 30 : 0
    const option: echarts.EChartsOption = { animation: false }
    if (chartType === 'pie') {
      option.tooltip = { trigger: 'item' }
      option.legend = { type: 'scroll', bottom: 0 }
      option.series = [{ type: 'pie', radius: ['35%', '70%'], data, label: { formatter: '{b}: {c}' } }]
    } else {
      option.tooltip = { trigger: 'axis' }
      option.grid = { left: 48, right: 24, top: 32, bottom: 48 }
      option.xAxis = { type: 'category', data: data.map((d) => d.name), axisLabel: { interval: 'auto', hideOverlap: true, rotate: xLabel } }
      option.yAxis = { type: 'value' }
      option.series = [{ type: chartType, data: data.map((d) => d.value), itemStyle: { color: accent }, smooth: chartType === 'line' }]
    }
    chart.setOption(option)
  }, [chartData, chartType, accent])

  useEffect(() => {
    const onResize = (): void => chartInstance.current?.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chartInstance.current?.dispose()
      chartInstance.current = null
    }
  }, [])

  // 切换表/字段后重置失效的图表列
  useEffect(() => {
    if (!active) return
    const names = active.fields.map((f) => f.name)
    setXCol((cur) => (cur && names.includes(cur) ? cur : (active.fields[0]?.name ?? null)))
    setYCol((cur) => {
      if (cur && names.includes(cur)) return cur
      return (active.fields.find((f) => f.type === 'number')?.name ?? active.fields[1]?.name ?? null)
    })
  }, [active])

  const importItems = [
    { key: 'csv', label: 'CSV 文件' },
    { key: 'tsv', label: 'TSV 文件' },
    { key: 'json', label: 'JSON 文件' },
    { key: 'excel', label: 'Excel 文件' }
  ].map((x) => ({ key: x.key, label: x.label, onClick: () => void handleImport(x.key as ImportFormat) }))

  const exportItems = [
    { key: 'csv', label: '导出 CSV' },
    { key: 'tsv', label: '导出 TSV' },
    { key: 'json', label: '导出 JSON' },
    { key: 'excel', label: '导出 Excel' }
  ].map((x) => ({ key: x.key, label: x.label, onClick: () => void handleExport(x.key as ImportFormat) }))

  return (
    <div className="databases-page">
      <div className="databases-list">
        <div className="notes-list-header">
          <Typography.Text strong>数据整理</Typography.Text>
          <Button type="text" size="small" icon={<PlusOutlined />} onClick={handleCreate} title="新建表" />
        </div>
        <div className="automations-list-body">
          {loading ? (
            <Skeleton active paragraph={{ rows: 6 }} />
          ) : tables.length === 0 ? (
            <Empty description="暂无表" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <List
              dataSource={tables}
              renderItem={(t) => (
                <SidebarItem
                  t={t}
                  activeId={activeId}
                  onClick={setActiveId}
                  onRemove={handleRemove}
                />
              )}
            />
          )}
        </div>
      </div>

      <div className="databases-detail">
        {activeId && tableLoading && !active ? (
          <Skeleton active paragraph={{ rows: 8 }} />
        ) : active ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <Input
                aria-label="表名称"
                value={active.name}
                onChange={(e) => handleRename(e.target.value)}
                style={{ width: 180, fontWeight: 600 }}
                size="small"
              />
              <Segmented
                size="small"
                value={view}
                onChange={(v) => setView(v as View)}
                options={[
                  { label: '表格', value: 'table' },
                  { label: '看板', value: 'board', disabled: !groupField },
                  { label: '图表', value: 'chart' }
                ]}
              />
              <Dropdown menu={{ items: importItems }}>
                <Button size="small" icon={<ImportOutlined />} loading={importing}>
                  {importing ? (importPhase === 'write' ? '写入中…' : '解析中…') : '导入'}
                </Button>
              </Dropdown>
              <Dropdown menu={{ items: exportItems }}>
                <Button size="small" icon={<DownloadOutlined />}>
                  导出
                </Button>
              </Dropdown>
              <Button size="small" icon={<PlusOutlined />} onClick={addRow}>
                添加行
              </Button>
              <Button
                size="small"
                icon={<FieldStringOutlined />}
                onClick={() => {
                  setEditingField(null)
                  fieldForm.resetFields()
                  setFieldModal(true)
                }}
              >
                添加字段
              </Button>
            </div>

            {view === 'table' && (
              <div className="databases-table-wrap">
                <Table
                  size="small"
                  rowKey="id"
                  dataSource={active.rows}
                  columns={columns}
                  pagination={{ pageSize: 50, showSizeChanger: true, pageSizeOptions: [20, 50, 100, 200] }}
                  locale={{ emptyText: '还没有数据行，点击「添加行」' }}
                  scroll={{ x: 'max-content' }}
                />
              </div>
            )}

            {view === 'board' && (
              <div className="board-container">
                {boardGroups.map((g) => (
                  <div key={g.option} className="board-column">
                    <div className="board-column-header">
                      <Tag color="processing">{g.option}</Tag>
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        {g.rows.length}
                      </Typography.Text>
                    </div>
                    <div className="board-column-body">
                      {g.rows.length === 0 ? (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          空
                        </Typography.Text>
                      ) : (
                        <>
                          {g.rows.slice(0, MAX_BOARD_CARDS).map((r) => (
                            <div key={r.id} className="board-card">
                              <div className="board-card-title">
                                {firstTextField ? (r.values[firstTextField.id] as string) || '（无标题）' : r.id.slice(0, 8)}
                              </div>
                              {active.fields
                                .filter((f) => f.type !== 'text' && f.id !== groupField?.id)
                                .slice(0, 3)
                                .map((f) => {
                                  const v = r.values[f.id]
                                  if (v === null || v === undefined || v === '') return null
                                  return (
                                    <div key={f.id} className="board-card-field">
                                      <span>
                                        {f.name}: {String(v)}
                                      </span>
                                    </div>
                                  )
                                })}
                            </div>
                          ))}
                          {g.rows.length > MAX_BOARD_CARDS && (
                            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                              仅显示前 {MAX_BOARD_CARDS} 张，共 {g.rows.length} 张
                            </Typography.Text>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {view === 'chart' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0 }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    X 轴：
                  </Typography.Text>
                  <Select aria-label="X 轴列" size="small" style={{ width: 140 }} value={xCol ?? undefined} onChange={setXCol} options={active.fields.map((f) => ({ label: f.name, value: f.name }))} />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Y 轴：
                  </Typography.Text>
                  <Select aria-label="Y 轴列" size="small" style={{ width: 140 }} value={yCol ?? undefined} onChange={setYCol} options={active.fields.map((f) => ({ label: f.name, value: f.name }))} />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    聚合：
                  </Typography.Text>
                  <Select
                    aria-label="聚合方式"
                    size="small"
                    style={{ width: 100 }}
                    value={aggregate}
                    onChange={setAggregate}
                    options={[
                      { label: '求和', value: 'sum' },
                      { label: '平均', value: 'avg' },
                      { label: '计数', value: 'count' },
                      { label: '原始', value: 'raw' }
                    ]}
                  />
                  <Segmented
                    size="small"
                    value={chartType}
                    onChange={(v) => setChartType(v as 'line' | 'bar' | 'pie')}
                    options={[
                      { label: '折线', value: 'line' },
                      { label: '柱状', value: 'bar' },
                      { label: '饼图', value: 'pie' }
                    ]}
                  />
                </div>
                <div className="analytics-chart" ref={chartRef} style={{ flex: 1 }} />
              </div>
            )}
          </>
        ) : (
          <Empty style={{ marginTop: 120 }} description="选择左侧表、新建表，或导入 CSV / Excel 数据" />
        )}
      </div>

      <Modal
        title={editingField ? '编辑字段' : '添加字段'}
        open={fieldModal}
        onCancel={() => {
          setFieldModal(false)
          setEditingField(null)
        }}
        onOk={() => fieldForm.submit()}
        okText="保存"
        cancelText="取消"
        width={420}
      >
        <Form form={fieldForm} layout="vertical" initialValues={{ type: 'text', options: ['选项1', '选项2'] }} onFinish={handleFieldSubmit}>
          <Form.Item name="name" label="字段名" rules={[{ required: true, message: '请输入字段名' }]}>
            <Input maxLength={20} />
          </Form.Item>
          <Form.Item name="type" label="类型">
            <Select
              options={[
                { label: '文本', value: 'text' },
                { label: '数字', value: 'number' },
                { label: '单选', value: 'select' },
                { label: '日期', value: 'date' },
                { label: '勾选', value: 'checkbox' }
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p, c) => p.type !== c.type}>
            {({ getFieldValue }) =>
              getFieldValue('type') === 'select' ? (
                <Form.Item name="options" label="选项列表">
                  <Select mode="tags" placeholder="输入选项后回车" />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          {editingField && (
            <Button danger size="small" onClick={() => removeField(editingField.id)}>
              删除此字段
            </Button>
          )}
        </Form>
      </Modal>
    </div>
  )
}
