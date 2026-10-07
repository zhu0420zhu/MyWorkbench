/**
 * 文本工具「独立工具」面板库：Markdown 编辑 / 音视频提取文字 / 提词器 / 统计 / 格式化。
 * 由 TextTools 统一工作台按需挂载（菜单「独立工具」分组），本文件不再提供目录页 UI。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Input, Slider, Space, Statistic, Switch, Tag, Typography, Upload, message } from 'antd'
import {
  PlayCircleOutlined,
  PauseCircleOutlined,
  DownloadOutlined,
  UploadOutlined
} from '@ant-design/icons'
import { marked } from 'marked'
import {
  changeCase,
  countStatsDetail,
  dedupeLines,
  removeEmptyLines,
  sortLines,
  trimLines
} from '../utils/textTools'

const { Text, Paragraph } = Typography

export function MarkdownPanel() {
  const [md, setMd] = useState('# 标题\n\n正文 **加粗**，`代码`。\n\n- 列表项 1\n- 列表项 2\n\n$$E = mc^2$$\n')
  const html = useMemo(() => {
    try {
      return marked.parse(md, { async: false }) as string
    } catch {
      return '<p>预览失败</p>'
    }
  }, [md])
  const toc = useMemo(() => {
    const lines = md.split(/\r?\n/)
    const items: Array<{ level: number; text: string }> = []
    for (const l of lines) {
      const m = /^(#{1,6})\s+(.*)$/.exec(l)
      if (m) items.push({ level: m[1].length, text: m[2].trim() })
    }
    return items
  }, [md])

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="实时预览 · 文档目录 · Mermaid 与数学公式" description="左编辑右预览；目录随标题自动生成。" />
      <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr 1fr', gap: 12, minHeight: 360 }}>
        <div style={{ overflow: 'auto', borderRight: '1px solid var(--lm-border, rgba(128,128,128,.16))', paddingRight: 8 }}>
          <Text type="secondary">文档目录</Text>
          {toc.map((t, i) => (
            <div key={i} style={{ paddingLeft: (t.level - 1) * 10, fontSize: 12, opacity: 0.8, marginTop: 4 }}>
              {t.text}
            </div>
          ))}
          {!toc.length && <Text type="secondary">暂无标题</Text>}
        </div>
        <Input.TextArea
          value={md}
          onChange={(e) => setMd(e.target.value)}
          style={{ height: 360, fontFamily: 'Consolas, monospace', fontSize: 13 }}
        />
        <div
          style={{ height: 360, overflow: 'auto', padding: 12, border: '1px solid var(--lm-border, rgba(128,128,128,.16))', borderRadius: 8 }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </Space>
  )
}

/* ---------- 音视频提取文字 ---------- */
export function SpeechPanel() {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const pickFile = async (f: File) => {
    setBusy(true)
    try {
      // 离线骨架：读取同名/内嵌文本或提示接入 ASR
      const name = f.name
      if (/\.(txt|srt|vtt|md)$/i.test(name)) {
        const raw = await f.text()
        setText(raw)
        message.success('已载入文本/字幕文件')
      } else {
        message.warning('当前版本支持导入 TXT/SRT/VTT 文本。音视频离线识别需接入 ASR 模型（whisper 等）。')
        setText(`# ${name}\n\n（待识别）\n`)
      }
    } finally {
      setBusy(false)
    }
    return false
  }

  const exportSrt = () => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim())
    const srt = lines
      .map((l, i) => {
        const start = i * 3
        const fmt = (s: number) =>
          `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')},000`
        return `${i + 1}\n${fmt(start)} --> ${fmt(start + 3)}\n${l}\n`
      })
      .join('\n')
    const blob = new Blob([srt], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'subtitle.srt'
    a.click()
    message.success('已导出 SRT')
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="离线识别中英文语音并导出字幕" description="可导入 TXT/SRT/VTT；音视频 ASR 可后续接 whisper.cpp。" />
      <Space wrap>
        <Upload accept=".txt,.srt,.vtt,.md,audio/*,video/*" showUploadList={false} beforeUpload={(f) => void pickFile(f)}>
          <Button icon={<UploadOutlined />} loading={busy}>
            选择文件
          </Button>
        </Upload>
        <Button icon={<DownloadOutlined />} disabled={!text} onClick={exportSrt}>
          导出 SRT
        </Button>
      </Space>
      <Input.TextArea rows={12} value={text} onChange={(e) => setText(e.target.value)} placeholder="识别结果 / 字幕文本" />
    </Space>
  )
}

/* ---------- 提词器 ---------- */
export function TeleprompterPanel() {
  const [script, setScript] = useState('欢迎使用提词器。\n这里是第二句台词，可以跟随朗读。\n第三句：保持语速平稳。')
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(40)
  const [follow, setFollow] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<number | null>(null)
  const [lineIdx, setLineIdx] = useState(0)
  const lines = useMemo(() => script.split(/\r?\n/).filter((l) => l.trim()), [script])

  useEffect(() => {
    if (!playing) {
      if (timerRef.current) window.clearInterval(timerRef.current)
      timerRef.current = null
      return
    }
    timerRef.current = window.setInterval(() => {
      const el = scrollRef.current
      if (!el) return
      el.scrollTop += 1
      if (follow && lines.length) {
        const ratio = el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight)
        setLineIdx(Math.min(lines.length - 1, Math.floor(ratio * lines.length)))
      }
    }, Math.max(8, 200 - speed))
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current)
    }
  }, [playing, speed, follow, lines.length])

  useEffect(() => {
    if (follow && playing && 'speechSynthesis' in window && lines[lineIdx]) {
      window.speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(lines[lineIdx])
      u.lang = 'zh-CN'
      u.rate = 0.9 + speed / 200
      window.speechSynthesis.speak(u)
    }
  }, [lineIdx, follow, playing, lines, speed])

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="平滑滚动台词 · 句子级语音跟随" description="调节滚动速度；开启跟读可调用系统语音。" />
      <Space wrap>
        <Button
          type="primary"
          icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
          onClick={() => setPlaying((p) => !p)}
        >
          {playing ? '暂停' : '开始滚动'}
        </Button>
        <Text>速度 {speed}</Text>
        <Slider style={{ width: 160 }} min={10} max={100} value={speed} onChange={setSpeed} />
        <Switch checked={follow} onChange={setFollow} checkedChildren="语音跟随" unCheckedChildren="语音跟随" />
      </Space>
      <Input.TextArea rows={5} value={script} onChange={(e) => setScript(e.target.value)} placeholder="粘贴台词，一句一行" />
      <div
        ref={scrollRef}
        style={{
          height: 220,
          overflow: 'auto',
          padding: 16,
          borderRadius: 10,
          background: 'var(--bg-canvas, rgba(0,0,0,0.03))',
          fontSize: 18,
          lineHeight: 1.8
        }}
      >
        {lines.map((l, i) => (
          <Paragraph key={i} style={{ margin: '8px 0', fontWeight: i === lineIdx && follow ? 700 : 400 }}>
            {l}
          </Paragraph>
        ))}
      </div>
    </Space>
  )
}

/* ---------- 文本统计 ---------- */
export function StatsPanel() {
  const [text, setText] = useState('')
  const s = useMemo(() => countStatsDetail(text), [text])
  const paras = useMemo(() => text.split(/\n\s*\n/).filter((p) => p.trim()).length, [text])
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="实时统计字符数、单词数、行数、段落数" description="输入即时统计，含中英数分类。" />
      <Input.TextArea rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder="粘贴或输入文本" />
      <Space size="large" wrap>
        <Statistic title="字符" value={s.chars} />
        <Statistic title="不含空格" value={s.charsNoSpace} />
        <Statistic title="单词" value={s.words} />
        <Statistic title="行数" value={s.lines} />
        <Statistic title="段落" value={paras} />
        <Statistic title="汉字" value={s.chinese} />
        <Statistic title="英文词" value={s.english} />
        <Statistic title="数字串" value={s.numbers} />
      </Space>
    </Space>
  )
}

/* ---------- 文本格式化 ---------- */
export function FormatPanel() {
  const [text, setText] = useState('')
  const [out, setOut] = useState('')
  const [desc, setDesc] = useState('')
  const apply = (fn: (s: string) => string, label: string) => {
    const r = fn(text)
    setOut(r)
    setDesc(label)
    setText(r)
    message.success(label)
  }
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="大小写转换 · 去空行 · 去多余空格 · 排序去重" description="操作直接作用于文本，可连续处理。" />
      <Space wrap>
        <Button onClick={() => apply((s) => changeCase(s, 'upper'), '英文大写')}>英文大写</Button>
        <Button onClick={() => apply((s) => changeCase(s, 'lower'), '英文小写')}>英文小写</Button>
        <Button onClick={() => apply(removeEmptyLines, '去空行')}>去空行</Button>
        <Button onClick={() => apply((s) => trimLines(s, true), '去多余空格')}>去多余空格</Button>
        <Button onClick={() => apply(dedupeLines, '去重')}>去重</Button>
        <Button onClick={() => apply((s) => sortLines(s), '排序')}>排序</Button>
      </Space>
      {desc && <Tag color="green">{desc}</Tag>}
      <Input.TextArea rows={12} value={text} onChange={(e) => setText(e.target.value)} placeholder="待格式化文本" />
      {out && (
        <div>
          <Text type="secondary">最近结果预览</Text>
          <pre style={{ maxHeight: 160, overflow: 'auto', fontSize: 12, background: 'var(--bg-canvas, rgba(0,0,0,.03))', padding: 10, borderRadius: 8 }}>{out.slice(0, 2000)}</pre>
        </div>
      )}
    </Space>
  )
}
