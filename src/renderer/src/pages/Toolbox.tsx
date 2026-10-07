/* 灵墨工作台 · 工具箱（移植 ToolKnit 开发者 / 计算器 / 创意 / 图像 能力，全部本地执行） */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  ColorPicker,
  Descriptions,
  Divider,
  Flex,
  Input,
  InputNumber,
  Progress,
  Radio,
  Row,
  Select,
  Slider,
  Space,
  Statistic,
  Switch,
  Tabs,
  Tag,
  Typography,
  Upload,
  message
} from 'antd'
import {
  BgColorsOutlined,
  CalculatorOutlined,
  CopyOutlined,
  DownloadOutlined,
  FileImageOutlined,
  ReloadOutlined,
  ScissorOutlined,
  ToolOutlined
} from '@ant-design/icons'
import {
  calcBodyFat,
  calcInterest,
  calcMortgage,
  colorSnapshot,
  cropCanvas,
  dateToTimestamp,
  downloadBlob,
  downloadText,
  drawImageToCanvas,
  extractPalette,
  formatBytes,
  generatePassword,
  generateUuidBatch,
  hashText,
  hmacText,
  makeIconSet,
  parseJwt,
  resizeCanvas,
  rgbToHex,
  stitchImages,
  timestampNow,
  timestampToDate,
  canvasToBlob,
  type HashAlgo
} from '../utils/toolbox'

const { Text, Title, Paragraph } = Typography

function CopyBtn({ text, label = '复制' }: { text: string; label?: string }) {
  return (
    <Button
      size="small"
      icon={<CopyOutlined />}
      onClick={() => {
        void navigator.clipboard.writeText(text)
        message.success('已复制')
      }}
      disabled={!text}
    >
      {label}
    </Button>
  )
}

// ── 开发者 ────────────────────────────────────────────────────────
function DevSection() {
  const [uuidCount, setUuidCount] = useState(5)
  const [uuidList, setUuidList] = useState<string[]>(() => generateUuidBatch(5))
  const [jwtInput, setJwtInput] = useState('')
  const jwt = useMemo(() => (jwtInput ? parseJwt(jwtInput) : null), [jwtInput])
  const [hashAlgo, setHashAlgo] = useState<HashAlgo>('SHA-256')
  const [hashTextIn, setHashTextIn] = useState('')
  const [hashOut, setHashOut] = useState('')
  const [hmacKey, setHmacKey] = useState('')
  const [hmacOut, setHmacOut] = useState('')
  const [pwdLen, setPwdLen] = useState(16)
  const [pwdOpts, setPwdOpts] = useState({ upper: true, lower: true, digits: true, symbols: true, excludeAmbiguous: true })
  const [pwd, setPwd] = useState(() =>
    generatePassword({ length: 16, upper: true, lower: true, digits: true, symbols: true, excludeAmbiguous: true })
  )

  const runHash = useCallback(async () => {
    if (!hashTextIn) {
      setHashOut('')
      return
    }
    try {
      setHashOut(await hashText(hashAlgo, hashTextIn))
    } catch (e) {
      setHashOut(e instanceof Error ? e.message : String(e))
    }
  }, [hashAlgo, hashTextIn])

  const runHmac = useCallback(async () => {
    if (!hashTextIn || !hmacKey || hashAlgo === 'MD5') {
      setHmacOut('')
      return
    }
    try {
      setHmacOut(await hmacText(hashAlgo as 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512', hmacKey, hashTextIn))
    } catch (e) {
      setHmacOut(e instanceof Error ? e.message : String(e))
    }
  }, [hashAlgo, hashTextIn, hmacKey])

  useEffect(() => {
    void runHash()
    void runHmac()
  }, [runHash, runHmac])

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={12}>
        <Card size="small" title="UUID 生成器" extra={<Button size="small" icon={<ReloadOutlined />} onClick={() => setUuidList(generateUuidBatch(uuidCount))}>重新生成</Button>}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space>
              <Text>数量</Text>
              <InputNumber min={1} max={200} value={uuidCount} onChange={(v) => setUuidCount(v ?? 1)} />
              <Button type="primary" size="small" onClick={() => setUuidList(generateUuidBatch(uuidCount))}>
                生成 v4
              </Button>
              <CopyBtn text={uuidList.join('\n')} label="复制全部" />
            </Space>
            <Input.TextArea rows={8} value={uuidList.join('\n')} readOnly />
          </Space>
        </Card>
      </Col>
      <Col xs={24} lg={12}>
        <Card size="small" title="JWT 查看器" extra={<Tag>仅本地解析</Tag>}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Input.TextArea
              rows={4}
              placeholder="粘贴 JWT（header.payload.signature）"
              value={jwtInput}
              onChange={(e) => setJwtInput(e.target.value)}
            />
            {jwt && !jwt.ok && <Alert type="error" showIcon message={jwt.error} />}
            {jwt?.ok && (
              <>
                <Space wrap>
                  {jwt.alg && <Tag color="blue">alg: {jwt.alg}</Tag>}
                  {jwt.subject && <Tag>sub: {jwt.subject}</Tag>}
                  {jwt.issuedAt && <Tag>iat: {jwt.issuedAt}</Tag>}
                  {jwt.expiresAt && (
                    <Tag color={Date.parse(jwt.expiresAt) < Date.now() ? 'red' : 'green'}>exp: {jwt.expiresAt}</Tag>
                  )}
                </Space>
                <Text strong>Header</Text>
                <Input.TextArea rows={4} readOnly value={JSON.stringify(jwt.header, null, 2)} />
                <Text strong>Payload</Text>
                <Input.TextArea rows={6} readOnly value={JSON.stringify(jwt.payload, null, 2)} />
              </>
            )}
          </Space>
        </Card>
      </Col>
      <Col xs={24} lg={12}>
        <Card size="small" title="Hash & HMAC">
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space wrap>
              <Select
                value={hashAlgo}
                style={{ width: 120 }}
                onChange={(v) => setHashAlgo(v)}
                options={[
                  { value: 'MD5', label: 'MD5（兼容）' },
                  { value: 'SHA-1', label: 'SHA-1' },
                  { value: 'SHA-256', label: 'SHA-256' },
                  { value: 'SHA-384', label: 'SHA-384' },
                  { value: 'SHA-512', label: 'SHA-512' }
                ]}
              />
              <CopyBtn text={hashOut} />
            </Space>
            <Input.TextArea rows={3} placeholder="待摘要文本" value={hashTextIn} onChange={(e) => setHashTextIn(e.target.value)} />
            <Input readOnly value={hashOut} placeholder="摘要结果" />
            <Divider style={{ margin: '8px 0' }} />
            <Space wrap>
              <Text>HMAC Key</Text>
              <Input.Password style={{ width: 200 }} value={hmacKey} onChange={(e) => setHmacKey(e.target.value)} />
              <CopyBtn text={hmacOut} />
            </Space>
            <Input readOnly value={hmacOut} placeholder="HMAC 结果（MD5 不支持）" />
            {hashAlgo === 'MD5' && <Text type="warning">MD5 已不安全，仅作旧数据兼容；生产请用 SHA-256+。</Text>}
          </Space>
        </Card>
      </Col>
      <Col xs={24} lg={12}>
        <Card size="small" title="密码生成器" extra={<Button size="small" icon={<ReloadOutlined />} onClick={() => setPwd(generatePassword({ length: pwdLen, ...pwdOpts }))}>刷新</Button>}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Input value={pwd} readOnly />
            <Space>
              <Text>长度</Text>
              <Slider style={{ width: 160 }} min={4} max={64} value={pwdLen} onChange={setPwdLen} />
              <InputNumber min={4} max={64} value={pwdLen} onChange={(v) => setPwdLen(v ?? 16)} />
            </Space>
            <Space wrap>
              <Switch checked={pwdOpts.upper} onChange={(v) => setPwdOpts((p) => ({ ...p, upper: v }))} /> 大写
              <Switch checked={pwdOpts.lower} onChange={(v) => setPwdOpts((p) => ({ ...p, lower: v }))} /> 小写
              <Switch checked={pwdOpts.digits} onChange={(v) => setPwdOpts((p) => ({ ...p, digits: v }))} /> 数字
              <Switch checked={pwdOpts.symbols} onChange={(v) => setPwdOpts((p) => ({ ...p, symbols: v }))} /> 符号
              <Switch
                checked={pwdOpts.excludeAmbiguous}
                onChange={(v) => setPwdOpts((p) => ({ ...p, excludeAmbiguous: v }))}
              />{' '}
              排除易混
            </Space>
            <Space>
              <Button type="primary" onClick={() => setPwd(generatePassword({ length: pwdLen, ...pwdOpts }))}>
                生成
              </Button>
              <CopyBtn text={pwd} />
            </Space>
          </Space>
        </Card>
      </Col>
    </Row>
  )
}

// ── 计算器 ────────────────────────────────────────────────────────
function CalcSection() {
  const [ts, setTs] = useState<string>(String(timestampNow()))
  const tsView = useMemo(() => {
    const n = Number(ts)
    return Number.isFinite(n) ? timestampToDate(n) : null
  }, [ts])
  const [dateIn, setDateIn] = useState(new Date().toISOString().slice(0, 19).replace('T', ' '))
  const dateTs = useMemo(() => dateToTimestamp(dateIn), [dateIn])

  const [principal, setPrincipal] = useState(100)
  const [rate, setRate] = useState(3.85)
  const [years, setYears] = useState(30)
  const [method, setMethod] = useState<'equal-installment' | 'equal-principal'>('equal-installment')
  const mortgage = useMemo(() => calcMortgage(principal * 10000, rate, years, method), [principal, rate, years, method])

  const [iPrincipal, setIPrincipal] = useState(10)
  const [iRate, setIRate] = useState(3)
  const [iYears, setIYears] = useState(3)
  const [compound, setCompound] = useState<'simple' | 'annual' | 'monthly'>('simple')
  const interest = useMemo(() => calcInterest(iPrincipal * 10000, iRate, iYears, compound), [iPrincipal, iRate, iYears, compound])

  const [height, setHeight] = useState(170)
  const [weight, setWeight] = useState(65)
  const [age, setAge] = useState(30)
  const [gender, setGender] = useState<'male' | 'female'>('male')
  const body = useMemo(() => calcBodyFat(height, weight, age, gender), [height, weight, age, gender])

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={12}>
        <Card size="small" title="时间戳计算器">
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space.Compact style={{ width: '100%' }}>
              <Input value={ts} onChange={(e) => setTs(e.target.value)} placeholder="Unix 时间戳（秒或毫秒）" />
              <Button onClick={() => setTs(String(timestampNow()))}>当前</Button>
              <CopyBtn text={ts} />
            </Space.Compact>
            {tsView ? (
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="本地时间">{tsView.local}</Descriptions.Item>
                <Descriptions.Item label="ISO">{tsView.iso}</Descriptions.Item>
                <Descriptions.Item label="毫秒">{tsView.ms}</Descriptions.Item>
              </Descriptions>
            ) : (
              <Text type="secondary">输入有效数字后显示转换结果</Text>
            )}
            <Divider style={{ margin: '8px 0' }} />
            <Space.Compact style={{ width: '100%' }}>
              <Input value={dateIn} onChange={(e) => setDateIn(e.target.value)} placeholder="2026-01-01 12:00:00" />
              <Button
                onClick={() => setDateIn(new Date().toISOString().slice(0, 19).replace('T', ' '))}
              >
                当前
              </Button>
              <Button onClick={() => dateTs != null && setTs(String(dateTs))}>→ 时间戳</Button>
            </Space.Compact>
            <Text type="secondary">
              解析结果：{dateTs != null ? `${dateTs}（秒） / ${dateTs * 1000}（毫秒）` : '无法解析日期'}
            </Text>
          </Space>
        </Card>
      </Col>
      <Col xs={24} lg={12}>
        <Card size="small" title="房贷计算器">
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space wrap>
              <Text>贷款（万）</Text>
              <InputNumber min={1} max={10000} value={principal} onChange={(v) => setPrincipal(v ?? 100)} />
              <Text>年利率 %</Text>
              <InputNumber min={0} max={30} step={0.01} value={rate} onChange={(v) => setRate(v ?? 0)} />
              <Text>年限</Text>
              <InputNumber min={1} max={50} value={years} onChange={(v) => setYears(v ?? 30)} />
            </Space>
            <Radio.Group
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              options={[
                { label: '等额本息', value: 'equal-installment' },
                { label: '等额本金', value: 'equal-principal' }
              ]}
            />
            <Row gutter={8}>
              <Col span={8}>
                <Statistic title="月供（元）" value={mortgage.monthly} precision={2} />
              </Col>
              <Col span={8}>
                <Statistic title="总利息" value={mortgage.totalInterest} precision={2} />
              </Col>
              <Col span={8}>
                <Statistic title="还款总额" value={mortgage.totalPayment} precision={2} />
              </Col>
            </Row>
          </Space>
        </Card>
      </Col>
      <Col xs={24} lg={12}>
        <Card size="small" title="利息计算器">
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space wrap>
              <Text>本金（万）</Text>
              <InputNumber min={0.01} value={iPrincipal} onChange={(v) => setIPrincipal(v ?? 1)} />
              <Text>年利率 %</Text>
              <InputNumber min={0} max={50} step={0.01} value={iRate} onChange={(v) => setIRate(v ?? 0)} />
              <Text>年限</Text>
              <InputNumber min={0.1} max={50} step={0.1} value={iYears} onChange={(v) => setIYears(v ?? 1)} />
            </Space>
            <Radio.Group
              value={compound}
              onChange={(e) => setCompound(e.target.value)}
              options={[
                { label: '单利', value: 'simple' },
                { label: '年复利', value: 'annual' },
                { label: '月复利', value: 'monthly' }
              ]}
            />
            <Row gutter={8}>
              <Col span={12}>
                <Statistic title="利息" value={interest.interest} precision={2} />
              </Col>
              <Col span={12}>
                <Statistic title="本息合计" value={interest.total} precision={2} />
              </Col>
            </Row>
          </Space>
        </Card>
      </Col>
      <Col xs={24} lg={12}>
        <Card size="small" title="体脂 / BMI">
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space wrap>
              <Text>身高 cm</Text>
              <InputNumber min={100} max={230} value={height} onChange={(v) => setHeight(v ?? 170)} />
              <Text>体重 kg</Text>
              <InputNumber min={30} max={200} value={weight} onChange={(v) => setWeight(v ?? 65)} />
              <Text>年龄</Text>
              <InputNumber min={10} max={100} value={age} onChange={(v) => setAge(v ?? 30)} />
              <Radio.Group
                value={gender}
                onChange={(e) => setGender(e.target.value)}
                options={[
                  { label: '男', value: 'male' },
                  { label: '女', value: 'female' }
                ]}
              />
            </Space>
            <Row gutter={8}>
              <Col span={8}>
                <Statistic title="BMI" value={body.bmi} />
              </Col>
              <Col span={8}>
                <Statistic title="体脂率 %" value={body.bodyFat} />
              </Col>
              <Col span={8}>
                <Statistic title="分类" value={body.category} />
              </Col>
            </Row>
            <Text type="secondary">未填颈围/腰围时使用 BMI 估算，结果仅供参考。</Text>
          </Space>
        </Card>
      </Col>
    </Row>
  )
}

// ── 创意：配色 / 色空间 / 打字 ─────────────────────────────────────
function CreativeSection() {
  const [hex, setHex] = useState('#1D9E75')
  const snap = useMemo(() => colorSnapshot(hex), [hex])
  const [colorFile, setColorFile] = useState<HTMLImageElement | null>(null)
  const [palette, setPalette] = useState<Array<{ hex: string; ratio: number }>>([])

  const onPickFile = useCallback(async (file: File) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('图片加载失败'))
      img.src = url
    })
    setColorFile(img)
    const canvas = drawImageToCanvas(img)
    const ctx = canvas.getContext('2d')
    if (ctx) setPalette(extractPalette(ctx.getImageData(0, 0, canvas.width, canvas.height), 8))
    URL.revokeObjectURL(url)
    return false
  }, [])

  // 打字测试
  const samples = useMemo(
    () => [
      '灵墨工作台把文件、文本与智能体能力收拢到同一套清晰工具体系里。',
      'The quick brown fox jumps over the lazy dog.',
      '本地优先：处理过程不上传，结果留在你的电脑上。',
      'To be or not to be, that is the question.'
    ],
    []
  )
  const [sampleIdx, setSampleIdx] = useState(0)
  const [typed, setTyped] = useState('')
  const [typingStart, setTypingStart] = useState<number | null>(null)
  const [typingDone, setTypingDone] = useState(false)
  const sample = samples[sampleIdx]

  const typingStats = useMemo(() => {
    const elapsed = typingStart ? (Date.now() - typingStart) / 1000 : 0
    let correct = 0
    for (let i = 0; i < typed.length && i < sample.length; i++) {
      if (typed[i] === sample[i]) correct++
    }
    const accuracy = typed.length ? Math.round((correct / typed.length) * 100) : 0
    const minutes = elapsed / 60
    const wpm = minutes > 0 ? Math.round((correct / 5 / minutes) * 10) / 10 : 0
    return { elapsed: Math.round(elapsed * 10) / 10, accuracy, wpm, correct, total: sample.length }
  }, [typed, sample, typingStart])

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={12}>
        <Card size="small" title="颜色空间对比" extra={<Tag color="magenta">8 分量联动</Tag>}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space wrap>
              <ColorPicker
                value={hex}
                onChange={(c) => setHex(c.toHexString())}
                showText
              />
              <Input
                style={{ width: 110 }}
                value={hex}
                onChange={(e) => setHex(e.target.value)}
                placeholder="#RRGGBB"
              />
              <CopyBtn text={snap?.hex ?? ''} />
            </Space>
            {snap && (
              <>
                <div
                  style={{
                    height: 64,
                    borderRadius: 8,
                    background: snap.hex,
                    border: '1px solid rgba(0,0,0,0.08)'
                  }}
                />
                <Descriptions size="small" column={2} bordered>
                  <Descriptions.Item label="HEX">{snap.hex}</Descriptions.Item>
                  <Descriptions.Item label="RGB">
                    {snap.rgb.r}, {snap.rgb.g}, {snap.rgb.b}
                  </Descriptions.Item>
                  <Descriptions.Item label="HSL">
                    {snap.hsl.h}°, {snap.hsl.s}%, {snap.hsl.l}%
                  </Descriptions.Item>
                  <Descriptions.Item label="HSV">
                    {snap.hsv.h}°, {snap.hsv.s}%, {snap.hsv.v}%
                  </Descriptions.Item>
                  <Descriptions.Item label="CMYK">
                    {snap.cmyk.c}, {snap.cmyk.m}, {snap.cmyk.y}, {snap.cmyk.k}
                  </Descriptions.Item>
                  <Descriptions.Item label="相对亮度">{snap.luminance}</Descriptions.Item>
                </Descriptions>
                <Text type="secondary">
                  文字对比建议：{snap.isLight ? '适合深色文字' : '适合浅色文字'}
                </Text>
              </>
            )}
            <Divider style={{ margin: '8px 0' }} />
            <Space wrap>
              <Upload accept="image/*" showUploadList={false} beforeUpload={(f) => void onPickFile(f)} maxCount={1}>
                <Button icon={<BgColorsOutlined />}>从图片提取主色</Button>
              </Upload>
              {colorFile && <Tag>{colorFile.naturalWidth}×{colorFile.naturalHeight}</Tag>}
            </Space>
            {palette.length > 0 && (
              <Space wrap>
                {palette.map((p) => (
                  <Button
                    key={p.hex}
                    size="small"
                    onClick={() => setHex(p.hex)}
                    style={{ background: p.hex, color: colorSnapshot(p.hex)?.isLight ? '#111' : '#fff', border: 'none' }}
                  >
                    {p.hex} {p.ratio}%
                  </Button>
                ))}
              </Space>
            )}
          </Space>
        </Card>
      </Col>
      <Col xs={24} lg={12}>
        <Card
          size="small"
          title="打字测试器"
          extra={
            <Space>
              <Select
                size="small"
                value={sampleIdx}
                style={{ width: 120 }}
                onChange={(v) => {
                  setSampleIdx(v)
                  setTyped('')
                  setTypingStart(null)
                  setTypingDone(false)
                }}
                options={samples.map((_, i) => ({ value: i, label: `样本 ${i + 1}` }))}
              />
              <Button
                size="small"
                onClick={() => {
                  setTyped('')
                  setTypingStart(null)
                  setTypingDone(false)
                }}
              >
                重置
              </Button>
            </Space>
          }
        >
          <Space direction="vertical" style={{ width: '100%' }}>
            <Paragraph
              style={{
                fontFamily: 'ui-monospace, Consolas, monospace',
                background: 'rgba(0,0,0,0.04)',
                padding: 12,
                borderRadius: 8,
                marginBottom: 0
              }}
            >
              {sample.split('').map((ch, i) => {
                const typedCh = typed[i]
                const cls =
                  typedCh == null
                    ? undefined
                    : typedCh === ch
                      ? { color: '#1D9E75' }
                      : { color: '#e11d48', textDecoration: 'underline' }
                return (
                  <span key={i} style={cls}>
                    {ch}
                  </span>
                )
              })}
            </Paragraph>
            <Input.TextArea
              rows={3}
              placeholder="点击后开始输入…"
              value={typed}
              onChange={(e) => {
                const v = e.target.value
                if (!typingStart && v) setTypingStart(Date.now())
                setTyped(v)
                if (v.length >= sample.length) setTypingDone(true)
              }}
            />
            <Row gutter={8}>
              <Col span={6}>
                <Statistic title="用时 (s)" value={typingStats.elapsed} />
              </Col>
              <Col span={6}>
                <Statistic title="速度 (WPM)" value={typingStats.wpm} />
              </Col>
              <Col span={6}>
                <Statistic title="正确率" value={`${typingStats.accuracy}%`} />
              </Col>
              <Col span={6}>
                <Statistic title="进度" value={`${Math.min(typed.length, sample.length)}/${sample.length}`} />
              </Col>
            </Row>
            <Progress percent={Math.min(100, Math.round((typed.length / sample.length) * 100))} size="small" status={typingDone ? 'success' : 'active'} />
          </Space>
        </Card>
      </Col>
    </Row>
  )
}

// ── 图像 ──────────────────────────────────────────────────────────
type LoadedImg = { name: string; canvas: HTMLCanvasElement; size: number }

function ImageSection() {
  const [images, setImages] = useState<LoadedImg[]>([])
  const [preview, setPreview] = useState<string>('')
  const [crop, setCrop] = useState({ x: 0, y: 0, w: 0, h: 0 })
  const [compressQ, setCompressQ] = useState(0.8)
  const [maxSide, setMaxSide] = useState(1600)
  const [stitchDir, setStitchDir] = useState<'horizontal' | 'vertical'>('vertical')
  const [stitchGap, setStitchGap] = useState(0)

  const loadFiles = useCallback(async (files: File[]) => {
    const loaded: LoadedImg[] = []
    for (const f of files) {
      try {
        const url = URL.createObjectURL(f)
        const img = new Image()
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = () => reject(new Error('load fail'))
          img.src = url
        })
        const canvas = drawImageToCanvas(img)
        URL.revokeObjectURL(url)
        loaded.push({ name: f.name, canvas, size: f.size })
      } catch {
        message.error(`无法读取 ${f.name}`)
      }
    }
    if (loaded.length) {
      setImages((prev) => [...prev, ...loaded])
      if (loaded[0]) {
        setCrop({ x: 0, y: 0, w: loaded[0].canvas.width, h: loaded[0].canvas.height })
        setPreview(loaded[0].canvas.toDataURL('image/png'))
      }
    }
  }, [message])

  const current = images[0]

  const exportCanvas = useCallback(async (canvas: HTMLCanvasElement, name: string, type: string, quality?: number) => {
    const blob = await canvasToBlob(canvas, type, quality)
    if (!blob) {
      message.error('导出失败')
      return
    }
    downloadBlob(blob, name)
    message.success(`已导出 ${name}（${formatBytes(blob.size)}）`)
  }, [message])

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={12}>
        <Card
          size="small"
          title="图片裁剪 / 压缩 / 格式"
          extra={
            <Upload
              multiple
              accept="image/*"
              showUploadList={false}
              beforeUpload={(f) => {
                void loadFiles([f])
                return false
              }}
            >
              <Button size="small" icon={<FileImageOutlined />}>选择图片</Button>
            </Upload>
          }
        >
          <Space direction="vertical" style={{ width: '100%' }}>
            {images.length === 0 && <Alert type="info" showIcon message="选择一张或多张图片，全部在本地 Canvas 处理" />}
            {images.length > 0 && (
              <>
                <Space wrap>
                  {images.map((im, i) => (
                    <Tag.CheckableTag
                      key={`${im.name}-${i}`}
                      checked={i === 0}
                      onChange={() => {
                        setPreview(im.canvas.toDataURL('image/png'))
                        setCrop({ x: 0, y: 0, w: im.canvas.width, h: im.canvas.height })
                        setImages((prev) => {
                          const next = [...prev]
                          const [picked] = next.splice(i, 1)
                          return [picked, ...next]
                        })
                      }}
                    >
                      {im.name}
                    </Tag.CheckableTag>
                  ))}
                  <Button size="small" danger onClick={() => setImages([])}>
                    清空
                  </Button>
                </Space>
                {current && (
                  <Text type="secondary">
                    {current.canvas.width}×{current.canvas.height} · {formatBytes(current.size)}
                  </Text>
                )}
                <img
                  alt="preview"
                  src={preview}
                  style={{ maxWidth: '100%', maxHeight: 220, borderRadius: 8, background: '#fafafa' }}
                />
                <Space wrap>
                  <Text>裁 X</Text>
                  <InputNumber size="small" min={0} value={crop.x} onChange={(v) => setCrop((c) => ({ ...c, x: v ?? 0 }))} />
                  <Text>Y</Text>
                  <InputNumber size="small" min={0} value={crop.y} onChange={(v) => setCrop((c) => ({ ...c, y: v ?? 0 }))} />
                  <Text>W</Text>
                  <InputNumber size="small" min={1} value={crop.w} onChange={(v) => setCrop((c) => ({ ...c, w: v ?? 1 }))} />
                  <Text>H</Text>
                  <InputNumber size="small" min={1} value={crop.h} onChange={(v) => setCrop((c) => ({ ...c, h: v ?? 1 }))} />
                  <Button
                    size="small"
                    icon={<ScissorOutlined />}
                    onClick={() => {
                      if (!current) return
                      const out = cropCanvas(current.canvas, crop.x, crop.y, crop.w, crop.h)
                      setPreview(out.toDataURL('image/png'))
                      void exportCanvas(out, `crop-${current.name.replace(/\.\w+$/, '')}.png`, 'image/png')
                    }}
                  >
                    裁剪并导出
                  </Button>
                </Space>
                <Space wrap>
                  <Text>JPEG 质量</Text>
                  <Slider style={{ width: 120 }} min={0.2} max={1} step={0.05} value={compressQ} onChange={setCompressQ} />
                  <Text>最长边</Text>
                  <InputNumber size="small" min={64} max={4096} value={maxSide} onChange={(v) => setMaxSide(v ?? 1600)} />
                </Space>
                <Space wrap>
                  <Button
                    size="small"
                    onClick={() => {
                      if (!current) return
                      const resized = resizeCanvas(current.canvas, maxSide)
                      void exportCanvas(resized, `compressed-${current.name.replace(/\.\w+$/, '')}.jpg`, 'image/jpeg', compressQ)
                    }}
                  >
                    压缩 JPEG
                  </Button>
                  <Button
                    size="small"
                    onClick={() => {
                      if (!current) return
                      void exportCanvas(current.canvas, `converted-${current.name.replace(/\.\w+$/, '')}.webp`, 'image/webp', 0.9)
                    }}
                  >
                    转 WebP
                  </Button>
                  <Button
                    size="small"
                    onClick={() => {
                      if (!current) return
                      void exportCanvas(current.canvas, `converted-${current.name.replace(/\.\w+$/, '')}.png`, 'image/png')
                    }}
                  >
                    转 PNG
                  </Button>
                  <Button
                    size="small"
                    onClick={() => {
                      if (!current) return
                      const resized = resizeCanvas(current.canvas, maxSide)
                      void exportCanvas(resized, `resized-${current.name}`, 'image/png')
                    }}
                  >
                    缩放 PNG
                  </Button>
                </Space>
              </>
            )}
          </Space>
        </Card>
      </Col>
      <Col xs={24} lg={12}>
        <Card size="small" title="图标生成 / 长图拼接">
          <Space direction="vertical" style={{ width: '100%' }}>
            <Button
              disabled={!current}
              onClick={async () => {
                if (!current) return
                const set = makeIconSet(current.canvas)
                // 逐个导出（浏览器无内置 zip，先导出 32/128/256 常用尺寸）
                for (const item of set.filter((s) => [32, 128, 256].includes(s.size))) {
                  const blob = await canvasToBlob(item.canvas, 'image/png')
                  if (blob) downloadBlob(blob, item.name)
                }
                message.success('已导出 32/128/256 图标 PNG')
              }}
            >
              <DownloadOutlined /> 生成多尺寸图标
            </Button>
            <Divider style={{ margin: '8px 0' }} />
            <Space wrap>
              <Radio.Group
                value={stitchDir}
                onChange={(e) => setStitchDir(e.target.value)}
                options={[
                  { label: '纵向拼接', value: 'vertical' },
                  { label: '横向拼接', value: 'horizontal' }
                ]}
              />
              <Text>间距</Text>
              <InputNumber size="small" min={0} max={64} value={stitchGap} onChange={(v) => setStitchGap(v ?? 0)} />
            </Space>
            <Button
              disabled={images.length < 2}
              onClick={() => {
                const stitched = stitchImages(images.map((i) => i.canvas), stitchDir, stitchGap)
                setPreview(stitched.toDataURL('image/png'))
                void exportCanvas(stitched, `stitch-${Date.now()}.png`, 'image/png')
              }}
            >
              拼接 {images.length} 张并导出
            </Button>
            <Text type="secondary">按上方标签顺序拼接；已选中的会排到第一位。</Text>
            <Divider style={{ margin: '8px 0' }} />
            <Flex vertical gap={4}>
              <Text strong>会话内文件</Text>
              {images.map((im, i) => (
                <Flex key={`${im.name}-list-${i}`} justify="space-between">
                  <Text ellipsis style={{ maxWidth: 220 }}>{im.name}</Text>
                  <Text type="secondary">{im.canvas.width}×{im.canvas.height}</Text>
                </Flex>
              ))}
            </Flex>
          </Space>
        </Card>
      </Col>
    </Row>
  )
}

// ── 主页面 ────────────────────────────────────────────────────────
export default function Toolbox() {
  const items = [
    {
      key: 'dev',
      label: (
        <span>
          <ToolOutlined /> 开发者
        </span>
      ),
      children: <DevSection />
    },
    {
      key: 'calc',
      label: (
        <span>
          <CalculatorOutlined /> 计算器
        </span>
      ),
      children: <CalcSection />
    },
    {
      key: 'creative',
      label: (
        <span>
          <BgColorsOutlined /> 创意
        </span>
      ),
      children: <CreativeSection />
    },
    {
      key: 'image',
      label: (
        <span>
          <FileImageOutlined /> 图像
        </span>
      ),
      children: <ImageSection />
    }
  ]

  return (
    <div style={{ padding: 16 }}>
      <Flex align="center" justify="space-between" style={{ marginBottom: 12 }} wrap gap={8}>
        <div>
          <Title level={4} style={{ margin: 0 }}>
            工具箱
          </Title>
          <Text type="secondary">
            对标 ToolKnit 开发者 / 计算器 / 创意 / 图像能力 · 全部本地计算，不上传文件
          </Text>
        </div>
        <Button
          icon={<DownloadOutlined />}
          onClick={() =>
            downloadText(
              [
                '# 灵墨工作台 · 工具箱',
                '',
                '- 开发者：UUID / JWT / Hash & HMAC / 密码生成',
                '- 计算器：时间戳 / 房贷 / 利息 / 体脂 BMI',
                '- 创意：颜色空间 / 配色提取 / 打字测试',
                '- 图像：裁剪 / 压缩 / 转换 / 图标 / 长图拼接'
              ].join('\n'),
              '工具箱说明.md',
              'text/markdown'
            )
          }
        >
          导出说明
        </Button>
      </Flex>
      <Tabs defaultActiveKey="dev" items={items} />
    </div>
  )
}
