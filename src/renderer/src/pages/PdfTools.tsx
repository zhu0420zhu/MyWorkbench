import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatError } from '../utils/formatError'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Dropdown,
  Input,
  InputNumber,
  Modal,
  Progress,
  Radio,
  Row,
  Segmented,
  Select,
  Slider,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  Upload,
  message
} from 'antd'
import {
  CloseOutlined,
  CompressOutlined,
  DownOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FileImageOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  LockOutlined,
  MergeCellsOutlined,
  NumberOutlined,
  RotateLeftOutlined,
  RotateRightOutlined,
  ScissorOutlined,
  SplitCellsOutlined,
  TableOutlined,
  UnlockOutlined,
  UploadOutlined,
  EditOutlined,
  HighlightOutlined,
  CopyrightOutlined
} from '@ant-design/icons'
import { PDFDocument, PDFFont, degrees, rgb, StandardFonts } from 'pdf-lib'
import { renderPdfPages, stackCanvasesVertically, extractPdfText, pagesToMarkdown } from '../utils/pdfRender'
import {
  enhanceImageData,
  analyze,
  STRENGTH_PRESETS,
  type EnhanceStrength,
  type ImageStats
} from '../utils/pdfEnhance'
import {
  createStampContext,
  stampTextAuto,
  stampTextAtCenter,
  stampWatermarkTile,
  expandPlaceholders,
  parsePageRanges,
  pickRenderMode,
  type Rgb,
  type TextAlign,
  type TextRenderMode,
  type TextStyle
} from '../utils/pdfText'
import { downloadBlob } from '../utils/imageTools'
import { recognizeImage } from '../utils/ppocr'
import { ocrExtractPages } from '../utils/pdfOcrExtract'
import { structureCompressPdf } from '../utils/pdfCompress'
import { RASTER_PRESETS, rasterCompressPdf, rasterLevelHint } from '../utils/pdfRasterCompress'
import {
  detectEncryption,
  describeProtectedOutcome,
  describeProtection,
  guardProtectedSource,
  type EncryptionVerdict
} from '../utils/pdfCompressGuard'
import { exportEachPage } from '../utils/pdfBatchWrite'
import {
  buildPageLabel,
  canEncode,
  PAGE_NUMBER_POSITIONS,
  pageNumberPlacement,
  pagePreviewTransform,
  safeTextWidth,
  type PageNumberTemplate
} from '../utils/pdfPageNumber'
import {
  clampMarginsPt,
  marginsToSelection,
  ptToUnit,
  selectionToMargins,
  unitToPt
} from '../utils/pdfCropSelect'
import {
  encryptPdf,
  decryptPdf,
  describePdfSecurity,
  isPdfSecurityError,
  type PdfSecurityInfo
} from '../utils/pdfSecurity'

const { Text, Title, Paragraph } = Typography

export type PdfToolKey =
  | 'pagenumber'
  | 'crop'
  | 'editor'
  | 'merge'
  | 'split'
  | 'toimage'
  | 'extract'
  | 'rotate'
  | 'watermark'
  | 'encrypt'
  | 'decrypt'
  | 'compress'
  | 'enhance'
  | 'excel'

export const TOOL_META: Array<{
  key: PdfToolKey
  title: string
  desc: string
  icon: React.ReactNode
  category: string
}> = [
  {
    key: 'pagenumber',
    title: 'PDF 加页码',
    desc: '实时预览并批量添加页码',
    icon: <NumberOutlined />,
    category: 'PDF工具'
  },
  {
    key: 'crop',
    title: 'PDF 裁剪',
    desc: '框选保留区域并批量裁剪页面',
    icon: <ScissorOutlined />,
    category: 'PDF工具'
  },
  {
    key: 'editor',
    title: 'PDF 编辑器',
    desc: '旋转、排序、删除页面并导出',
    icon: <EditOutlined />,
    category: 'PDF工具'
  },
  {
    key: 'merge',
    title: 'PDF 文件合并',
    desc: '多个 PDF 按顺序合并为一个',
    icon: <MergeCellsOutlined />,
    category: 'PDF工具'
  },
  {
    key: 'split',
    title: 'PDF 文件拆分',
    desc: '选择页面并拆分为独立 PDF',
    icon: <SplitCellsOutlined />,
    category: 'PDF工具'
  },
  {
    key: 'toimage',
    title: 'PDF 转图像',
    desc: '选择页面导出单图或长图',
    icon: <FileImageOutlined />,
    category: 'PDF工具'
  },
  {
    key: 'extract',
    title: 'PDF 文本提取 / Markdown',
    desc: '提取电子 PDF 文字并生成 Markdown',
    icon: <FileTextOutlined />,
    category: 'PDF工具'
  },
  {
    key: 'rotate',
    title: 'PDF 页面旋转',
    desc: '旋转 PDF 页面方向',
    icon: <RotateRightOutlined />,
    category: 'PDF工具'
  },
  {
    key: 'watermark',
    title: 'PDF 水印 / 页眉页脚',
    desc: '加盖文字水印、页眉页脚，支持中文与页码占位符',
    icon: <CopyrightOutlined />,
    category: 'PDF工具'
  },
  {
    key: 'encrypt',
    title: 'PDF 文件加密',
    desc: '给 PDF 添加密码保护',
    icon: <LockOutlined />,
    category: 'PDF工具'
  },
  {
    key: 'decrypt',
    title: 'PDF 文件解密',
    desc: '移除 PDF 密码保护',
    icon: <UnlockOutlined />,
    category: 'PDF工具'
  },
  {
    key: 'compress',
    title: 'PDF 文件压缩',
    desc: '压缩 PDF 体积，支持多等级',
    icon: <CompressOutlined />,
    category: 'PDF工具'
  },
  {
    key: 'enhance',
    title: 'PDF 文字增强',
    desc: '提升模糊文字清晰度',
    icon: <HighlightOutlined />,
    category: 'PDF工具'
  },
  {
    key: 'excel',
    title: 'Excel 转 PDF',
    desc: '把工作簿本地渲染为便于分享和打印的 PDF',
    icon: <TableOutlined />,
    category: 'PDF工具'
  }
]

interface PickedFile {
  path: string
  name: string
  size: number
}

function getPdfApi() {
  return window.api.pdf
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

/** 通用：加载单个 PDF 字节 */
async function loadPdf(path: string): Promise<PDFDocument> {
  const api = getPdfApi()
  const bytes = await api.read(path)
  if (!bytes) throw new Error('读取 PDF 失败')
  return PDFDocument.load(bytes, { ignoreEncryption: true })
}

async function savePdf(doc: PDFDocument, defaultName: string): Promise<string | null> {
  const api = getPdfApi()
  const bytes = await doc.save()
  const out = await api.savePath(defaultName, ['pdf'])
  if (!out) return null
  const ok = await api.write(out, bytes)
  return ok ? out : null
}

/* ---------- 文字增强：真·栅格化处理 ---------- */

/** 单页增强统计，用于向用户如实展示"本次做了什么" */
export interface EnhanceStat {
  page: number
  before: ImageStats
  after: ImageStats
  blackPoint: number
  whitePoint: number
  /** 纸底白化下界 paperFloor：原图亮度 ≥ 它即推纯白；256 表示本档未白化。
   *  由「纸底主导背景带」宽度算出（见 pdfEnhance.whitenFloor）：下界稳落在带内、
   *  恒大于分割点，故只提纯与背景连成一片的纸底，不啃墨迹、不动独立灰阶。
   *  数字原生页（背景与浅灰内容间有直方图空档）下界即纯白 → 相当于不白化。 */
  whitenThreshold: number
  /** 本次是否真的执行了白化（paperFloor < 256）。数字原生页/浅底页会为 false，
   *  面板据此如实说明"本页纸底已接近纯白，未做白化"，避免用户误以为白化生效。 */
  whitenApplied: boolean
}

/**
 * 文字增强：逐页栅格化 → 色阶/锐化/纸底白化 → 重建 PDF。
 *
 * 与「图像化压缩」的关键区别：这里按【原始页面点尺寸】建页，
 * 画布分辨率只决定清晰度，因此输出的物理页面尺寸与源文件一致
 * （rasterCompressPdf 直接用画布像素当页尺寸，会让页面物理尺寸翻倍）。
 *
 * 代价必须如实告知用户：栅格化后文字不再是文本层，无法选中/检索。
 */
async function enhancePdf(
  bytes: Uint8Array,
  strength: EnhanceStrength,
  format: 'jpeg' | 'png',
  onProgress?: (done: number, total: number, stat: EnhanceStat) => void
): Promise<{ out: Uint8Array; stats: EnhanceStat[] }> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const n = src.getPageCount()
  const out = await PDFDocument.create()
  // 保留文档级信息（旧实现会静默清空，属数据丢失）
  out.setTitle(src.getTitle() ?? '')
  out.setAuthor(src.getAuthor() ?? '')
  out.setSubject(src.getSubject() ?? '')
  out.setKeywords([...(src.getKeywords() ?? '')].length ? (src.getKeywords() as string).split(' ') : [])
  // 只设 Creator：Producer 表示「生成该 PDF 的工具」，本工具并未参与生成，
  // 强行写入会误导下游（如扫码枪/审计系统）对文件来源的判断。
  out.setCreator('LingmoWorkbench')

  const preset = STRENGTH_PRESETS[strength]
  // 三档使用同一栅格化倍率与同一上限：让"强度"只由色调映射激进度决定，
  // 避免分辨率差异污染对比度/灰雾等度量（详见 STRENGTH_PRESETS 注释）。
  const maxSide = 2200
  const stats: EnhanceStat[] = []

  for (let i = 0; i < n; i++) {
    const originalSize = src.getPage(i).getSize()
    const [render] = await renderPdfPages(bytes, [i], { scale: preset.renderScale, maxSide })
    if (!render) continue
    const canvas = render.canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) continue
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const before = analyze(img.data)
    const { auto, whitenThreshold, whitenApplied } = enhanceImageData(
      img.data,
      canvas.width,
      canvas.height,
      strength
    )
    ctx.putImageData(img, 0, 0)
    const after = analyze(img.data)
    const stat: EnhanceStat = {
      page: i + 1,
      before,
      after,
      blackPoint: auto.blackPoint,
      whitePoint: auto.whitePoint,
      whitenThreshold,
      whitenApplied
    }
    stats.push(stat)

    const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png'
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('图像编码失败'))), mime, 0.92)
    )
    const imgBytes = new Uint8Array(await blob.arrayBuffer())
    const embedded = format === 'jpeg' ? await out.embedJpg(imgBytes) : await out.embedPng(imgBytes)
    // 关键：按源页面点尺寸建页，保证物理尺寸不变
    const page = out.addPage([originalSize.width, originalSize.height])
    page.drawImage(embedded, { x: 0, y: 0, width: originalSize.width, height: originalSize.height })

    // 逐页释放画布，避免整本 PDF 的画布同时驻留内存
    canvas.width = 0
    canvas.height = 0
    onProgress?.(i + 1, n, stat)
  }
  return { out: await out.save({ useObjectStreams: true }), stats }
}

/* ---------- 文字加盖：水印 / 页眉 / 页脚 ---------- */

export type StampKind = 'watermark' | 'header' | 'footer'
export type WatermarkLayout = 'center' | 'diagonal' | 'tile'

export interface StampOptions {
  kind: StampKind
  text: string
  fontSize: number
  color: Rgb
  opacity: number
  /** 水印排版方式 */
  layout: WatermarkLayout
  /** 水印旋转角度（度） */
  rotate: number
  /** 页眉页脚的水平对齐 */
  align: TextAlign
  /** 页眉页脚距页边距（pt） */
  margin: number
  /** 页码范围表达式，空 = 全部 */
  range: string
}

export interface StampResult {
  out: Uint8Array
  /** 实际被加盖的页码（1-based） */
  pages: number[]
  /** 本次用到的渲染路径，供 UI 如实告知 */
  modes: TextRenderMode[]
  total: number
}

/**
 * 在 PDF 上加盖文字。水印支持居中/对角/平铺三种排版，
 * 页眉页脚支持 {page} {total} {date} {time} 占位符。
 */
async function applyTextStamp(bytes: Uint8Array, o: StampOptions): Promise<StampResult> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const total = doc.getPageCount()
  const pages = parsePageRanges(o.range, total)
  const ctx = createStampContext(doc)
  const modes = new Set<TextRenderMode>()

  for (const pageNo of pages) {
    const page = doc.getPage(pageNo - 1)
    const { width, height } = page.getSize()
    const text = expandPlaceholders(o.text, pageNo, total)
    if (!text) continue
    const style: TextStyle = {
      fontSize: o.fontSize,
      color: o.color,
      opacity: o.opacity,
      rotate: o.kind === 'watermark' ? o.rotate : 0
    }

    if (o.kind === 'watermark') {
      if (o.layout === 'tile') {
        modes.add(await stampWatermarkTile(ctx, page, text, style))
      } else if (o.layout === 'diagonal') {
        // 沿对角线铺开：可用宽度取页面对角线的 85%，保证不超出页面
        const diag = Math.sqrt(width * width + height * height)
        const res = await stampTextAtCenter(ctx, page, text, width / 2, height / 2, style, diag * 0.85)
        modes.add(res.mode)
      } else {
        const res = await stampTextAtCenter(ctx, page, text, width / 2, height / 2, style, width * 0.9)
        modes.add(res.mode)
      }
      continue
    }

    // 页眉 / 页脚：基线位置留出字高的余量，避免贴边被裁
    const lift = o.fontSize * 1.25
    const y = o.kind === 'header' ? height - o.margin - lift : o.margin
    const x = o.align === 'left' ? o.margin : o.align === 'right' ? width - o.margin : width / 2
    const res = await stampTextAuto(
      ctx,
      page,
      text,
      { x, y, align: o.align, maxWidth: width - o.margin * 2 },
      style
    )
    modes.add(res.mode)
  }

  return { out: await doc.save({ useObjectStreams: true }), pages, modes: [...modes], total }
}

/** 颜色预设，覆盖水印常用场景 */
const STAMP_COLORS: Array<{ label: string; value: Rgb }> = [
  { label: '灰', value: { r: 0.55, g: 0.55, b: 0.58 } },
  { label: '红', value: { r: 0.78, g: 0.22, b: 0.22 } },
  { label: '蓝', value: { r: 0.22, g: 0.42, b: 0.75 } },
  { label: '绿', value: { r: 0.20, g: 0.55, b: 0.35 } },
  { label: '黑', value: { r: 0.12, g: 0.12, b: 0.12 } }
]

const rgbToHex = (c: Rgb) =>
  '#' + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')

function WatermarkPanel({ initialFile }: { initialFile?: PickedFile | null }) {
  const [file, setFile] = useState<PickedFile | null>(initialFile ?? null)
  const [doc, setDoc] = useState<PDFDocument | null>(null)
  const [kind, setKind] = useState<StampKind>('watermark')
  const [text, setText] = useState('内部资料 请勿外传')
  const [fontSize, setFontSize] = useState(46)
  const [color, setColor] = useState<Rgb>(STAMP_COLORS[0].value)
  const [opacity, setOpacity] = useState(0.18)
  const [layout, setLayout] = useState<WatermarkLayout>('diagonal')
  const [rotate, setRotate] = useState(-30)
  const [align, setAlign] = useState<TextAlign>('center')
  const [margin, setMargin] = useState(28)
  const [range, setRange] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ pages: number[]; modes: TextRenderMode[] } | null>(null)

  // 切换类型时套用该场景更合适的默认值（水印要淡而大，页眉页脚要小而清晰）
  useEffect(() => {
    if (kind === 'watermark') {
      setFontSize(46)
      setOpacity(0.18)
      setLayout('diagonal')
      return
    }
    setFontSize(10)
    setOpacity(0.75)
    if (kind === 'footer') {
      // 用函数式更新，避免把 text 带进依赖数组
      setText((prev) => (/\{page\}/.test(prev) ? prev : '第 {page} 页 / 共 {total} 页'))
    }
  }, [kind])

  const accept = async (f: PickedFile) => {
    setFile(f)
    setPreview(null)
    try {
      setDoc(await loadPdf(f.path))
    } catch (err) {
      message.error(formatError(err))
    }
  }

  const pick = async () => {
    const list = await getPdfApi().pickPdfs()
    if (!list[0]) return
    await accept(list[0])
  }

  // 挂载时带入页面级所选文件
  useEffect(() => {
    if (initialFile) void accept(initialFile)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pageCount = doc?.getPageCount() ?? 0
  // 预览实际命中的页码（纯前端解析，不发 IPC，无需落盘）
  const hitPages = useMemo(() => (pageCount ? parsePageRanges(range, pageCount) : []), [range, pageCount])
  const renderMode = useMemo(() => pickRenderMode(text), [text])

  const run = async () => {
    if (!file) return
    if (!text.trim()) {
      message.warning('请输入要加盖的文字')
      return
    }
    setBusy(true)
    try {
      const bytes = await getPdfApi().read(file.path)
      if (!bytes) throw new Error('读取失败')
      const res = await applyTextStamp(bytes, {
        kind, text, fontSize, color, opacity, layout, rotate, align, margin, range
      })
      setPreview({ pages: res.pages, modes: res.modes })
      const suffix = kind === 'watermark' ? 'watermarked' : kind === 'header' ? 'header' : 'footer'
      const target = await getPdfApi().savePath(file.name.replace(/\.pdf$/i, '') + `-${suffix}.pdf`, ['pdf'])
      if (target) {
        await getPdfApi().write(target, res.out)
        message.success(`已加盖 ${res.pages.length} 页（${res.modes.join(' + ')} 渲染）`)
      }
    } catch (err) {
      message.error(formatError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert
        type="info"
        showIcon
        message="文字水印 / 页眉页脚"
        description="在指定页面上加盖文字。页眉页脚支持占位符：{page} 当前页、{total} 总页数、{date} 日期、{time} 时间。"
      />
      <Space wrap>
        <Button icon={<UploadOutlined />} onClick={() => void pick()}>
          选择 PDF
        </Button>
        {file && <Tag>{file.name} · {formatBytes(file.size)}</Tag>}
        {pageCount > 0 && <Tag color="blue">共 {pageCount} 页</Tag>}
      </Space>

      {doc && (
        <>
          <Row gutter={[12, 12]}>
            <Col span={6}>
              <Text>类型</Text>
              <Segmented
                block
                value={kind}
                onChange={(v) => setKind(v as StampKind)}
                options={[
                  { label: '水印', value: 'watermark' },
                  { label: '页眉', value: 'header' },
                  { label: '页脚', value: 'footer' }
                ]}
              />
            </Col>
            <Col span={18}>
              <Text>文字内容</Text>
              <Input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={kind === 'watermark' ? '内部资料 请勿外传' : '如：第 {page} 页 / 共 {total} 页'}
                suffix={
                  <Tag color={renderMode === 'vector' ? 'green' : 'orange'}>
                    {renderMode === 'vector' ? '矢量文字' : '中文·图像'}
                  </Tag>
                }
              />
            </Col>

            {kind === 'watermark' && (
              <Col span={6}>
                <Text>排版</Text>
                <Segmented
                  block
                  value={layout}
                  onChange={(v) => setLayout(v as WatermarkLayout)}
                  options={[
                    { label: '对角', value: 'diagonal' },
                    { label: '居中', value: 'center' },
                    { label: '平铺', value: 'tile' }
                  ]}
                />
              </Col>
            )}
            {kind !== 'watermark' && (
              <Col span={6}>
                <Text>水平对齐</Text>
                <Segmented
                  block
                  value={align}
                  onChange={(v) => setAlign(v as TextAlign)}
                  options={[
                    { label: '左', value: 'left' },
                    { label: '中', value: 'center' },
                    { label: '右', value: 'right' }
                  ]}
                />
              </Col>
            )}

            <Col span={4}>
              <Text>字号 {fontSize}pt</Text>
              <Slider
                min={6}
                max={96}
                value={fontSize}
                onChange={(v) => setFontSize(v)}
              />
            </Col>
            <Col span={4}>
              <Text>不透明度 {Math.round(opacity * 100)}%</Text>
              <Slider
                min={0.02}
                max={1}
                step={0.01}
                value={opacity}
                onChange={(v) => setOpacity(v)}
              />
            </Col>
            {kind === 'watermark' && (
              <Col span={4}>
                <Text>旋转 {rotate}°</Text>
                <Slider min={-90} max={90} value={rotate} onChange={setRotate} disabled={layout === 'tile'} />
              </Col>
            )}
            {kind !== 'watermark' && (
              <Col span={4}>
                <Text>边距 {margin}pt</Text>
                <Slider min={8} max={80} value={margin} onChange={setMargin} />
              </Col>
            )}

            <Col span={6}>
              <Text>颜色</Text>
              <Space wrap>
                {STAMP_COLORS.map((c) => (
                  <Button
                    key={c.label}
                    size="small"
                    type={rgbToHex(color) === rgbToHex(c.value) ? 'primary' : 'default'}
                    onClick={() => setColor(c.value)}
                  >
                    {c.label}
                  </Button>
                ))}
              </Space>
            </Col>
            <Col span={6}>
              <Text>应用页码</Text>
              <Input
                value={range}
                onChange={(e) => setRange(e.target.value)}
                placeholder="留空=全部，如 1-3,5,8-"
                suffix={<Text type="secondary" style={{ fontSize: 11 }}>{hitPages.length} 页</Text>}
              />
            </Col>
          </Row>

          <Space wrap>
            <Button type="primary" icon={<CopyrightOutlined />} loading={busy} onClick={() => void run()}>
              加盖并导出
            </Button>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {renderMode === 'vector'
                ? '当前文字为纯西文，将以矢量文本写入 —— 可选中、可检索、任意缩放清晰。'
                : '当前文字含中文等非西文，将以高分辨率图像写入 —— 任意语言通用，但文字不可选中。'}
            </Text>
          </Space>

          {preview && (
            <Alert
              type="success"
              showIcon
              message={`已处理 ${preview.pages.length} 页`}
              description={`页码：${preview.pages.slice(0, 20).join(', ')}${preview.pages.length > 20 ? ` …（共 ${preview.pages.length} 页）` : ''}　渲染方式：${preview.modes.join(' + ')}`}
            />
          )}
        </>
      )}
    </Space>
  )
}

/* ---------- 加页码 ---------- */
function PageNumberPanel({ initialFile }: { initialFile?: PickedFile | null }) {
  const [file, setFile] = useState<PickedFile | null>(initialFile ?? null)
  const [doc, setDoc] = useState<PDFDocument | null>(null)
  const [position, setPosition] = useState('bottom-center')
  const [startAt, setStartAt] = useState(1)
  const [fontSize, setFontSize] = useState(11)
  const [margin, setMargin] = useState(24)
  const [template, setTemplate] = useState<PageNumberTemplate>('number')
  const [custom, setCustom] = useState('{n} / {total}')
  const [busy, setBusy] = useState(false)
  /** 只渲染「当前预览页」，不整本渲染 */
  const [previewPage, setPreviewPage] = useState(1)
  const [preview, setPreview] = useState<{ url: string; w: number; h: number; rot: number } | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [previewNote, setPreviewNote] = useState('')
  const bytesRef = useRef<Uint8Array | null>(null)
  /** 仅用于取 Helvetica 的文字度量（独立文档，避免污染导出文档） */
  const metricsRef = useRef<PDFFont | null>(null)

  const loadPreview = async (bytes: Uint8Array, pageNo: number, source: PDFDocument): Promise<void> => {
    setLoadingPreview(true)
    setPreview(null)
    setPreviewNote('')
    // 先让加载态上屏，再做渲染（渲染是同步重活，否则会白屏卡住）
    await new Promise((resolve) => setTimeout(resolve, 0))
    try {
      const idx = Math.min(Math.max(pageNo, 1), source.getPageCount()) - 1
      const page = source.getPage(idx)
      const size = page.getSize()
      const rot = ((page.getRotation().angle % 360) + 360) % 360
      const [r] = await renderPdfPages(bytes, [idx], { scale: 1.5, maxSide: 1400 })
      if (r) setPreview({ url: r.canvas.toDataURL('image/png'), w: size.width, h: size.height, rot })
      else setPreviewNote('该页预览渲染失败，导出功能不受影响。')
    } catch (err) {
      setPreviewNote('页面预览渲染失败（文件可能受保护或已损坏），导出功能不受影响：' + formatError(err))
    } finally {
      setLoadingPreview(false)
    }
  }

  const accept = async (f: PickedFile) => {
    setFile(f)
    setPreviewPage(1)
    try {
      const bytes = await getPdfApi().read(f.path)
      if (!bytes) throw new Error('读取 PDF 失败')
      bytesRef.current = bytes
      const d = await PDFDocument.load(bytes, { ignoreEncryption: true })
      setDoc(d)
      if (!metricsRef.current) {
        const metricsDoc = await PDFDocument.create()
        metricsRef.current = await metricsDoc.embedFont(StandardFonts.Helvetica)
      }
      message.success(`已载入 ${f.name}`)
      await loadPreview(bytes, 1, d)
    } catch (err) {
      message.error(formatError(err))
    }
  }

  const pick = async () => {
    const list = await getPdfApi().pickPdfs()
    if (!list[0]) return
    await accept(list[0])
  }

  // 挂载时带入页面级所选文件
  useEffect(() => {
    if (initialFile) void accept(initialFile)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const bytes = bytesRef.current
    if (!bytes || !doc) return
    void loadPreview(bytes, previewPage, doc)
    // 仅在切换预览页时重渲染；参数改动由叠加层实时反映，无需重渲染位图
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewPage])

  const total = doc?.getPageCount() ?? 0
  const metricsFont = metricsRef.current
  const previewLabel = buildPageLabel({ template, custom, n: startAt + (previewPage - 1), total })
  const encodable = !metricsFont || canEncode(metricsFont, previewLabel)
  const labelWidth = metricsFont ? safeTextWidth(metricsFont, previewLabel, fontSize) : undefined
  const transform = preview ? pagePreviewTransform(preview.w, preview.h, preview.rot) : null
  const place =
    preview && labelWidth !== undefined
      ? pageNumberPlacement({
          position,
          textWidth: labelWidth,
          fontSize,
          margin,
          pageW: preview.w,
          pageH: preview.h
        })
      : null

  const apply = async () => {
    if (!doc) return
    const font = await doc.embedFont(StandardFonts.Helvetica)
    if (!canEncode(font, previewLabel)) {
      message.error(
        `页码字体为 Helvetica（WinAnsi 编码），无法编码当前模板中的字符：${previewLabel}。请改用数字/ASCII 模板，或使用「水印 / 页眉页脚」工具（支持中文）。`
      )
      return
    }
    setBusy(true)
    try {
      const pages = doc.getPages()
      pages.forEach((page, i) => {
        const { width, height } = page.getSize()
        const n = startAt + i
        const label = buildPageLabel({ template, custom, n, total: pages.length })
        const tw = font.widthOfTextAtSize(label, fontSize)
        const { x, y } = pageNumberPlacement({ position, textWidth: tw, fontSize, margin, pageW: width, pageH: height })
        page.drawText(label, { x, y, size: fontSize, font, color: rgb(0.2, 0.2, 0.2) })
      })
      const out = await savePdf(doc, `${file?.name?.replace(/\.pdf$/i, '') || 'document'}-numbered.pdf`)
      if (out) message.success(`已导出：${out}`)
    } catch (err) {
      message.error(formatError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert
        type="info"
        showIcon
        message="实时预览并批量添加页码"
        description="下方按当前的位置 / 格式 / 起始页码 / 字号 / 边距实时叠加显示页码，改任一参数预览立即更新。导出为矢量写入，不修改源文件。"
      />
      <Alert
        type="warning"
        showIcon
        message="页码字体限制（务必先看）"
        description="页码使用 PDF 标准字体 Helvetica（WinAnsi 编码），只能编码数字与 ASCII 字符，无法编码中文。若需要「第 1 页 / 共 N 页」这类中文页码，请使用「PDF 水印 / 页眉页脚」工具（支持中文）。"
      />
      {!encodable && (
        <Alert
          type="error"
          showIcon
          message="当前模板包含无法编码的字符，导出会失败"
          description={`Helvetica（WinAnsi）无法编码：${previewLabel}。请删掉中文/全角字符，或改用内置的三个数字模板。`}
        />
      )}
      <Space wrap>
        <Button icon={<UploadOutlined />} onClick={() => void pick()}>
          选择 PDF
        </Button>
        {file && <Tag>{file.name} · {formatBytes(file.size)}</Tag>}
      </Space>
      {doc && (
        <>
          <Row gutter={[12, 12]}>
            <Col span={12}>
              <Text>位置</Text>
              <Select
                style={{ width: '100%' }}
                value={position}
                onChange={setPosition}
                options={PAGE_NUMBER_POSITIONS}
              />
            </Col>
            <Col span={12}>
              <Text>格式</Text>
              <Select
                style={{ width: '100%' }}
                value={template}
                onChange={(v) => setTemplate(v)}
                options={[
                  { value: 'number', label: '1, 2, 3' },
                  { value: 'pageof', label: '1 / N' },
                  { value: 'dash', label: '- 1 -' },
                  { value: 'custom', label: '自定义（{n} / {total}）' }
                ]}
              />
            </Col>
            {template === 'custom' && (
              <Col span={24}>
                <Text>自定义模板</Text>
                <Input
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  placeholder="{n} = 页码，{total} = 总页数；仅支持数字与 ASCII 字符"
                />
                <Text type="secondary">仅支持数字与 ASCII（Helvetica/WinAnsi）；含中文请改用「水印 / 页眉页脚」工具。</Text>
              </Col>
            )}
            <Col span={8}>
              <Text>起始页码</Text>
              <InputNumber min={0} value={startAt} onChange={(v) => setStartAt(v ?? 1)} style={{ width: '100%' }} />
            </Col>
            <Col span={8}>
              <Text>字号</Text>
              <InputNumber min={6} max={36} value={fontSize} onChange={(v) => setFontSize(v ?? 11)} style={{ width: '100%' }} />
            </Col>
            <Col span={8}>
              <Text>边距</Text>
              <InputNumber min={0} max={120} value={margin} onChange={(v) => setMargin(v ?? 24)} style={{ width: '100%' }} />
            </Col>
            <Col span={8}>
              <Text>预览页</Text>
              <InputNumber
                min={1}
                max={Math.max(1, total)}
                value={previewPage}
                onChange={(v) => setPreviewPage(Math.min(Math.max(1, v ?? 1), Math.max(1, total)))}
                style={{ width: '100%' }}
              />
            </Col>
          </Row>
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <Text type="secondary">
              仅渲染第 {previewPage} 页做预览（不整本渲染）。落位坐标与导出一致，用同一套 Helvetica 度量计算；
              预览以系统字体绘制，字形宽度与标准 Helvetica 可能存在极细微差异。
            </Text>
            {loadingPreview ? (
              <Space>
                <Spin size="small" />
                <Text type="secondary">正在渲染第 {previewPage} 页…</Text>
              </Space>
            ) : preview ? (
              <div
                style={{
                  position: 'relative',
                  width: '100%',
                  maxWidth: 380,
                  overflow: 'hidden',
                  borderRadius: 4,
                  lineHeight: 0
                }}
              >
                <img
                  src={preview.url}
                  alt={`第 ${previewPage} 页页码位置预览`}
                  draggable={false}
                  style={{ width: '100%', display: 'block', border: '1px solid var(--lm-border)' }}
                />
                {transform && place && (
                  <svg
                    viewBox={`0 0 ${transform.width} ${transform.height}`}
                    preserveAspectRatio="none"
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
                    aria-hidden="true"
                  >
                    <g transform={`matrix(${transform.matrix.join(' ')})`}>
                      <text x={place.x} y={place.y} fontSize={fontSize} fill="#333333" fontFamily="Helvetica, Arial, sans-serif">
                        {previewLabel}
                      </text>
                    </g>
                  </svg>
                )}
              </div>
            ) : previewNote ? (
              <Alert type="warning" showIcon message="无法生成预览" description={previewNote} />
            ) : null}
          </Space>
          <Button
            type="primary"
            icon={<NumberOutlined />}
            loading={busy}
            disabled={!encodable}
            onClick={() => void apply()}
          >
            导出带页码 PDF
          </Button>
        </>
      )}
    </Space>
  )
}

/* ---------- 裁剪 ---------- */
function CropPanel({ initialFile }: { initialFile?: PickedFile | null }) {
  const [file, setFile] = useState<PickedFile | null>(initialFile ?? null)
  const [doc, setDoc] = useState<PDFDocument | null>(null)
  const [unit, setUnit] = useState<'mm' | 'pt'>('mm')
  const [margins, setMargins] = useState({ top: 0, right: 0, bottom: 0, left: 0 })
  const [busy, setBusy] = useState(false)
  /** 第 1 页的位图预览（拖拽框选的底图）；w/h 为该页的点尺寸 */
  const [preview, setPreview] = useState<{ url: string; w: number; h: number } | null>(null)
  const [previewNote, setPreviewNote] = useState('')
  const [dragging, setDragging] = useState(false)
  /** 拖拽中的选框，单位：相对预览图的百分比 */
  const [dragRect, setDragRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)

  const accept = async (f: PickedFile) => {
    setFile(f)
    setPreview(null)
    setPreviewNote('')
    setMargins({ top: 0, right: 0, bottom: 0, left: 0 })
    try {
      const bytes = await getPdfApi().read(f.path)
      if (!bytes) throw new Error('读取 PDF 失败')
      const d = await PDFDocument.load(bytes, { ignoreEncryption: true })
      setDoc(d)
      const rot = ((d.getPage(0).getRotation().angle % 360) + 360) % 360
      const size = d.getPage(0).getSize()
      if (rot !== 0) {
        // 页面带旋转时，预览图的朝向与 setCropBox 的页面坐标系不一致，
        // 拖拽会把边距算到错误的边上 —— 停用框选并如实说明，保留数值裁剪能力。
        setPreviewNote(
          `第 1 页带 ${rot}° 旋转，拖拽框选已停用（避免把边距算到错误的边上），请用下方边距数值精确裁剪。`
        )
        return
      }
      try {
        const [r] = await renderPdfPages(bytes, [0], { scale: 1.5, maxSide: 1400 })
        if (r) setPreview({ url: r.canvas.toDataURL('image/png'), w: size.width, h: size.height })
      } catch (err) {
        setPreviewNote('页面预览渲染失败（文件可能受保护或已损坏），仍可用边距数值裁剪：' + formatError(err))
      }
    } catch (err) {
      message.error(formatError(err))
    }
  }

  const pick = async () => {
    const list = await getPdfApi().pickPdfs()
    if (!list[0]) return
    await accept(list[0])
  }

  // 挂载时带入页面级所选文件
  useEffect(() => {
    if (initialFile) void accept(initialFile)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

  /** 边距 → 选框（百分比）：实现「改数值 → 选框同步移动」 */
  const selRect = useMemo(
    () =>
      preview
        ? marginsToSelection({ margins, pageW: preview.w, pageH: preview.h, unit })
        : null,
    [preview, margins, unit]
  )

  /** 选框 → 四边边距（百分比 → pt → 当前单位），含越界/零面积/反向拖拽归一化 */
  const applySelection = (x0p: number, y0p: number, x1p: number, y1p: number) => {
    if (!preview) return
    setMargins(
      selectionToMargins({ x0p, y0p, x1p, y1p, pageW: preview.w, pageH: preview.h, unit })
    )
  }

  const pointFromEvent = (clientX: number, clientY: number) => {
    const el = boxRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      xp: (clamp(clientX - r.left, 0, r.width) / r.width) * 100,
      yp: (clamp(clientY - r.top, 0, r.height) / r.height) * 100
    }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!preview) return
    const p = pointFromEvent(e.clientX, e.clientY)
    if (!p) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
    setDragRect({ x0: p.xp, y0: p.yp, x1: p.xp, y1: p.yp })
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    const p = pointFromEvent(e.clientX, e.clientY)
    if (!p) return
    setDragRect((d) => (d ? { ...d, x1: p.xp, y1: p.yp } : d))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    setDragging(false)
    const p = pointFromEvent(e.clientX, e.clientY)
    const d = dragRect
    setDragRect(null)
    if (!p || !d) return
    // 误点（两个方向都几乎没有位移）不改变当前边距
    if (Math.abs(p.xp - d.x0) < 1.5 && Math.abs(p.yp - d.y0) < 1.5) return
    applySelection(d.x0, d.y0, p.xp, p.yp)
  }

  const apply = async () => {
    if (!doc) return
    setBusy(true)
    try {
      const pages = doc.getPages()
      for (const page of pages) {
        const { width, height } = page.getSize()
        const { l, r, t, b } = clampMarginsPt(margins, width, height, unit)
        page.setCropBox(l, b, width - l - r, height - t - b)
      }
      const out = await savePdf(doc, `${file?.name?.replace(/\.pdf$/i, '') || 'document'}-crop.pdf`)
      if (out) message.success(`已导出：${out}`)
    } catch (err) {
      message.error(formatError(err))
    } finally {
      setBusy(false)
    }
  }

  const shown = dragRect
    ? {
        left: Math.min(dragRect.x0, dragRect.x1),
        top: Math.min(dragRect.y0, dragRect.y1),
        width: Math.abs(dragRect.x1 - dragRect.x0),
        height: Math.abs(dragRect.y1 - dragRect.y0)
      }
    : selRect

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert
        type="info"
        showIcon
        message="框选保留区域并批量裁剪页面"
        description="在下方页面预览上拖拽画出保留区域，四边边距会同步更新；也可直接改边距数值做精确微调。裁剪为矢量操作（改写 CropBox），不重采样、不损坏内容。"
      />
      <Space wrap>
        <Button icon={<UploadOutlined />} onClick={() => void pick()}>
          选择 PDF
        </Button>
        {file && <Tag>{file.name}</Tag>}
        <Segmented
          value={unit}
          onChange={(v) => setUnit(v as 'mm' | 'pt')}
          options={[
            { label: 'mm', value: 'mm' },
            { label: 'pt', value: 'pt' }
          ]}
        />
      </Space>
      {doc && (
        <>
          {preview ? (
            <>
              <Text type="secondary">
                框选基于第 1 页；边距按各页自身尺寸应用到全部 {doc.getPageCount()} 页（批量裁剪）。
              </Text>
              <div
                ref={boxRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                style={{
                  position: 'relative',
                  width: '100%',
                  maxWidth: 460,
                  overflow: 'hidden',
                  borderRadius: 4,
                  touchAction: 'none',
                  cursor: 'crosshair',
                  userSelect: 'none',
                  lineHeight: 0
                }}
              >
                <img
                  src={preview.url}
                  alt="第 1 页预览：拖拽框选保留区域"
                  draggable={false}
                  style={{ width: '100%', display: 'block', border: '1px solid var(--lm-border)' }}
                />
                {shown && (
                  <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                    <div
                      style={{
                        position: 'absolute',
                        left: `${shown.left}%`,
                        top: `${shown.top}%`,
                        width: `${shown.width}%`,
                        height: `${shown.height}%`,
                        border: '2px solid var(--accent, #28607d)',
                        boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.35)'
                      }}
                    />
                  </div>
                )}
              </div>
            </>
          ) : previewNote ? (
            <Alert type="warning" showIcon message="拖拽框选已停用" description={previewNote} />
          ) : (
            <Text type="secondary">页面预览加载中…</Text>
          )}
          <Row gutter={[12, 12]}>
            {(['top', 'right', 'bottom', 'left'] as const).map((k) => (
              <Col span={6} key={k}>
                <Text>{{ top: '上', right: '右', bottom: '下', left: '左' }[k]}边距</Text>
                <InputNumber
                  min={0}
                  step={0.5}
                  value={margins[k]}
                  onChange={(v) => setMargins((m) => ({ ...m, [k]: Math.max(0, v ?? 0) }))}
                  style={{ width: '100%' }}
                />
              </Col>
            ))}
          </Row>
          <Space wrap>
            <Button type="primary" icon={<ScissorOutlined />} loading={busy} onClick={() => void apply()}>
              导出裁剪 PDF
            </Button>
            <Button onClick={() => setMargins({ top: 0, right: 0, bottom: 0, left: 0 })}>重置为整页</Button>
            {preview && (
              <Text type="secondary">
                保留区域 {ptToUnit(preview.w - unitToPt(margins.left, unit) - unitToPt(margins.right, unit), unit)} ×{' '}
                {ptToUnit(preview.h - unitToPt(margins.top, unit) - unitToPt(margins.bottom, unit), unit)} {unit}（第 1 页）
              </Text>
            )}
          </Space>
        </>
      )}
    </Space>
  )
}

/* ---------- 编辑器（旋转 / 排序 / 删除 / 导出） ---------- */
function EditorPanel({ initialFile }: { initialFile?: PickedFile | null }) {
  const [file, setFile] = useState<PickedFile | null>(initialFile ?? null)
  const [doc, setDoc] = useState<PDFDocument | null>(null)
  const [rotations, setRotations] = useState<number[]>([])
  const [busy, setBusy] = useState(false)

  const accept = async (f: PickedFile) => {
    setFile(f)
    try {
      const d = await loadPdf(f.path)
      setDoc(d)
      setRotations(d.getPages().map(() => 0))
    } catch (err) {
      message.error(formatError(err))
    }
  }

  const pick = async () => {
    const list = await getPdfApi().pickPdfs()
    if (!list[0]) return
    await accept(list[0])
  }

  // 挂载时带入页面级所选文件
  useEffect(() => {
    if (initialFile) void accept(initialFile)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const rotate = (index: number, delta: number) => {
    setRotations((r) => r.map((v, i) => (i === index ? (v + delta + 360) % 360 : v)))
  }

  const rebuildWithOrder = async (order: number[], msg: string) => {
    if (!doc) return
    setBusy(true)
    try {
      // 先写入当前旋转，再按新顺序重建，避免旋转丢失
      const source = await PDFDocument.create()
      const cloned = await source.copyPages(doc, doc.getPageIndices())
      cloned.forEach((p, i) => {
        const cur = p.getRotation().angle
        p.setRotation(degrees((cur + (rotations[i] || 0)) % 360))
        source.addPage(p)
      })
      const out = await PDFDocument.create()
      const copied = await out.copyPages(source, order)
      copied.forEach((p) => out.addPage(p))
      setDoc(out)
      setRotations(out.getPages().map(() => 0))
      message.success(msg)
    } catch (err) {
      message.error(formatError(err))
    } finally {
      setBusy(false)
    }
  }

  const move = (index: number, dir: -1 | 1) => {
    if (!doc) return
    const n = doc.getPageCount()
    const j = index + dir
    if (j < 0 || j >= n) return
    const order = Array.from({ length: n }, (_, i) => i)
    order.splice(index, 1)
    order.splice(j, 0, index)
    void rebuildWithOrder(order, '已调整顺序')
  }

  const removePage = (index: number) => {
    if (!doc) return
    const order = doc.getPageIndices().filter((i) => i !== index)
    if (!order.length) {
      message.warning('至少保留一页')
      return
    }
    void rebuildWithOrder(order, '已删除页面')
  }

  const apply = async () => {
    if (!doc) return
    setBusy(true)
    try {
      const pages = doc.getPages()
      pages.forEach((p, i) => {
        const cur = p.getRotation().angle
        p.setRotation(degrees((cur + rotations[i]) % 360))
      })
      const out = await savePdf(doc, `${file?.name?.replace(/\.pdf$/i, '') || 'document'}-edited.pdf`)
      if (out) message.success(`已导出：${out}`)
    } catch (err) {
      message.error(formatError(err))
    } finally {
      setBusy(false)
    }
  }

  const pages = doc?.getPages() ?? []

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="旋转、排序、删除页面并导出为新的 PDF" description="支持页面旋转、排序、删除；导出为新 PDF。" />
      <Space wrap>
        <Button icon={<UploadOutlined />} onClick={() => void pick()}>
          选择 PDF
        </Button>
        {file && <Tag>{file.name}</Tag>}
        <Button type="primary" icon={<DownloadOutlined />} loading={busy} disabled={!doc} onClick={() => void apply()}>
          导出 PDF
        </Button>
      </Space>
      {doc && (
        <Table
          size="small"
          rowKey={(_, i) => String(i)}
          pagination={false}
          dataSource={pages.map((p, i) => ({ index: i, size: p.getSize(), rotation: p.getRotation().angle }))}
          columns={[
            { title: '#', dataIndex: 'index', render: (v) => v + 1 },
            {
              title: '尺寸',
              key: 'size',
              render: (_, r) => `${Math.round(r.size.width)}×${Math.round(r.size.height)}`
            },
            {
              title: '旋转',
              key: 'rot',
              render: (_, r) => (
                <Space>
                  <Tag>{(r.rotation + rotations[r.index]) % 360}°</Tag>
                  <Button size="small" icon={<RotateLeftOutlined />} onClick={() => rotate(r.index, -90)} />
                  <Button size="small" icon={<RotateRightOutlined />} onClick={() => rotate(r.index, 90)} />
                </Space>
              )
            },
            {
              title: '操作',
              key: 'ops',
              render: (_, r) => (
                <Space>
                  <Button size="small" onClick={() => move(r.index, -1)}>
                    上移
                  </Button>
                  <Button size="small" onClick={() => move(r.index, 1)}>
                    下移
                  </Button>
                  <Button size="small" danger icon={<DeleteOutlined />} onClick={() => removePage(r.index)} />
                </Space>
              )
            }
          ]}
        />
      )}
    </Space>
  )
}

/* ---------- 合并 ---------- */
function MergePanel({ initialFile }: { initialFile?: PickedFile | null }) {
  const [files, setFiles] = useState<PickedFile[]>(initialFile ? [initialFile] : [])
  const [busy, setBusy] = useState(false)

  const pick = async () => {
    const list = await getPdfApi().pickPdfs()
    if (list.length) setFiles((prev) => [...prev, ...list])
  }

  const merge = async () => {
    if (files.length < 2) {
      message.warning('至少需要 2 个 PDF')
      return
    }
    setBusy(true)
    try {
      const out = await PDFDocument.create()
      for (const f of files) {
        const src = await loadPdf(f.path)
        const pages = await out.copyPages(src, src.getPageIndices())
        pages.forEach((p) => out.addPage(p))
      }
      const path = await savePdf(out, 'merged.pdf')
      if (path) message.success(`已合并导出：${path}`)
    } catch (err) {
      message.error(formatError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="多个 PDF 按顺序合并为一个" description="按列表顺序合并，可调整先后。" />
      <Space wrap>
        <Button icon={<UploadOutlined />} onClick={() => void pick()}>
          添加 PDF
        </Button>
        <Button type="primary" icon={<MergeCellsOutlined />} loading={busy} disabled={files.length < 2} onClick={() => void merge()}>
          合并导出（{files.length}）
        </Button>
      </Space>
      <Table
        size="small"
        rowKey="path"
        pagination={false}
        dataSource={files}
        columns={[
          { title: '顺序', render: (_, __, i) => i + 1 },
          { title: '文件', dataIndex: 'name' },
          { title: '大小', dataIndex: 'size', render: (v) => formatBytes(v) },
          {
            title: '操作',
            render: (_, __, i) => (
              <Space>
                <Button size="small" disabled={i === 0} onClick={() => setFiles((fs) => {
                  const next = [...fs]
                  ;[next[i - 1], next[i]] = [next[i], next[i - 1]]
                  return next
                })}>
                  上移
                </Button>
                <Button
                  size="small"
                  danger
                  onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}
                >
                  移除
                </Button>
              </Space>
            )
          }
        ]}
      />
    </Space>
  )
}

/* ---------- 拆分 ---------- */
function SplitPanel({ initialFile }: { initialFile?: PickedFile | null }) {
  const [file, setFile] = useState<PickedFile | null>(initialFile ?? null)
  const [doc, setDoc] = useState<PDFDocument | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [mode, setMode] = useState<'each' | 'range'>('each')
  const [busy, setBusy] = useState(false)
  const [failures, setFailures] = useState<Array<{ name: string; error: string }>>([])

  const accept = async (f: PickedFile) => {
    setFile(f)
    setFailures([])
    try {
      const d = await loadPdf(f.path)
      setDoc(d)
      setSelected(d.getPageIndices())
    } catch (err) {
      message.error(formatError(err))
    }
  }

  const pick = async () => {
    const list = await getPdfApi().pickPdfs()
    if (!list[0]) return
    await accept(list[0])
  }

  // 挂载时带入页面级所选文件
  useEffect(() => {
    if (initialFile) void accept(initialFile)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 重名覆盖确认：取消时**不写入任何文件**，不绑定任何不可逆动作 */
  const confirmOverwrite = (names: string[]): Promise<boolean> =>
    new Promise((resolve) => {
      Modal.confirm({
        title: '目标文件夹存在同名文件',
        content:
          `以下 ${names.length} 个文件已存在：${names.slice(0, 8).join('、')}${names.length > 8 ? ` 等（共 ${names.length} 个）` : ''}。` +
          '继续将**覆盖**这些文件的原有内容，覆盖后无法恢复；其余文件正常导出。',
        okText: '覆盖并导出',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: () => resolve(true),
        onCancel: () => resolve(false)
      })
    })

  const run = async () => {
    if (!doc || !selected.length) return
    setBusy(true)
    setFailures([])
    try {
      if (mode === 'each') {
        // 逐页导出：只弹一次目录选择，随后批量写入（旧实现每页弹一次保存框）
        const res = await exportEachPage(getPdfApi(), {
          baseName: file?.name?.replace(/\.pdf$/i, '') || 'doc',
          pages: selected,
          pickTitle: `选择逐页导出的目标文件夹（共 ${selected.length} 页）`,
          buildPage: async (i) => {
            const out = await PDFDocument.create()
            const [p] = await out.copyPages(doc, [i])
            out.addPage(p)
            return out.save()
          },
          confirmOverwrite,
          formatError
        })
        if (res.canceled) {
          if (res.conflicts.length) message.info('已取消：未覆盖任何文件，也未写入新文件')
          return
        }
        setFailures(res.failed)
        if (!res.failed.length) message.success(`已导出 ${res.ok}/${selected.length} 个 PDF 到：${res.dir}`)
        else if (!res.ok) message.error(`导出失败：0/${selected.length} 个成功，原因见下方清单`)
        else message.warning(`部分成功：${res.ok}/${selected.length} 个已导出，${res.failed.length} 个失败，原因见下方清单`)
      } else {
        const out = await PDFDocument.create()
        const pages = await out.copyPages(doc, selected)
        pages.forEach((p) => out.addPage(p))
        const path = await savePdf(out, `${file?.name?.replace(/\.pdf$/i, '') || 'doc'}-split.pdf`)
        if (path) message.success(`已导出：${path}`)
      }
    } catch (err) {
      message.error(formatError(err))
    } finally {
      setBusy(false)
    }
  }

  const total = doc?.getPageCount() ?? 0

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert
        type="info"
        showIcon
        message="选择页面并拆分为独立 PDF"
        description="「逐页导出」= 选一次目标文件夹后批量写入（不再逐页弹窗）；「合并所选」= 所选页合并为一个 PDF。"
      />
      <Space wrap>
        <Button icon={<UploadOutlined />} onClick={() => void pick()}>
          选择 PDF
        </Button>
        {file && <Tag>{file.name} · 共 {total} 页</Tag>}
        <Segmented
          value={mode}
          onChange={(v) => setMode(v as 'each' | 'range')}
          options={[
            { label: '逐页导出', value: 'each' },
            { label: '合并所选', value: 'range' }
          ]}
        />
        <Button type="primary" icon={<ScissorOutlined />} loading={busy} disabled={!doc} onClick={() => void run()}>
          开始拆分
        </Button>
      </Space>
      {failures.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`${failures.length} 个文件未能导出`}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {failures.map((f) => (
                <li key={f.name}>
                  {f.name}：{f.error}
                </li>
              ))}
            </ul>
          }
        />
      )}
      {doc && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {doc.getPageIndices().map((i) => (
            <Checkbox
              key={i}
              checked={selected.includes(i)}
              onChange={(e) =>
                setSelected((s) => (e.target.checked ? [...s, i] : s.filter((x) => x !== i)))
              }
            >
              第 {i + 1} 页
            </Checkbox>
          ))}
        </div>
      )}
    </Space>
  )
}

/* ---------- 旋转 ---------- */
function RotatePanel({ initialFile }: { initialFile?: PickedFile | null }) {
  const [file, setFile] = useState<PickedFile | null>(initialFile ?? null)
  const [doc, setDoc] = useState<PDFDocument | null>(null)
  const [angle, setAngle] = useState<90 | 180 | 270>(90)
  const [scope, setScope] = useState<'all' | 'odd' | 'even'>('all')
  const [busy, setBusy] = useState(false)

  const accept = async (f: PickedFile) => {
    setFile(f)
    try {
      setDoc(await loadPdf(f.path))
    } catch (err) {
      message.error(formatError(err))
    }
  }

  const pick = async () => {
    const list = await getPdfApi().pickPdfs()
    if (!list[0]) return
    await accept(list[0])
  }

  // 挂载时带入页面级所选文件
  useEffect(() => {
    if (initialFile) void accept(initialFile)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const run = async () => {
    if (!doc) return
    setBusy(true)
    try {
      doc.getPages().forEach((p, i) => {
        const hit = scope === 'all' || (scope === 'odd' && i % 2 === 0) || (scope === 'even' && i % 2 === 1)
        if (hit) p.setRotation(degrees((p.getRotation().angle + angle) % 360))
      })
      const out = await savePdf(doc, `${file?.name?.replace(/\.pdf$/i, '') || 'doc'}-rotated.pdf`)
      if (out) message.success(`已导出：${out}`)
    } catch (err) {
      message.error(formatError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="旋转 PDF 页面方向" description="支持全部 / 奇数页 / 偶数页。" />
      <Space wrap>
        <Button icon={<UploadOutlined />} onClick={() => void pick()}>
          选择 PDF
        </Button>
        {file && <Tag>{file.name}</Tag>}
        <Segmented
          value={angle}
          onChange={(v) => setAngle(v as 90 | 180 | 270)}
          options={[
            { label: '90°', value: 90 },
            { label: '180°', value: 180 },
            { label: '270°', value: 270 }
          ]}
        />
        <Segmented
          value={scope}
          onChange={(v) => setScope(v as 'all' | 'odd' | 'even')}
          options={[
            { label: '全部', value: 'all' },
            { label: '奇数页', value: 'odd' },
            { label: '偶数页', value: 'even' }
          ]}
        />
        <Button type="primary" icon={<RotateRightOutlined />} loading={busy} disabled={!doc} onClick={() => void run()}>
          导出旋转 PDF
        </Button>
      </Space>
    </Space>
  )
}

/* ---------- 加密 / 解密 ---------- */
function CryptoPanel({ mode, initialFile }: { mode: 'encrypt' | 'decrypt'; initialFile?: PickedFile | null }) {
  const [file, setFile] = useState<PickedFile | null>(initialFile ?? null)
  const [userPwd, setUserPwd] = useState('')
  const [ownerPwd, setOwnerPwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState<PdfSecurityInfo | null>(null)

  const accept = async (f: PickedFile) => {
    setFile(f)
    setInfo(null)
    // 选中即探测：解密前就能看到真实算法、是否受支持，避免「点了才知道打不开」
    try {
      const bytes = await getPdfApi().read(f.path)
      if (bytes) setInfo(await describePdfSecurity(bytes))
    } catch {
      setInfo(null)
    }
  }

  const pick = async () => {
    const list = await getPdfApi().pickPdfs()
    if (!list[0]) return
    await accept(list[0])
  }

  // 挂载时带入页面级所选文件
  useEffect(() => {
    if (initialFile) void accept(initialFile)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const run = async () => {
    if (!file) return
    if (mode === 'encrypt' && !userPwd) {
      // 空用户口令 = 任何人都能直接打开，故加密必须显式填写；给出说明而非静默返回
      message.warning('请先设置用户口令（打开文件时需要输入）。留空会让任何人都能直接打开，达不到加密目的。')
      return
    }
    if (mode === 'decrypt' && info && !info.supported) {
      message.error(info.reason ?? '该加密方式当前版本暂不支持')
      return
    }
    setBusy(true)
    try {
      const bytes = await getPdfApi().read(file.path)
      if (!bytes) throw new Error('读取失败')
      const base = file.name.replace(/\.pdf$/i, '')
      let out: Uint8Array
      let defaultName: string
      if (mode === 'encrypt') {
        // 真实现：AES-128（V4 / R4），由本地 pdfSecurity 逐对象加密后写出 /Encrypt
        out = await encryptPdf(bytes, { userPassword: userPwd, ownerPassword: ownerPwd })
        defaultName = `${base}-encrypted.pdf`
      } else {
        // 真实现：解开标准安全处理器，产出无密码、可被任意阅读器打开的干净副本
        out = await decryptPdf(bytes, userPwd)
        defaultName = `${base}-decrypted.pdf`
      }
      const target = await getPdfApi().savePath(defaultName, ['pdf'])
      if (!target) return
      const ok = await getPdfApi().write(target, out)
      if (!ok) throw new Error('写入文件失败')
      message.success(mode === 'encrypt' ? `已导出加密 PDF：${target}` : `已导出无密码副本：${target}`)
    } catch (err) {
      // 口令错误要给出分明、可行动的提示，而不是笼统的「操作失败」
      if (isPdfSecurityError(err)) {
        if (err.code === 'PASSWORD_INCORRECT') {
          message.error(
            mode === 'encrypt'
              ? '口令处理异常，请更换口令后重试'
              : '口令不正确。若该 PDF 打开时无需输入口令，请留空直接解密；否则请输入正确的打开口令。'
          )
        } else if (err.code === 'UNSUPPORTED_CRYPTO') {
          message.error(err.message)
        } else if (err.code === 'NOT_ENCRYPTED') {
          message.warning('该文件未加密，无需解密')
        } else {
          message.error(err.message)
        }
      } else {
        message.error(formatError(err, mode === 'encrypt' ? '加密失败' : '解密失败'))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert
        type="info"
        showIcon
        message={mode === 'encrypt' ? 'PDF 加密（AES-128）' : '移除 PDF 密码保护'}
        description={
          mode === 'encrypt'
            ? '用 AES-128（V4 / R4）写出带口令的 PDF：打开需输入用户口令；所有者口令可选（留空则同用户口令）。权限固定为「允许打印与无障碍阅读；禁止修改内容、添加注释、填写表单、提取内容」。加密由本工具本地完成，不依赖外部程序。'
            : '输入口令解开标准安全处理器（支持 RC4 40/128-bit 与 AES-128），产出为无密码、任意阅读器可直接打开的副本。若该 PDF 打开时无需口令（仅所有者口令保护），留空即可直接解密。不支持 AES-256 与公钥/证书加密。'
        }
      />
      <Space wrap>
        <Button icon={<UploadOutlined />} onClick={() => void pick()}>
          选择 PDF
        </Button>
        {file && <Tag>{file.name}</Tag>}
        {mode === 'decrypt' && info && (
          info.encrypted ? (
            <Tag color={info.supported ? 'blue' : 'red'}>
              {info.supported
                ? `检测到 ${info.algorithm}`
                : `${info.algorithm}：暂不支持`}
            </Tag>
          ) : (
            <Tag color="green">未加密</Tag>
          )
        )}
        {mode === 'encrypt' && info?.encrypted && <Tag color="orange">源文件已加密，请先解密</Tag>}
        <Input.Password
          style={{ width: 200 }}
          placeholder={mode === 'encrypt' ? '用户口令' : '打开口令'}
          value={userPwd}
          onChange={(e) => setUserPwd(e.target.value)}
        />
        {mode === 'encrypt' && (
          <Input.Password
            style={{ width: 200 }}
            placeholder="所有者口令（可选）"
            value={ownerPwd}
            onChange={(e) => setOwnerPwd(e.target.value)}
          />
        )}
        <Button
          type="primary"
          icon={mode === 'encrypt' ? <LockOutlined /> : <UnlockOutlined />}
          loading={busy}
          disabled={!file}
          onClick={() => void run()}
        >
          {mode === 'encrypt' ? '加密导出' : '解密导出'}
        </Button>
      </Space>
    </Space>
  )
}

/* ---------- 压缩 / 增强 / 转图 / 提取 / Excel ---------- */
function CompressPanel({ initialFile }: { initialFile?: PickedFile | null }) {
  const [file, setFile] = useState<PickedFile | null>(initialFile ?? null)
  const [level, setLevel] = useState<'low' | 'medium' | 'high'>('medium')
  const [mode, setMode] = useState<'structure' | 'raster'>('structure')
  const [busy, setBusy] = useState(false)
  const [before, setBefore] = useState(0)
  const [after, setAfter] = useState(0)
  const [note, setNote] = useState('')
  /** 源文件保护状态：加密时面板常驻警示，导出前强制二次确认 */
  const [verdict, setVerdict] = useState<EncryptionVerdict | null>(null)

  const accept = async (f: PickedFile) => {
    setFile(f)
    setBefore(f.size)
    setAfter(0)
    setNote('')
    // 选中即探测保护状态，让用户在点「压缩导出」之前就看到警示
    try {
      const bytes = await getPdfApi().read(f.path)
      setVerdict(bytes ? await detectEncryption(bytes) : null)
    } catch {
      setVerdict(null)
    }
  }

  const pick = async () => {
    const list = await getPdfApi().pickPdfs()
    if (!list[0]) return
    await accept(list[0])
  }

  // 挂载时带入页面级所选文件
  useEffect(() => {
    if (initialFile) void accept(initialFile)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const run = async () => {
    if (!file) return
    setBusy(true)
    setNote('')
    try {
      const bytes = await getPdfApi().read(file.path)
      if (!bytes) throw new Error('读取失败')
      // ── 加密闸门（结构 / 图像化两个模式都必须过）──────────────────────
      // 压缩会重建文档结构，源文件的 /Encrypt 不可能被带过去：产出副本将不再
      // 需要任何口令。这是数据安全事故，必须由用户显式确认；取消时零写入。
      const decision = await guardProtectedSource({
        bytes,
        confirm: (v) => {
          const outcome = describeProtectedOutcome(mode, v)
          return new Promise<boolean>((resolve) => {
            Modal.confirm({
              title: '源文件受密码保护，压缩后果请先确认',
              okText: '我已了解，继续压缩',
              cancelText: '取消（不写入任何文件）',
              okButtonProps: { danger: true },
              width: 620,
              content: (
                <Space direction="vertical" size="small" style={{ width: '100%' }}>
                  <Text>源文件：{file.name}</Text>
                  <Text strong style={{ color: '#cf1322' }}>
                    {describeProtection(v)}
                  </Text>
                  <Text>{outcome.consequence}</Text>
                  <Text type="secondary">{outcome.advice}</Text>
                </Space>
              ),
              // onOk / onCancel 只负责把用户的选择回传，绝不在这里执行不可逆动作
              onOk: () => resolve(true),
              onCancel: () => resolve(false)
            })
          })
        }
      })
      if (decision === 'canceled') {
        message.info('已取消压缩：没有写入任何文件，源文件保持不变。')
        return
      }
      // ────────────────────────────────────────────────────────────
      let outBytes: Uint8Array
      let keptOriginal = false
      if (mode === 'raster') {
        const res = await rasterCompressPdf(bytes, level, renderPdfPages)
        outBytes = res.bytes
        keptOriginal = res.keptOriginal
        if (keptOriginal) {
          setNote('本档无收益，已保留原文件，未输出新文件。')
          message.warning(
            `本档压缩无收益：图像化后反而更大（原文件 ${formatBytes(file.size)} 已是低清小图），已保留原文件（不输出更大的文件）。请改用「结构压缩」。`
          )
          return
        }
        setNote(`图像化：${RASTER_PRESETS[level].result}`)
      } else {
        // 结构压缩：三档走完全不同的管线（见 utils/pdfCompress.ts）。
        // 任一档产出不小于原文件时，该模块会直接返回原文件并要求我们如实告知。
        const res = await structureCompressPdf(bytes, level)
        outBytes = res.bytes
        if (res.stats.keptOriginal) {
          const pct = file.size ? (((outBytes.byteLength - file.size) / file.size) * 100).toFixed(1) : '0.0'
          setNote('本档无收益，已保留原文件，未输出新文件。')
          message.warning(
            `本档压缩无收益：预计产出 ${formatBytes(outBytes.byteLength)}，比原文件 ${formatBytes(file.size)} 大 ${pct}%，已保留原文件（不输出更大的文件）。图像主导的文件请改用「图像化强压缩」。`
          )
          return
        }
        const detail = [
          res.stats.metadataCleared ? '已清空文档元数据' : '已保留文档元数据',
          res.stats.droppedLinkAnnots ? `移除 ${res.stats.droppedLinkAnnots} 个链接热区` : '',
          res.stats.prunedObjects ? `剪除 ${res.stats.prunedObjects} 个冗余对象` : '',
          res.stats.unsafeFallback ? '剪枝结果校验未通过，已自动退回保守版本' : ''
        ].filter(Boolean)
        setNote(detail.join('；'))
      }
      const out = await getPdfApi().savePath(file.name.replace(/\.pdf$/i, '') + '-min.pdf', ['pdf'])
      if (out) {
        await getPdfApi().write(out, outBytes)
        setAfter(outBytes.byteLength)
        message.success(`已导出：${out}`)
      }
    } catch (err) {
      // 用户已确认继续、底层仍然失败时，别把 pdf-lib 的内部报错直接丢给用户
      message.error(
        verdict?.encrypted
          ? `源文件受密码保护，压缩未能完成：${formatError(err)}。请先到「加密 / 解密」面板解密后再试。`
          : formatError(err)
      )
    } finally {
      setBusy(false)
    }
  }

  const levelHint = (
    {
      structure: {
        low: '低：重建页面结构，保留文档元数据。压缩强度最弱。',
        medium: '中：在「低」基础上清空文档元数据（标题/作者/主题/关键词/生成器/文件标识）。',
        high: '高：在「中」基础上移除无外观链接热区并剪除不可达对象。压缩强度最强。'
      },
      // 图像化档位：低→高 = 压缩强度递增（与结构压缩同向），文案由 preset 生成
      raster: {
        low: rasterLevelHint('low'),
        medium: rasterLevelHint('medium'),
        high: rasterLevelHint('high')
      }
    } as const
  )[mode][level]

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert
        type="info"
        showIcon
        message="压缩 PDF 体积，支持多等级"
        description="两种模式都不会输出更大的文件：任一档若产出不小于原文件，将保留原文件并如实提示。两个模式的「低 / 中 / 高」都表示压缩强度（高 = 压得更狠）。结构压缩不重采样图片，图像主导的文件请用「图像化强压缩」。"
      />
      {mode === 'structure' && (
        <Alert
          type="warning"
          showIcon
          message="结构压缩的取舍（请确认）"
          description="重建页面会丢弃无障碍标签、书签大纲、页面标签、附件等页面外数据；页面的可见内容、尺寸、旋转与裁剪框保留，带外观的批注/图章/表单域保留。中/高会清空文档元数据，该操作不可恢复。"
        />
      )}
      {verdict?.encrypted && (
        <Alert
          type="error"
          showIcon
          message="源文件受密码保护：本次压缩会毁掉这份保护，请先确认后果"
          description={
            <Space direction="vertical" size={2}>
              <Text>{describeProtection(verdict)}</Text>
              <Text>{describeProtectedOutcome(mode, verdict).consequence}</Text>
              <Text type="secondary">
                点「压缩导出」时会再次要求您显式确认；取消则不会写入任何文件。
                {describeProtectedOutcome(mode, verdict).advice}
              </Text>
            </Space>
          }
        />
      )}
      <Space wrap>
        <Button icon={<UploadOutlined />} onClick={() => void pick()}>
          选择 PDF
        </Button>
        {file && <Tag>{file.name} · {formatBytes(before)}</Tag>}
        <Segmented
          value={mode}
          onChange={(v) => setMode(v as 'structure' | 'raster')}
          options={[
            { label: '结构压缩（保留文字层）', value: 'structure' },
            { label: '图像化强压缩', value: 'raster' }
          ]}
        />
        <Segmented
          value={level}
          onChange={(v) => setLevel(v as 'low' | 'medium' | 'high')}
          options={[
            { label: '低', value: 'low' },
            { label: '中', value: 'medium' },
            { label: '高', value: 'high' }
          ]}
        />
        <Button type="primary" icon={<CompressOutlined />} loading={busy} disabled={!file} onClick={() => void run()}>
          压缩导出
        </Button>
      </Space>
      {file && <Text type="secondary">{levelHint}</Text>}
      {note && <Text type="secondary">本次处理：{note}</Text>}
      {after > 0 && (
        <Progress
          percent={Math.max(0, Math.round((1 - after / Math.max(1, before)) * 100))}
          status="success"
          format={(p) => `缩小 ${p}%（${formatBytes(before)} → ${formatBytes(after)}）`}
        />
      )}
    </Space>
  )
}

function EnhancePanel({ initialFile }: { initialFile?: PickedFile | null }) {
  const [file, setFile] = useState<PickedFile | null>(initialFile ?? null)
  const [strength, setStrength] = useState<EnhanceStrength>('medium')
  const [format, setFormat] = useState<'jpeg' | 'png'>('jpeg')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [stat, setStat] = useState<EnhanceStat | null>(null)

  const accept = async (f: PickedFile) => {
    setFile(f)
    setStat(null)
    setProgress(null)
  }

  const pick = async () => {
    const list = await getPdfApi().pickPdfs()
    if (list[0]) await accept(list[0])
  }

  // 挂载时带入页面级所选文件
  useEffect(() => {
    if (initialFile) void accept(initialFile)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const run = async () => {
    if (!file) return
    setBusy(true)
    setStat(null)
    setProgress({ done: 0, total: 0 })
    try {
      const bytes = await getPdfApi().read(file.path)
      if (!bytes) throw new Error('读取失败')
      const { out, stats } = await enhancePdf(bytes, strength, format, (done, total, s) => {
        setProgress({ done, total })
        setStat(s)
      })
      const target = await getPdfApi().savePath(file.name.replace(/\.pdf$/i, '') + '-enhanced.pdf', ['pdf'])
      if (target) {
        await getPdfApi().write(target, out)
        const ratio = out.length / Math.max(1, bytes.length)
        message.success(`已导出 ${stats.length} 页：${formatBytes(bytes.length)} → ${formatBytes(out.length)}`)
        if (ratio > 3) {
          message.warning('体积增至 3 倍以上。文字型 PDF 增强后为图像，属预期；可用「PDF 压缩」二次处理。', 6)
        }
      }
    } catch (err) {
      message.error(formatError(err))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const delta = stat ? stat.after.stdLuma - stat.before.stdLuma : 0
  const gainPct = stat && stat.before.stdLuma > 0 ? (delta / stat.before.stdLuma) * 100 : 0

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert
        type="info"
        showIcon
        message="提升模糊文字清晰度"
        description="逐页栅格化后做：墨迹感知自动色阶（去灰雾）→ gamma（压暗中间调、加粗笔画）→ 纸底白化（按纸底主导背景带折入色阶）→ 反锐化掩模。适合文字发灰、纸底脏的扫描件。"
      />
      <Alert
        type="warning"
        showIcon
        message="注意：本工具会重写纸底，可能影响浅灰内容"
        description={
          <>
            增强会重写纸底：发灰扫描件的脏底会被清理到纯白，但页面上的
            <Text strong>浅灰元素</Text>
            （浅色表格线、灰色图例等）也可能被一并清掉。请仅在扫描件/发灰文档上使用；含浅灰内容的数字文档建议先用预览确认。
          </>
        }
      />
      <Alert
        type="warning"
        showIcon
        message="注意：本工具会栅格化页面"
        description="增强后页面是图像，文字将无法选中或检索，体积也会增大。纯文字型（矢量）PDF 通常不需要增强。"
      />
      <Space wrap>
        <Button icon={<UploadOutlined />} onClick={() => void pick()}>
          选择 PDF
        </Button>
        {file && <Tag>{file.name} · {formatBytes(file.size)}</Tag>}
        <Segmented
          value={strength}
          onChange={(v) => setStrength(v as EnhanceStrength)}
          options={[
            { label: '轻度', value: 'light' },
            { label: '中度', value: 'medium' },
            { label: '强力', value: 'strong' }
          ]}
        />
        <Segmented
          value={format}
          onChange={(v) => setFormat(v as 'jpeg' | 'png')}
          options={[
            { label: 'JPEG（体积小）', value: 'jpeg' },
            { label: 'PNG（无损）', value: 'png' }
          ]}
        />
        <Button type="primary" icon={<HighlightOutlined />} loading={busy} disabled={!file} onClick={() => void run()}>
          增强导出
        </Button>
      </Space>

      {progress && progress.total > 0 && (
        <Progress percent={Math.round((progress.done / progress.total) * 100)} status="active" format={() => `${progress.done} / ${progress.total} 页`} />
      )}

      {stat && (
        <Card size="small" title={`处理结果 · 第 ${stat.page} 页`}>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="对比度（亮度标准差）">
              {stat.before.stdLuma.toFixed(1)} → <Text strong>{stat.after.stdLuma.toFixed(1)}</Text>
              {gainPct !== 0 && (
                <Text type={gainPct > 0 ? 'success' : 'danger'}> （{gainPct > 0 ? '+' : ''}{gainPct.toFixed(0)}%）</Text>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="文字变黑（暗像素占比）">
              {(stat.before.darkRatio * 100).toFixed(1)}% → <Text strong>{(stat.after.darkRatio * 100).toFixed(1)}%</Text>
            </Descriptions.Item>
            <Descriptions.Item label="灰雾（140–210 亮度）">
              {(stat.before.hazeRatio * 100).toFixed(1)}% → <Text strong>{(stat.after.hazeRatio * 100).toFixed(1)}%</Text>
            </Descriptions.Item>
            <Descriptions.Item label="纸底白化">
              {(stat.before.lightRatio * 100).toFixed(1)}% → <Text strong>{(stat.after.lightRatio * 100).toFixed(1)}%</Text>
            </Descriptions.Item>
            <Descriptions.Item label="自动色阶（黑场 / 白场）">
              {Math.round(stat.blackPoint * 255)} / {Math.round(stat.whitePoint * 255)}
            </Descriptions.Item>
            <Descriptions.Item label="纸底白化">
              {stat.whitenApplied
                ? `${stat.whitenThreshold}（≥ 该亮度即推纯白）`
                : strength === 'light'
                  ? '本档未白化（轻度不做白化）'
                  : '本页纸底已接近纯白，未做白化'}
            </Descriptions.Item>
            <Descriptions.Item label="调参建议">
              扫描件先试「轻度」，灰得厉害再上「强力」
            </Descriptions.Item>
          </Descriptions>
        </Card>
      )}
    </Space>
  )
}

function ToImagePanel({ initialFile }: { initialFile?: PickedFile | null }) {
  const [file, setFile] = useState<PickedFile | null>(initialFile ?? null)
  const [doc, setDoc] = useState<PDFDocument | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [format, setFormat] = useState<'png' | 'jpeg'>('png')
  const [mode, setMode] = useState<'each' | 'long'>('each')
  const [busy, setBusy] = useState(false)

  const accept = async (f: PickedFile) => {
    setFile(f)
    try {
      const d = await loadPdf(f.path)
      setDoc(d)
      setSelected([0])
    } catch (err) {
      message.error(formatError(err))
    }
  }

  const pick = async () => {
    const list = await getPdfApi().pickPdfs()
    if (!list[0]) return
    await accept(list[0])
  }

  // 挂载时带入页面级所选文件
  useEffect(() => {
    if (initialFile) void accept(initialFile)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const run = async () => {
    if (!doc || !file || !selected.length) return
    setBusy(true)
    try {
      const bytes = await getPdfApi().read(file.path)
      if (!bytes) throw new Error('读取失败')
      const pages = await renderPdfPages(bytes, selected, { scale: 2 })
      if (!pages.length) throw new Error('渲染失败')
      const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png'
      const ext = format === 'jpeg' ? 'jpg' : 'png'
      if (mode === 'long') {
        const long = stackCanvasesVertically(pages)
        const blob = await new Promise<Blob>((resolve, reject) =>
          long.toBlob((b) => (b ? resolve(b) : reject(new Error('导出失败'))), mime, 0.92)
        )
        downloadBlob(blob, `${file.name.replace(/\.pdf$/i, '')}-long.${ext}`)
      } else {
        for (const p of pages) {
          const blob = await new Promise<Blob>((resolve, reject) =>
            p.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('导出失败'))), mime, 0.92)
          )
          downloadBlob(blob, `${file.name.replace(/\.pdf$/i, '')}-p${p.pageIndex + 1}.${ext}`)
          await new Promise((r) => setTimeout(r, 120))
        }
      }
      message.success(`已导出 ${pages.length} 页图像`)
    } catch (err) {
      message.error(formatError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="选择页面导出单图或长图" description="支持 PNG / JPG 逐页导出或竖向拼长图（pdf.js 本地渲染）。" />
      <Space wrap>
        <Button icon={<UploadOutlined />} onClick={() => void pick()}>
          选择 PDF
        </Button>
        {file && <Tag>{file.name}</Tag>}
        <Segmented
          value={format}
          onChange={(v) => setFormat(v as 'png' | 'jpeg')}
          options={[
            { label: 'PNG', value: 'png' },
            { label: 'JPG', value: 'jpeg' }
          ]}
        />
        <Segmented
          value={mode}
          onChange={(v) => setMode(v as 'each' | 'long')}
          options={[
            { label: '逐页导出', value: 'each' },
            { label: '拼长图', value: 'long' }
          ]}
        />
        <Button type="primary" icon={<FileImageOutlined />} loading={busy} disabled={!doc} onClick={() => void run()}>
          导出图像
        </Button>
      </Space>
      {doc && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {doc.getPageIndices().map((i) => (
            <Checkbox
              key={i}
              checked={selected.includes(i)}
              onChange={(e) =>
                setSelected((s) => (e.target.checked ? [...s, i] : s.filter((x) => x !== i)))
              }
            >
              第 {i + 1} 页
            </Checkbox>
          ))}
        </div>
      )}
    </Space>
  )
}

function ExtractPanel({ initialFile }: { initialFile?: PickedFile | null }) {
  const [file, setFile] = useState<PickedFile | null>(initialFile ?? null)
  const [markdown, setMarkdown] = useState('')
  const [busy, setBusy] = useState(false)
  /** 无文本层（扫描件/图片型）时提供面板内 OCR 入口；有文本层时不出现 */
  const [noTextLayer, setNoTextLayer] = useState(false)
  const [pageCount, setPageCount] = useState(0)
  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrProgress, setOcrProgress] = useState<{ page: number; total: number; stage: string } | null>(null)

  const accept = async (f: PickedFile) => {
    setFile(f)
    setBusy(true)
    setNoTextLayer(false)
    setOcrProgress(null)
    try {
      const bytes = await getPdfApi().read(f.path)
      if (!bytes) throw new Error('读取失败')
      const pages = await extractPdfText(bytes)
      const md = pagesToMarkdown(pages, f.name)
      setMarkdown(md)
      setPageCount(pages.length)
      const totalChars = pages.reduce((s, p) => s + p.lines.join('').length, 0)
      setNoTextLayer(totalChars === 0)
      if (!totalChars) {
        message.warning('未提取到文本层（扫描件 / 图片型 PDF）。可点击下方「用 OCR 识别此扫描件」。')
      } else {
        message.success(`已提取 ${pages.length} 页 / ${totalChars} 字`)
      }
    } catch (err) {
      message.error(formatError(err))
    } finally {
      setBusy(false)
    }
  }

  const pick = async () => {
    const list = await getPdfApi().pickPdfs()
    if (!list[0]) return
    await accept(list[0])
  }

  // 挂载时带入页面级所选文件
  useEffect(() => {
    if (initialFile) void accept(initialFile)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runOcr = async () => {
    if (!file) return
    // 页数多时先如实警告（逐页 OCR 线性耗时），用户确认后才跑
    if (pageCount > 10) {
      const go = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: `共 ${pageCount} 页，逐页 OCR 较慢`,
          content: '每一页都要「渲染成图 → 文本检测 → 逐行识别」，页数越多耗时越长；进度会逐页显示。',
          okText: '继续 OCR',
          cancelText: '取消',
          // onOk / onCancel 只负责回传用户的选择
          onOk: () => resolve(true),
          onCancel: () => resolve(false)
        })
      })
      if (!go) return
    }
    setOcrBusy(true)
    setOcrProgress(null)
    try {
      const bytes = await getPdfApi().read(file.path)
      if (!bytes) throw new Error('读取失败')
      const indices = Array.from({ length: pageCount }, (_, i) => i)
      const res = await ocrExtractPages(
        bytes,
        indices,
        { render: renderPdfPages, recognize: recognizeImage },
        (p) => setOcrProgress(p)
      )
      // 与文本提取同一条 markdown 输出路径
      setMarkdown(pagesToMarkdown(res.pages, file.name))
      if (res.lineCount === 0) {
        message.warning('OCR 未识别出文字（可能不是含文字的扫描件，或版式过于特殊）。')
      } else {
        message.success(
          `OCR 完成：${res.pages.length} 页 / ${res.lineCount} 行，平均置信度 ${(res.avgScore * 100).toFixed(1)}%`
        )
      }
    } catch (err) {
      message.error(formatError(err))
    } finally {
      setOcrBusy(false)
      setOcrProgress(null)
    }
  }

  const download = () => {
    const blob = new Blob([markdown], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${file?.name?.replace(/\.pdf$/i, '') || 'document'}.md`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert
        type="info"
        showIcon
        message="提取 PDF 文字并生成 Markdown"
        description="读取有文本层的电子 PDF；扫描件 / 图片型 PDF 会自动提供面板内 OCR 识别。"
      />
      <Space wrap>
        <Button icon={<UploadOutlined />} loading={busy} onClick={() => void pick()}>
          选择 PDF
        </Button>
        {file && <Tag>{file.name}</Tag>}
        <Button icon={<DownloadOutlined />} disabled={!markdown} onClick={download}>
          导出 Markdown
        </Button>
      </Space>
      {file && noTextLayer && (
        <Alert
          type="warning"
          showIcon
          message="此 PDF 没有文本层（扫描件 / 图片型）"
          description={
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Text>
                可以直接在本面板用本地 OCR（PP-OCRv4）识别。首次使用需加载 det / rec / cls 三个识别模型，
                <Text strong>可能需要数十秒</Text>；之后按页识别，页数越多越慢。
              </Text>
              <Button type="primary" icon={<FileTextOutlined />} loading={ocrBusy} onClick={() => void runOcr()}>
                用 OCR 识别此扫描件
              </Button>
              {ocrBusy && ocrProgress && (
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Text>
                    第 {ocrProgress.page} / {ocrProgress.total} 页 · {ocrProgress.stage}
                  </Text>
                  <Progress
                    percent={Math.round((ocrProgress.page / Math.max(1, ocrProgress.total)) * 100)}
                    size="small"
                  />
                </Space>
              )}
            </Space>
          }
        />
      )}
      {markdown && (
        <pre
          style={{
            maxHeight: 320,
            overflow: 'auto',
            background: 'var(--bg-canvas, rgba(0,0,0,0.03))',
            padding: 12,
            borderRadius: 8,
            fontSize: 12
          }}
        >
          {markdown}
        </pre>
      )}
    </Space>
  )
}

function ExcelPanel() {
  const [file, setFile] = useState<PickedFile | null>(null)
  const [orientation, setOrientation] = useState<'auto' | 'portrait' | 'landscape'>('auto')
  const [busy, setBusy] = useState(false)
  const [sofficeReady, setSofficeReady] = useState<boolean | null>(null)

  useEffect(() => {
    void getPdfApi()
      .sofficeAvailable()
      .then(setSofficeReady)
      .catch(() => setSofficeReady(false))
  }, [])

  const pick = async () => {
    const list = await getPdfApi().pickExcel()
    if (list[0]) setFile(list[0])
  }

  const run = async () => {
    if (!file) return
    setBusy(true)
    try {
      const res = await getPdfApi().excelToPdf({
        sourcePath: file.path,
        pageOrientation: orientation
      })
      if (res.ok) message.success(`已导出：${res.outputPath}`)
      else message.error(res.error || '转换失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {sofficeReady === false ? (
        <Alert
          type="warning"
          showIcon
          message="未检测到 LibreOffice"
          description="Excel 转 PDF 需要 LibreOffice。请安装后重启应用，或将 soffice 放入 resources/tools/soffice/。"
        />
      ) : (
        <Alert type="info" showIcon message="把工作簿本地渲染为便于分享和打印的 PDF" description="走内置 LibreOffice，支持 XLSX / XLS / ODS。" />
      )}
      <Space wrap>
        <Button icon={<TableOutlined />} onClick={() => void pick()}>
          上传 Excel 文件
        </Button>
        {file && <Tag>{file.name}</Tag>}
        <Segmented
          value={orientation}
          onChange={(v) => setOrientation(v as 'auto' | 'portrait' | 'landscape')}
          options={[
            { label: '跟随源文件', value: 'auto' },
            { label: '纵向', value: 'portrait' },
            { label: '横向', value: 'landscape' }
          ]}
        />
        <Button type="primary" icon={<FilePdfOutlined />} loading={busy} disabled={!file || sofficeReady === false} onClick={() => void run()}>
          转换 PDF
        </Button>
      </Space>
    </Space>
  )
}

/* ---------- 页面级：小菜单栏 + PDF 内容预览 ---------- */

const PREVIEW_BATCH = 8
const PREVIEW_MAX_PAGES = 60

export default function PdfTools({
  embedded = false,
  initialTool,
  initialFile,
  onExit,
  onEditContent
}: {
  embedded?: boolean
  /** 外部（文档处理工具条）选中的工具，变化时同步 */
  initialTool?: PdfToolKey | null
  /** 外部注入的源文件（如文档处理里已打开的 PDF），仅作初始值 */
  initialFile?: { path: string; name: string; size: number } | null
  /** 嵌入模式下由外部提供「返回文档」 */
  onExit?: () => void
  /** 嵌入模式下由外部提供「编辑文字内容」（切到 Word 模式，带完整排版菜单） */
  onEditContent?: () => void
}) {
  const [tool, setTool] = useState<PdfToolKey>('merge')
  const [srcFile, setSrcFile] = useState<PickedFile | null>(initialFile ?? null)
  useEffect(() => {
    if (initialTool) setTool(initialTool)
  }, [initialTool])
  /** 已渲染页的 dataURL（JPEG，白底），分批增量渲染 */
  const [preview, setPreview] = useState<string[]>([])
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewLimit, setPreviewLimit] = useState(PREVIEW_BATCH)
  const [pageCount, setPageCount] = useState(0)
  const meta = useMemo(() => TOOL_META.find((t) => t.key === tool)!, [tool])

  const pickSource = async () => {
    const list = await getPdfApi().pickPdfs()
    if (!list[0]) return
    setPreviewLimit(PREVIEW_BATCH)
    setSrcFile(list[0])
  }

  // 页面内容预览：pdf.js 分批渲染（整本一次渲染会让大文件长时间白屏）
  useEffect(() => {
    if (!srcFile || tool === 'excel') {
      setPreview([])
      setPageCount(0)
      return
    }
    let cancelled = false
    setPreviewBusy(true)
    setPreview([])
    void (async () => {
      try {
        const bytes = await getPdfApi().read(srcFile.path)
        if (!bytes) throw new Error('读取 PDF 失败')
        const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
        const total = doc.getPageCount()
        const indices = Array.from({ length: Math.min(previewLimit, total) }, (_, i) => i)
        await new Promise((r) => setTimeout(r, 0)) // 加载态先上屏，再做同步重活
        const pages = await renderPdfPages(bytes, indices, { scale: 1.1, maxSide: 880 })
        if (cancelled) return
        setPageCount(total)
        setPreview(pages.map((p) => p.canvas.toDataURL('image/jpeg', 0.72)))
      } catch (err) {
        if (!cancelled) {
          message.error('内容预览失败（文件可能受密码保护或已损坏）：' + formatError(err))
          setPreview([])
          setPageCount(0)
        }
      } finally {
        if (!cancelled) setPreviewBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [srcFile, previewLimit, tool])

  const menuItems = TOOL_META.map((t) => ({
    key: t.key,
    icon: t.icon,
    label: (
      <div className="pdf-menu-item">
        <div className="pdf-menu-item-title">{t.title}</div>
        <div className="pdf-menu-item-desc">{t.desc}</div>
      </div>
    )
  }))

  return (
    <div className="media-tools-page">
      {!embedded && (
        <div className="page-header">
          <Title level={4} style={{ margin: 0 }}>
            PDF 工具
          </Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            合并 · 拆分 · 旋转 · 页码 · 加解密 · 压缩 · 提取 · Excel 转 PDF
          </Text>
          <div style={{ flex: 1 }} />
          <Tag color="green">pdf-lib · LibreOffice · 纯本地</Tag>
        </div>
      )}

      <div className="pdf-toolbar">
        {!embedded && (
          <Dropdown
            trigger={['click']}
            menu={{
              items: menuItems,
              selectedKeys: [tool],
              onClick: ({ key }) => setTool(key as PdfToolKey)
            }}
            overlayStyle={{ maxHeight: 460, overflowY: 'auto' }}
          >
            <Button icon={meta.icon}>
              {meta.title}
              <DownOutlined />
            </Button>
          </Dropdown>
        )}
        {embedded && onExit && (
          <Button icon={<FilePdfOutlined />} onClick={onExit}>
            返回文档
          </Button>
        )}
        <Button icon={<UploadOutlined />} onClick={() => void pickSource()}>
          选择 PDF
        </Button>
        {embedded && onEditContent && (
          <Button icon={<EditOutlined />} onClick={onEditContent}>
            编辑文字内容
          </Button>
        )}
        {srcFile && (
          <>
            <Tag icon={<FilePdfOutlined />} style={{ marginInlineEnd: 0 }}>
              {srcFile.name} · {formatBytes(srcFile.size)}
              {pageCount > 0 ? ` · ${pageCount} 页` : ''}
            </Tag>
            <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => setSrcFile(null)}>
              移除
            </Button>
          </>
        )}
        {!embedded && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            选好 PDF 后内容预览在下方，所有工具自动带入该文件
          </Text>
        )}
      </div>

      {srcFile && tool !== 'excel' && (
        <Card
          size="small"
          title={
            <Space>
              <FilePdfOutlined />
              <span>PDF 内容预览</span>
              {pageCount > 0 && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  共 {pageCount} 页
                </Text>
              )}
            </Space>
          }
          className="mt-panel"
        >
          {previewBusy ? (
            <div className="pdf-preview-loading">
              <Spin />
              <Text type="secondary">正在渲染页面…</Text>
            </div>
          ) : (
            <>
              <div className="pdf-preview-grid">
                {preview.map((src, i) => (
                  <figure key={i} className="pdf-preview-page">
                    <img src={src} alt={`第 ${i + 1} 页`} loading="lazy" />
                    <figcaption>第 {i + 1} 页</figcaption>
                  </figure>
                ))}
              </div>
              {preview.length < pageCount && previewLimit < PREVIEW_MAX_PAGES && (
                <Button onClick={() => setPreviewLimit((l) => l + PREVIEW_BATCH)}>
                  继续渲染后面 {Math.min(PREVIEW_BATCH, pageCount - preview.length)} 页（已渲染 {preview.length}/
                  {pageCount}）
                </Button>
              )}
              {previewLimit >= PREVIEW_MAX_PAGES && preview.length < pageCount && (
                <Text type="secondary">
                  大文件仅预览前 {PREVIEW_MAX_PAGES} 页；工具面板内不受此限制。
                </Text>
              )}
            </>
          )}
        </Card>
      )}

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
        {tool === 'pagenumber' && <PageNumberPanel initialFile={srcFile} />}
        {tool === 'crop' && <CropPanel initialFile={srcFile} />}
        {tool === 'editor' && <EditorPanel initialFile={srcFile} />}
        {tool === 'merge' && <MergePanel initialFile={srcFile} />}
        {tool === 'split' && <SplitPanel initialFile={srcFile} />}
        {tool === 'toimage' && <ToImagePanel initialFile={srcFile} />}
        {tool === 'extract' && <ExtractPanel initialFile={srcFile} />}
        {tool === 'rotate' && <RotatePanel initialFile={srcFile} />}
        {tool === 'watermark' && <WatermarkPanel initialFile={srcFile} />}
        {tool === 'encrypt' && <CryptoPanel mode="encrypt" initialFile={srcFile} />}
        {tool === 'decrypt' && <CryptoPanel mode="decrypt" initialFile={srcFile} />}
        {tool === 'compress' && <CompressPanel initialFile={srcFile} />}
        {tool === 'enhance' && <EnhancePanel initialFile={srcFile} />}
        {tool === 'excel' && <ExcelPanel />}
      </Card>
    </div>
  )
}
