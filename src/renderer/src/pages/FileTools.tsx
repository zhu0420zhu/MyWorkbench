import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  Input,
  Tabs,
  Typography,
  Progress,
  Table,
  Tag,
  Space,
  message,
  Empty,
  Switch,
  Select,
  List,
  Alert,
  Collapse,
  Card,
  Modal,
  Segmented
} from 'antd'
import {
  FolderOpenOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined,
  StopOutlined,
  DeleteOutlined,
  FileSearchOutlined,
  CopyOutlined,
  PartitionOutlined,
  SwapOutlined
} from '@ant-design/icons'
import ImageTools from './ImageTools'
import VideoTools from './VideoTools'
import HardwareTools from './HardwareTools'

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`
  return `${bytes} B`
}

/* 类型别名：直接取自 window.api.tools 的全局声明（避免引入 preload 模块） */
type Disks = Awaited<ReturnType<typeof window.api.tools.getAllDisks>>
type Analysis = Awaited<ReturnType<typeof window.api.tools.analyzeDirectory>>
type DupResult = Awaited<ReturnType<typeof window.api.tools.findDuplicates>>
type Watched = Awaited<ReturnType<typeof window.api.tools.watcher.list>>
type Evt = Parameters<Parameters<typeof window.api.tools.watcher.onEvent>[0]>[0]

/* ---------- 磁盘信息 ---------- */
function DiskSection() {
  const [disks, setDisks] = useState<Disks>([])
  const [loading, setLoading] = useState(false)

  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      setDisks(await window.api.tools.getAllDisks())
    } catch (err) {
      message.error(`获取磁盘信息失败：${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Button size="small" icon={<FolderOpenOutlined />} onClick={() => void load()} loading={loading}>
          刷新磁盘
        </Button>
      </Space>
      {disks.length === 0 ? (
        <Empty description="未获取到磁盘信息" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 720 }}>
          {disks.map((d) => (
            <div
              key={d.path}
              style={{
                border: '1px solid var(--border-color, rgba(128,128,128,.25))',
                borderRadius: 8,
                padding: '10px 14px'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography.Text strong>{d.path}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {d.used_formatted} / {d.total_formatted}（可用 {d.free_formatted}）
                </Typography.Text>
              </div>
              <Progress
                percent={d.percent_used}
                size="small"
                status={d.percent_used > 90 ? 'exception' : 'normal'}
                style={{ marginTop: 6 }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------- 目录分析 ---------- */
function AnalyzeSection() {
  const [dir, setDir] = useState('')
  const [recursive, setRecursive] = useState(true)
  const [minSize, setMinSize] = useState(50)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<Analysis | null>(null)

    const pickDir = async (): Promise<void> => {
    const dir = await window.api.data.pickDir('选择目录')
    if (dir) setDir(dir)
  }

const analyze = async (): Promise<void> => {
    if (!dir.trim()) {
      message.warning('请输入要分析的目录路径')
      return
    }
    setLoading(true)
    try {
      const r = await window.api.tools.analyzeDirectory(dir.trim(), recursive, minSize * 1024 * 1024)
      setResult(r)
    } catch (err) {
      message.error(`分析失败：${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <Input
          aria-label="目录路径"
          size="small"
          placeholder="目录路径，如 C:\Users\me\Downloads"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          style={{ width: 320 }}
          onPressEnter={() => void analyze()}
        />
        <Button size="small" icon={<FolderOpenOutlined />} onClick={() => void pickDir()}>
          选择目录
        </Button>
        <Switch size="small" checked={recursive} onChange={setRecursive} checkedChildren="递归" unCheckedChildren="仅当前" />
        <Input
          aria-label="大文件阈值（MB）"
          size="small"
          type="number"
          placeholder="大文件阈值 MB"
          value={String(minSize)}
          onChange={(e) => setMinSize(Number(e.target.value) || 50)}
          style={{ width: 120 }}
        />
        <Button size="small" type="primary" icon={<FileSearchOutlined />} onClick={() => void analyze()} loading={loading}>
          分析目录
        </Button>
      </Space>

      {result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Space>
            <Typography.Text strong>总大小：{result.total_size_formatted}</Typography.Text>
            <Typography.Text type="secondary">
              {result.category_stats.reduce((s, c) => s + c.count, 0)} 个文件 · 大文件 {result.large_file_count} 个
            </Typography.Text>
          </Space>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <Table
              size="small"
              style={{ flex: 1, minWidth: 380 }}
              title={() => <Typography.Text strong>类别分布</Typography.Text>}
              rowKey="category"
              dataSource={result.category_stats}
              pagination={false}
              columns={[
                { title: '类别', dataIndex: 'category', render: (v: string) => v },
                { title: '数量', dataIndex: 'count', width: 70 },
                { title: '大小', dataIndex: 'size_formatted', width: 100 },
                {
                  title: '占比',
                  dataIndex: 'percent',
                  width: 90,
                  render: (v: number) => `${v}%`
                }
              ]}
            />
            <Table
              size="small"
              style={{ flex: 1, minWidth: 380 }}
              title={() => <Typography.Text strong>后缀分布（前 10）</Typography.Text>}
              rowKey="extension"
              dataSource={result.extension_stats.slice(0, 10)}
              pagination={false}
              columns={[
                { title: '后缀', dataIndex: 'extension', render: (v: string) => <Tag>{v || '(无后缀)'}</Tag> },
                { title: '数量', dataIndex: 'count', width: 70 },
                { title: '大小', dataIndex: 'size_formatted', width: 100 },
                { title: '占比', dataIndex: 'percent', width: 90, render: (v: number) => `${v}%` }
              ]}
            />
          </div>
          {result.large_files.length > 0 && (
            <Table
              size="small"
              title={() => <Typography.Text strong>大文件（≥{minSize}MB）</Typography.Text>}
              rowKey="path"
              dataSource={result.large_files}
              pagination={{ pageSize: 10 }}
              columns={[
                { title: '文件名', dataIndex: 'name' },
                {
                  title: '大小',
                  dataIndex: 'size_formatted',
                  width: 110,
                  render: (v: string) => <Typography.Text strong>{v}</Typography.Text>
                },
                { title: '路径', dataIndex: 'path', ellipsis: true }
              ]}
            />
          )}
        </div>
      )}
    </div>
  )
}

/* ---------- 重复检测 ---------- */
function DuplicateSection() {
  const [dir, setDir] = useState('')
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [result, setResult] = useState<DupResult | null>(null)

    const pickDir = async (): Promise<void> => {
    const dir = await window.api.data.pickDir('选择目录')
    if (dir) setDir(dir)
  }

  const scan = async (): Promise<void> => {
    if (!dir.trim()) {
      message.warning('请输入要扫描的目录路径')
      return
    }
    setLoading(true)
    try {
      const r = await window.api.tools.findDuplicates(dir.trim(), { minSize: 1 })
      setResult(r)
    } catch (err) {
      message.error(`扫描失败：${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  /** 删除全部重复项（每组保留建议项），统一入回收站 */
  const deleteDuplicates = async (): Promise<void> => {
    if (!result) return
    const targets = result.groups.flatMap((g) => g.files.filter((f) => f !== g.keep))
    if (targets.length === 0) {
      message.info('没有可删除的重复项')
      return
    }
    Modal.confirm({
      title: '删除重复文件',
      content: `将删除 ${targets.length} 个重复文件（每组保留「建议保留」项），文件将移入回收站。确定继续吗？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setDeleting(true)
        let ok = 0
        try {
          for (const p of targets) {
            if (await window.api.tools.deleteFile(p, true)) ok++
          }
          message.success(`已删除 ${ok}/${targets.length} 个重复文件（入回收站）`)
          setResult(null)
          await scan()
        } catch (err) {
          message.error('删除失败：' + (err as Error).message)
        } finally {
          setDeleting(false)
        }
      }
    })
  }

  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <Input
          aria-label="目录路径"
          size="small"
          placeholder="目录路径"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          style={{ width: 320 }}
          onPressEnter={() => void scan()}
        />
        <Button size="small" icon={<FolderOpenOutlined />} onClick={() => void pickDir()}>
          选择目录
        </Button>
        <Button size="small" type="primary" icon={<CopyOutlined />} onClick={() => void scan()} loading={loading}>
          检测重复文件
        </Button>
        {result && result.groups.length > 0 && (
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => void deleteDuplicates()} loading={deleting}>
            删除重复项
          </Button>
        )}
      </Space>

      {result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Space>
            <Tag color="orange">重复组 {result.total_groups}</Tag>
            <Tag color="red">可删 {result.total_duplicates} 个</Tag>
            <Tag color="green">可节省 {result.total_savings >= 1024 * 1024 * 1024 ? `${(result.total_savings / 1024 / 1024 / 1024).toFixed(2)} GB` : `${(result.total_savings / 1024 / 1024).toFixed(2)} MB`}</Tag>
          </Space>
          {result.groups.length === 0 ? (
            <Empty description="未发现重复文件" />
          ) : (
            <Table
              size="small"
              rowKey={(_, i) => String(i)}
              dataSource={result.groups}
              pagination={{ pageSize: 10 }}
              expandable={{
                expandedRowRender: (g) => (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {g.files.map((f) => (
                      <div key={f}>
                        {f === g.keep ? <Tag color="green">保留</Tag> : <Tag color="red">删除</Tag>}
                        <Typography.Text code style={{ fontSize: 12 }}>{f}</Typography.Text>
                      </div>
                    ))}
                  </div>
                )
              }}
              columns={[
                { title: '组', render: (_v, _r, i) => i + 1, width: 50 },
                {
                  title: '文件数',
                  dataIndex: 'files',
                  width: 80,
                  render: (files: string[]) => files.length
                },
                {
                  title: '相似度',
                  dataIndex: 'similarity',
                  width: 90,
                  render: (v: number) => (v >= 1 ? '完全相同' : `${(v * 100).toFixed(0)}%`)
                },
                {
                  title: '大小',
                  dataIndex: 'size',
                  width: 100,
                  render: (v: number) => (v >= 1024 * 1024 ? `${(v / 1024 / 1024).toFixed(2)} MB` : `${v} B`)
                },
                {
                  title: '节省空间',
                  dataIndex: 'savings',
                  width: 100,
                  render: (v: number) => (v >= 1024 * 1024 ? `${(v / 1024 / 1024).toFixed(2)} MB` : `${v} B`)
                },
                {
                  title: '建议保留',
                  dataIndex: 'keep',
                  ellipsis: true,
                  render: (v: string) => <Typography.Text style={{ fontSize: 12 }}>{v?.split(/[\\/]/).pop()}</Typography.Text>
                }
              ]}
            />
          )}
        </div>
      )}
    </div>
  )
}

/* ---------- 文件监控 ---------- */
function WatcherSection() {
  const [dir, setDir] = useState('')
  const [running, setRunning] = useState(false)
  const [paused, setPaused] = useState(false)
  const [events, setEvents] = useState<Evt[]>([])
  const [watched, setWatched] = useState<Watched>([])

  const refresh = async (): Promise<void> => {
    try {
      setWatched(await window.api.tools.watcher.list())
    } catch (err) {
      message.error('获取监控目录失败：' + (err as Error).message)
    }
  }

  useEffect(() => {
    void refresh()
    const off = window.api.tools.watcher.onEvent((e) => {
      setEvents((list) => [e, ...list].slice(0, 100))
    })
    return off
  }, [])

    const pickDir = async (): Promise<void> => {
    const dir = await window.api.data.pickDir('选择目录')
    if (dir) setDir(dir)
  }

const addDir = async (): Promise<void> => {
    if (!dir.trim()) {
      message.warning('请输入要监控的目录路径')
      return
    }
    const ok = await window.api.tools.watcher.add(dir.trim())
    if (ok) {
      message.success('已添加监控目录')
      setDir('')
      void refresh()
    } else {
      message.error('目录不存在或已监控')
    }
  }

  /** 移除一个监控目录：主进程会从被监控集合中删除，轮询时不再扫描它（可重新添加，故不做二次确认） */
  const removeDir = async (path: string): Promise<void> => {
    try {
      const ok = await window.api.tools.watcher.remove(path)
      if (ok) {
        message.success('已移除监控目录')
        await refresh()
      } else {
        message.error('移除失败：该目录不在监控列表中')
      }
    } catch (err) {
      message.error('移除失败：' + (err as Error).message)
    }
  }

  const start = async (): Promise<void> => {
    await window.api.tools.watcher.start()
    setRunning(true)
    setPaused(false)
    message.success('监控已启动')
  }
  const stop = async (): Promise<void> => {
    await window.api.tools.watcher.stop()
    setRunning(false)
    setPaused(false)
    message.success('监控已停止')
  }
  const pause = async (): Promise<void> => {
    await window.api.tools.watcher.pause()
    setPaused(true)
  }
  const resume = async (): Promise<void> => {
    await window.api.tools.watcher.resume()
    setPaused(false)
  }

  const eventColor = (t: string): string =>
    t === 'created' ? 'green' : t === 'deleted' ? 'red' : t === 'modified' ? 'blue' : 'default'

  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <Input
          aria-label="监控目录路径"
          size="small"
          placeholder="要监控的目录路径"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          style={{ width: 300 }}
          onPressEnter={() => void addDir()}
        />
        <Button size="small" icon={<FolderOpenOutlined />} onClick={() => void pickDir()}>
          选择目录
        </Button>
        <Button size="small" onClick={() => void addDir()}>
          添加目录
        </Button>
        <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={() => void start()} disabled={running}>
          启动
        </Button>
        <Button size="small" icon={<PauseCircleOutlined />} onClick={() => void (paused ? resume() : pause())} disabled={!running}>
          {paused ? '恢复' : '暂停'}
        </Button>
        <Button size="small" danger icon={<StopOutlined />} onClick={() => void stop()} disabled={!running}>
          停止
        </Button>
        <Button size="small" icon={<DeleteOutlined />} onClick={() => setEvents([])}>
          清空事件
        </Button>
      </Space>

      <div style={{ marginBottom: 12 }}>
        <Typography.Text type="secondary">监控目录：</Typography.Text>
        {watched.length === 0 ? (
          <Typography.Text type="secondary">（无）</Typography.Text>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
            {watched.map((w) => (
              <div key={w.path} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Tag style={{ margin: 0 }}>{w.name}</Tag>
                <Typography.Text code style={{ fontSize: 12 }} ellipsis={{ tooltip: w.path }}>
                  {w.path}
                </Typography.Text>
                <Button
                  size="small"
                  danger
                  type="text"
                  icon={<DeleteOutlined />}
                  style={{ marginLeft: 'auto' }}
                  onClick={() => void removeDir(w.path)}
                >
                  移除
                </Button>
              </div>
            ))}
          </div>
        )}
        <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
          {running ? (paused ? '（已暂停）' : '（运行中）') : '（未启动）'}
        </Typography.Text>
      </div>

      {events.length === 0 ? (
        <Empty description="暂无文件事件（启动监控后，目录内新建/修改/删除文件会实时显示）" />
      ) : (
        <div
          style={{
            maxHeight: 420,
            overflow: 'auto',
            border: '1px solid var(--border-color, rgba(128,128,128,.25))',
            borderRadius: 8,
            padding: 8
          }}
        >
          {events.map((e, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0', fontSize: 12 }}>
              <Tag color={eventColor(e.event_type)} style={{ margin: 0, width: 64, textAlign: 'center' }}>
                {e.event_type}
              </Tag>
              <Typography.Text code style={{ fontSize: 12 }} ellipsis={{ tooltip: e.path }}>
                {e.path}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 'auto' }}>
                {new Date(e.timestamp * 1000).toLocaleTimeString()}
              </Typography.Text>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

import CleanSection from './CleanSection'

/* ---------- 智能分类与整理执行（organize） ---------- */

/** 可选类目：与主进程 organizer.CLASSIFY_CATEGORIES 保持一致 */
const ORGANIZE_CATEGORIES = ['文档', '图片', '视频', '音频', '压缩包', '代码', '安装包', '下载文件', '其他']

type OrganizePlan = Awaited<ReturnType<typeof window.api.organize.generatePlan>>
type PlanAction = OrganizePlan['actions'][number]

/** 从计划项目标路径反推当前类目（目标路径 = 目标基目录/类目） */
function categoryOfAction(a: PlanAction): string {
  if (!a.targetPath) return ''
  const parts = a.targetPath.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

/** 拼接目标基目录与类目（渲染层无 node:path，按基目录已有分隔符拼接） */
function joinTarget(base: string, category: string): string {
  const trimmed = base.replace(/[\\/]+$/, '')
  const sep = base.includes('\\') ? '\\' : '/'
  return `${trimmed}${sep}${category}`
}

function OrganizeSection() {
  const [files, setFiles] = useState('')
  const [useAi, setUseAi] = useState(true)
  const [loading, setLoading] = useState(false)
  const [plan, setPlan] = useState<OrganizePlan | null>(null)
  const [result, setResult] = useState<Awaited<ReturnType<typeof window.api.organize.executePlan>> | null>(null)
  const [memory, setMemory] = useState<Awaited<ReturnType<typeof window.api.organize.memoryList>>>([])
  /** 每项待改的类目（sourcePath → 类目）；未选择时回落到当前类目 */
  const [categoryChoice, setCategoryChoice] = useState<Record<string, string>>({})

  const loadMemory = async (): Promise<void> => {
    try {
      setMemory(await window.api.organize.memoryList())
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    void loadMemory()
  }, [])

  /** 类目下拉项：标准类目 + 计划里出现过的（AI 可能给出标准列表之外的类目） */
  const categoryOptions = useMemo(() => {
    const set = new Set<string>(ORGANIZE_CATEGORIES)
    if (plan) {
      for (const a of plan.actions) {
        const c = categoryOfAction(a)
        if (c) set.add(c)
      }
    }
    return [...set].map((c) => ({ label: c, value: c }))
  }, [plan])

  /**
   * 手动纠正某项的类目。
   * 1) 写入分类纠正记忆（个性化：同一扩展名累计 2 次后，后续分类会优先采用该记忆）；
   * 2) 就地把该项目标路径改到「目标基目录/新类目」，让界面立刻反映纠正结果。
   */
  const applyCategory = async (a: PlanAction): Promise<void> => {
    const category = (categoryChoice[a.sourcePath] ?? categoryOfAction(a)).trim()
    if (!category) {
      message.warning('请先选择目标类目')
      return
    }
    try {
      await window.api.organize.recordCorrection(a.sourcePath, category)
      const base = await window.api.organize.getTargetBase()
      const targetPath = joinTarget(base, category)
      setPlan((prev) =>
        prev
          ? {
              ...prev,
              actions: prev.actions.map((x) =>
                x.sourcePath === a.sourcePath
                  ? { ...x, targetPath, reason: `手动改类目：${category}` }
                  : x
              )
            }
          : prev
      )
      await loadMemory()
      message.success(`已改类目为「${category}」并记入分类记忆`)
    } catch (err) {
      message.error('改类目失败：' + (err as Error).message)
    }
  }

  const preview = async (): Promise<void> => {
    const list = files.split(/\n|;/).map((f) => f.trim()).filter(Boolean)
    if (list.length === 0) {
      message.warning('请输入待整理的文件路径（每行一个）')
      return
    }
    setLoading(true)
    try {
      const p = await window.api.organize.generatePlan(list, { useAi })
      setPlan(p)
      setCategoryChoice({})
    } catch (err) {
      message.error('生成计划失败：' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const execute = async (): Promise<void> => {
    if (!plan) return
    const moves = plan.actions.filter((a) => a.actionType === 'move' || a.actionType === 'rename' || a.actionType === 'copy').length
    const deletes = plan.actions.filter((a) => a.actionType === 'delete').length
    Modal.confirm({
      title: '执行整理计划',
      content: `将移动/复制 ${moves} 项${deletes > 0 ? `、删除 ${deletes} 项（入回收站）` : ''}。确定执行吗？`,
      okText: '执行',
      okButtonProps: { danger: deletes > 0 },
      cancelText: '取消',
      onOk: async () => {
        setLoading(true)
        try {
          const r = await window.api.organize.executePlan(plan.actions)
          setResult(r)
          message.success(`整理完成：成功 ${r.successCount} / 失败 ${r.failedCount}`)
          setPlan(null)
          void loadMemory()
        } catch (err) {
          message.error('执行失败：' + (err as Error).message)
        } finally {
          setLoading(false)
        }
      }
    })
  }

  const clearMemory = async (): Promise<void> => {
    try {
      await window.api.organize.memoryClear()
      setMemory([])
      message.success('分类纠正记忆已清空')
    } catch {
      /* ignore */
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="按内容/扩展名记忆自动归类文件到目标目录；记忆达到阈值后优先采用（个性化分类）" />
      <Input.TextArea
        aria-label="待整理文件路径列表"
        rows={4}
        placeholder={'每行一个文件路径，如：\nC:/Downloads/report.pdf\nD:/Inbox/photo.jpg'}
        value={files}
        onChange={(e) => setFiles(e.target.value)}
      />
      <Space>
        <Switch checked={useAi} onChange={setUseAi} checkedChildren="AI 分类" unCheckedChildren="仅记忆" />
        <Button type="primary" icon={<PartitionOutlined />} loading={loading} onClick={preview}>
          生成整理计划
        </Button>
        {plan && (
          <Button icon={<PlayCircleOutlined />} loading={loading} onClick={execute}>
            执行（{plan.actions.length} 项）
          </Button>
        )}
      </Space>

      {plan && (
        <Collapse
          size="small"
          defaultActiveKey={['p']}
          items={[
            {
              key: 'p',
              label: `整理计划（${plan.actions.length} 项）`,
              children: (
                <List
                  size="small"
                  dataSource={plan.actions}
                  renderItem={(a) => (
                    <List.Item>
                      <Typography.Text code style={{ fontSize: 12 }} ellipsis={{ tooltip: a.sourcePath }}>
                        {a.sourcePath}
                      </Typography.Text>
                      <Tag>{a.actionType}</Tag>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        → {a.targetPath ?? '删除'}
                      </Typography.Text>
                      {a.actionType !== 'delete' && (
                        <Space size={4}>
                          <Select
                            size="small"
                            style={{ width: 118 }}
                            aria-label={`为 ${a.sourcePath} 选择目标类目`}
                            placeholder="新类目"
                            value={categoryChoice[a.sourcePath] ?? (categoryOfAction(a) || undefined)}
                            onChange={(v) =>
                              setCategoryChoice((p) => ({ ...p, [a.sourcePath]: v }))
                            }
                            options={categoryOptions}
                          />
                          <Button size="small" onClick={() => void applyCategory(a)}>
                            改类目
                          </Button>
                        </Space>
                      )}
                    </List.Item>
                  )}
                />
              )
            }
          ]}
        />
      )}

      {result && (
        <Card size="small" title="执行结果">
          <Space>
            <Tag color="green">成功 {result.successCount}</Tag>
            <Tag color="red">失败 {result.failedCount}</Tag>
            <Tag>总计 {result.totalFiles}</Tag>
          </Space>
        </Card>
      )}

      <Card
        size="small"
        title="分类纠正记忆"
        extra={
          <Button size="small" icon={<DeleteOutlined />} onClick={clearMemory}>
            清空
          </Button>
        }
      >
        {memory.length === 0 ? (
          <Empty description="暂无记忆（整理时纠正分类会被记录）" />
        ) : (
          <List
            size="small"
            dataSource={memory}
            renderItem={(m) => (
              <List.Item>
                <Tag>{m.pattern}</Tag>
                <Typography.Text strong>{m.category}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  学习 {m.count} 次
                </Typography.Text>
              </List.Item>
            )}
          />
        )}
      </Card>
    </Space>
  )
}

/* ---------- 格式转换引擎（convert） ---------- */
function ConvertSection() {
  const [source, setSource] = useState('')
  const [targetFormat, setTargetFormat] = useState('')
  const [converters, setConverters] = useState<Awaited<ReturnType<typeof window.api.convert.converters>>>([])
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<Awaited<ReturnType<typeof window.api.convert.convert>> | null>(null)

  const load = async (): Promise<void> => {
    try {
      const list = await window.api.convert.converters()
      setConverters(list)
      if (!targetFormat && list[0]) setTargetFormat(list[0].sourceFormats[0] ?? '')
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    void load()
  }, [])

  /* 展开全部转换器支持的全部格式（标注所属转换器与可用性） */
  const formatOptions = useMemo(() => {
    const seen = new Set<string>()
    const out: { label: string; value: string }[] = []
    for (const c of converters) {
      for (const f of c.sourceFormats) {
        if (seen.has(f)) continue
        seen.add(f)
        out.push({
          label: `${f} · ${c.name}${c.available ? '' : '（未安装）'}`,
          value: f
        })
      }
    }
    return out
  }, [converters])

  const run = async (): Promise<void> => {
    if (!source.trim() || !targetFormat) {
      message.warning('请输入源文件并选择目标格式')
      return
    }
    setLoading(true)
    try {
      const r = await window.api.convert.convert({ sourcePath: source.trim(), targetFormat })
      setResult(r)
      if (r.success) message.success(`已转换：${r.targetPath}`)
      else message.error('转换失败：' + r.error)
    } catch (err) {
      message.error('转换失败：' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const pick = async (): Promise<void> => {
    const f = await window.api.pickBufferFile()
    if (f) setSource(f.name)
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space wrap>
        <Input aria-label="源文件路径" style={{ width: 320 }} placeholder="源文件路径" value={source} onChange={(e) => setSource(e.target.value)} />
        <Button icon={<FolderOpenOutlined />} onClick={pick}>
          选择文件
        </Button>
        <Select
          aria-label="目标格式"
          style={{ width: 240 }}
          placeholder="目标格式"
          value={targetFormat || undefined}
          onChange={setTargetFormat}
          options={formatOptions}
        />
        <Button type="primary" icon={<SwapOutlined />} loading={loading} onClick={run}>
          转换
        </Button>
      </Space>

      {result && (
        <Card size="small">
          <Space>
            <Tag color={result.success ? 'green' : 'red'}>{result.success ? '成功' : '失败'}</Tag>
            <Typography.Text code style={{ fontSize: 12 }}>{result.targetPath ?? '-'}</Typography.Text>
            {result.converterName && <Tag>{result.converterName}</Tag>}
          </Space>
          {!result.success && (
            <div>
              <Typography.Text type="danger">{result.error}</Typography.Text>
            </div>
          )}
        </Card>
      )}

      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
        自动路由 4 类转换器：文档(docx/pdf/xlsx…)、音视频(ffmpeg)、图片(imagemagick)、文本。转换中间产物会被自动清理。
      </Typography.Paragraph>
    </Space>
  )
}

/* ---------- 目录对比 ---------- */
type CompareResult = Awaited<ReturnType<typeof window.api.tools.compareFolders>>
type CompareFile = CompareResult['different'][number]

function CompareSection() {
  const [left, setLeft] = useState('')
  const [right, setRight] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<CompareResult | null>(null)
  const [filter, setFilter] = useState<'all' | 'only-left' | 'only-right' | 'different' | 'identical'>('all')
  const [diffFile, setDiffFile] = useState<CompareFile | null>(null)

  const pickDir = async (side: 'left' | 'right'): Promise<void> => {
    const dir = await window.api.data.pickDir(`选择${side === 'left' ? '左侧' : '右侧'}目录`)
    if (dir) {
      if (side === 'left') setLeft(dir)
      else setRight(dir)
    }
  }

  const run = async (): Promise<void> => {
    if (!left.trim() || !right.trim()) {
      message.warning('请选择左右两个目录')
      return
    }
    setLoading(true)
    try {
      const r = await window.api.tools.compareFolders(left.trim(), right.trim(), {
        hash: true,
        diffText: true
      })
      setResult(r)
    } catch (err) {
      message.error(`对比失败：${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  const allFiles = useMemo(() => {
    if (!result) return []
    return [
      ...result.onlyInLeft.map((f) => ({ ...f, category: 'only-left' as const })),
      ...result.onlyInRight.map((f) => ({ ...f, category: 'only-right' as const })),
      ...result.different.map((f) => ({ ...f, category: 'different' as const })),
      ...result.identical.map((f) => ({ ...f, category: 'identical' as const }))
    ]
  }, [result])

  const filtered = useMemo(
    () => (filter === 'all' ? allFiles : allFiles.filter((f) => f.category === filter)),
    [allFiles, filter]
  )

  const statusTag = (status: CompareFile['status']) => {
    const map: Record<CompareFile['status'], { color: string; label: string }> = {
      'only-left': { color: 'orange', label: '仅左侧' },
      'only-right': { color: 'cyan', label: '仅右侧' },
      different: { color: 'red', label: '内容不同' },
      identical: { color: 'green', label: '完全相同' }
    }
    return <Tag color={map[status].color}>{map[status].label}</Tag>
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space wrap>
        <Input
          aria-label="左侧目录"
          size="small"
          placeholder="左侧目录"
          value={left}
          onChange={(e) => setLeft(e.target.value)}
          style={{ width: 260 }}
        />
        <Button size="small" icon={<FolderOpenOutlined />} onClick={() => void pickDir('left')}>
          选择左侧
        </Button>
        <SwapOutlined style={{ color: 'var(--text-secondary)' }} />
        <Input
          aria-label="右侧目录"
          size="small"
          placeholder="右侧目录"
          value={right}
          onChange={(e) => setRight(e.target.value)}
          style={{ width: 260 }}
        />
        <Button size="small" icon={<FolderOpenOutlined />} onClick={() => void pickDir('right')}>
          选择右侧
        </Button>
        <Button type="primary" size="small" icon={<FileSearchOutlined />} loading={loading} onClick={run}>
          对比目录
        </Button>
      </Space>

      {result && (
        <>
          <Space wrap>
            <Tag>左 {result.summary.totalLeft} 个文件</Tag>
            <Tag>右 {result.summary.totalRight} 个文件</Tag>
            <Tag color="green">相同 {result.summary.identical}</Tag>
            <Tag color="red">不同 {result.summary.different}</Tag>
            <Tag color="orange">仅左 {result.summary.onlyLeft}</Tag>
            <Tag color="cyan">仅右 {result.summary.onlyRight}</Tag>
          </Space>
          <Segmented
            size="small"
            value={filter}
            onChange={(v) => setFilter(v as typeof filter)}
            options={[
              { label: `全部 (${allFiles.length})`, value: 'all' },
              { label: `仅左侧 (${result.summary.onlyLeft})`, value: 'only-left' },
              { label: `仅右侧 (${result.summary.onlyRight})`, value: 'only-right' },
              { label: `内容不同 (${result.summary.different})`, value: 'different' },
              { label: `完全相同 (${result.summary.identical})`, value: 'identical' }
            ]}
          />
          <Table
            size="small"
            rowKey="relativePath"
            dataSource={filtered}
            pagination={{ pageSize: 20 }}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: '相对路径', dataIndex: 'relativePath', ellipsis: true },
              { title: '状态', width: 100, render: (_v, r: CompareFile) => statusTag(r.status) },
              {
                title: '左侧大小',
                width: 110,
                render: (_v, r: CompareFile) =>
                  r.leftSize !== undefined ? formatBytes(r.leftSize) : '-'
              },
              {
                title: '右侧大小',
                width: 110,
                render: (_v, r: CompareFile) =>
                  r.rightSize !== undefined ? formatBytes(r.rightSize) : '-'
              },
              {
                title: '操作',
                width: 110,
                render: (_v, r: CompareFile) =>
                  r.status === 'different' ? (
                    <Button size="small" onClick={() => setDiffFile(r)}>
                      查看差异
                    </Button>
                  ) : null
              }
            ]}
          />
        </>
      )}

      <Modal
        title={`差异：${diffFile?.relativePath ?? ''}`}
        open={diffFile !== null}
        onCancel={() => setDiffFile(null)}
        width={900}
        footer={null}
      >
        {diffFile?.diff && diffFile.diff.length > 0 ? (
          <div
            style={{
              maxHeight: 520,
              overflow: 'auto',
              fontFamily: 'monospace',
              fontSize: 12,
              background: 'var(--bg-subtle, rgba(0,0,0,.03))',
              borderRadius: 8,
              padding: 8
            }}
          >
            {diffFile.diff.map((line, i) => (
              <div
                key={i}
                style={{
                  whiteSpace: 'pre-wrap',
                  color:
                    line.type === 'added'
                      ? '#389e0d'
                      : line.type === 'removed'
                        ? '#cf1322'
                        : 'var(--text-primary)',
                  background:
                    line.type === 'added'
                      ? 'rgba(82,196,26,.12)'
                      : line.type === 'removed'
                        ? 'rgba(255,77,79,.12)'
                        : 'transparent',
                  padding: '1px 4px',
                  borderRadius: 2
                }}
              >
                {line.type === 'added' ? '+ ' : line.type === 'removed' ? '- ' : '  '}
                {line.line}
              </div>
            ))}
          </div>
        ) : (
          <Empty description="无可读文本差异（可能为二进制文件或内容未采集）" />
        )}
      </Modal>
    </Space>
  )
}

/* ---------- 页面 ---------- */
type FileGroup = 'files' | 'image' | 'video' | 'hw'

const GROUP_META: Array<{ key: FileGroup; label: string; desc: string }> = [
  { key: 'files', label: '文件管理', desc: '磁盘分析 · 目录占用 · 重复文件 · 目录监控 · 智能分类与整理 · 格式转换 · 磁盘清理' },
  { key: 'image', label: '图片工具', desc: '裁剪 · 抠图 · 调色 · 转换压缩 · 拼接 · 图标' },
  { key: 'video', label: '视频工具', desc: '转换 · 抽帧 · GIF · 音频处理 · FFmpeg 本地引擎' },
  { key: 'hw', label: '硬件工具', desc: '剪贴板 · 整机 · CPU/内存 · 显卡 · 磁盘 · 网络 · 电源' }
]

export default function FileTools() {
  const [group, setGroup] = useState<FileGroup>('files')
  return (
    <div className="texttools-page">
      <div className="page-header">
        <Typography.Title level={4} style={{ margin: 0 }}>
          文件工具
        </Typography.Title>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {GROUP_META.find((g) => g.key === group)?.desc}
        </Typography.Text>
      </div>

      {/* 分组平铺按钮（Word 工具条式，无下拉） */}
      <div className="tt-v2-toolbar" style={{ borderBottom: 'none', padding: '4px 0 8px' }}>
        {GROUP_META.map((g) => (
          <Button key={g.key} size="small" type={group === g.key ? 'primary' : 'default'} onClick={() => setGroup(g.key)}>
            {g.label}
          </Button>
        ))}
      </div>

      {group === 'files' && (
        <Tabs
          defaultActiveKey="disk"
          items={[
            { key: 'disk', label: '磁盘信息', children: <DiskSection /> },
            { key: 'analyze', label: '目录分析', children: <AnalyzeSection /> },
            { key: 'duplicate', label: '重复检测', children: <DuplicateSection /> },
            { key: 'compare', label: '目录对比', children: <CompareSection /> },
            { key: 'watcher', label: '文件监控', children: <WatcherSection /> },
            { key: 'organize', label: '智能分类与整理', children: <OrganizeSection /> },
            { key: 'convert', label: '格式转换', children: <ConvertSection /> },
            { key: 'clean', label: '磁盘清理', children: <CleanSection /> }
          ]}
        />
      )}
      {group === 'image' && <ImageTools embedded />}
      {group === 'video' && <VideoTools embedded />}
      {group === 'hw' && <HardwareTools embedded />}
    </div>
  )
}
