import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Col, Form, Input, Modal, Row, Select, Space, message } from 'antd'
import { ExportOutlined } from '@ant-design/icons'
import type { CharacterMeta } from './types'

/** 从角色卡 extensions 读出角色专属技能 id 列表（容错：非字符串数组一律视为空） */
function readCardSkillIds(meta: CharacterMeta | null): string[] {
  const ext = meta?.card.extensions as Record<string, unknown> | undefined
  const ids = ext?.lingmoSkills
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
}

/* ================= 角色卡编辑弹窗 ================= */
export default function CharacterEditorModal({ meta, onClose }: { meta: CharacterMeta | null; onClose: () => void }) {
  const [form] = Form.useForm()
  const [avatarBytes, setAvatarBytes] = useState<Uint8Array | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // 写作技能库（角色专属技能候选项）
  const [skillOptions, setSkillOptions] = useState<Array<{ label: string; value: string }>>([])
  const isNew = useMemo(() => {
    // 新建时 meta.card.name 为「新角色」且无更新时间
    return meta?.updatedAt === 0 || meta == null
  }, [meta])

  useEffect(() => {
    void window.api.novel
      .listSkills()
      .then((l) => {
        const arr = (l as Array<{ id: string; name: string }>) ?? []
        setSkillOptions(arr.map((s) => ({ label: s.name, value: s.id })))
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (meta) form.setFieldsValue({ ...meta.card, lingmoSkills: readCardSkillIds(meta) })
  }, [meta, form])

  const save = useCallback(async () => {
    if (!meta) return
    const values = await form.validateFields()
    const { lingmoSkills, ...rest } = values as Record<string, unknown> & { lingmoSkills?: string[] }
    const ids = Array.isArray(lingmoSkills) ? lingmoSkills : []
    const card = {
      ...meta.card,
      ...rest,
      tags: (values.tags ?? '').split(/[,，]/).map((s: string) => s.trim()).filter(Boolean),
      // 角色专属技能存入 extensions：随角色卡持久化与导出；清空时不留脏键
      extensions: { ...(meta.card.extensions ?? {}), ...(ids.length ? { lingmoSkills: ids } : { lingmoSkills: undefined }) }
    }
    await window.api.sillytavern.charsSave(meta.id, card)
    if (avatarBytes) {
      await window.api.sillytavern.charsAvatar(meta.id, avatarBytes)
    }
    message.success('角色卡已保存')
    onClose()
  }, [meta, form, avatarBytes, onClose])

  const exportCard = useCallback(async () => {
    if (!meta) return
    const res = (await window.api.sillytavern.charsExport(meta.id)) as { bytes: Uint8Array; isPng: boolean }
    await window.api.exportBuffer(`${meta.card.name}.${res.isPng ? 'png' : 'json'}`, res.bytes)
  }, [meta])

  return (
    <Modal
      open={meta != null}
      title={isNew ? '新建角色卡' : `编辑角色卡：${meta?.card.name ?? ''}`}
      onCancel={onClose}
      width={720}
      onOk={() => void save()}
      okText="保存"
      cancelText="取消"
      footer={(_, { OkBtn, CancelBtn }) => (
        <Space>
          <Button size="small" icon={<ExportOutlined />} onClick={() => void exportCard()}>
            导出卡片
          </Button>
          <Button size="small" onClick={() => fileRef.current?.click()}>
            上传头像（PNG 卡片）
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".png"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) {
                void f.arrayBuffer().then((b) => setAvatarBytes(new Uint8Array(b)))
                message.info('头像已选择，保存时生效（自动嵌入角色卡）')
              }
              e.target.value = ''
            }}
          />
          <CancelBtn />
          <OkBtn />
        </Space>
      )}
    >
      <Form form={form} layout="vertical" size="small">
        <Row gutter={12}>
          <Col span={8}>
            <Form.Item name="name" label="角色名" rules={[{ required: true, message: '请输入角色名' }]}>
              <Input placeholder="如：苏晚晴" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="creator" label="作者">
              <Input />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="character_version" label="版本">
              <Input placeholder="1.0" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="description" label="人设描述">
          <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="角色背景、身份、目标…" />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="personality" label="性格">
              <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="性格特征…" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="scenario" label="场景">
              <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="当前所处场景…" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="first_mes" label="开场白（进入角色时的第一句话）">
          <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="你好，你终于来了…" />
        </Form.Item>
        <Form.Item name="mes_example" label="对话示例（few-shot）">
          <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} placeholder={'<START>\n角色：……\n用户：……'} />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="system_prompt" label="系统指令">
              <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="始终以第一人称扮演，不要提及自己是 AI…" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="post_history_instructions" label="历史后指令">
              <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="每次回复后遵循…" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="tags" label="标签（逗号分隔）">
          <Input placeholder="古风, 恋爱, 御姐" />
        </Form.Item>
        <Form.Item
          name="lingmoSkills"
          label="角色专属技能"
          extra="从写作技能库勾选；对话中选择该角色时自动注入这些技能（随角色卡保存与导出）"
        >
          <Select mode="multiple" allowClear placeholder="不选则仅使用全局技能" options={skillOptions} />
        </Form.Item>
        <Form.Item name="creator_notes" label="创作备注">
          <Input.TextArea autoSize={{ minRows: 1, maxRows: 3 }} />
        </Form.Item>
      </Form>
    </Modal>
  )
}
