import { EditOutlined } from '@ant-design/icons'
import { Typography } from 'antd'
import WritingWorkspace from '../components/roleWorkshop/WritingWorkspace'

/* ============================================
 * 写作页（统一入口）
 * 短篇写作（角色 / 世界书 / 设定 / 草稿 / 成书）与长篇作品（分卷章节 / 大纲 / 上下文 / 伏笔 / 灵感）
 * 在 WritingWorkspace 内合一，共用同一套 AI 引擎，无重复实现。
 * ============================================ */
export default function Writing() {
  return (
    <div className="hub-page" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="page-header">
        <Typography.Title level={4} style={{ margin: 0 }}>
          <EditOutlined style={{ marginRight: 8 }} />
          写作
        </Typography.Title>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          写作对话 · 角色扮演 · 设定面板 · 分卷章节 · 大纲设定 · 上下文编排
        </Typography.Text>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <WritingWorkspace />
      </div>
    </div>
  )
}
