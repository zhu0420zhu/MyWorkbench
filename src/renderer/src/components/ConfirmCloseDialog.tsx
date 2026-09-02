import { useCallback, useEffect, useState } from 'react'
import { Button, Checkbox, Modal, Typography } from 'antd'
import { ColumnHeightOutlined, PoweroffOutlined } from '@ant-design/icons'

/**
 * 关闭确认：主进程拦截窗口 close 后推送 window:confirm-close，这里弹窗并回执。
 *
 * 主进程给的是 15 秒超时，超时会退化成原生对话框，因此本组件必须在任何情况下
 * 都给出答复（包括 ESC / 点遮罩 → cancel），否则用户点关闭后会"卡"十几秒。
 *
 * 「不再提示」勾选后，选择会写入 userData/window-state.json，
 * 之后按同一方式处理；可在设置里改回"每次询问"。
 */
export default function ConfirmCloseDialog() {
  const [open, setOpen] = useState(false)
  const [remember, setRemember] = useState(false)

  useEffect(() => {
    const off = window.api.windowApi.onConfirmClose(() => {
      setRemember(false)
      setOpen(true)
    })
    return off
  }, [])

  const reply = useCallback(
    (action: 'minimize' | 'quit' | 'cancel') => {
      window.api.windowApi.replyClose(action, action !== 'cancel' && remember)
      setOpen(false)
    },
    [remember]
  )

  // ESC / 点遮罩都视为取消（不关闭、不退出）
  const cancel = useCallback(() => reply('cancel'), [reply])

  return (
    <Modal
      open={open}
      title="关闭灵墨工作台"
      width={420}
      onCancel={cancel}
      maskClosable
      keyboard
      destroyOnHidden
      footer={[
        <div
          key="footer"
          style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
        >
          <Checkbox
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            style={{ marginRight: 'auto', marginLeft: 0 }}
          >
            不再提示
          </Checkbox>
          <Button key="cancel" onClick={cancel}>
            取消
          </Button>
          <Button key="quit" icon={<PoweroffOutlined />} onClick={() => reply('quit')}>
            直接退出
          </Button>
          <Button
            key="minimize"
            type="primary"
            icon={<ColumnHeightOutlined />}
            onClick={() => reply('minimize')}
          >
            最小化到后台
          </Button>
        </div>
      ]}
    >
      <Typography.Paragraph style={{ marginBottom: 8 }}>
        要最小化到后台继续运行，还是直接退出？
      </Typography.Paragraph>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        最小化到后台后应用会在系统托盘继续运行，可随时点托盘图标回到写作；直接退出会结束所有窗口。
      </Typography.Text>
    </Modal>
  )
}
