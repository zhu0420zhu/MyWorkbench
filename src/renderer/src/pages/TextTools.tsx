/**
 * 文本工具 · 统一工作台
 *
 * 一个「输入 → 处理 → 输出」工作区，全部能力经顶部 Word 工具条式菜单平铺访问：
 * - 第一行：8 个批处理分类 + 分析与识别 + 独立工具（可见按钮，自动换行，无下拉）
 * - 第二行：当前分类下的功能按钮 + 参数 + 执行 + 全局操作
 * - 文本处理 8 类 38 个批处理工具（行处理/转换/清理/排版/编码/增强/替换/翻译）
 * - 分析与识别：关键词高亮 / 差异对比 / OCR 图片识别（专属工作区，输入输出互通）
 * - 独立工具：Markdown 编辑器 / 音视频提取文字 / 提词器 / 文本统计器 / 文本格式化
 *
 * 交互约定：菜单选中功能 → 工具条展示该功能参数 → 执行；结果在输出区，
 * 「输出 → 输入」或流转按钮可继续加工，避免功能重复与冲突。
 */
import { useMemo, useState } from 'react'
import { Button, Card, Checkbox, Empty, Input, Select, Switch, Tag, Typography, message } from 'antd'
import {
  ClearOutlined,
  CloseOutlined,
  CopyOutlined,
  DownloadOutlined,
  FileImageOutlined,
  SaveOutlined,
  ScanOutlined,
  ToolOutlined
} from '@ant-design/icons'
import { useNav } from '../nav'
import { FormatPanel, MarkdownPanel, SpeechPanel, StatsPanel, TeleprompterPanel } from './TextCatalog'
import {
  addLineNumbers,
  addPrefixSuffix,
  addQuotesAndSymbols,
  addSymbols,
  base64Decode,
  base64Encode,
  changeCase,
  countDuplicates,
  countStats,
  countStatsDetail,
  dedupeLines,
  diffLines,
  escapeHtml,
  firstLetterPinyin,
  formatJson,
  highlightKeywords,
  htmlToText,
  mergeBlankParagraphs,
  multiReplace,
  paragraphsToLines,
  regexReplace,
  removeEmptyLines,
  removePunctuation,
  reverseChars,
  reverseLines,
  slugify,
  sortLines,
  stripMarkdown,
  SYMBOL_PRESETS_EN,
  SYMBOL_PRESETS_ZH,
  toFullWidth,
  toHalfWidth,
  trimLines,
  unwrapQuotes,
  urlDecode,
  urlEncode,
  wordFrequency,
  wrapQuotes,
  type QuoteChar
} from '../utils/textTools'
import { recognizeImage } from '../utils/ppocr'
import type { OcrImageInfo } from '@shared/types'

type ToolCat = 'lines' | 'transform' | 'clean' | 'encode' | 'format' | 'enhance' | 'translate' | 'regex'
/** 工具条第一级：8 个批处理分类 + 分析与识别 + 独立工具（Word 工具条式平铺，不用下拉） */
type CatView = ToolCat | 'analysis' | 'panels'

const TOOL_CATS: Array<{ key: ToolCat; label: string; desc: string }> = [
  { key: 'lines', label: '行处理', desc: '去重 / 排序 / 空行 / 行号' },
  { key: 'transform', label: '转换', desc: '大小写 / 全半角 / 拼音' },
  { key: 'clean', label: '清理', desc: '去标点 / HTML / Markdown' },
  { key: 'format', label: '排版', desc: '段落 / 引号 / 行前缀' },
  { key: 'encode', label: '编码', desc: 'Base64 / URL / JSON' },
  { key: 'enhance', label: '增强', desc: '词频 / 统计 / slug' },
  { key: 'regex', label: '替换', desc: '正则 / 批量规则' },
  { key: 'translate', label: '翻译', desc: '多语言互译' }
]

/** 批处理工具注册表：key 全局唯一；cat 决定菜单分组与工具条参数区 */
const PROC_TOOLS: Array<{ key: string; label: string; cat: ToolCat }> = [
  { key: 'dedupe', label: '去重行', cat: 'lines' },
  { key: 'dupstats', label: '重复统计', cat: 'lines' },
  { key: 'sort', label: '排序', cat: 'lines' },
  { key: 'revlines', label: '反转行', cat: 'lines' },
  { key: 'rmempty', label: '去空行', cat: 'lines' },
  { key: 'trim', label: '去首尾空白', cat: 'lines' },
  { key: 'linenum', label: '加行号', cat: 'lines' },
  { key: 'toline', label: '合并为一行', cat: 'lines' },
  { key: 'mergepara', label: '段落整理', cat: 'lines' },
  { key: 'upper', label: '英文大写', cat: 'transform' },
  { key: 'lower', label: '英文小写', cat: 'transform' },
  { key: 'titlecase', label: '首字母大写', cat: 'transform' },
  { key: 'revchars', label: '反转字符', cat: 'transform' },
  { key: 'half', label: '全角→半角', cat: 'transform' },
  { key: 'full', label: '半角→全角', cat: 'transform' },
  { key: 'pinyin', label: '首字母拼音', cat: 'transform' },
  { key: 'nopunct', label: '去中英标点', cat: 'clean' },
  { key: 'html2text', label: 'HTML→文本', cat: 'clean' },
  { key: 'stripmd', label: '去 Markdown', cat: 'clean' },
  { key: 'trailsp', label: '去行尾空格', cat: 'clean' },
  { key: 'lf', label: '统一换行 LF', cat: 'clean' },
  { key: 'quote', label: '加引号', cat: 'format' },
  { key: 'unquote', label: '去引号', cat: 'format' },
  { key: 'affix', label: '加前后缀', cat: 'format' },
  { key: 'symbols', label: '批量加符号', cat: 'format' },
  { key: 'b64enc', label: 'Base64 编码', cat: 'encode' },
  { key: 'b64dec', label: 'Base64 解码', cat: 'encode' },
  { key: 'urlenc', label: 'URL 编码', cat: 'encode' },
  { key: 'urldec', label: 'URL 解码', cat: 'encode' },
  { key: 'jsonfmt', label: 'JSON 格式化', cat: 'encode' },
  { key: 'jsonmin', label: 'JSON 压缩', cat: 'encode' },
  { key: 'htmlesc', label: 'HTML 转义', cat: 'encode' },
  { key: 'freq', label: '词频 Top50', cat: 'enhance' },
  { key: 'slug', label: '生成 slug', cat: 'enhance' },
  { key: 'statdetail', label: '详细统计', cat: 'enhance' },
  { key: 'rereplace', label: '正则替换', cat: 'regex' },
  { key: 'multireplace', label: '批量替换', cat: 'regex' },
  { key: 'translate', label: '多语言翻译', cat: 'translate' }
]

/** 特殊功能：非「输入→输出」批处理，各自有专属工作区 */
const SPECIAL_TOOLS: Array<{ key: string; label: string; group: string }> = [
  { key: 'highlight', label: '关键词高亮', group: '分析与识别' },
  { key: 'diff', label: '差异对比', group: '分析与识别' },
  { key: 'ocr', label: 'OCR 图片识别', group: '分析与识别' },
  { key: 'markdown', label: 'Markdown 编辑器', group: '独立工具' },
  { key: 'speech', label: '音视频提取文字', group: '独立工具' },
  { key: 'teleprompter', label: '提词器', group: '独立工具' },
  { key: 'stats', label: '文本统计器', group: '独立工具' },
  { key: 'fmt-tool', label: '文本格式化', group: '独立工具' }
]

const PANEL_META: Record<string, { title: string }> = {
  markdown: { title: 'Markdown 文档编辑器' },
  speech: { title: '音视频提取文字' },
  teleprompter: { title: '提词器' },
  stats: { title: '文本统计器' },
  'fmt-tool': { title: '文本格式化' }
}

export default function TextTools() {
  const { navigate } = useNav()
  const [active, setActive] = useState<string>('dedupe')
  /** 工具条第一级分类视图（Word 工具条式平铺） */
  const [catView, setCatView] = useState<CatView>('lines')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [keywords, setKeywords] = useState('')
  const [inputA, setInputA] = useState('')
  const [inputB, setInputB] = useState('')
  const [replaceRules, setReplaceRules] = useState('')
  const [fixPrefix, setFixPrefix] = useState('')
  const [fixSuffix, setFixSuffix] = useState('')
  const [pinyinSep, setPinyinSep] = useState<' ' | '' | '\n'>(' ')

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
  const [symbolMode, setSymbolMode] = useState<'en' | 'zh'>('en')
  const [symbolSelected, setSymbolSelected] = useState<string[]>([])
  const [customSymbols, setCustomSymbols] = useState('')
  const [symbolPosition, setSymbolPosition] = useState<'before' | 'after' | 'both'>('after')
  const [symbolQuote, setSymbolQuote] = useState<QuoteChar | ''>('')
  const [srcLang, setSrcLang] = useState('zh-CN')
  const [tgtLang, setTgtLang] = useState('en')
  const [translating, setTranslating] = useState(false)
  const [ocrImages, setOcrImages] = useState<OcrImageInfo[]>([])
  const [ocrLoading, setOcrLoading] = useState(false)
  const [ocrStatus, setOcrStatus] = useState('')

  const activeProc = useMemo(() => PROC_TOOLS.find((t) => t.key === active), [active])
  const activeSpecial = useMemo(() => SPECIAL_TOOLS.find((t) => t.key === active), [active])

  const stats = useMemo(() => countStats(output), [output])
  const statsIn = useMemo(() => countStatsDetail(input), [input])
  const highlighted = useMemo(
    () => highlightKeywords(input, keywords.split(',').map((k) => k.trim())),
    [input, keywords]
  )
  const diffResult = useMemo(() => diffLines(inputA, inputB), [inputA, inputB])

  const apply = (fn: (s: string) => string): void => {
    setOutput(fn(input))
  }
  const applyChecked = (fn: () => { ok: boolean; value?: string; error?: string } | string): void => {
    const r = fn()
    if (typeof r === 'string') setOutput(r)
    else if (r.ok && r.value !== undefined) setOutput(r.value)
    else message.error(r.error ?? '处理失败')
  }

  const applySymbols = (): void => {
    const custom = customSymbols.split(/\s+/).map((s) => s.trim()).filter(Boolean)
    const list = [...symbolSelected, ...custom]
    if (list.length === 0 && !symbolQuote) {
      message.warning('请先选择/输入至少一个符号')
      return
    }
    if (symbolQuote) {
      setOutput(addQuotesAndSymbols(input, { quote: symbolQuote, symbols: list, position: symbolPosition, combine: 'all' }))
    } else {
      setOutput(addSymbols(input, { symbols: list, position: symbolPosition, combine: 'all' }))
    }
  }

  const runTranslate = async (): Promise<void> => {
    if (!input.trim()) {
      message.warning('请先输入文本')
      return
    }
    setTranslating(true)
    try {
      const r = await window.api.translate.run(input, srcLang, tgtLang)
      if (r.ok && r.value) setOutput(r.value)
      else message.error(r.error || '翻译失败')
    } finally {
      setTranslating(false)
    }
  }

  /** 批处理执行分发：菜单选中 → 执行 */
  const runProc = (key: string): void => {
    switch (key) {
      case 'dedupe':
        apply((s) => dedupeLines(s, { ignoreCase: dedupeIgnoreCase, keepLast: dedupeKeepLast }))
        break
      case 'dupstats':
        apply((s) => countDuplicates(s, dedupeIgnoreCase, countOnlyDuplicated))
        break
      case 'sort':
        apply((s) => sortLines(s, { desc: sortDesc }))
        break
      case 'revlines':
        apply(reverseLines)
        break
      case 'rmempty':
        apply((s) => removeEmptyLines(s))
        break
      case 'trim':
        apply((s) => trimLines(s))
        break
      case 'linenum':
        apply((s) => addLineNumbers(s))
        break
      case 'toline':
        apply(paragraphsToLines)
        break
      case 'mergepara':
        apply(mergeBlankParagraphs)
        break
      case 'upper':
        apply((s) => changeCase(s, 'upper'))
        break
      case 'lower':
        apply((s) => changeCase(s, 'lower'))
        break
      case 'titlecase':
        apply((s) => changeCase(s, 'title'))
        break
      case 'revchars':
        apply(reverseChars)
        break
      case 'half':
        apply(toHalfWidth)
        break
      case 'full':
        apply(toFullWidth)
        break
      case 'pinyin':
        apply((s) => s.split(pinyinSep).map(firstLetterPinyin).join(pinyinSep))
        break
      case 'nopunct':
        apply((s) => removePunctuation(s))
        break
      case 'html2text':
        apply(htmlToText)
        break
      case 'stripmd':
        apply(stripMarkdown)
        break
      case 'trailsp':
        apply((s) => s.replace(/[ \t]+$/gm, ''))
        break
      case 'lf':
        apply((s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n'))
        break
      case 'quote':
        apply((s) => wrapQuotes(s, quoteType, quoteEscape))
        break
      case 'unquote':
        apply(unwrapQuotes)
        break
      case 'affix':
        apply((s) => addPrefixSuffix(s, fixPrefix, fixSuffix))
        break
      case 'symbols':
        applySymbols()
        break
      case 'b64enc':
        apply(base64Encode)
        break
      case 'b64dec':
        apply(base64Decode)
        break
      case 'urlenc':
        apply(urlEncode)
        break
      case 'urldec':
        apply(urlDecode)
        break
      case 'jsonfmt':
        applyChecked(() => formatJson(input, jsonCompact))
        break
      case 'jsonmin':
        applyChecked(() => formatJson(input, true))
        break
      case 'htmlesc':
        apply(escapeHtml)
        break
      case 'freq':
        apply((s) => wordFrequency(s, 50))
        break
      case 'slug':
        apply(slugify)
        break
      case 'statdetail': {
        const d = countStatsDetail(input)
        setOutput(
          [
            `行数：${d.lines}`,
            `字符数：${d.chars}`,
            `去空白字符：${d.charsNoSpace}`,
            `英文单词：${d.words}`,
            `汉字：${d.chinese}`,
            `英文词：${d.english}`,
            `数字串：${d.numbers}`
          ].join('\n')
        )
        break
      }
      case 'rereplace':
        applyChecked(() => regexReplace(input, regexPattern, regexReplacement, regexFlags))
        break
      case 'multireplace':
        apply((s) => multiReplace(s, replaceRules))
        break
      case 'translate':
        void runTranslate()
        break
      default:
        break
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

  const openFile = async (): Promise<void> => {
    try {
      const r = await window.api.pickTextFile()
      if (r?.content) setInput(r.content)
    } catch {
      message.error('打开文件失败')
    }
  }

  const handleOcrPick = async (): Promise<void> => {
    try {
      const imgs = await window.api.ocr.pickImages()
      if (imgs?.length) setOcrImages((prev) => [...prev, ...imgs])
    } catch {
      /* ignore */
    }
  }

  const handleOcrDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    const files = e.dataTransfer.files
    if (!files || files.length === 0) return
    const imgs = Array.from(files).filter((f) => f.type.startsWith('image/'))
    const pending: OcrImageInfo[] = []
    let done = 0
    imgs.forEach((file) => {
      const reader = new FileReader()
      reader.onload = () => {
        pending.push({ dataUrl: String(reader.result), name: file.name, size: file.size })
        done++
        if (done === imgs.length) setOcrImages((prev) => [...prev, ...pending])
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
        setOcrStatus(`第 ${i + 1}/${ocrImages.length} 张：${img.name}`)
        const lines = await recognizeImage(img.dataUrl, (stage) =>
          setOcrStatus(`第 ${i + 1}/${ocrImages.length} 张 ${img.name}：${stage}`)
        )
        parts.push(
          lines.length > 0
            ? `===== ${img.name} =====\n${lines.map((l) => l.text).join('\n')}`
            : `===== ${img.name} =====\n（未识别到文字）`
        )
      }
      const text = parts.join('\n\n')
      setOutput(text)
      setOcrStatus(`批量识别完成：${ocrImages.length} 张`)
    } catch (err) {
      message.error('识别失败：' + (err as Error).message)
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

  /** 切换分类视图：进入批处理分类时若无已选工具则自动选中该类第一个 */
  const switchCat = (c: CatView): void => {
    setCatView(c)
    if (c !== 'analysis' && c !== 'panels') {
      const still = PROC_TOOLS.find((t) => t.key === active && t.cat === c)
      if (!still) {
        const first = PROC_TOOLS.find((t) => t.cat === c)
        if (first) setActive(first.key)
      }
    }
  }

  /** 当前功能的参数区（批处理工具专属；特殊功能有自己的工作区） */
  const renderParams = (cat: ToolCat): React.ReactNode => {
    switch (cat) {
      case 'lines':
        return (
          <span className="tt-v2-opt">
            <Switch size="small" checked={dedupeIgnoreCase} onChange={setDedupeIgnoreCase} checkedChildren="忽略大小写" unCheckedChildren="区分大小写" />
            <Switch size="small" checked={dedupeKeepLast} onChange={setDedupeKeepLast} checkedChildren="保留末次" unCheckedChildren="保留首次" />
            <Switch size="small" checked={sortDesc} onChange={setSortDesc} checkedChildren="降序" unCheckedChildren="升序" />
            <Switch size="small" checked={countOnlyDuplicated} onChange={setCountOnlyDuplicated} checkedChildren="仅重复>1" unCheckedChildren="全部行" />
          </span>
        )
      case 'transform':
        return (
          <Select
            size="small"
            style={{ width: 96 }}
            value={pinyinSep}
            onChange={(v) => setPinyinSep(v)}
            options={[
              { label: '空格连接', value: ' ' as const },
              { label: '连写', value: '' as const },
              { label: '换行', value: '\n' as const }
            ]}
          />
        )
      case 'format':
        return (
          <>
            <Input size="small" style={{ width: 96 }} placeholder="行前缀" value={fixPrefix} onChange={(e) => setFixPrefix(e.target.value)} />
            <Input size="small" style={{ width: 96 }} placeholder="行后缀" value={fixSuffix} onChange={(e) => setFixSuffix(e.target.value)} />
            <Select
              size="small"
              value={quoteType}
              style={{ width: 110 }}
              onChange={(v) => setQuoteType(v as QuoteChar)}
              options={[
                { label: '双引号"', value: '"' as QuoteChar },
                { label: "单引号'", value: "'" as QuoteChar },
                { label: '反引号`', value: '`' as QuoteChar },
                { label: '中文「」', value: '「' as QuoteChar },
                { label: '中文“”', value: '“' as QuoteChar }
              ]}
            />
            <div className="tt-v2-symbols">
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                批量加符号
              </Typography.Text>
              <Select size="small" value={symbolMode} style={{ width: 100 }} onChange={(v) => setSymbolMode(v)} options={[{ label: '英文符号', value: 'en' as const }, { label: '中文标点', value: 'zh' as const }]} />
              <Checkbox.Group options={symbolMode === 'en' ? SYMBOL_PRESETS_EN : SYMBOL_PRESETS_ZH} value={symbolSelected} onChange={(vals) => setSymbolSelected(vals as string[])} />
              <Input size="small" style={{ width: 160 }} placeholder="自定义符号（空格分隔）" value={customSymbols} onChange={(e) => setCustomSymbols(e.target.value)} />
              <Select size="small" value={symbolPosition} style={{ width: 84 }} onChange={(v) => setSymbolPosition(v)} options={[{ label: '行尾', value: 'after' as const }, { label: '行首', value: 'before' as const }, { label: '首尾', value: 'both' as const }]} />
              <Select size="small" value={symbolQuote} style={{ width: 84 }} onChange={(v) => setSymbolQuote(v)} options={[{ label: '无引号', value: '' as const }, { label: '"双', value: '"' as const }, { label: "'单", value: "'" as const }]} />
            </div>
          </>
        )
      case 'encode':
        return <Switch size="small" checked={jsonCompact} onChange={setJsonCompact} checkedChildren="JSON 紧凑" unCheckedChildren="JSON 美化" />
      case 'regex':
        return (
          <div className="tt-v2-regex">
            <Input size="small" style={{ width: 150 }} placeholder="正则查找" value={regexPattern} onChange={(e) => setRegexPattern(e.target.value)} />
            <Input size="small" style={{ width: 72 }} placeholder="flags" value={regexFlags} onChange={(e) => setRegexFlags(e.target.value)} />
            <Input size="small" style={{ width: 130 }} placeholder="替换为" value={regexReplacement} onChange={(e) => setRegexReplacement(e.target.value)} />
            <Input size="small" style={{ width: 240 }} placeholder="批量规则：查找|替换（每行一条）" value={replaceRules} onChange={(e) => setReplaceRules(e.target.value)} />
          </div>
        )
      case 'translate':
        return (
          <>
            <Select size="small" value={srcLang} style={{ width: 110 }} onChange={setSrcLang} options={[{ label: '中文', value: 'zh-CN' }, { label: '英文', value: 'en' }, { label: '日文', value: 'ja' }, { label: '韩文', value: 'ko' }, { label: '法语', value: 'fr' }, { label: '德语', value: 'de' }, { label: '俄语', value: 'ru' }, { label: '西班牙', value: 'es' }]} />
            <span>→</span>
            <Select size="small" value={tgtLang} style={{ width: 110 }} onChange={setTgtLang} options={[{ label: '英文', value: 'en' }, { label: '中文', value: 'zh-CN' }, { label: '日文', value: 'ja' }, { label: '韩文', value: 'ko' }, { label: '法语', value: 'fr' }, { label: '德语', value: 'de' }, { label: '俄语', value: 'ru' }, { label: '西班牙', value: 'es' }]} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              MyMemory 免费接口 · 需联网
            </Typography.Text>
          </>
        )
      default:
        return null
    }
  }

  const gotoProc = (): void => {
    setActive('dedupe')
    message.success('内容已在输入区，可继续加工')
  }

  return (
    <div className="texttools-page texttools-page-v2">
      <div className="page-header">
        <Typography.Title level={4} style={{ margin: 0 }}>
          文本工具
        </Typography.Title>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          统一工作台：菜单选择功能 · 40+ 批处理 · 高亮 · 对比 · OCR · 独立工具，结果可继续加工
        </Typography.Text>
      </div>

      {/* Word 工具条式菜单：第一行分类、第二行功能平铺，全部可见可点，不用下拉 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
          {TOOL_CATS.map((c) => (
            <Button
              key={c.key}
              size="small"
              type={catView === c.key ? 'primary' : 'default'}
              title={c.desc}
              onClick={() => switchCat(c.key)}
            >
              {c.label}
            </Button>
          ))}
          <span style={{ width: 1, height: 18, background: 'var(--border-color, rgba(128,128,128,.25))', margin: '0 4px' }} />
          <Button size="small" type={catView === 'analysis' ? 'primary' : 'default'} onClick={() => switchCat('analysis')}>
            分析与识别
          </Button>
          <Button size="small" type={catView === 'panels' ? 'primary' : 'default'} onClick={() => switchCat('panels')}>
            独立工具
          </Button>
        </div>
        <div className="tt-v2-toolbar" style={{ marginBottom: 0 }}>
          {(catView === 'analysis' || catView === 'panels'
            ? SPECIAL_TOOLS.filter((t) => (catView === 'analysis' ? t.group === '分析与识别' : t.group === '独立工具'))
            : PROC_TOOLS.filter((t) => t.cat === catView)
          ).map((t) => (
            <Button key={t.key} size="small" type={active === t.key ? 'primary' : 'default'} onClick={() => setActive(t.key)}>
              {t.label}
            </Button>
          ))}
          {activeProc && renderParams(activeProc.cat)}
          {activeProc && (
            <Button size="small" type="primary" loading={active === 'translate' && translating} onClick={() => runProc(active)}>
              执行
            </Button>
          )}
          <Button size="small" onClick={() => void openFile()}>
            打开文本文件
          </Button>
          <Button size="small" disabled={!output} onClick={() => setInput(output)}>
            输出 → 输入
          </Button>
        </div>
      </div>

      {activeProc && (
        <div className="texttools-work">
          <div className="texttools-pane">
            <div className="texttools-pane-header">
              <Typography.Text strong>输入</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {statsIn.lines} 行 · 汉字 {statsIn.chinese} · 字符 {statsIn.chars}
              </Typography.Text>
              <Button size="small" type="text" icon={<ClearOutlined />} onClick={() => setInput('')} title="清空" />
            </div>
            <textarea
              className="texttools-textarea"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="粘贴或打开文件，再点「执行」…"
            />
          </div>
          <div className="texttools-pane">
            <div className="texttools-pane-header">
              <Typography.Text strong>输出</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {stats.lines} 行 · {stats.chars} 字符 · {stats.words} 词
              </Typography.Text>
              <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => void copy()} disabled={!output} title="复制" />
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
      )}

      {active === 'highlight' && (
        <div className="texttools-single">
          <div className="texttools-option-row">
            <Typography.Text strong>关键词</Typography.Text>
            <Input placeholder="多个关键词用逗号分隔，例如：error, warning" value={keywords} onChange={(e) => setKeywords(e.target.value)} style={{ maxWidth: 420 }} allowClear />
            <Button size="small" icon={<ToolOutlined />} disabled={!input} onClick={gotoProc}>
              在处理工具中继续
            </Button>
          </div>
          <textarea className="texttools-textarea texttools-textarea-lg" value={input} onChange={(e) => setInput(e.target.value)} placeholder="输入文本，匹配的关键词会实时标黄" />
          <div className="texttools-pane-header" style={{ marginTop: 12 }}>
            <Typography.Text strong>高亮结果</Typography.Text>
          </div>
          <pre className="texttools-output texttools-output-lg" dangerouslySetInnerHTML={{ __html: highlighted || '<span style="opacity:.5">（结果区）</span>' }} />
        </div>
      )}

      {active === 'diff' && (
        <div className="texttools-diff">
          <div className="texttools-diff-panes">
            <div className="texttools-pane">
              <div className="texttools-pane-header">
                <Typography.Text strong>文本 A（原）</Typography.Text>
              </div>
              <textarea className="texttools-textarea" value={inputA} onChange={(e) => setInputA(e.target.value)} placeholder="原始文本" />
            </div>
            <div className="texttools-pane">
              <div className="texttools-pane-header">
                <Typography.Text strong>文本 B（新）</Typography.Text>
              </div>
              <textarea className="texttools-textarea" value={inputB} onChange={(e) => setInputB(e.target.value)} placeholder="对比文本" />
            </div>
          </div>
          <div className="texttools-pane-header" style={{ marginTop: 12 }}>
            <Typography.Text strong>差异</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              绿 + 新增 · 红 - 删除 · 灰 = 相同
            </Typography.Text>
            <Button
              size="small"
              icon={<ToolOutlined />}
              disabled={diffResult.length === 0}
              onClick={() => {
                const text = diffResult
                  .map((l) => (l.type === 'add' ? '+ ' : l.type === 'remove' ? '- ' : '  ') + l.text)
                  .join('\n')
                setInput(text)
                gotoProc()
                message.success('对比结果已送入处理工具输入区')
              }}
            >
              结果送入处理工具
            </Button>
          </div>
          <pre className="texttools-output texttools-output-lg">
            {diffResult.length === 0
              ? '（结果区）'
              : diffResult.map((l, i) => (
                  <div
                    key={i}
                    className={'diff-line diff-' + l.type}
                    dangerouslySetInnerHTML={{
                      __html: `${l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' '} ${escapeHtml(l.text)}`
                    }}
                  />
                ))}
          </pre>
        </div>
      )}

      {active === 'ocr' && (
        <div className="texttools-single">
          <div className="texttools-option-row">
            <Button icon={<FileImageOutlined />} onClick={() => void handleOcrPick()}>
              选择图片
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              或拖拽图片到下方区域（PNG / JPG / WebP）
            </Typography.Text>
          </div>
          <div className="ocr-dropzone" onDragOver={(e) => e.preventDefault()} onDrop={handleOcrDrop}>
            {ocrImages.length > 0 ? (
              <div className="ocr-thumbs">
                {ocrImages.map((img, i) => (
                  <div key={i} className="ocr-thumb">
                    <img src={img.dataUrl} alt={img.name} className="ocr-thumb-img" />
                    <div className="ocr-thumb-name">{img.name}</div>
                    <Button size="small" type="text" danger icon={<CloseOutlined />} className="ocr-thumb-remove" onClick={() => setOcrImages((prev) => prev.filter((_, j) => j !== i))} title="移除" />
                  </div>
                ))}
              </div>
            ) : (
              <Empty description="拖拽图片到这里（可多张），或点击「选择图片」" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: 24 }} />
            )}
          </div>
          <div className="texttools-option-row" style={{ marginTop: 12 }}>
            <Button type="primary" icon={<ScanOutlined />} onClick={() => void handleOcrRun()} disabled={ocrImages.length === 0 || ocrLoading} loading={ocrLoading}>
              {ocrLoading ? ocrStatus || '识别中…' : `批量识别${ocrImages.length > 0 ? `（${ocrImages.length} 张）` : ''}`}
            </Button>
            <Button icon={<SaveOutlined />} onClick={() => void handleOcrSaveNote()} disabled={!output.trim()}>
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
              {stats.lines} 行 · {stats.chars} 字符（已同步到输出区）
            </Typography.Text>
            <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => void copy()} disabled={!output} title="复制" />
            <Button size="small" icon={<ToolOutlined />} disabled={!output.trim()} onClick={gotoProc}>
              送入处理工具
            </Button>
          </div>
          <textarea className="texttools-textarea texttools-textarea-lg" value={output} onChange={(e) => setOutput(e.target.value)} placeholder="识别结果将显示在这里" />
        </div>
      )}

      {activeSpecial?.group === '独立工具' && (
        <Card size="small" title={PANEL_META[active]?.title ?? '独立工具'} className="mt-panel">
          {active === 'markdown' && <MarkdownPanel />}
          {active === 'speech' && <SpeechPanel />}
          {active === 'teleprompter' && <TeleprompterPanel />}
          {active === 'stats' && <StatsPanel />}
          {active === 'fmt-tool' && <FormatPanel />}
        </Card>
      )}
    </div>
  )
}
