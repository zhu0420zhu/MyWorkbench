import { useMemo, useState } from 'react'
import {
  Button,
  Checkbox,
  Input,
  Segmented,
  Select,
  Switch,
  Typography,
  Tooltip,
  message,
  Empty
} from 'antd'
import {
  ClearOutlined, CloseOutlined,
  CopyOutlined,
  FileImageOutlined,
  HighlightOutlined,
  SaveOutlined, DownloadOutlined,
  ScanOutlined,
  SwapOutlined,
  ToolOutlined
} from '@ant-design/icons'
import { useNav } from '../nav'
import {
  addLineNumbers,
  base64Decode,
  base64Encode,
  changeCase,
  countDuplicates,
  countStats,
  dedupeLines,
  firstLetterPinyin,
  diffLines,
  escapeHtml,
  formatJson,
  highlightKeywords,
  regexReplace,
  removeEmptyLines,
  reverseChars,
  reverseLines,
  sortLines,
  trimLines,
  unwrapQuotes,
  urlDecode,
  urlEncode,
  wrapQuotes,
  addSymbols,
  addQuotesAndSymbols,
  SYMBOL_PRESETS_EN,
  SYMBOL_PRESETS_ZH,
  type QuoteChar
} from '../utils/textTools'
import { recognizeImage } from '../utils/ppocr'
import type { OcrImageInfo } from '@shared/types'

type Mode = 'tools' | 'highlight' | 'diff' | 'ocr'

export default function TextTools() {
  const { navigate } = useNav()
  const [mode, setMode] = useState<Mode>('tools')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [keywords, setKeywords] = useState('')
  const [inputA, setInputA] = useState('')
  const [inputB, setInputB] = useState('')

  // 工具选项
  const [dedupeIgnoreCase, setDedupeIgnoreCase] = useState(false)
  const [dedupeKeepLast, setDedupeKeepLast] = useState(false)
  const [countOnlyDuplicated, setCountOnlyDuplicated] = useState(false)
  const [sortDesc, setSortDesc] = useState(false)
  const [quoteType, setQuoteType] = useState<QuoteChar>('"')
  const [quoteEscape, setQuoteEscape] = useState(false)
  const [jsonCompact, setJsonCompact] = useState(false)
  const [regexPattern, setRegexPattern] = useState('')
  const [regexFlags, setRegexFlags] = useState('g')
  const [regexReplacement, setRegexReplacement] = useState('')

  // 符号添加选项
  const [symbolMode, setSymbolMode] = useState<'en' | 'zh'>('en')
  const [symbolSelected, setSymbolSelected] = useState<string[]>([])
  const [customSymbols, setCustomSymbols] = useState('')
  const [symbolPosition, setSymbolPosition] = useState<'before' | 'after' | 'both'>('after')
  const [symbolQuote, setSymbolQuote] = useState<QuoteChar | ''>('')

  // 翻译
  const [srcLang, setSrcLang] = useState('zh-CN')
  const [tgtLang, setTgtLang] = useState('en')
  const [translating, setTranslating] = useState(false)

  // OCR 状态
  const [ocrImages, setOcrImages] = useState<OcrImageInfo[]>([])
  const [ocrLoading, setOcrLoading] = useState(false)
  const [ocrStatus, setOcrStatus] = useState('')

  const stats = useMemo(() => countStats(output), [output])
  const highlighted = useMemo(
    () => highlightKeywords(input, keywords.split(',').map((k) => k.trim())),
    [input, keywords]
  )
  const diffResult = useMemo(() => diffLines(inputA, inputB), [inputA, inputB])

  const apply = (fn: (s: string) => string): void => {
    setOutput(fn(input))
  }

  const applyChecked = (fn: () => { ok: boolean; value?: string; error?: string }): void => {
    const r = fn()
    if (r.ok && r.value !== undefined) setOutput(r.value)
    else message.error(r.error ?? '处理失败')
  }

  /* ---- 符号添加 ---- */
  const handleQuoteWithSymbols = (): void => {
    const custom = customSymbols
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
    const list = [...symbolSelected, ...custom]
    if (list.length > 0) {
      // 符号添加组有符号 → 引号 + 符号联合添加
      setOutput(
        addQuotesAndSymbols(input, {
          quote: quoteType,
          symbols: list,
          position: symbolPosition,
          combine: 'all'
        })
      )
      message.success('已联合添加引号 + ' + list.length + ' 个符号')
    } else {
      // 无符号 → 仅加引号
      setOutput(wrapQuotes(input, quoteType, quoteEscape))
    }
  }

  const applySymbols = (): void => {
    const custom = customSymbols
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
    const list = [...symbolSelected, ...custom]
    if (list.length === 0 && !symbolQuote) {
      message.warning('请先选择/输入至少一个符号，或勾选引号')
      return
    }
    if (symbolQuote) {
      setOutput(
        addQuotesAndSymbols(input, {
          quote: symbolQuote,
          symbols: list,
          position: symbolPosition,
          combine: 'all'
        })
      )
    } else {
      setOutput(addSymbols(input, { symbols: list, position: symbolPosition, combine: 'all' }))
    }
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(output)
      message.success('已复制')
    } catch {
      message.error('复制失败')
    }
  }

  /* ---- OCR ---- */
  const handleTranslate = async (): Promise<void> => {
    if (!input.trim() || translating) return
    setTranslating(true)
    try {
      const res = await window.api.translate.run(input, srcLang, tgtLang)
      if (res.ok && res.value !== undefined) {
        setOutput(res.value)
        message.success('翻译完成')
      } else {
        message.error(res.error ?? '翻译失败')
      }
    } catch (err) {
      message.error('翻译失败：' + (err as Error).message)
    } finally {
      setTranslating(false)
    }
  }

  const handleOcrPick = async (): Promise<void> => {
    try {
      const infos = await window.api.ocr.pickImages()
      if (infos.length > 0) {
        setOcrImages((prev) => [...prev, ...infos])
        setOcrStatus('')
      }
    } catch {
      message.error('选择图片失败')
    }
  }

  const handleOcrDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    const files = e.dataTransfer.files
    if (!files || files.length === 0) return
    const imgs = Array.from(files).filter((f) => /^image\//.test(f.type))
    if (imgs.length === 0) {
      message.warning('请拖入图片文件')
      return
    }
    const pending: OcrImageInfo[] = []
    let done = 0
    imgs.forEach((file) => {
      const reader = new FileReader()
      reader.onload = () => {
        pending.push({ dataUrl: String(reader.result), name: file.name, size: file.size })
        done++
        if (done === imgs.length) {
          setOcrImages((prev) => [...prev, ...pending])
          setOcrStatus('')
        }
      }
      reader.readAsDataURL(file)
    })
  }

  const handleOcrRun = async (): Promise<void> => {
    if (ocrImages.length === 0 || ocrLoading) return
    setOcrLoading(true)
    setOcrStatus('')
    try {
      const parts: string[] = []
      for (let i = 0; i < ocrImages.length; i++) {
        const img = ocrImages[i]
        setOcrStatus('第 ' + (i + 1) + '/' + ocrImages.length + ' 张：' + img.name + '（加载模型…）')
        const lines = await recognizeImage(img.dataUrl, (stage) =>
          setOcrStatus('第 ' + (i + 1) + '/' + ocrImages.length + ' 张 ' + img.name + '：' + stage)
        )
        if (lines.length > 0) {
          parts.push('===== ' + img.name + ' =====\n' + lines.map((l) => l.text).join('\n'))
        } else {
          parts.push('===== ' + img.name + ' =====\n（未识别到文字）')
        }
      }
      const text = parts.join('\n\n')
      setOutput(text)
      setOcrStatus('批量识别完成：' + ocrImages.length + ' 张（已同步到输出区）')
    } catch (err) {
      message.error('识别失败：' + (err as Error).message)
      setOcrStatus('识别失败')
    } finally {
      setOcrLoading(false)
    }
  }

  const handleOcrSaveNote = async (): Promise<void> => {
    const text = output.trim()
    if (!text) {
      message.warning('没有可保存的内容')
      return
    }
    try {
      const firstLine = text.split('\n')[0].slice(0, 30)
      const list = await window.api.notes.create(firstLine || 'OCR 识别')
      await window.api.notes.update(list[0].id, text)
      message.success('已存入知识库')
      navigate({ page: 'notes', id: list[0].id })
    } catch {
      message.error('保存笔记失败')
    }
  }

  return (
    <div className="texttools-page">
      <div className="page-header">
        <Typography.Title level={4} style={{ margin: 0 }}>
          文本工具
        </Typography.Title>
        <Segmented
          value={mode}
          onChange={(v) => setMode(v as Mode)}
          options={[
            { label: '处理工具', value: 'tools', icon: <ToolOutlined /> },
            { label: '关键词高亮', value: 'highlight', icon: <HighlightOutlined /> },
            { label: '差异对比', value: 'diff', icon: <SwapOutlined /> },
            { label: 'OCR 识别', value: 'ocr', icon: <ScanOutlined /> }
          ]}
        />
      </div>

      {mode === 'tools' && (
        <>
          <div className="texttools-tools">
            <div className="tool-group">
              <span className="tool-group-label">行处理</span>
              <Button size="small" onClick={() => apply((s) => dedupeLines(s, { ignoreCase: dedupeIgnoreCase, keepLast: dedupeKeepLast }))}>
                去重行
              </Button>
              <Tooltip title="输出 次数\t行内容，按次数降序">
                <Button size="small" onClick={() => apply((s) => countDuplicates(s, dedupeIgnoreCase, countOnlyDuplicated))}>
                  重复统计
                </Button>
              </Tooltip>
              <Tooltip title="勾选后只输出出现次数 > 1 的行">
                <Switch size="small" checked={countOnlyDuplicated} onChange={setCountOnlyDuplicated} checkedChildren="仅重复>1" unCheckedChildren="全部" />
              </Tooltip>
              <Button size="small" onClick={() => apply((s) => sortLines(s, { desc: sortDesc }))}>
                排序
              </Button>
              <Button size="small" onClick={() => apply(reverseLines)}>
                反转行
              </Button>
              <Button size="small" onClick={() => apply((s) => removeEmptyLines(s))}>
                去空行
              </Button>
              <Button size="small" onClick={() => apply((s) => trimLines(s))}>
                去首尾空白
              </Button>
              <Button size="small" onClick={() => apply((s) => addLineNumbers(s))}>
                加行号
              </Button>
            </div>
            <div className="tool-group">
              <span className="tool-group-label">转换</span>
              <Button size="small" onClick={() => apply((s) => changeCase(s, 'upper'))}>
                大写
              </Button>
              <Button size="small" onClick={() => apply((s) => changeCase(s, 'lower'))}>
                小写
              </Button>
              <Button size="small" onClick={() => apply((s) => changeCase(s, 'title'))}>
                首字母大写
              </Button>
              <Button size="small" onClick={() => apply(reverseChars)}>
                反转字符
              </Button>
              <Tooltip title="提取中文段落每个汉字拼音首字母（如「灵墨工作台」→ l m g z t）">
                <Button size="small" onClick={() => apply(firstLetterPinyin)}>
                  首字母拼音
                </Button>
              </Tooltip>
            </div>
            <div className="tool-group">
              <span className="tool-group-label">引号</span>
              <Select
                size="small"
                value={quoteType}
                aria-label="引号类型"
                onChange={(v) => setQuoteType(v as QuoteChar)}
                style={{ width: 64 }}
                options={[
                  { label: '"双', value: '"' },
                  { label: "'单", value: "'" },
                  { label: '`反', value: '`' }
                ]}
              />
              <Switch size="small" checked={quoteEscape} onChange={setQuoteEscape} checkedChildren="转义" unCheckedChildren="不转义" />
              <Button
                size="small"
                onClick={handleQuoteWithSymbols}
                title={symbolSelected.length + customSymbols.trim().split(/\s+/).filter(Boolean).length > 0 ? '引号 + 符号添加联合使用（符号列表见下方符号添加组）' : '每行加引号'}
              >
                每行加引号
              </Button>
              <Button size="small" onClick={() => apply(unwrapQuotes)}>
                去引号
              </Button>
            </div>
            <div className="tool-group">
              <span className="tool-group-label">编解码</span>
              <Button size="small" onClick={() => apply(base64Encode)}>
                Base64 编码
              </Button>
              <Button size="small" onClick={() => apply(base64Decode)}>
                Base64 解码
              </Button>
              <Button size="small" onClick={() => apply(urlEncode)}>
                URL 编码
              </Button>
              <Button size="small" onClick={() => apply(urlDecode)}>
                URL 解码
              </Button>
              <Switch size="small" checked={jsonCompact} onChange={setJsonCompact} checkedChildren="压缩" unCheckedChildren="美化" />
              <Button size="small" onClick={() => applyChecked(() => formatJson(input, jsonCompact))}>
                JSON 格式化
              </Button>
            </div>
            <div className="tool-group">
              <span className="tool-group-label">正则替换</span>
              <Input
                size="small"
                placeholder="pattern"
                aria-label="正则 pattern"
                value={regexPattern}
                onChange={(e) => setRegexPattern(e.target.value)}
                style={{ width: 140 }}
              />
              <Input
                size="small"
                placeholder="flags (gim)"
                aria-label="正则 flags"
                value={regexFlags}
                onChange={(e) => setRegexFlags(e.target.value)}
                style={{ width: 90 }}
              />
              <Input
                size="small"
                placeholder="replacement"
                aria-label="正则替换文本"
                value={regexReplacement}
                onChange={(e) => setRegexReplacement(e.target.value)}
                style={{ width: 140 }}
              />
              <Button
                size="small"
                type="primary"
                disabled={!regexPattern}
                onClick={() =>
                  applyChecked(() => regexReplace(input, regexPattern, regexFlags, regexReplacement))
                }
              >
                替换
              </Button>
            </div>
            <div className="tool-group">
              <span className="tool-group-label">翻译</span>
              <Select
                size="small"
                value={srcLang}
                aria-label="翻译源语言"
                onChange={setSrcLang}
                style={{ width: 96 }}
                options={[
                  { label: '中文', value: 'zh-CN' },
                  { label: '英文', value: 'en' },
                  { label: '日文', value: 'ja' },
                  { label: '韩文', value: 'ko' },
                  { label: '法文', value: 'fr' },
                  { label: '德文', value: 'de' },
                  { label: '俄文', value: 'ru' },
                  { label: '西文', value: 'es' }
                ]}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                →
              </Typography.Text>
              <Select
                size="small"
                value={tgtLang}
                aria-label="翻译目标语言"
                onChange={setTgtLang}
                style={{ width: 96 }}
                options={[
                  { label: '中文', value: 'zh-CN' },
                  { label: '英文', value: 'en' },
                  { label: '日文', value: 'ja' },
                  { label: '韩文', value: 'ko' },
                  { label: '法文', value: 'fr' },
                  { label: '德文', value: 'de' },
                  { label: '俄文', value: 'ru' },
                  { label: '西文', value: 'es' }
                ]}
              />
              <Button size="small" type="primary" loading={translating} onClick={handleTranslate}>
                翻译
              </Button>
            </div>
            <div className="tool-group">
              <span className="tool-group-label">符号添加</span>
              <Segmented
                size="small"
                value={symbolMode}
                onChange={(v) => {
                  setSymbolMode(v as 'en' | 'zh')
                  setSymbolSelected([])
                }}
                options={[
                  { label: '英文', value: 'en' },
                  { label: '中文', value: 'zh' }
                ]}
              />
              <Select
                size="small"
                value={symbolQuote}
                aria-label="符号引号"
                onChange={(v) => setSymbolQuote(v as QuoteChar | '')}
                style={{ width: 78 }}
                options={[
                  { label: '引号', value: '' },
                  { label: '"双', value: '"' },
                  { label: "'单", value: "'" },
                  { label: '`反', value: '`' }
                ]}
              />
              <Checkbox.Group
                options={symbolMode === 'en' ? SYMBOL_PRESETS_EN : SYMBOL_PRESETS_ZH}
                value={symbolSelected}
                onChange={(vals) => setSymbolSelected(vals as string[])}
              />
              <Input
                size="small"
                placeholder="自定义符号（空格分隔，如 @ #）"
                aria-label="自定义符号"
                value={customSymbols}
                onChange={(e) => setCustomSymbols(e.target.value)}
                style={{ width: 190 }}
              />
              <Select
                size="small"
                value={symbolPosition}
                aria-label="符号位置"
                onChange={(v) => setSymbolPosition(v as 'before' | 'after' | 'both')}
                style={{ width: 72 }}
                options={[
                  { label: '行尾', value: 'after' },
                  { label: '行首', value: 'before' },
                  { label: '首尾', value: 'both' }
                ]}
              />
              <Tooltip title="每行添加全部所选符号（行数不变）">
                <Button size="small" type="primary" onClick={applySymbols}>
                  添加符号
                </Button>
              </Tooltip>
            </div>
            <div className="tool-group">
              <span className="tool-group-label">去重选项</span>
              <Switch size="small" checked={dedupeIgnoreCase} onChange={setDedupeIgnoreCase} checkedChildren="忽略大小写" unCheckedChildren="区分大小写" />
              <Switch size="small" checked={dedupeKeepLast} onChange={setDedupeKeepLast} checkedChildren="保留末次" unCheckedChildren="保留首次" />
              <Switch size="small" checked={sortDesc} onChange={setSortDesc} checkedChildren="降序" unCheckedChildren="升序" />
            </div>
          </div>

          <div className="texttools-work">
            <div className="texttools-pane">
              <div className="texttools-pane-header">
                <Typography.Text strong>输入</Typography.Text>
                <Button size="small" type="text" icon={<ClearOutlined />} onClick={() => setInput('')} title="清空" />
              </div>
              <textarea
                className="texttools-textarea"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="粘贴文本，点上方工具处理（按行操作）"
              />
            </div>
            <div className="texttools-pane">
              <div className="texttools-pane-header">
                <Typography.Text strong>输出</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {stats.lines} 行 · {stats.chars} 字符 · {stats.words} 词
                </Typography.Text>
                <Button size="small" type="text" icon={<CopyOutlined />} onClick={copy} disabled={!output} title="复制" />
                <Button
                  size="small"
                  type="text"
                  icon={<DownloadOutlined />}
                  disabled={!output}
                  title="导出"
                  onClick={async () => {
                    try {
                      const saved = await window.api.exportText('输出.txt', output)
                      if (saved) message.success('已导出：' + saved)
                    } catch {
                      message.error('导出失败')
                    }
                  }}
                />
                <Button size="small" type="text" icon={<ClearOutlined />} onClick={() => setOutput('')} disabled={!output} title="清空" />
              </div>
              <pre className="texttools-output">{output || '（输出区）'}</pre>
            </div>
          </div>
        </>
      )}

      {mode === 'highlight' && (
        <div className="texttools-single">
          <div className="texttools-option-row">
            <Typography.Text strong>关键词</Typography.Text>
            <Input
              placeholder="多个关键词用逗号分隔，例如：error, warning"
              aria-label="关键词"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              style={{ maxWidth: 420 }}
              allowClear
            />
          </div>
          <textarea
            className="texttools-textarea texttools-textarea-lg"
            aria-label="待高亮文本"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入文本，匹配的关键词会实时标黄"
          />
          <div className="texttools-pane-header" style={{ marginTop: 12 }}>
            <Typography.Text strong>高亮结果</Typography.Text>
          </div>
          <pre
            className="texttools-output texttools-output-lg"
            dangerouslySetInnerHTML={{ __html: highlighted || '<span style="opacity:.5">（结果区）</span>' }}
          />
        </div>
      )}

      {mode === 'diff' && (
        <div className="texttools-diff">
          <div className="texttools-diff-panes">
            <div className="texttools-pane">
              <div className="texttools-pane-header">
                <Typography.Text strong>文本 A（原）</Typography.Text>
              </div>
              <textarea
                className="texttools-textarea"
                value={inputA}
                onChange={(e) => setInputA(e.target.value)}
                placeholder="原始文本"
              />
            </div>
            <div className="texttools-pane">
              <div className="texttools-pane-header">
                <Typography.Text strong>文本 B（新）</Typography.Text>
              </div>
              <textarea
                className="texttools-textarea"
                value={inputB}
                onChange={(e) => setInputB(e.target.value)}
                placeholder="对比文本"
              />
            </div>
          </div>
          <div className="texttools-pane-header" style={{ marginTop: 12 }}>
            <Typography.Text strong>差异</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              绿 + 新增 · 红 - 删除 · 灰 = 相同
            </Typography.Text>
          </div>
          <pre className="texttools-output texttools-output-lg">
            {diffResult.length === 0 ? (
              '（结果区）'
            ) : (
              diffResult.map((l, i) => (
                <div
                  key={i}
                  className={'diff-line diff-' + l.type}
                  dangerouslySetInnerHTML={{
                    __html: `${l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' '} ${escapeHtml(l.text)}`
                  }}
                />
              ))
            )}
          </pre>
        </div>
      )}

      {mode === 'ocr' && (
        <div className="texttools-single">
          <div className="texttools-option-row">
            <Button icon={<FileImageOutlined />} onClick={handleOcrPick}>
              选择图片
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              或拖拽图片到下方区域（PNG / JPG / WebP）
            </Typography.Text>
          </div>

          <div
            className="ocr-dropzone"
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleOcrDrop}
          >
            {ocrImages.length > 0 ? (
              <div className="ocr-thumbs">
                {ocrImages.map((img, i) => (
                  <div key={i} className="ocr-thumb">
                    <img src={img.dataUrl} alt={img.name} className="ocr-thumb-img" />
                    <div className="ocr-thumb-name">{img.name}</div>
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<CloseOutlined />}
                      className="ocr-thumb-remove"
                      onClick={() => setOcrImages((prev) => prev.filter((_, j) => j !== i))}
                      title="移除"
                    />
                  </div>
                ))}
              </div>
            ) : (
              <Empty description="拖拽图片到这里（可多张），或点击「选择图片」" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: 24 }} />
            )}
          </div>

          <div className="texttools-option-row" style={{ marginTop: 12 }}>
            <Button
              type="primary"
              icon={<ScanOutlined />}
              onClick={handleOcrRun}
              disabled={ocrImages.length === 0 || ocrLoading}
              loading={ocrLoading}
            >
              {ocrLoading ? ocrStatus || '识别中…' : '批量识别' + (ocrImages.length > 0 ? '（' + ocrImages.length + ' 张）' : '')}
            </Button>
            <Button icon={<SaveOutlined />} onClick={handleOcrSaveNote} disabled={!output.trim()}>
              存为笔记
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              中文 PP-OCRv4 模型，本地 WASM 识别，离线可用
            </Typography.Text>
          </div>

          {ocrStatus && (
            <Typography.Text type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
              {ocrStatus}
            </Typography.Text>
          )}

          <div className="texttools-pane-header" style={{ marginTop: 12 }}>
            <Typography.Text strong>识别结果</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {stats.lines} 行 · {stats.chars} 字符（已同步到输出区，可继续用上方处理工具）
            </Typography.Text>
            <Button size="small" type="text" icon={<CopyOutlined />} onClick={copy} disabled={!output} title="复制" />
          </div>
          <textarea
            className="texttools-textarea texttools-textarea-lg"
            value={output}
            onChange={(e) => setOutput(e.target.value)}
            placeholder="识别结果将显示在这里"
          />
        </div>
      )}
    </div>
  )
}

