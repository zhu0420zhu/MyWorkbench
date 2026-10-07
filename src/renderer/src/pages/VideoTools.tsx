import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ToolCard } from '../components/ToolCard'
import { formatError } from '../utils/formatError'
import {
  Alert,
  Button,
  Card,
  InputNumber,
  Segmented,
  Select,
  Slider,
  Space,
  Spin,
  Tag,
  Typography,
  Upload,
  message
} from 'antd'
import {
  AudioOutlined,
  CameraOutlined,
  DownloadOutlined,
  FileImageOutlined,
  FastForwardOutlined,
  LoadingOutlined,
  ScissorOutlined,
  SwapOutlined,
  UploadOutlined,
  VideoCameraOutlined
} from '@ant-design/icons'
import {
  buildPeaks,
  detectBpm,
  decodeAudioFile,
  drawWaveform,
  formatTime,
  sliceAudioToWav,
  type BpmResult
} from '../utils/audioTools'
import { formatBytes } from '../utils/imageTools'

const { Text, Title } = Typography

type VideoToolKey =
  | 'video-convert'
  | 'video-frame'
  | 'video-gif'
  | 'audio-convert'
  | 'bpm'
  | 'audio-trim'
  | 'audio-extract'

const TOOL_META: Array<{
  key: VideoToolKey
  title: string
  desc: string
  icon: React.ReactNode
  category: string
}> = [
  {
    key: 'audio-convert',
    title: '音频文件格式转换',
    desc: 'MP3 / AAC / WAV / FLAC / ALAC / OGG / WMA',
    icon: <SwapOutlined />,
    category: '音频工具'
  },
  {
    key: 'bpm',
    title: 'BPM 节拍测速器',
    desc: '上传音频自动检测 BPM',
    icon: <FastForwardOutlined />,
    category: '音频工具'
  },
  {
    key: 'audio-trim',
    title: '音频剪辑',
    desc: '波形可视化剪辑、区域选择、导出片段',
    icon: <ScissorOutlined />,
    category: '音频工具'
  },
  {
    key: 'audio-extract',
    title: '音频提取',
    desc: '从视频中提取音频',
    icon: <AudioOutlined />,
    category: '音频工具'
  },
  {
    key: 'video-convert',
    title: '视频格式转换',
    desc: 'MP4 / AVI / MKV / MOV / WebM / FLV / WMV / TS',
    icon: <SwapOutlined />,
    category: '视频工具'
  },
  {
    key: 'video-frame',
    title: '视频高清单帧图',
    desc: '逐帧定位 / PNG 无损 / 原始分辨率',
    icon: <CameraOutlined />,
    category: '视频工具'
  },
  {
    key: 'video-gif',
    title: '视频截取 GIF',
    desc: '起止帧选择 / 最长 30 秒 / 逐帧预览',
    icon: <FileImageOutlined />,
    category: '视频工具'
  }
]

interface PickedFile {
  path: string
  name: string
  size: number
}

function getMediaApi() {
  return window.api.media
}

function useFfmpegReady() {
  const [ready, setReady] = useState<boolean | null>(null)
  useEffect(() => {
    void getMediaApi()
      .ffmpegAvailable()
      .then(setReady)
      .catch(() => setReady(false))
  }, [])
  return ready
}

function FfmpegBanner() {
  const ready = useFfmpegReady()
  if (ready === null) return <Alert type="info" showIcon message="正在检测 FFmpeg…" />
  if (!ready)
    return (
      <Alert
        type="warning"
        showIcon
        message="未检测到 FFmpeg"
        description="视频/音频处理依赖内置 FFmpeg。请确认 resources/tools/ffmpeg 可用，或安装 ffmpeg 并加入 PATH。"
      />
    )
  return <Alert type="success" showIcon message="FFmpeg 已就绪（本地处理，文件不上传）" />
}

/* ---------- 视频格式转换 ---------- */
function VideoConvertPanel() {
  const [file, setFile] = useState<PickedFile | null>(null)
  const [format, setFormat] = useState('.mp4')
  const [quality, setQuality] = useState<'low' | 'medium' | 'high'>('medium')
  const [busy, setBusy] = useState(false)
  const api = getMediaApi()

  const pick = async () => {
    const list = await api.pickVideo()
    if (list[0]) setFile(list[0])
  }

  const run = async () => {
    if (!file) return
    setBusy(true)
    try {
      const res = await api.convert({
        sourcePath: file.path,
        targetFormat: format,
        quality,
        kind: 'video'
      })
      if (res.ok) message.success(`已导出：${res.outputPath}`)
      else message.error(res.error || '转换失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="MP4 / AVI / MKV / MOV / WebM / FLV / WMV / TS" description="基于 FFmpeg 本地转码，支持质量三档。" />
      <Space wrap>
        <Button icon={<UploadOutlined />} onClick={() => void pick()}>
          选择视频
        </Button>
        {file && <Tag>{file.name} · {formatBytes(file.size)}</Tag>}
        <Select
          style={{ width: 120 }}
          value={format}
          onChange={setFormat}
          options={['.mp4', '.avi', '.mkv', '.mov', '.webm', '.flv', '.wmv', '.ts', '.m4v'].map((f) => ({
            value: f,
            label: f.slice(1).toUpperCase()
          }))}
        />
        <Segmented
          value={quality}
          onChange={(v) => setQuality(v as 'low' | 'medium' | 'high')}
          options={[
            { label: '低', value: 'low' },
            { label: '中', value: 'medium' },
            { label: '高', value: 'high' }
          ]}
        />
        <Button type="primary" icon={<SwapOutlined />} loading={busy} disabled={!file} onClick={() => void run()}>
          开始转换
        </Button>
      </Space>
    </Space>
  )
}

/* ---------- 视频单帧 ---------- */
function VideoFramePanel() {
  const [file, setFile] = useState<PickedFile | null>(null)
  const [timeSec, setTimeSec] = useState(0)
  const [duration, setDuration] = useState(0)
  const [format, setFormat] = useState<'png' | 'jpg' | 'webp'>('png')
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState('')
  const api = getMediaApi()

  const pick = async () => {
    const list = await api.pickVideo()
    if (!list[0]) return
    setFile(list[0])
    const probe = await api.probe(list[0].path)
    if (probe.ok) {
      setDuration(probe.durationSec)
      setTimeSec(0)
      setInfo(`${probe.width}×${probe.height} · ${probe.durationSec.toFixed(1)}s · ${probe.fps}fps`)
    }
  }

  const run = async () => {
    if (!file) return
    setBusy(true)
    try {
      const res = await api.extractFrame({
        sourcePath: file.path,
        timeSec,
        format
      })
      if (res.ok) message.success(`已导出：${res.outputPath}`)
      else message.error(res.error || '抽帧失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="逐帧定位 / PNG 无损 / 原始分辨率" description="按时间点精确抽取单帧，PNG 默认无损。" />
      <Space wrap>
        <Button icon={<UploadOutlined />} onClick={() => void pick()}>
          选择视频
        </Button>
        {file && <Tag>{file.name}</Tag>}
        {info && <Tag color="blue">{info}</Tag>}
      </Space>
      {file && (
        <>
          <Space direction="vertical" style={{ width: '100%', maxWidth: 480 }}>
            <Text>时间点：{formatTime(timeSec)}</Text>
            <Slider min={0} max={Math.max(duration, 1)} step={0.04} value={timeSec} onChange={setTimeSec} />
            <Space>
              <InputNumber
                size="small"
                min={0}
                max={duration}
                step={0.1}
                value={Number(timeSec.toFixed(2))}
                onChange={(v) => setTimeSec(v ?? 0)}
              />
              <Segmented
                value={format}
                onChange={(v) => setFormat(v as 'png' | 'jpg' | 'webp')}
                options={[
                  { label: 'PNG', value: 'png' },
                  { label: 'JPG', value: 'jpg' },
                  { label: 'WebP', value: 'webp' }
                ]}
              />
            </Space>
          </Space>
          <Button type="primary" icon={<CameraOutlined />} loading={busy} onClick={() => void run()}>
            导出单帧图
          </Button>
        </>
      )}
    </Space>
  )
}

/* ---------- 视频转 GIF ---------- */
function VideoGifPanel() {
  const [file, setFile] = useState<PickedFile | null>(null)
  const [startSec, setStartSec] = useState(0)
  const [endSec, setEndSec] = useState(3)
  const [duration, setDuration] = useState(0)
  const [fps, setFps] = useState(12)
  const [width, setWidth] = useState(480)
  const [busy, setBusy] = useState(false)
  const api = getMediaApi()

  const pick = async () => {
    const list = await api.pickVideo()
    if (!list[0]) return
    setFile(list[0])
    const probe = await api.probe(list[0].path)
    if (probe.ok) {
      setDuration(probe.durationSec)
      setStartSec(0)
      setEndSec(Math.min(3, probe.durationSec))
    }
  }

  const run = async () => {
    if (!file) return
    if (endSec - startSec <= 0) {
      message.warning('结束时间需大于开始时间')
      return
    }
    if (endSec - startSec > 30) {
      message.warning('最长 30 秒')
      return
    }
    setBusy(true)
    try {
      const res = await api.videoToGif({
        sourcePath: file.path,
        startSec,
        endSec,
        fps,
        width
      })
      if (res.ok) message.success(`已导出：${res.outputPath}`)
      else message.error(res.error || 'GIF 生成失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="起止帧选择 / 最长 30 秒 / 逐帧预览" description="FFmpeg 调色板两遍生成，体积更小画质更稳。" />
      <Space wrap>
        <Button icon={<UploadOutlined />} onClick={() => void pick()}>
          选择视频
        </Button>
        {file && <Tag>{file.name} · {duration.toFixed(1)}s</Tag>}
      </Space>
      {file && (
        <>
          <Space direction="vertical" style={{ width: '100%', maxWidth: 520 }}>
            <Text>开始：{formatTime(startSec)}</Text>
            <Slider min={0} max={Math.max(duration, 1)} step={0.04} value={startSec} onChange={setStartSec} />
            <Text>结束：{formatTime(endSec)}（时长 {(endSec - startSec).toFixed(1)}s / 上限 30s）</Text>
            <Slider min={0} max={Math.max(duration, 1)} step={0.04} value={endSec} onChange={setEndSec} />
            <Space>
              <Text>FPS</Text>
              <InputNumber size="small" min={1} max={30} value={fps} onChange={(v) => setFps(v ?? 12)} />
              <Text>宽度</Text>
              <InputNumber size="small" min={64} max={1280} step={16} value={width} onChange={(v) => setWidth(v ?? 480)} />
            </Space>
          </Space>
          <Button type="primary" icon={<FileImageOutlined />} loading={busy} onClick={() => void run()}>
            生成 GIF
          </Button>
        </>
      )}
    </Space>
  )
}

/* ---------- 音频格式转换 ---------- */
function AudioConvertPanel() {
  const [file, setFile] = useState<PickedFile | null>(null)
  const [format, setFormat] = useState('.mp3')
  const [quality, setQuality] = useState<'low' | 'medium' | 'high'>('medium')
  const [busy, setBusy] = useState(false)
  const api = getMediaApi()

  const pick = async () => {
    const list = await api.pickAudio()
    if (list[0]) setFile(list[0])
  }

  const run = async () => {
    if (!file) return
    setBusy(true)
    try {
      const res = await api.convert({
        sourcePath: file.path,
        targetFormat: format,
        quality,
        kind: 'audio'
      })
      if (res.ok) message.success(`已导出：${res.outputPath}`)
      else message.error(res.error || '转换失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="MP3 / AAC / WAV / FLAC / ALAC / OGG / WMA" description="本地 FFmpeg 音频转码。" />
      <Space wrap>
        <Button icon={<UploadOutlined />} onClick={() => void pick()}>
          选择音频
        </Button>
        {file && <Tag>{file.name} · {formatBytes(file.size)}</Tag>}
        <Select
          style={{ width: 120 }}
          value={format}
          onChange={setFormat}
          options={['.mp3', '.aac', '.wav', '.flac', '.alac', '.ogg', '.wma', '.m4a', '.opus', '.aiff'].map((f) => ({
            value: f,
            label: f.slice(1).toUpperCase()
          }))}
        />
        <Segmented
          value={quality}
          onChange={(v) => setQuality(v as 'low' | 'medium' | 'high')}
          options={[
            { label: '低', value: 'low' },
            { label: '中', value: 'medium' },
            { label: '高', value: 'high' }
          ]}
        />
        <Button type="primary" icon={<SwapOutlined />} loading={busy} disabled={!file} onClick={() => void run()}>
          开始转换
        </Button>
      </Space>
    </Space>
  )
}

/* ---------- BPM ---------- */
function BpmPanel() {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<BpmResult | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const onPick = (f: File) => {
    setFile(f)
    setResult(null)
    return false
  }

  const run = async () => {
    if (!file) return
    setBusy(true)
    try {
      const r = await detectBpm(file)
      setResult(r)
      if (r.ok) {
        message.success(`检测到 BPM ≈ ${r.bpm}`)
        requestAnimationFrame(() => {
          const c = canvasRef.current
          if (c) drawWaveform(c, r.peaks, { color: 'rgba(29,158,117,0.8)' })
        })
      } else {
        message.error(r.error || '检测失败')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="上传音频自动检测 BPM" description="Onset 能量包络 + 自相关，纯本地计算。" />
      <Space wrap>
        <Upload accept="audio/*" showUploadList={false} beforeUpload={(f) => onPick(f)} maxCount={1}>
          <Button icon={<UploadOutlined />}>选择音频</Button>
        </Upload>
        {file && <Tag>{file.name}</Tag>}
        <Button type="primary" icon={<FastForwardOutlined />} loading={busy} disabled={!file} onClick={() => void run()}>
          检测 BPM
        </Button>
      </Space>
      {busy && <Spin indicator={<LoadingOutlined spin />} />}
      {result?.ok && (
        <Card size="small">
          <Space size="large" wrap>
            <div>
              <Text type="secondary">BPM</Text>
              <Title level={2} style={{ margin: 0 }}>
                {result.bpm}
              </Title>
            </div>
            <div>
              <Text type="secondary">置信度</Text>
              <Title level={3} style={{ margin: 0 }}>
                {Math.round(result.confidence * 100)}%
              </Title>
            </div>
            <div>
              <Text type="secondary">时长</Text>
              <Title level={3} style={{ margin: 0 }}>
                {formatTime(result.durationSec)}
              </Title>
            </div>
          </Space>
          <canvas ref={canvasRef} width={640} height={120} className="mt-wave" />
        </Card>
      )}
    </Space>
  )
}

/* ---------- 音频剪辑 ---------- */
function AudioTrimPanel() {
  const [file, setFile] = useState<File | null>(null)
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null)
  const [peaks, setPeaks] = useState<number[]>([])
  const [sel, setSel] = useState({ start: 0, end: 0 })
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const redraw = useCallback(
    (s: { start: number; end: number }, pk: number[]) => {
      const c = canvasRef.current
      if (!c) return
      const total = buffer?.duration || 1
      drawWaveform(c, pk, {
        selection: {
          startRatio: s.start / total,
          endRatio: s.end / total
        },
        color: 'rgba(40,96,125,0.7)',
        selectionColor: 'rgba(29,158,117,0.45)'
      })
    },
    [buffer]
  )

  useEffect(() => {
    if (peaks.length) redraw(sel, peaks)
  }, [peaks, sel, redraw])

  const onPick = async (f: File) => {
    setBusy(true)
    try {
      const buf = await decodeAudioFile(f)
      const pk = buildPeaks(buf, 400)
      setFile(f)
      setBuffer(buf)
      setPeaks(pk)
      const next = { start: 0, end: buf.duration }
      setSel(next)
      requestAnimationFrame(() => redraw(next, pk))
    } catch (err) {
      message.error(`音频解码失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
    return false
  }

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!buffer) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width
    const t = ratio * buffer.duration
    // 简单交互：左键设起点，Shift+左键设终点
    if (e.shiftKey) {
      const next = { ...sel, end: Math.max(sel.start + 0.05, t) }
      setSel(next)
      redraw(next, peaks)
    } else {
      const next = { start: t, end: Math.max(t + 0.05, sel.end) }
      setSel(next)
      redraw(next, peaks)
    }
  }

  const exportWav = async () => {
    if (!buffer) return
    const blob = await sliceAudioToWav(buffer, sel.start, sel.end)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `trim-${file?.name?.replace(/\.\w+$/, '') || 'audio'}.wav`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    message.success('片段已导出 WAV')
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert
        type="info"
        showIcon
        message="波形可视化剪辑 · 区域选择 · 导出片段"
        description="点击设起点，Shift+点击设终点；导出 WAV 片段。"
      />
      <Space wrap>
        <Upload accept="audio/*" showUploadList={false} beforeUpload={(f) => void onPick(f)} maxCount={1}>
          <Button icon={<UploadOutlined />} loading={busy}>
            选择音频
          </Button>
        </Upload>
        {file && <Tag>{file.name}</Tag>}
        {buffer && (
          <>
            <Tag color="blue">
              {formatTime(sel.start)} → {formatTime(sel.end)}
            </Tag>
            <Button type="primary" icon={<DownloadOutlined />} onClick={() => void exportWav()}>
              导出片段 WAV
            </Button>
          </>
        )}
      </Space>
      {buffer && (
        <canvas
          ref={canvasRef}
          width={720}
          height={160}
          className="mt-wave mt-wave-interactive"
          onClick={onCanvasClick}
        />
      )}
    </Space>
  )
}

/* ---------- 音频提取 ---------- */
function AudioExtractPanel() {
  const [file, setFile] = useState<PickedFile | null>(null)
  const [format, setFormat] = useState('.mp3')
  const [quality, setQuality] = useState<'low' | 'medium' | 'high'>('medium')
  const [busy, setBusy] = useState(false)
  const api = getMediaApi()

  const pick = async () => {
    const list = await api.pickVideo()
    if (list[0]) setFile(list[0])
  }

  const run = async () => {
    if (!file) return
    setBusy(true)
    try {
      const res = await api.extractAudio({
        sourcePath: file.path,
        targetFormat: format,
        quality
      })
      if (res.ok) message.success(`已导出：${res.outputPath}`)
      else message.error(res.error || '提取失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="从视频中提取音频" description="丢弃视频轨，导出高质量音频。" />
      <Space wrap>
        <Button icon={<VideoCameraOutlined />} onClick={() => void pick()}>
          选择视频
        </Button>
        {file && <Tag>{file.name}</Tag>}
        <Select
          style={{ width: 110 }}
          value={format}
          onChange={setFormat}
          options={['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.opus', '.wma'].map((f) => ({
            value: f,
            label: f.slice(1).toUpperCase()
          }))}
        />
        <Segmented
          value={quality}
          onChange={(v) => setQuality(v as 'low' | 'medium' | 'high')}
          options={[
            { label: '低', value: 'low' },
            { label: '中', value: 'medium' },
            { label: '高', value: 'high' }
          ]}
        />
        <Button type="primary" icon={<AudioOutlined />} loading={busy} disabled={!file} onClick={() => void run()}>
          提取音频
        </Button>
      </Space>
    </Space>
  )
}

export default function VideoTools({ embedded = false }: { embedded?: boolean }) {
  const [tool, setTool] = useState<VideoToolKey>('video-convert')
  const meta = useMemo(() => TOOL_META.find((t) => t.key === tool)!, [tool])

  return (
    <div className="media-tools-page">
      {!embedded && (
        <div className="page-header">
          <Title level={4} style={{ margin: 0 }}>
            视频工具
          </Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            转换 · 抽帧 · GIF · 音频处理
          </Text>
          <div style={{ flex: 1 }} />
          <Tag color="green">FFmpeg 本地引擎</Tag>
        </div>
      )}

      <FfmpegBanner />

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
        {tool === 'video-convert' && <VideoConvertPanel />}
        {tool === 'video-frame' && <VideoFramePanel />}
        {tool === 'video-gif' && <VideoGifPanel />}
        {tool === 'audio-convert' && <AudioConvertPanel />}
        {tool === 'bpm' && <BpmPanel />}
        {tool === 'audio-trim' && <AudioTrimPanel />}
        {tool === 'audio-extract' && <AudioExtractPanel />}
      </Card>
    </div>
  )
}
