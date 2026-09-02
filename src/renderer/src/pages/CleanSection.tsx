/* 磁盘清理 tab（P0）：大文件扫描删除 + 临时文件一键清理 */
import { useState } from 'react'
import { Button, Checkbox, Empty, Input, Modal, Space, Table, Tag, Typography, message } from 'antd'
import { DeleteOutlined, FileSearchOutlined, ThunderboltOutlined } from '@ant-design/icons'

type LargeFile = Awaited<ReturnType<typeof window.api.tools.findLargeFiles>>[number]
type ScanFile = Awaited<ReturnType<typeof window.api.tools.scanDirectory>>[number]

function fmt(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  return `${(n / 1024).toFixed(1)} KB`
}

export default function CleanSection() {
  const [dir, setDir] = useState('')
  const [minSize, setMinSize] = useState(50)
  const [loading, setLoading] = useState(false)
  const [largeFiles, setLargeFiles] = useState<LargeFile[]>([])
  const [tempFiles, setTempFiles] = useState<ScanFile[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const scanLarge = async (): Promise<void> => {
    if (!dir.trim()) {
      message.warning('请输入目录路径')
      return
    }
    setLoading(true)
    try {
      const files = await window.api.tools.findLargeFiles(dir.trim(), minSize * 1024 * 1024, 200)
      setLargeFiles(files)
      setSelected([])
      if (files.length === 0) message.info('未发现大文件')
    } catch (err) {
      message.error(`扫描失败：${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  const scanTemp = async (): Promise<void> => {
    if (!dir.trim()) {
      message.warning('请输入目录路径')
      return
    }
    setLoading(true)
    try {
      const files = await window.api.tools.scanDirectory(dir.trim(), {
        recursive: true
      })
      const temps = files.filter((f) => f.category === 'temp')
      setTempFiles(temps)
      if (temps.length === 0) message.info('未发现临时文件')
    } catch (err) {
      message.error(`扫描失败：${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  const totalSelected = [...selected].reduce((sum, p) => {
    const f = largeFiles.find((x) => x.path === p) ?? tempFiles.find((x) => x.path === p)
    return sum + (f?.size ?? 0)
  }, 0)

  const doDelete = async (): Promise<void> => {
    setDeleting(true)
    let ok = 0
    for (const p of selected) {
      if (await window.api.tools.deleteFile(p, true)) ok++
    }
    setLargeFiles((list) => list.filter((f) => !selected.includes(f.path)))
    setTempFiles((list) => list.filter((f) => !selected.includes(f.path)))
    setConfirmOpen(false)
    setSelected([])
    setDeleting(false)
    message.success(`已删除 ${ok}/${selected.length} 个文件（移入回收站）`)
  }

  const largeColumns = [
    { title: '', dataIndex: 'path', width: 36, render: (_v: unknown, r: LargeFile) => (
      <Checkbox checked={selected.includes(r.path)} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, r.path] : s.filter((x) => x !== r.path)))} />
    ) },
    { title: '文件名', dataIndex: 'name', ellipsis: true },
    { title: '大小', dataIndex: 'size', width: 90, render: (v: number) => <Typography.Text strong>{fmt(v)}</Typography.Text> },
    { title: '路径', dataIndex: 'path', ellipsis: true, render: (v: string) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{v}</Typography.Text> }
  ]

  const tempColumns = [
    { title: '', dataIndex: 'path', width: 36, render: (_v: unknown, r: ScanFile) => (
      <Checkbox checked={selected.includes(r.path)} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, r.path] : s.filter((x) => x !== r.path)))} />
    ) },
    { title: '文件名', dataIndex: 'name', ellipsis: true },
    { title: '类型', dataIndex: 'extension', width: 80, render: (v: string) => <Tag>{v || '无'}</Tag> },
    { title: '大小', dataIndex: 'size', width: 90, render: (v: number) => fmt(v) },
    { title: '路径', dataIndex: 'path', ellipsis: true, render: (v: string) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{v}</Typography.Text> }
  ]

  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <Input aria-label="目录路径" size="small" placeholder="目录路径" value={dir} onChange={(e) => setDir(e.target.value)} style={{ width: 300 }} onPressEnter={() => void scanLarge()} />
        <Input aria-label="大文件阈值（MB）" size="small" type="number" placeholder="大文件阈值 MB" value={String(minSize)} onChange={(e) => setMinSize(Number(e.target.value) || 50)} style={{ width: 110 }} />
        <Button size="small" type="primary" icon={<FileSearchOutlined />} onClick={() => void scanLarge()} loading={loading}>
          扫描大文件
        </Button>
        <Button size="small" icon={<ThunderboltOutlined />} onClick={() => void scanTemp()} loading={loading}>
          扫描临时文件
        </Button>
        <Button
          size="small"
          danger
          icon={<DeleteOutlined />}
          disabled={selected.length === 0}
          onClick={() => setConfirmOpen(true)}
        >
          删除选中（{selected.length} 项 · {fmt(totalSelected)}）
        </Button>
      </Space>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <Typography.Text strong>大文件（≥{minSize}MB）</Typography.Text>
          {largeFiles.length === 0 ? (
            <Empty style={{ marginTop: 20 }} description="点击「扫描大文件」查看" />
          ) : (
            <Table size="small" rowKey="path" dataSource={largeFiles} columns={largeColumns} pagination={{ pageSize: 10 }} style={{ marginTop: 8 }} />
          )}
        </div>
        <div>
          <Typography.Text strong>临时文件（.tmp/.temp/.bak/.swp 等）</Typography.Text>
          {tempFiles.length === 0 ? (
            <Empty style={{ marginTop: 20 }} description="点击「扫描临时文件」查看" />
          ) : (
            <Table size="small" rowKey="path" dataSource={tempFiles} columns={tempColumns} pagination={{ pageSize: 10 }} style={{ marginTop: 8 }} />
          )}
        </div>
      </div>

      <Modal
        title="确认删除"
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onOk={() => void doDelete()}
        okText="移入回收站"
        okButtonProps={{ danger: true, loading: deleting }}
        cancelText="取消"
      >
        <Typography.Text>
          将 {selected.length} 个文件（共 {fmt(totalSelected)}）移入回收站。可随时从回收站恢复。
        </Typography.Text>
      </Modal>
    </div>
  )
}
