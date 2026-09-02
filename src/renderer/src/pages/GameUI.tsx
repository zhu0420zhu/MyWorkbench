import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Collapse, Empty, Input, Select, Space, Spin, Tag, Typography, message } from 'antd'
import {
  AppstoreOutlined,
  BorderOutlined,
  CloudUploadOutlined,
  CopyOutlined,
  PlayCircleOutlined,
  DownloadOutlined
} from '@ant-design/icons'
import { gameUiModules, getGameUiModule, type GameUiModule } from '@gameui/index'
import {
  splitSpriteSheet,
  defaultSplitSettings,
  type SplitSettings,
  type SplitElement
} from '@gameui/spriteSplitter'
import { createStoreZip } from '@gameui/zipStore'

const { TextArea } = Input

/** 把拆分出的元素渲染为独立透明 PNG 字节 */
function elementToPngBytes(el: SplitElement): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = el.dimensions[0]
  canvas.height = el.dimensions[1]
  const ctx = canvas.getContext('2d')!
  ctx.putImageData(new ImageData(el.data, el.dimensions[0], el.dimensions[1]), 0, 0)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('PNG 导出失败'))
      blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)))
    }, 'image/png')
  })
}

export default function GameUI() {
  const [selectedId, setSelectedId] = useState(gameUiModules[0].id)
  const module = getGameUiModule(selectedId) as GameUiModule

  return (
    <div className="gameui-page">
      <div className="page-header">
        <Typography.Title level={4} style={{ margin: 0 }}>
          游戏 UI 设计
        </Typography.Title>
        <Typography.Text type="secondary">内置三个游戏 UI 设计模块（来自 guiguiyan930-source），可直接调用。</Typography.Text>
      </div>

      <div className="gameui-grid">
        {gameUiModules.map((m) => (
          <Card
            key={m.id}
            hoverable
            className={'gameui-module-card' + (m.id === selectedId ? ' active' : '')}
            onClick={() => setSelectedId(m.id)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <AppstoreOutlined style={{ fontSize: 20, color: 'var(--accent)' }} />
              <Typography.Title level={5} style={{ margin: 0 }}>
                {m.title}
              </Typography.Title>
              <Tag color={m.kind === 'workflow' ? 'purple' : 'blue'} style={{ marginLeft: 'auto' }}>
                {m.kind === 'workflow' ? '工作流' : '提示词技能'}
              </Tag>
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {m.subtitle}
            </Typography.Text>
            <p style={{ marginTop: 8, fontSize: 13, color: 'var(--text)', lineHeight: 1.6 }}>{m.description}</p>
            <Typography.Text code style={{ fontSize: 11 }}>
              {m.source}
            </Typography.Text>
          </Card>
        ))}
      </div>

      <div style={{ marginTop: 16 }}>
        {module.kind === 'prompt' ? (
          <PromptRunner module={module} />
        ) : (
          <WorkflowRunner module={module} />
        )}
      </div>
    </div>
  )
}

/* ------------------------- 提示词技能运行器 ------------------------- */
function PromptRunner({ module }: { module: GameUiModule }) {
  const [pageType, setPageType] = useState('商店页')
  const [style, setStyle] = useState('国风武侠')
  const [ratio, setRatio] = useState('16:9')
  const [coreFunc, setCoreFunc] = useState('购买、领取、升级')
  const [mainBtn, setMainBtn] = useState('购买')
  const [brief, setBrief] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState('')
  const sessionRef = useRef('')

  useEffect(() => {
    const offChunk = window.api.ai.onChunk((p: { sessionId: string; chunk: string }) => {
      if (p.sessionId !== sessionRef.current) return
      setResult((prev) => prev + p.chunk)
    })
    const offDone = window.api.ai.onDone((p: { sessionId: string; ok: boolean }) => {
      if (p.sessionId !== sessionRef.current) return
      setRunning(false)
      sessionRef.current = ''
      if (!p.ok) message.warning('AI 未配置，请到「设置」页配置模型')
    })
    return () => {
      offChunk()
      offDone()
    }
  }, [])

  const buildPrompt = useCallback((): string => {
    const briefText = [
      `页面类型：${pageType}`,
      `目标风格：${style}`,
      `画面比例：${ratio}`,
      `核心功能：${coreFunc}`,
      `主按钮文案：${mainBtn}`,
      brief.trim() ? `补充说明：${brief.trim()}` : ''
    ]
      .filter(Boolean)
      .join('\n')
    return `${module.skillText}\n\n---\n# 用户需求（请严格按技能定义的输出格式生成）\n${briefText}`
  }, [module, pageType, style, ratio, coreFunc, mainBtn, brief])

  const run = useCallback(async () => {
    const prompt = buildPrompt()
    setResult('')
    setRunning(true)
    const sessionId = crypto.randomUUID()
    sessionRef.current = sessionId
    try {
      const ok = await window.api.ai.chat(sessionId, [{ role: 'user', content: prompt }])
      if (!ok) {
        setRunning(false)
        sessionRef.current = ''
        message.warning('AI 未配置，请到「设置」页配置模型')
      }
    } catch {
      setRunning(false)
      sessionRef.current = ''
      message.error('请求失败')
    }
  }, [buildPrompt])

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildPrompt())
      message.success('已复制完整提示词到剪贴板')
    } catch {
      message.error('复制失败')
    }
  }, [buildPrompt])

  return (
    <Card title={`运行技能：${module.title}`}>
      <Space wrap style={{ marginBottom: 12 }}>
        <Input style={{ width: 150 }} addonBefore="页面类型" aria-label="页面类型" value={pageType} onChange={(e) => setPageType(e.target.value)} />
        <Input style={{ width: 150 }} addonBefore="目标风格" aria-label="目标风格" value={style} onChange={(e) => setStyle(e.target.value)} />
        <Select style={{ width: 110 }} value={ratio} aria-label="比例" onChange={setRatio} options={['16:9', '9:16', '4:3', '1:1'].map((r) => ({ label: r, value: r }))} />
        <Input style={{ width: 200 }} addonBefore="核心功能" aria-label="核心功能" value={coreFunc} onChange={(e) => setCoreFunc(e.target.value)} />
        <Input style={{ width: 140 }} addonBefore="主按钮" aria-label="主按钮" value={mainBtn} onChange={(e) => setMainBtn(e.target.value)} />
      </Space>
      <TextArea
        rows={3}
        placeholder="补充说明（可选）：目标游戏、具体文案、必须保留的元素等"
        aria-label="补充说明"
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        style={{ marginBottom: 12 }}
      />
      <Space wrap>
        <Button type="primary" icon={<PlayCircleOutlined />} loading={running} onClick={run}>
          运行技能（调用 AI）
        </Button>
        <Button icon={<CopyOutlined />} onClick={copy}>
          复制提示词
        </Button>
        <Button icon={<BorderOutlined />} onClick={() => setResult('')}>
          清空结果
        </Button>
      </Space>

      <Collapse style={{ marginTop: 16 }} items={[{ key: 'src', label: '查看技能原文（SKILL.md）', children: <pre className="gameui-skill-src">{module.skillText}</pre> }]} />

      {running && (
        <div style={{ marginTop: 12 }}>
          <Spin /> <Typography.Text type="secondary"> AI 正在按技能规范生成…</Typography.Text>
        </div>
      )}
      {result && (
        <Card size="small" style={{ marginTop: 12, background: 'var(--card-bg)' }} title="生成结果">
          <div className="gameui-result" style={{ whiteSpace: 'pre-wrap' }}>{result}</div>
        </Card>
      )}
    </Card>
  )
}

/* ------------------------- 工作流运行器 + 雪碧图拆分工具 ------------------------- */
function WorkflowRunner({ module }: { module: GameUiModule }) {
  const [img, setImg] = useState<{ data: Uint8ClampedArray; width: number; height: number; name: string } | null>(null)
  const [settings, setSettings] = useState<SplitSettings>(defaultSplitSettings())
  const [elements, setElements] = useState<SplitElement[]>([])
  const [busy, setBusy] = useState(false)
  const [zipBusy, setZipBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const loadImage = useCallback((file: File) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(image, 0, 0)
      const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      setImg({ data: new Uint8ClampedArray(rgba), width: canvas.width, height: canvas.height, name: file.name })
      setElements([])
      URL.revokeObjectURL(url)
    }
    image.onerror = () => {
      message.error('图片加载失败')
      URL.revokeObjectURL(url)
    }
    image.src = url
  }, [])

  const doSplit = useCallback(() => {
    if (!img) return
    setBusy(true)
    try {
      const els = splitSpriteSheet(img.data, img.width, img.height, settings)
      setElements(els)
      message.success(`拆分出 ${els.length} 个元素`)
    } catch (err) {
      message.error('拆分失败：' + (err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [img, settings])

  const downloadZip = useCallback(async () => {
    if (elements.length === 0) return
    setZipBusy(true)
    try {
      const entries = []
      const manifest = {
        schema_version: 1,
        source_sheet: img?.name ?? 'sprite-sheet',
        item_count: elements.length,
        items: elements.map((el) => ({
          id: el.id,
          bbox: el.bbox,
          dimensions: el.dimensions,
          transparent_background: true
        }))
      }
      entries.push({ name: 'sprite-manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) })
      for (const el of elements) {
        const bytes = await elementToPngBytes(el)
        entries.push({ name: `items/${el.id}.png`, data: bytes })
      }
      const blob = createStoreZip(entries)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'sprite-sheet-png.zip'
      a.click()
      URL.revokeObjectURL(url)
      message.success('已打包下载 sprite-sheet-png.zip')
    } catch (err) {
      message.error('打包失败：' + (err as Error).message)
    } finally {
      setZipBusy(false)
    }
  }, [elements, img])

  return (
    <div>
      <Card title={`工作流：${module.title}`} style={{ marginBottom: 16 }}>
        <Alert
          type="info"
          showIcon
          message="端到端游戏 UI 设计工作流"
          description="从策划 PRD、UI 规范、页面延展到组件拆解、雪碧图拆分打包、Atlas 与引擎 JSON 交付。下方内置「雪碧图拆分」工具（TS 移植，无需 Python）。"
        />
        <div className="gameui-steps">
          {(module.steps ?? []).map((s) => (
            <div key={s.n} className="gameui-step">
              <span className="gameui-step-n">{s.n}</span>
              <div>
                <div style={{ fontWeight: 600 }}>{s.title}</div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {s.goal}
                </Typography.Text>
              </div>
            </div>
          ))}
        </div>
        <Collapse style={{ marginTop: 12 }} items={[{ key: 'src', label: '查看工作流技能原文（SKILL.md）', children: <pre className="gameui-skill-src">{module.skillText}</pre> }]} />
      </Card>

      <Card title="雪碧图拆分工具">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) loadImage(f)
          }}
        />
        <Space wrap style={{ marginBottom: 12 }}>
          <Button icon={<CloudUploadOutlined />} onClick={() => fileRef.current?.click()}>
            选择雪碧图
          </Button>
          <Select
            style={{ width: 140 }}
            value={settings.mode}
            aria-label="拆分模式"
            onChange={(v) => setSettings((s) => ({ ...s, mode: v }))}
            options={[
              { label: '自动', value: 'auto' },
              { label: 'Alpha 通道', value: 'alpha' },
              { label: '背景差分', value: 'background' }
            ]}
          />
          <Input
            style={{ width: 130 }}
            type="number"
            addonBefore="最小面积"
            aria-label="最小面积"
            value={String(settings.minArea)}
            onChange={(e) => setSettings((s) => ({ ...s, minArea: Number(e.target.value) || 64 }))}
          />
          <Input
            style={{ width: 120 }}
            type="number"
            addonBefore="留白"
            aria-label="留白"
            value={String(settings.padding)}
            onChange={(e) => setSettings((s) => ({ ...s, padding: Number(e.target.value) || 0 }))}
          />
          <Input
            style={{ width: 130 }}
            addonBefore="前缀"
            aria-label="前缀"
            value={settings.prefix}
            onChange={(e) => setSettings((s) => ({ ...s, prefix: e.target.value || 'element' }))}
          />
          <Button type="primary" icon={<PlayCircleOutlined />} loading={busy} disabled={!img} onClick={doSplit}>
            拆分
          </Button>
          <Button icon={<DownloadOutlined />} loading={zipBusy} disabled={elements.length === 0} onClick={downloadZip}>
            下载 ZIP
          </Button>
        </Space>

        {img && (
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
            已载入：{img.name}（{img.width}×{img.height}）
          </Typography.Text>
        )}

        {elements.length === 0 ? (
          <Empty description={img ? '点击「拆分」开始' : '请先选择一张雪碧图'} />
        ) : (
          <div className="gameui-elements">
            {elements.map((el) => (
              <ElementThumb key={el.id} el={el} />
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

function ElementThumb({ el }: { el: SplitElement }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    canvas.width = el.dimensions[0]
    canvas.height = el.dimensions[1]
    const ctx = canvas.getContext('2d')!
    ctx.putImageData(new ImageData(el.data, el.dimensions[0], el.dimensions[1]), 0, 0)
  }, [el])
  return (
    <div className="gameui-el">
      <canvas ref={ref} className="gameui-el-canvas" />
      <div className="gameui-el-meta">
        <code>{el.id}.png</code>
        <span>
          {el.dimensions[0]}×{el.dimensions[1]}
        </span>
      </div>
    </div>
  )
}
