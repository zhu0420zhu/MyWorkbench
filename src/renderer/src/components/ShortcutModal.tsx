import { useEffect } from 'react'
import { Form, Input, Modal, Radio, Select } from 'antd'
import type { Shortcut, ShortcutInput } from '@shared/types'
import { COLORS, DEFAULT_COLOR, DEFAULT_ICON, ICON_KEYS, ICON_MAP } from '../constants/shortcuts'

interface Props {
  open: boolean
  editing: Shortcut | null
  onCancel: () => void
  onSubmit: (values: ShortcutInput) => Promise<void>
}

export default function ShortcutModal({ open, editing, onCancel, onSubmit }: Props) {
  const [form] = Form.useForm<ShortcutInput>()

  useEffect(() => {
    if (!open) return
    if (editing) {
      form.setFieldsValue({
        name: editing.name,
        type: editing.type,
        target: editing.target,
        icon: editing.icon,
        color: editing.color
      })
    } else {
      form.resetFields()
    }
  }, [open, editing, form])

  return (
    <Modal
      title={editing ? '编辑快捷方式' : '添加快捷方式'}
      open={open}
      onCancel={onCancel}
      onOk={() => form.submit()}
      okText="保存"
      cancelText="取消"
      width={420}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ type: 'url', icon: DEFAULT_ICON, color: DEFAULT_COLOR }}
        onFinish={(values) => {
          onSubmit(values)
        }}
      >
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
          <Input placeholder="例如：GitHub" maxLength={20} />
        </Form.Item>
        <Form.Item name="type" label="类型" rules={[{ required: true }]}>
          <Radio.Group>
            <Radio.Button value="url">网址</Radio.Button>
            <Radio.Button value="command">命令</Radio.Button>
          </Radio.Group>
        </Form.Item>
        <Form.Item noStyle shouldUpdate={(prev, cur) => prev.type !== cur.type}>
          {({ getFieldValue }) => (
            <Form.Item
              name="target"
              label={getFieldValue('type') === 'command' ? '命令' : '网址'}
              rules={[{ required: true, message: '请输入内容' }]}
            >
              <Input
                placeholder={
                  getFieldValue('type') === 'command' ? '例如：explorer D:\\' : 'https://example.com'
                }
              />
            </Form.Item>
          )}
        </Form.Item>
        <Form.Item name="icon" label="图标">
          <Select>
            {ICON_KEYS.map((k) => {
              const Icon = ICON_MAP[k]
              return (
                <Select.Option key={k} value={k}>
                  <Icon style={{ marginRight: 8 }} />
                  {k}
                </Select.Option>
              )
            })}
          </Select>
        </Form.Item>
        <Form.Item name="color" label="颜色">
          <Radio.Group>
            {COLORS.map((c) => (
              <Radio.Button
                key={c}
                value={c}
                style={{
                  width: 34,
                  height: 34,
                  padding: 0,
                  background: c,
                  border: 'none',
                  marginRight: 8
                }}
              />
            ))}
          </Radio.Group>
        </Form.Item>
      </Form>
    </Modal>
  )
}
