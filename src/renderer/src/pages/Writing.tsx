import { EditOutlined } from '@ant-design/icons'
import { Typography } from 'antd'
import WritingWorkspace from '../components/roleWorkshop/WritingWorkspace'
import { pageLabelOf } from '@shared/pageMeta'

/* ============================================
 * 写作页（统一入口）
 * 短篇写作（角色 / 世界书 / 设定 / 草稿 / 成书）与长篇作品（分卷章节 / 大纲 / 上下文 / 伏笔 / 灵感）
 * 在 WritingWorkspace 内合一，共用同一套 AI 引擎，无重复实现。
 *
 * 本页是短篇 + 长篇的唯一入口：
 *   - 默认落在短篇习惯栏位（角色库 / 对话 / 设定），并优先沿用用户上次的三栏选择；
 *   - 长篇意图（novelMode：历史「长篇作品」入口 / 独立窗口 ?win=novel，或带 openChapterId 的
 *     指定章节跳转）时忽略用户栏位记忆，强制落在长篇栏位（章节树 / 正文 / 长篇工具）。
 * ============================================ */
export default function Writing({
  openChapterId,
  novelMode = false
}: {
  openChapterId?: string
  /**
   * 由旧「长篇作品」路由（PageView case 'novel' / ?win=novel）重定向而来。
   * 此时无论有没有 openChapterId 都按长篇工作流落位，保住长篇用户的入口习惯。
   */
  novelMode?: boolean
}) {
  // 长篇意图优先：novel 路由，或显式跳转指定章节——都忽略用户栏位记忆
  const longForm = novelMode || !!openChapterId
  return (
    <div className="hub-page" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="page-header">
        <Typography.Title level={4} style={{ margin: 0 }}>
          <EditOutlined style={{ marginRight: 8 }} />
          {pageLabelOf('writing')}
        </Typography.Title>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          短篇对话 · 角色扮演 · 设定面板 · 世界书 · 长篇分卷章节 · 大纲 · 伏笔追踪
        </Typography.Text>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <WritingWorkspace
          openChapterId={openChapterId}
          respectStoredTabs={!longForm}
          defaultLeftTab={longForm ? 'chapters' : 'chars'}
          defaultCenterTab={longForm ? 'editor' : 'chat'}
          defaultRightTab={longForm ? 'novel' : 'settings'}
        />
      </div>
    </div>
  )
}
