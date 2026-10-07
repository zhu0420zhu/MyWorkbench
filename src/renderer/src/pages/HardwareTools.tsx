import { useCallback, useEffect, useState } from 'react'
import { formatError } from '../utils/formatError'
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Progress,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  message
} from 'antd'
import {
  AudioOutlined,
  ThunderboltOutlined,
  CameraOutlined,
  ClearOutlined,
  CloudServerOutlined,
  CopyOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  DesktopOutlined,
  FileTextOutlined,
  HddOutlined,
  LoadingOutlined,
  MobileOutlined,
  UsbOutlined,
  VideoCameraOutlined
} from '@ant-design/icons'

const { Text, Title, Paragraph } = Typography

type HardwareToolKey =
  | 'clipboard'
  | 'overview'
  | 'cpu'
  | 'graphics'
  | 'board'
  | 'disk'
  | 'network'
  | 'power'

interface ClipboardEntry {
  id: string
  kind: 'text' | 'image' | 'files'
  text?: string
  preview?: string
  filePaths?: string[]
  imageDataUrl?: string
  size: number
  createdAt: number
}

const TOOL_META: Array<{
  key: HardwareToolKey
  title: string
  desc: string
  icon: React.ReactNode
  category: string
}> = [
  {
    key: 'clipboard',
    title: '剪贴板历史',
    desc: '实时记录文字、图片与文件路径',
    icon: <FileTextOutlined />,
    category: '硬件工具'
  },
  {
    key: 'overview',
    title: '整机概览',
    desc: '系统、机型、BIOS 与安全状态',
    icon: <DesktopOutlined />,
    category: '硬件工具'
  },
  {
    key: 'cpu',
    title: 'CPU 与内存',
    desc: '核心线程、频率、缓存与内存通道',
    icon: <DashboardOutlined />,
    category: '硬件工具'
  },
  {
    key: 'graphics',
    title: '显卡与显示器',
    desc: '显存、驱动、分辨率与刷新率',
    icon: <VideoCameraOutlined />,
    category: '硬件工具'
  },
  {
    key: 'board',
    title: '主板与固件',
    desc: '主板、BIOS/UEFI 与 PCIe 设备',
    icon: <CloudServerOutlined />,
    category: '硬件工具'
  },
  {
    key: 'disk',
    title: '磁盘与健康',
    desc: '容量、接口、分区与可靠性状态',
    icon: <HddOutlined />,
    category: '硬件工具'
  },
  {
    key: 'network',
    title: '网络与设备',
    desc: '网卡、蓝牙、音频、USB 与摄像头',
    icon: <UsbOutlined />,
    category: '硬件工具'
  },
  {
    key: 'power',
    title: '电源与传感器',
    desc: '电池健康和硬件可提供的传感器数据',
    icon: <ThunderboltOutlined />,
    category: '硬件工具'
  }
]

function formatBytes(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function SectionCard({ children, title, extra }: { children: React.ReactNode; title: string; extra?: React.ReactNode }) {
  return (
    <Card size="small" title={title} extra={extra} style={{ marginBottom: 12 }}>
      {children}
    </Card>
  )
}

/* ---------- 剪贴板历史 ---------- */
function ClipboardPanel() {
  const [items, setItems] = useState<ClipboardEntry[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = (await window.api.hardware.clipboardList()) as ClipboardEntry[]
      setItems(list || [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const off = window.api.hardware.onClipboardEvent((entry) => {
      const item = entry as ClipboardEntry
      setItems((prev) => [item, ...prev.filter((e) => e.id !== item.id)].slice(0, 80))
    })
    return off
  }, [load])

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="实时记录文字、图片与文件路径" description="后台轮询系统剪贴板，仅保存在本地。" />
      <Space>
        <Button icon={<LoadingOutlined />} loading={loading} onClick={() => void load()}>
          刷新
        </Button>
        <Button
          icon={<ClearOutlined />}
          onClick={() => {
            void window.api.hardware.clipboardClear()
            setItems([])
          }}
        >
          清空
        </Button>
        <Text type="secondary">共 {items.length} 条</Text>
      </Space>
      {items.length === 0 ? (
        <Text type="secondary">暂无记录，复制一些内容试试</Text>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((item) => (
            <Card key={item.id} size="small">
              <Space align="start" style={{ width: '100%' }}>
                {item.kind === 'image' && item.preview && (
                  <img src={item.preview} alt="" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 6 }} />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Space>
                    <Tag color={item.kind === 'text' ? 'blue' : item.kind === 'image' ? 'purple' : 'green'}>
                      {item.kind === 'text' ? '文本' : item.kind === 'image' ? '图片' : '文件'}
                    </Tag>
                    <Text type="secondary">{new Date(item.createdAt).toLocaleTimeString()}</Text>
                    <Text type="secondary">{formatBytes(item.size)}</Text>
                  </Space>
                  <Paragraph
                    style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', maxHeight: 96, overflow: 'auto', fontSize: 12 }}
                    type="secondary"
                  >
                    {item.preview || item.text || (item.filePaths || []).join('\n')}
                  </Paragraph>
                </div>
                <Space direction="vertical">
                  <Button
                    size="small"
                    icon={<CopyOutlined />}
                    onClick={() => {
                      void window.api.hardware.clipboardCopy(item.id).then((ok) => {
                        if (ok) message.success('已复制')
                      })
                    }}
                  >
                    复制
                  </Button>
                  <Button
                    size="small"
                    danger
                    onClick={() => {
                      void window.api.hardware.clipboardRemove(item.id)
                      setItems((prev) => prev.filter((e) => e.id !== item.id))
                    }}
                  >
                    删除
                  </Button>
                </Space>
              </Space>
            </Card>
          ))}
        </div>
      )}
    </Space>
  )
}

/* ---------- 通用硬件数据面板 ---------- */
function HardwareDataPanel({
  fetcher,
  render,
  title
}: {
  fetcher: (force?: boolean) => Promise<{ ok: boolean; error?: string; data?: unknown }>
  render: (data: Record<string, unknown>) => React.ReactNode
  title: string
}) {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  /** 渐近进度：探测总量不可预知，用 0→95% 渐近曲线给等待过程以反馈 */
  const [pct, setPct] = useState(0)

  const load = useCallback(
    async (force = false) => {
      setLoading(true)
      setError('')
      try {
        const res = await fetcher(force)
        if (res.ok && res.data) setData(res.data as Record<string, unknown>)
        else setError(res.error || '读取失败')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [fetcher]
  )

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!loading) {
      setPct(0)
      return
    }
    setPct(8)
    const timer = setInterval(() => {
      setPct((p) => Math.min(95, p + Math.max(0.5, (95 - p) * 0.08)))
    }, 180)
    return () => clearInterval(timer)
  }, [loading])

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space>
        <Button onClick={() => void load(true)} loading={loading}>
          刷新（强制重采）
        </Button>
        {error && <Text type="danger">{error}</Text>}
      </Space>
      {loading && !data ? (
        <div className="hw-loading">
          <Progress percent={Math.round(pct)} status="active" style={{ maxWidth: 420 }} />
          <Text type="secondary">
            正在采集{title}数据…（首次探测较慢，系统会在启动后预热并缓存，之后秒开）
          </Text>
        </div>
      ) : data ? (
        render(data)
      ) : !error ? (
        <Text type="secondary">无数据</Text>
      ) : null}
    </Space>
  )
}

function DescList({ items }: { items: Array<[string, React.ReactNode]> }) {
  return (
    <Descriptions size="small" column={2} bordered>
      {items.map(([k, v]) => (
        <Descriptions.Item key={k} label={k}>
          {v}
        </Descriptions.Item>
      ))}
    </Descriptions>
  )
}

export default function HardwareTools({ embedded = false }: { embedded?: boolean }) {
  const [tool, setTool] = useState<HardwareToolKey>('clipboard')
  const meta = TOOL_META.find((t) => t.key === tool)!

  return (
    <div className="media-tools-page">
      {!embedded && (
        <div className="page-header">
          <Title level={4} style={{ margin: 0 }}>
            硬件工具
          </Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            剪贴板 · 整机 · CPU/内存 · 显卡 · 磁盘 · 网络 · 电源
          </Text>
          <div style={{ flex: 1 }} />
          <Tag color="green">本地采集 · systeminformation</Tag>
        </div>
      )}

      <div className="pdf-toolbar">
        {TOOL_META.map((t) => (
          <Button
            key={t.key}
            size="small"
            icon={t.icon}
            type={tool === t.key ? 'primary' : 'default'}
            title={t.desc}
            onClick={() => setTool(t.key)}
          >
            {t.title}
          </Button>
        ))}
        <Text type="secondary" style={{ fontSize: 12 }}>
          全部工具平铺于此；硬件数据启动时后台预热并缓存，面板秒开
        </Text>
      </div>

      <Card
        size="small"
        title={
          <Space>
            {meta.icon}
            <span>{meta.title}</span>
            <Tag>{meta.category}</Tag>
          </Space>
        }
        className="mt-panel"
      >
        {tool === 'clipboard' && <ClipboardPanel />}

        {tool === 'overview' && (
          <HardwareDataPanel
            fetcher={(force) => window.api.hardware.system(force)}
            title="整机概览"
            render={(d) => (
              <>
                <SectionCard title="整机">
                  <DescList
                    items={[
                      ['厂商', String(d.manufacturer ?? '—')],
                      ['型号', String(d.model ?? '—')],
                      ['序列号', String(d.serial ?? '—')],
                      ['系统', String(d.os ?? '—')],
                      ['主机名', String(d.hostname ?? '—')],
                      ['虚拟机', d.virtual ? '是' : '否']
                    ]}
                  />
                </SectionCard>
                <SectionCard title="BIOS / 主板">
                  <DescList
                    items={[
                      ['BIOS 厂商', String(d.biosVendor ?? '—')],
                      ['BIOS 版本', String(d.biosVersion ?? '—')],
                      ['BIOS 日期', String(d.biosReleaseDate ?? '—')],
                      ['主板', `${d.boardVendor ?? ''} ${d.boardModel ?? ''}`.trim() || '—'],
                      ['CPU', String(d.cpuBrand ?? '—')],
                      ['内存', `${d.totalMemGb ?? '—'} GB`]
                    ]}
                  />
                </SectionCard>
              </>
            )}
          />
        )}

        {tool === 'cpu' && (
          <HardwareDataPanel
            fetcher={(force) => window.api.hardware.cpuMemory(force)}
            title="CPU 与内存"
            render={(d) => {
              const cache = (d.cache || {}) as Record<string, number>
              return (
                <>
                  <SectionCard title="CPU">
                    <DescList
                      items={[
                        ['品牌', String(d.brand ?? '—')],
                        ['工艺/家族', `${d.family ?? ''} / ${d.model ?? ''}`.trim() || '—'],
                        ['插槽', String(d.socket ?? '—')],
                        ['核心/线程', `${d.physicalCores ?? '—'} / ${d.cores ?? '—'}`],
                        ['频率', `${d.speed ?? '—'} GHz（最大 ${d.speedMax ?? '—'}）`],
                        ['缓存', `L1 ${cache.l1d ?? cache.l1 ?? '—'} · L2 ${cache.l2 ?? '—'} · L3 ${cache.l3 ?? '—'}`]
                      ]}
                    />
                  </SectionCard>
                  <SectionCard title="内存">
                    <DescList
                      items={[
                        ['总计', formatBytes(Number(d.memTotal))],
                        ['已用', formatBytes(Number(d.memUsed))],
                        ['可用', formatBytes(Number(d.memAvailable))],
                        ['交换', `${formatBytes(Number(d.swapused))} / ${formatBytes(Number(d.swaptotal))}`]
                      ]}
                    />
                    <div style={{ marginTop: 8 }}>
                      <Progress
                        percent={Math.round((Number(d.memUsed) / Math.max(1, Number(d.memTotal))) * 100)}
                        status="active"
                      />
                    </div>
                    <Table
                      style={{ marginTop: 12 }}
                      size="small"
                      rowKey={(r, i) => String(i)}
                      pagination={false}
                      dataSource={(d.modules as Array<Record<string, unknown>>) || []}
                      columns={[
                        { title: '插槽', dataIndex: 'bank' },
                        { title: '类型', dataIndex: 'type' },
                        { title: '容量', dataIndex: 'size', render: (v) => formatBytes(Number(v)) },
                        { title: '频率', dataIndex: 'clockSpeed', render: (v) => (v ? `${v} MHz` : '—') },
                        { title: '厂商', dataIndex: 'manufacturer' },
                        { title: '型号', dataIndex: 'partNum' }
                      ]}
                    />
                  </SectionCard>
                </>
              )
            }}
          />
        )}

        {tool === 'graphics' && (
          <HardwareDataPanel
            fetcher={(force) => window.api.hardware.graphics(force)}
            title="显卡与显示器"
            render={(d) => (
              <>
                <SectionCard title="显卡">
                  <Table
                    size="small"
                    rowKey={(r, i) => String(i)}
                    pagination={false}
                    dataSource={(d.controllers as Array<Record<string, unknown>>) || []}
                    columns={[
                      { title: '厂商', dataIndex: 'vendor' },
                      { title: '型号', dataIndex: 'model' },
                      { title: '显存', dataIndex: 'vram', render: (v) => (v ? `${v} MB` : '—') },
                      { title: '驱动', dataIndex: 'driverVersion' },
                      { title: '驱动日期', dataIndex: 'driverDate' },
                      { title: '总线', dataIndex: 'bus' }
                    ]}
                  />
                </SectionCard>
                <SectionCard title="显示器">
                  <Table
                    size="small"
                    rowKey={(r, i) => String(i)}
                    pagination={false}
                    dataSource={(d.displays as Array<Record<string, unknown>>) || []}
                    columns={[
                      { title: '厂商', dataIndex: 'vendor' },
                      { title: '型号', dataIndex: 'model' },
                      {
                        title: '分辨率',
                        key: 'res',
                        render: (_, r) => `${r.resolutionX || r.currentResX || '?'}×${r.resolutionY || r.currentResY || '?'}`
                      },
                      { title: '刷新率', dataIndex: 'currentRefreshRate', render: (v) => (v ? `${v} Hz` : '—') },
                      { title: '尺寸', key: 'size', render: (_, r) => (r.sizeX ? `${r.sizeX}×${r.sizeY} mm` : '—') }
                    ]}
                  />
                </SectionCard>
              </>
            )}
          />
        )}

        {tool === 'board' && (
          <HardwareDataPanel
            fetcher={(force) => window.api.hardware.board(force)}
            title="主板与固件"
            render={(d) => {
              const board = (d.board || {}) as Record<string, unknown>
              const bios = (d.bios || {}) as Record<string, unknown>
              return (
                <>
                  <SectionCard title="主板">
                    <DescList
                      items={[
                        ['厂商', String(board.manufacturer ?? '—')],
                        ['型号', String(board.model ?? '—')],
                        ['版本', String(board.version ?? '—')],
                        ['序列号', String(board.serial ?? '—')],
                        ['最大内存', board.memMax ? formatBytes(Number(board.memMax)) : '—'],
                        ['内存插槽', String(board.memSlots ?? '—')]
                      ]}
                    />
                  </SectionCard>
                  <SectionCard title="BIOS / UEFI">
                    <DescList
                      items={[
                        ['厂商', String(bios.vendor ?? '—')],
                        ['版本', String(bios.version ?? '—')],
                        ['发布日期', String(bios.releaseDate ?? '—')]
                      ]}
                    />
                  </SectionCard>
                  <SectionCard title="PCIe 设备">
                    <Table
                      size="small"
                      rowKey={(r, i) => String(i)}
                      pagination={{ pageSize: 8 }}
                      dataSource={(d.pciDevices as Array<Record<string, unknown>>) || []}
                      columns={[
                        { title: '厂商', dataIndex: 'vendor' },
                        { title: '设备', dataIndex: 'name' },
                        { title: '类', dataIndex: 'class' },
                        { title: 'ID', dataIndex: 'id' }
                      ]}
                    />
                  </SectionCard>
                </>
              )
            }}
          />
        )}

        {tool === 'disk' && (
          <HardwareDataPanel
            fetcher={(force) => window.api.hardware.disk(force)}
            title="磁盘与健康"
            render={(d) => (
              <>
                <SectionCard title="分区容量">
                  <Table
                    size="small"
                    rowKey={(r, i) => String(i)}
                    pagination={false}
                    dataSource={(d.filesystems as Array<Record<string, unknown>>) || []}
                    columns={[
                      { title: '挂载', dataIndex: 'mount' },
                      { title: '类型', dataIndex: 'type' },
                      { title: '容量', dataIndex: 'size', render: (v) => formatBytes(Number(v)) },
                      { title: '已用', dataIndex: 'used', render: (v) => formatBytes(Number(v)) },
                      {
                        title: '使用率',
                        dataIndex: 'use',
                        render: (v) => <Progress percent={Math.round(Number(v))} size="small" style={{ width: 100 }} />
                      }
                    ]}
                  />
                </SectionCard>
                <SectionCard title="物理磁盘">
                  <Table
                    size="small"
                    rowKey={(r, i) => String(i)}
                    pagination={false}
                    dataSource={(d.physical as Array<Record<string, unknown>>) || []}
                    columns={[
                      { title: '名称', dataIndex: 'name' },
                      { title: '类型', dataIndex: 'type' },
                      { title: '容量', dataIndex: 'size', render: (v) => formatBytes(Number(v)) },
                      { title: '接口', dataIndex: 'interfaceType' },
                      {
                        title: '健康',
                        dataIndex: 'smartStatus',
                        render: (v) => (
                          <Tag color={String(v).toLowerCase() === 'ok' || String(v).toLowerCase() === 'passed' ? 'green' : 'orange'}>
                            {String(v || '—')}
                          </Tag>
                        )
                      },
                      { title: '温度', dataIndex: 'temperature', render: (v) => (v ? `${v}°C` : '—') }
                    ]}
                  />
                </SectionCard>
              </>
            )}
          />
        )}

        {tool === 'network' && (
          <HardwareDataPanel
            fetcher={(force) => window.api.hardware.network(force)}
            title="网络与设备"
            render={(d) => (
              <>
                <SectionCard title="网卡">
                  <Table
                    size="small"
                    rowKey={(r, i) => String(i)}
                    pagination={false}
                    dataSource={(d.interfaces as Array<Record<string, unknown>>) || []}
                    columns={[
                      { title: '接口', dataIndex: 'iface' },
                      { title: '类型', dataIndex: 'type' },
                      { title: 'IPv4', dataIndex: 'ip4' },
                      { title: 'MAC', dataIndex: 'mac' },
                      { title: '速率', dataIndex: 'speed', render: (v) => (v ? `${v} Mbps` : '—') },
                      { title: '状态', dataIndex: 'operstate' }
                    ]}
                  />
                </SectionCard>
                <SectionCard title="USB 设备">
                  <Table
                    size="small"
                    rowKey={(r, i) => String(i)}
                    pagination={{ pageSize: 8 }}
                    dataSource={(d.usb as Array<Record<string, unknown>>) || []}
                    columns={[
                      { title: '名称', dataIndex: 'name' },
                      { title: '厂商', dataIndex: 'manufacturer' },
                      { title: '类型', dataIndex: 'type' }
                    ]}
                  />
                </SectionCard>
                <SectionCard title="音频 / 蓝牙">
                  <Table
                    size="small"
                    rowKey={(r, i) => `a${String(i)}`}
                    pagination={false}
                    dataSource={(d.audio as Array<Record<string, unknown>>) || []}
                    columns={[
                      { title: '音频设备', dataIndex: 'name' },
                      { title: '厂商', dataIndex: 'manufacturer' }
                    ]}
                  />
                  <Table
                    style={{ marginTop: 8 }}
                    size="small"
                    rowKey={(r, i) => `b${String(i)}`}
                    pagination={false}
                    dataSource={(d.bluetooth as Array<Record<string, unknown>>) || []}
                    columns={[
                      { title: '蓝牙设备', dataIndex: 'name' },
                      { title: '地址', dataIndex: 'address' },
                      { title: '电量', dataIndex: 'batteryPercent', render: (v) => (v != null ? `${v}%` : '—') }
                    ]}
                  />
                </SectionCard>
              </>
            )}
          />
        )}

        {tool === 'power' && (
          <HardwareDataPanel
            fetcher={(force) => window.api.hardware.power(force)}
            title="电源与传感器"
            render={(d) => {
              const battery = (d.battery || {}) as Record<string, unknown>
              const sensors = (d.sensors || {}) as Record<string, unknown>
              return (
                <>
                  <SectionCard title="电池">
                    {battery.hasBattery ? (
                      <>
                        <DescList
                          items={[
                            ['充电中', battery.isCharging ? '是' : '否'],
                            ['电量', `${battery.percent ?? '—'}%`],
                            ['设计容量', formatBytes(Number(battery.designedCapacity))],
                            ['最大容量', formatBytes(Number(battery.maxCapacity))],
                            ['电压', battery.voltage ? `${battery.voltage} V` : '—'],
                            ['厂商', String(battery.manufacturer ?? '—')],
                            ['型号', String(battery.model ?? '—')]
                          ]}
                        />
                        <div style={{ marginTop: 8 }}>
                          <Progress percent={Number(battery.percent ?? 0)} status={battery.isCharging ? 'success' : 'normal'} />
                        </div>
                      </>
                    ) : (
                      <Text type="secondary">未检测到电池（台式机）</Text>
                    )}
                  </SectionCard>
                  <SectionCard title="传感器">
                    <DescList
                      items={[
                        ['CPU 温度', sensors.cpuTemp != null ? `${sensors.cpuTemp}°C` : '—'],
                        ['CPU 负载', sensors.cpuLoad != null ? `${sensors.cpuLoad}%` : '—'],
                        ['内存占用', sensors.memUsedPercent != null ? `${sensors.memUsedPercent}%` : '—'],
                        ['磁盘占用', sensors.diskUsePercent != null ? `${sensors.diskUsePercent}%` : '—']
                      ]}
                    />
                  </SectionCard>
                </>
              )
            }}
          />
        )}
      </Card>
    </div>
  )
}
