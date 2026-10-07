import { ToolCard } from '../components/ToolCard'
import { formatError } from '../utils/formatError'
import { useCallback, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  ColorPicker,
  InputNumber,
  Progress,
  Radio,
  Segmented,
  Select,
  Slider,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
  Upload,
  message
} from 'antd'
import {
  CompressOutlined,
  ScissorOutlined,
  DownloadOutlined,
  FormatPainterOutlined,
  LoadingOutlined,
  SkinOutlined,
  AppstoreOutlined,
  MergeCellsOutlined,
  UploadOutlined
} from '@ant-design/icons'
import {
  CROP_ASPECTS,
  ICON_SIZES,
  QUALITY_PRESETS,
  canvasToBlob,
  compressImage,
  convertImage,
  cropCanvas,
  downloadBlob,
  fitAspectCrop,
  formatBytes,
  loadImages,
  makeIconSet,
  packCanvasesToZip,
  removeBackground,
  replaceColor,
  resizeCanvas,
  stitchImages,
  type CropAspect,
  type CropRect,
  type ImageFormat,
  type LoadedImage,
  type QualityPreset,
  type StitchDir
} from '../utils/imageTools'

const { Text, Title } = Typography

type ImageToolKey =
  | 'crop'
  | 'bgremove'
  | 'colorreplace'
  | 'convert'
  | 'compress'
  | 'stitch'
  | 'icon'

const TOOL_META: Array<{
  key: ImageToolKey
  title: string
  desc: string
  icon: React.ReactNode
  category: string
}> = [
  {
    key: 'crop',
    title: '图像剪裁',
    desc: '比例预设、构图辅助线与原图导出',
    icon: <ScissorOutlined />,
    category: '图像工具'
  },
  {
    key: 'bgremove',
    title: '背景移除',
    desc: '纯色/渐变背景一键抠图，支持羽化',
    icon: <SkinOutlined />,
    category: '图像工具'
  },
  {
    key: 'colorreplace',
    title: '智能颜色替换',
    desc: '吸管取样、连通区域保护与自然边缘过渡',
    icon: <FormatPainterOutlined />,
    category: '图像工具'
  },
  {
    key: 'convert',
    title: '图片格式转换',
    desc: 'JPG / PNG / WebP / BMP / GIF / SVG 互转',
    icon: <SwapIcon />,
    category: '图像工具'
  },
  {
    key: 'compress',
    title: '图片压缩',
    desc: '三档画质 / 批量压缩',
    icon: <CompressOutlined />,
    category: '图像工具'
  },
  {
    key: 'stitch',
    title: '长图拼接',
    desc: '纵向 / 横向 / 无缝拼接 / PNG / JPG',
    icon: <MergeCellsOutlined />,
    category: '图像工具'
  },
  {
    key: 'icon',
    title: '图标生成器',
    desc: '一键生成多尺寸图标并打包',
    icon: <AppstoreOutlined />,
    category: '图像工具'
  }
]

function SwapIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M7 7h11l-3-3M17 17H6l3 3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function useImageWorkspace() {
  const [images, setImages] = useState<LoadedImage[]>([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)

  const pick = useCallback(async (files: File[]) => {
    if (!files.length) return
    setBusy(true)
    try {
      const loaded = await loadImages(files)
      if (!loaded.length) {
        message.error('未能读取所选图片')
        return
      }
      setImages((prev) => [...prev, ...loaded])
      message.success(`已加载 ${loaded.length} 张图片`)
    } finally {
      setBusy(false)
    }
  }, [])

  const clear = useCallback(() => {
    setImages([])
    setProgress(0)
  }, [])

  return { images, setImages, busy, setBusy, progress, setProgress, pick, clear }
}

/* ---------- 裁剪 ---------- */
function CropPanel({ images }: { images: LoadedImage[] }) {
  const [index, setIndex] = useState(0)
  const [aspect, setAspect] = useState<CropAspect>('free')
  const [rect, setRect] = useState<CropRect>({ x: 0, y: 0, w: 0, h: 0 })
  const [showGrid, setShowGrid] = useState(true)
  const current = images[Math.min(index, images.length - 1)]

  const applyAspect = useCallback(
    (a: CropAspect) => {
      setAspect(a)
      if (!current) return
      const r = fitAspectCrop(current.width, current.height, a)
      setRect(r)
    },
    [current]
  )

  // 初始化裁剪框
  const inited = useRef(false)
  if (current && !inited.current) {
    inited.current = true
    setRect({ x: 0, y: 0, w: current.width, h: current.height })
  }

  const doCrop = async (keepOriginal: boolean) => {
    if (!current) return
    const out = cropCanvas(current.canvas, rect)
    const blob = await canvasToBlob(out, 'image/png')
    downloadBlob(blob, keepOriginal ? `crop-${current.name}` : `crop-${Date.now()}.png`)
    message.success('裁剪已导出')
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert
        type="info"
        showIcon
        message="比例预设 · 构图辅助线 · 原图导出"
        description="选择比例后自动居中裁剪框，可微调数值；支持导出裁剪结果或原图。"
      />
      {!current ? (
        <Text type="secondary">请先在上方加载图片</Text>
      ) : (
        <>
          <Space wrap>
            <Select
              style={{ width: 120 }}
              value={index}
              onChange={setIndex}
              options={images.map((im, i) => ({ value: i, label: im.name }))}
            />
            <Segmented
              value={aspect}
              onChange={(v) => applyAspect(v as CropAspect)}
              options={CROP_ASPECTS.map((a) => ({ label: a.label, value: a.value }))}
            />
            <Switch checked={showGrid} onChange={setShowGrid} checkedChildren="辅助线" unCheckedChildren="辅助线" />
          </Space>

          <div className="mt-preview-box">
            <canvas
              ref={(el) => {
                if (!el || !current) return
                el.width = Math.min(560, current.width)
                const scale = el.width / current.width
                el.height = Math.round(current.height * scale)
                const ctx = el.getContext('2d')
                if (!ctx) return
                ctx.clearRect(0, 0, el.width, el.height)
                ctx.drawImage(current.canvas, 0, 0, el.width, el.height)
                const sx = rect.x * scale
                const sy = rect.y * scale
                const sw = rect.w * scale
                const sh = rect.h * scale
                ctx.fillStyle = 'rgba(0,0,0,0.45)'
                ctx.fillRect(0, 0, el.width, el.height)
                ctx.clearRect(sx, sy, sw, sh)
                ctx.drawImage(current.canvas, rect.x, rect.y, rect.w, rect.h, sx, sy, sw, sh)
                ctx.strokeStyle = '#1D9E75'
                ctx.lineWidth = 2
                ctx.strokeRect(sx, sy, sw, sh)
                if (showGrid) {
                  ctx.strokeStyle = 'rgba(255,255,255,0.45)'
                  ctx.lineWidth = 1
                  for (let i = 1; i < 3; i++) {
                    ctx.beginPath()
                    ctx.moveTo(sx + (sw * i) / 3, sy)
                    ctx.lineTo(sx + (sw * i) / 3, sy + sh)
                    ctx.moveTo(sx, sy + (sh * i) / 3)
                    ctx.lineTo(sx + sw, sy + (sh * i) / 3)
                    ctx.stroke()
                  }
                }
              }}
            />
          </div>

          <Space wrap>
            <Text>X</Text>
            <InputNumber size="small" min={0} max={current.width} value={rect.x} onChange={(v) => setRect((r) => ({ ...r, x: v ?? 0 }))} />
            <Text>Y</Text>
            <InputNumber size="small" min={0} max={current.height} value={rect.y} onChange={(v) => setRect((r) => ({ ...r, y: v ?? 0 }))} />
            <Text>W</Text>
            <InputNumber size="small" min={1} max={current.width} value={rect.w} onChange={(v) => setRect((r) => ({ ...r, w: v ?? 1 }))} />
            <Text>H</Text>
            <InputNumber size="small" min={1} max={current.height} value={rect.h} onChange={(v) => setRect((r) => ({ ...r, h: v ?? 1 }))} />
          </Space>

          <Space wrap>
            <Button type="primary" icon={<ScissorOutlined />} onClick={() => void doCrop(false)}>
              导出裁剪图
            </Button>
            <Button icon={<DownloadOutlined />} onClick={() => void doCrop(true)}>
              导出原图
            </Button>
            <Button onClick={() => applyAspect(aspect)}>重置裁剪框</Button>
          </Space>
        </>
      )}
    </Space>
  )
}

/* ---------- 背景移除 ---------- */
function BgRemovePanel({ images }: { images: LoadedImage[] }) {
  const [index, setIndex] = useState(0)
  const [tolerance, setTolerance] = useState(35)
  const [feather, setFeather] = useState(2)
  const [keepLargest, setKeepLargest] = useState(true)
  const [preview, setPreview] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const current = images[Math.min(index, images.length - 1)]

  const run = async () => {
    if (!current) return
    setBusy(true)
    try {
      // 小图先处理，避免卡顿
      const src = current.width * current.height > 2_500_000 ? resizeCanvas(current.canvas, 1600) : current.canvas
      const out = removeBackground(src, { tolerance, feather, keepLargest })
      setPreview(out.toDataURL('image/png'))
      message.success('背景已移除')
    } catch (err) {
      message.error(formatError(err))
    } finally {
      setBusy(false)
    }
  }

  const download = async () => {
    if (!preview) return
    const res = await fetch(preview)
    downloadBlob(await res.blob(), `nobg-${current?.name?.replace(/\.\w+$/, '') || 'image'}.png`)
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert
        type="info"
        showIcon
        message="纯色背景抠图 · 边缘羽化 · 最大连通区保护"
        description="从四角/边缘采样背景色，智能分离前景并对边缘做羽化，适合纯色/渐变背景。"
      />
      {!current ? (
        <Text type="secondary">请先加载图片</Text>
      ) : (
        <>
          <Space wrap>
            <Select style={{ width: 160 }} value={index} onChange={setIndex} options={images.map((im, i) => ({ value: i, label: im.name }))} />
            <Button type="primary" icon={<SkinOutlined />} loading={busy} onClick={() => void run()}>
              一键移除背景
            </Button>
            <Button icon={<DownloadOutlined />} disabled={!preview} onClick={() => void download()}>
              导出 PNG
            </Button>
          </Space>
          <Space direction="vertical" style={{ width: '100%', maxWidth: 420 }}>
            <Text>容差 {tolerance}</Text>
            <Slider min={5} max={90} value={tolerance} onChange={setTolerance} />
            <Text>边缘羽化 {feather}</Text>
            <Slider min={0} max={8} value={feather} onChange={setFeather} />
            <Switch checked={keepLargest} onChange={setKeepLargest} checkedChildren="保留主体" unCheckedChildren="保留全部" />
          </Space>
          <div className="mt-preview-box">
            {busy ? (
              <Spin indicator={<LoadingOutlined spin />} />
            ) : preview ? (
              <img src={preview} alt="preview" className="mt-preview-img checkerboard" />
            ) : (
              <img src={current.canvas.toDataURL('image/png')} alt="src" className="mt-preview-img" />
            )}
          </div>
        </>
      )}
    </Space>
  )
}

/* ---------- 颜色替换 ---------- */
function ColorReplacePanel({ images }: { images: LoadedImage[] }) {
  const [index, setIndex] = useState(0)
  const [from, setFrom] = useState('#ffffff')
  const [to, setTo] = useState('#1D9E75')
  const [tolerance, setTolerance] = useState(30)
  const [softness, setSoftness] = useState(2)
  const [contiguous, setContiguous] = useState(true)
  const [preview, setPreview] = useState<string>('')
  const current = images[Math.min(index, images.length - 1)]

  const hexToRgb = (hex: string): [number, number, number] => {
    const h = hex.replace('#', '')
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
  }

  const sample = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!current) return
    const img = e.currentTarget
    const rect = img.getBoundingClientRect()
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * current.width)
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * current.height)
    const ctx = current.canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    const d = ctx.getImageData(x, y, 1, 1).data
    const hex = `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`
    setFrom(hex)
    message.success(`已取样 ${hex}`)
  }

  const run = () => {
    if (!current) return
    const out = replaceColor(current.canvas, {
      from: hexToRgb(from),
      to: hexToRgb(to),
      tolerance,
      softness,
      contiguous
    })
    setPreview(out.toDataURL('image/png'))
  }

  const download = async () => {
    if (!preview) return
    const res = await fetch(preview)
    downloadBlob(await res.blob(), `recolor-${current?.name?.replace(/\.\w+$/, '') || 'image'}.png`)
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert
        type="info"
        showIcon
        message="吸管取样 · 连通区域 · 自然边缘过渡"
        description="点击预览图取样目标色，替换为新色；开启连通区域可避免误伤同色无关区块。"
      />
      {!current ? (
        <Text type="secondary">请先加载图片</Text>
      ) : (
        <>
          <Space wrap>
            <Select style={{ width: 160 }} value={index} onChange={setIndex} options={images.map((im, i) => ({ value: i, label: im.name }))} />
            <Text>取样色</Text>
            <ColorPicker value={from} onChange={(c) => setFrom(c.toHexString())} showText />
            <Text>替换为</Text>
            <ColorPicker value={to} onChange={(c) => setTo(c.toHexString())} showText />
            <Switch checked={contiguous} onChange={setContiguous} checkedChildren="连通区域" unCheckedChildren="全图匹配" />
          </Space>
          <Space direction="vertical" style={{ width: '100%', maxWidth: 420 }}>
            <Text>容差 {tolerance}</Text>
            <Slider min={5} max={90} value={tolerance} onChange={setTolerance} />
            <Text>边缘过渡 {softness}</Text>
            <Slider min={0} max={5} value={softness} onChange={setSoftness} />
          </Space>
          <Space>
            <Button type="primary" icon={<FormatPainterOutlined />} onClick={run}>
              替换颜色
            </Button>
            <Button icon={<DownloadOutlined />} disabled={!preview} onClick={() => void download()}>
              导出 PNG
            </Button>
          </Space>
          <div className="mt-preview-box">
            <img
              src={preview || current.canvas.toDataURL('image/png')}
              alt="preview"
              className="mt-preview-img"
              onClick={sample}
              style={{ cursor: 'crosshair' }}
            />
          </div>
          <Text type="secondary">点击图片可吸取颜色</Text>
        </>
      )}
    </Space>
  )
}

/* ---------- 格式转换 ---------- */
function ConvertPanel({ images }: { images: LoadedImage[] }) {
  const [format, setFormat] = useState<ImageFormat>('webp')
  const [quality, setQuality] = useState(0.9)
  const [busy, setBusy] = useState(false)

  const convertAll = async () => {
    if (!images.length) return
    setBusy(true)
    try {
      for (const im of images) {
        const blob = await convertImage(im.canvas, format, quality)
        const ext = format === 'jpeg' ? 'jpg' : format
        downloadBlob(blob, `${im.name.replace(/\.\w+$/, '')}.${ext}`)
        await new Promise((r) => setTimeout(r, 150))
      }
      message.success(`已转换 ${images.length} 张`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="JPG / PNG / WebP / BMP / GIF 互转" description="本地 Canvas 解码编码，批量导出。SVG 为矢量格式请使用矢量工具。" />
      <Space wrap>
        <Text>目标格式</Text>
        <Segmented
          value={format}
          onChange={(v) => setFormat(v as ImageFormat)}
          options={[
            { label: 'JPG', value: 'jpeg' },
            { label: 'PNG', value: 'png' },
            { label: 'WebP', value: 'webp' },
            { label: 'BMP', value: 'bmp' },
            { label: 'GIF', value: 'gif' }
          ]}
        />
        {format !== 'png' && (
          <>
            <Text>质量 {Math.round(quality * 100)}</Text>
            <Slider style={{ width: 140 }} min={0.3} max={1} step={0.05} value={quality} onChange={setQuality} />
          </>
        )}
        <Button type="primary" icon={<SwapIcon />} loading={busy} disabled={!images.length} onClick={() => void convertAll()}>
          批量转换（{images.length}）
        </Button>
      </Space>
      <div className="mt-file-list">
        {images.map((im) => (
          <Tag key={im.name + im.size}>
            {im.name} · {im.width}×{im.height} · {formatBytes(im.size)}
          </Tag>
        ))}
      </div>
    </Space>
  )
}

/* ---------- 压缩 ---------- */
function CompressPanel({ images }: { images: LoadedImage[] }) {
  const [preset, setPreset] = useState<QualityPreset>('medium')
  const [format, setFormat] = useState<ImageFormat>('jpeg')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Array<{ name: string; before: number; after: number }>>([])

  const run = async () => {
    if (!images.length) return
    setBusy(true)
    const list: Array<{ name: string; before: number; after: number }> = []
    try {
      for (const im of images) {
        const r = await compressImage(im.canvas, preset, format)
        const ext = format === 'jpeg' ? 'jpg' : format
        downloadBlob(r.blob, `${im.name.replace(/\.\w+$/, '')}-min.${ext}`)
        list.push({ name: im.name, before: im.size, after: r.size })
        await new Promise((res) => setTimeout(res, 150))
      }
      setResults(list)
      message.success('批量压缩完成')
    } finally {
      setBusy(false)
    }
  }

  const totalBefore = results.reduce((s, r) => s + r.before, 0)
  const totalAfter = results.reduce((s, r) => s + r.after, 0)

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="三档画质 / 批量压缩" description="高画质 / 中等 / 极限压缩，自动限制长边并导出。" />
      <Space wrap>
        <Radio.Group value={preset} onChange={(e) => setPreset(e.target.value)}>
          <Radio.Button value="high">高画质</Radio.Button>
          <Radio.Button value="medium">中等</Radio.Button>
          <Radio.Button value="low">极限压缩</Radio.Button>
        </Radio.Group>
        <Segmented
          value={format}
          onChange={(v) => setFormat(v as ImageFormat)}
          options={[
            { label: 'JPG', value: 'jpeg' },
            { label: 'WebP', value: 'webp' },
            { label: 'PNG', value: 'png' }
          ]}
        />
        <Button type="primary" icon={<CompressOutlined />} loading={busy} disabled={!images.length} onClick={() => void run()}>
          开始压缩
        </Button>
      </Space>
      {results.length > 0 && (
        <Card size="small" title="压缩结果">
          {results.map((r) => (
            <div key={r.name} className="mt-compress-row">
              <Text ellipsis style={{ maxWidth: 220 }}>{r.name}</Text>
              <Text type="secondary">
                {formatBytes(r.before)} → {formatBytes(r.after)}
              </Text>
              <Progress
                percent={Math.max(0, Math.round((1 - r.after / Math.max(1, r.before)) * 100))}
                size="small"
                style={{ width: 140 }}
              />
            </div>
          ))}
          <Text strong>
            合计：{formatBytes(totalBefore)} → {formatBytes(totalAfter)}（节省{' '}
            {totalBefore ? Math.round((1 - totalAfter / totalBefore) * 100) : 0}%）
          </Text>
        </Card>
      )}
    </Space>
  )
}

/* ---------- 长图拼接 ---------- */
function StitchPanel({ images }: { images: LoadedImage[] }) {
  const [dir, setDir] = useState<StitchDir>('vertical')
  const [gap, setGap] = useState(0)
  const [format, setFormat] = useState<'png' | 'jpeg'>('png')
  const [preview, setPreview] = useState<string>('')

  const doStitch = async () => {
    if (images.length < 2) {
      message.warning('至少需要 2 张图片')
      return
    }
    const out = stitchImages(images.map((i) => i.canvas), dir, gap)
    setPreview(out.toDataURL('image/png'))
    const blob = await canvasToBlob(out, format === 'png' ? 'image/png' : 'image/jpeg', 0.92)
    downloadBlob(blob, `stitch.${format === 'png' ? 'png' : 'jpg'}`)
    message.success('拼接完成')
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="纵向 / 横向 / 无缝拼接" description="按加载顺序拼接，可设置间距；支持 PNG / JPG 导出。" />
      <Space wrap>
        <Segmented
          value={dir}
          onChange={(v) => setDir(v as StitchDir)}
          options={[
            { label: '纵向', value: 'vertical' },
            { label: '横向', value: 'horizontal' }
          ]}
        />
        <Text>间距</Text>
        <InputNumber size="small" min={0} max={100} value={gap} onChange={(v) => setGap(v ?? 0)} />
        <Segmented
          value={format}
          onChange={(v) => setFormat(v as 'png' | 'jpeg')}
          options={[
            { label: 'PNG', value: 'png' },
            { label: 'JPG', value: 'jpeg' }
          ]}
        />
        <Button type="primary" icon={<MergeCellsOutlined />} onClick={() => void doStitch()}>
          拼接并导出
        </Button>
      </Space>
      <Space wrap>
        {images.map((im, i) => (
          <Tag key={i}>{i + 1}. {im.name}</Tag>
        ))}
      </Space>
      {preview && (
        <div className="mt-preview-box">
          <img src={preview} alt="stitch" className="mt-preview-img" />
        </div>
      )}
    </Space>
  )
}

/* ---------- 图标生成 ---------- */
function IconPanel({ images }: { images: LoadedImage[] }) {
  const [index, setIndex] = useState(0)
  const [sizes, setSizes] = useState<number[]>([16, 32, 48, 64, 128, 256, 512])
  const [pad, setPad] = useState(8)
  const [busy, setBusy] = useState(false)
  const current = images[Math.min(index, images.length - 1)]

  const generate = async () => {
    if (!current) return
    setBusy(true)
    try {
      const set = makeIconSet(current.canvas, sizes, { padRatio: pad / 100 })
      const zip = await packCanvasesToZip(set)
      downloadBlob(zip, `icons-${current.name.replace(/\.\w+$/, '')}.zip`)
      message.success(`已打包 ${set.length} 个尺寸`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="一键生成多尺寸图标并打包" description="自动生成常见尺寸 PNG 并打包为 ZIP。" />
      {!current ? (
        <Text type="secondary">请先加载图片</Text>
      ) : (
        <>
          <Space wrap>
            <Select style={{ width: 160 }} value={index} onChange={setIndex} options={images.map((im, i) => ({ value: i, label: im.name }))} />
            <Select
              mode="multiple"
              style={{ minWidth: 280 }}
              value={sizes}
              onChange={setSizes}
              options={ICON_SIZES.map((s) => ({ value: s, label: `${s}×${s}` }))}
            />
            <Text>留白 {pad}%</Text>
            <Slider style={{ width: 120 }} min={0} max={25} value={pad} onChange={setPad} />
            <Button type="primary" icon={<AppstoreOutlined />} loading={busy} onClick={() => void generate()}>
              生成并打包 ZIP
            </Button>
          </Space>
          <div className="mt-icon-preview">
            {makeIconSet(current.canvas, sizes.filter((s) => s <= 128), { padRatio: pad / 100 }).map((item) => (
              <div key={item.size} className="mt-icon-item">
                <img src={item.canvas.toDataURL('image/png')} alt={item.name} />
                <Text type="secondary">{item.size}</Text>
              </div>
            ))}
          </div>
        </>
      )}
    </Space>
  )
}

export default function ImageTools({ embedded = false }: { embedded?: boolean }) {
  const [tool, setTool] = useState<ImageToolKey>('crop')
  const { images, busy, pick, clear } = useImageWorkspace()
  const meta = TOOL_META.find((t) => t.key === tool)!

  return (
    <div className="media-tools-page">
      {embedded ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <Upload
            multiple
            accept="image/*"
            showUploadList={false}
            beforeUpload={(f) => {
              void pick([f])
              return false
            }}
          >
            <Button size="small" icon={<UploadOutlined />} loading={busy}>
              加载图片
            </Button>
          </Upload>
          <Button size="small" onClick={clear} disabled={!images.length}>
            清空（{images.length}）
          </Button>
          <Text type="secondary" style={{ fontSize: 12 }}>
            裁剪 · 抠图 · 调色 · 转换压缩 · 拼接 · 图标
          </Text>
        </div>
      ) : (
        <div className="page-header">
          <Title level={4} style={{ margin: 0 }}>
            图片工具
          </Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            裁剪 · 抠图 · 调色 · 转换压缩 · 拼接 · 图标
          </Text>
          <div style={{ flex: 1 }} />
          <Space>
            <Upload
              multiple
              accept="image/*"
              showUploadList={false}
              beforeUpload={(f) => {
                void pick([f])
                return false
              }}
            >
              <Button icon={<UploadOutlined />} loading={busy}>
                加载图片
              </Button>
            </Upload>
            <Button onClick={clear} disabled={!images.length}>
              清空（{images.length}）
            </Button>
          </Space>
        </div>
      )}

      <div className="mt-grid">
        {TOOL_META.map((t) => (
          <ToolCard
            key={t.key}
            active={tool === t.key}
            title={t.title}
            desc={t.desc}
            icon={t.icon}
            category={t.category}
            onClick={() => setTool(t.key)}
          />
        ))}
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
        {tool === 'crop' && <CropPanel images={images} />}
        {tool === 'bgremove' && <BgRemovePanel images={images} />}
        {tool === 'colorreplace' && <ColorReplacePanel images={images} />}
        {tool === 'convert' && <ConvertPanel images={images} />}
        {tool === 'compress' && <CompressPanel images={images} />}
        {tool === 'stitch' && <StitchPanel images={images} />}
        {tool === 'icon' && <IconPanel images={images} />}
      </Card>
    </div>
  )
}
