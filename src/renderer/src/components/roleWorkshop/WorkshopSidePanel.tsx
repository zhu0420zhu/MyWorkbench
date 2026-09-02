import { useState } from 'react'
import {
  Button,
  Collapse,
  Empty,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tabs,
  Typography,
  message
} from 'antd'
import { DeleteOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons'
import type { WorldInfo, RolePreset, SamplingParams, AuthorNote, RegexScript, QuickReply } from './types'
import { DEFAULT_SAMPLING } from './types'

/* ================= 世界书 ================= */
function LorebookTab({ world, onWorldChange }: { world: WorldInfo; onWorldChange: (w: WorldInfo) => void }) {
  const [name, setName] = useState(world.name)
  const [entries, setEntries] = useState(world.entries)

  const save = () => {
    onWorldChange({ ...world, name: name || world.name, entries })
    message.success('世界书已保存')
  }

  const addEntry = () =>
    setEntries((prev) => [
      ...prev,
      { uid: Date.now(), key: [''], keysecondary: [], comment: '', content: '', constant: false, selective: false, insertion_order: prev.length, enabled: true, position: 'before_char', exclude_recursion: false, prevent_recursion: false, display_index: prev.length, delay_until_recursion: false, depth: 0 }
    ])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Space.Compact style={{ width: '100%' }}>
        <Input size="small" aria-label="世界书名" value={name} onChange={(e) => setName(e.target.value)} placeholder="世界书名" />
        <Button size="small" type="primary" icon={<SaveOutlined />} onClick={save}>
          保存
        </Button>
      </Space.Compact>
      <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={addEntry}>
        新增条目
      </Button>
      {entries.map((e, i) => (
        <Collapse
          key={e.uid}
          size="small"
          items={[
            {
              key: String(e.uid),
              label: `${e.key[0] || '未命名'}（${e.content.length} 字）`,
              children: (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <Input size="small" aria-label="触发关键词" value={e.key[0] ?? ''} onChange={(ev) => setEntries((p) => p.map((x, xi) => (xi === i ? { ...x, key: [ev.target.value] } : x)))} placeholder="触发关键词" />
                  <Input.TextArea aria-label="设定内容" autoSize={{ minRows: 2, maxRows: 6 }} value={e.content} onChange={(ev) => setEntries((p) => p.map((x, xi) => (xi === i ? { ...x, content: ev.target.value } : x)))} placeholder="设定内容（对话中出现关键词时自动注入）" />
                  <Space size={8} wrap>
                    <span style={{ fontSize: 12 }}>常驻</span>
                    <Switch size="small" checked={e.constant} onChange={(v) => setEntries((p) => p.map((x, xi) => (xi === i ? { ...x, constant: v } : x)))} />
                    <span style={{ fontSize: 12 }}>启用</span>
                    <Switch size="small" checked={e.enabled} onChange={(v) => setEntries((p) => p.map((x, xi) => (xi === i ? { ...x, enabled: v } : x)))} />
                    <Popconfirm title="删除该条目？" onConfirm={() => setEntries((p) => p.filter((_, xi) => xi !== i))}>
                      <Button size="small" type="text" danger aria-label="删除该条目" icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                </div>
              )
            }
          ]}
        />
      ))}
    </div>
  )
}

/* ================= 预设采样 ================= */
function PresetTab({ preset, onSamplingChange }: { preset: RolePreset; onSamplingChange: (p: Partial<SamplingParams>) => void }) {
  const sampling: SamplingParams = { ...DEFAULT_SAMPLING, ...(preset.sampling ?? {}) }
  const row = (label: string, key: keyof SamplingParams, min: number, max: number, step: number, precision = 2) => (
    <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
      <Typography.Text style={{ fontSize: 12 }}>{label}</Typography.Text>
      <InputNumber size="small" aria-label={label} style={{ width: 110 }} min={min} max={max} step={step} precision={precision} value={sampling[key] as number} onChange={(v) => onSamplingChange({ [key]: v ?? 0 } as Partial<SamplingParams>)} />
    </div>
  )
  return (
    <div style={{ padding: '4px 0' }}>
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        预设：{preset.name}
      </Typography.Text>
      <div style={{ marginTop: 8 }}>
        {row('温度 temperature', 'temperature', 0, 2, 0.05)}
        {row('核采样 top_p', 'top_p', 0, 1, 0.05)}
        {row('最大长度 max_tokens', 'max_tokens', 16, 16384, 64, 0)}
        {row('存在惩罚 presence', 'presence_penalty', -2, 2, 0.1)}
        {row('频率惩罚 frequency', 'frequency_penalty', -2, 2, 0.1)}
        {row('重复惩罚 repetition', 'repetition_penalty', 0, 2, 0.05)}
        {row('Top-K（0=关闭）', 'top_k', 0, 200, 1, 0)}
      </div>
    </div>
  )
}

/* ================= 容器（受控） ================= */
export interface SidePanelProps {
  world: WorldInfo | null
  setWorld: (w: WorldInfo | null) => void
  worlds: Array<{ id: string; name: string }>
  setWorlds: (l: Array<{ id: string; name: string }>) => void
  worldId: string | null
  setWorldId: (id: string | null) => Promise<void>
  preset: RolePreset | null
  setPreset: (p: RolePreset | null) => void
  presets: Array<{ id: string; name: string }>
  setPresets: (l: Array<{ id: string; name: string }>) => void
  presetId: string | null
  setPresetId: (id: string | null) => Promise<void>
  note: AuthorNote
  setNote: (n: AuthorNote) => void
  regex: RegexScript[]
  setRegex: (l: RegexScript[]) => void
  quick: QuickReply[]
  setQuick: (l: QuickReply[]) => void
}

export default function WorkshopSidePanel(props: SidePanelProps) {
  const { world, setWorld, worlds, worldId, setWorldId, preset, setPreset, presets, presetId, setPresetId, note, setNote, regex, setRegex, quick, setQuick } = props

  return (
    <div style={{ padding: '6px 10px 12px' }}>
      <Tabs
        size="small"
        items={[
          {
            key: 'lore',
            label: '世界书',
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Space.Compact style={{ width: '100%' }}>
                  <Select size="small" aria-label="世界书" style={{ flex: 1 }} placeholder="选择世界书" value={worldId} options={worlds.map((w) => ({ value: w.id, label: w.name }))} onChange={(id) => void setWorldId(id)} allowClear notFoundContent="暂无世界书" />
                  <Button size="small" onClick={() => void setWorldId(null)}>
                    关闭
                  </Button>
                </Space.Compact>
                {world && <LorebookTab world={world} onWorldChange={setWorld} />}
              </div>
            )
          },
          {
            key: 'preset',
            label: '预设',
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Select size="small" aria-label="选择采样预设" placeholder="选择采样预设" value={presetId} options={presets.map((p) => ({ value: p.id, label: p.name }))} onChange={(id) => void setPresetId(id)} allowClear notFoundContent="暂无预设" />
                {preset && <PresetTab preset={preset} onSamplingChange={(patch) => setPreset({ ...preset, sampling: { ...preset.sampling, ...patch } })} />}
              </div>
            )
          },
          {
            key: 'note',
            label: '作者注释',
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Space>
                  <Switch size="small" checked={note.enabled} onChange={(v) => setNote({ ...note, enabled: v })} />
                  <Typography.Text style={{ fontSize: 12 }}>启用</Typography.Text>
                </Space>
                <Input.TextArea aria-label="作者注释" autoSize={{ minRows: 3, maxRows: 8 }} value={note.note} onChange={(e) => setNote({ ...note, note: e.target.value })} placeholder="始终注入提示词的设定文本（引导整体风格/剧情走向）" />
              </div>
            )
          },
          {
            key: 'regex',
            label: '正则',
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => setRegex([...regex, { id: `rx_${Date.now()}`, name: '新规则', findRegex: '', replaceString: '', trimStrings: false, placement: ['ai'], disabled: false, markdownOnly: false, promptOnly: false }])}>
                  新增正则
                </Button>
                {regex.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无正则脚本" />}
                {regex.map((r, i) => (
                  <Collapse
                    key={r.id}
                    size="small"
                    items={[
                      {
                        key: r.id,
                        label: `${r.name}${r.disabled ? '（停用）' : ''}`,
                        children: (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <Space.Compact style={{ width: '100%' }}>
                              <Input size="small" aria-label="规则名" value={r.name} onChange={(e) => setRegex(regex.map((x, xi) => (xi === i ? { ...x, name: e.target.value } : x)))} placeholder="规则名" />
                              <Switch size="small" checked={!r.disabled} onChange={(v) => setRegex(regex.map((x, xi) => (xi === i ? { ...x, disabled: !v } : x)))} />
                              <Popconfirm title="删除？" onConfirm={() => setRegex(regex.filter((_, xi) => xi !== i))}>
                                <Button size="small" type="text" danger aria-label="删除正则" icon={<DeleteOutlined />} />
                              </Popconfirm>
                            </Space.Compact>
                            <Input size="small" aria-label="查找正则" value={r.findRegex} onChange={(e) => setRegex(regex.map((x, xi) => (xi === i ? { ...x, findRegex: e.target.value } : x)))} placeholder="查找正则（如 \\*\\*(.*?)\\*\\*）" />
                            <Input size="small" aria-label="替换内容" value={r.replaceString} onChange={(e) => setRegex(regex.map((x, xi) => (xi === i ? { ...x, replaceString: e.target.value } : x)))} placeholder="替换为（$1 引用捕获组）" />
                          </div>
                        )
                      }
                    ]}
                  />
                ))}
              </div>
            )
          },
          {
            key: 'quick',
            label: '快捷',
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => setQuick([...quick, { id: `qr_${Date.now()}`, label: '新快捷', message: '', isUser: true }])}>
                  新增快捷回复
                </Button>
                {quick.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无快捷回复宏" />}
                {quick.map((q, i) => (
                  <div key={q.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, border: '1px solid rgba(5,5,5,.08)', borderRadius: 8, padding: 8 }}>
                    <Space.Compact style={{ width: '100%' }}>
                      <Input size="small" aria-label="按钮名" value={q.label} onChange={(e) => setQuick(quick.map((x, xi) => (xi === i ? { ...x, label: e.target.value } : x)))} placeholder="按钮名" />
                      <Button size="small" type="text" danger aria-label="删除快捷回复" icon={<DeleteOutlined />} onClick={() => setQuick(quick.filter((_, xi) => xi !== i))} />
                    </Space.Compact>
                    <Input.TextArea aria-label="快捷回复内容" autoSize={{ minRows: 1, maxRows: 4 }} value={q.message} onChange={(e) => setQuick(quick.map((x, xi) => (xi === i ? { ...x, message: e.target.value } : x)))} placeholder="点击即发送的内容" />
                  </div>
                ))}
              </div>
            )
          }
        ]}
      />
    </div>
  )
}
