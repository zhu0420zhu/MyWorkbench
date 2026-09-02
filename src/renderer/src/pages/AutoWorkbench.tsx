import { useEffect, useState } from 'react'
import { Button, Modal, Segmented, Typography, message } from 'antd'
import {
  QuestionCircleOutlined,
  RobotOutlined,
  FolderOpenOutlined,
  BookOutlined,
  FileTextOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import Dashboard from './Dashboard'
import Automations from './Automations'
import AiAssistantPanel from '../components/AiAssistantPanel'
import { useNav } from '../nav'

const CASES = [
  {
    title: '📌 常用工具一键直达',
    steps: ['「快捷卡片」→ 添加卡片 → 网址或命令（如 explorer D:\\MyWorkbench）', '点击卡片即打开，配合 Ctrl+K 全局搜索更快']
  },
  {
    title: '⚡ 每日备份自动化',
    steps: ['「自动化命令」→ 新建命令：robocopy "源目录" "D:\\Backup" /MIR', '设置工作目录后点「运行」，实时看输出与退出码']
  },
  {
    title: '🔍 文本批处理流水线',
    steps: ['文本工具页粘贴日志 → 去重行 → 加引号 → 翻译', 'OCR 识别截图 → 识别结果直接进输出区继续处理']
  },
  {
    title: '📊 数据分析三步走',
    steps: ['「数据整理」→ 导入 CSV/Excel → 表格整理 → 切图表视图选 X/Y 列', '看板视图按「状态」列分组跟踪任务']
  },
  {
    title: '🔥 热点跟进 + 分发',
    steps: ['多媒体页刷新热点（16 平台聚合自动分类）→ 点击事件内置浏览器阅读', '一键分发到微博/B站等，AI 改写标题']
  }
]

export default function AutoWorkbench({
  openAutomationId,
  action
}: {
  openAutomationId?: string
  action?: string
}) {
  const [view, setView] = useState<'cards' | 'automations' | 'ai'>('cards')
  const [tutorialOpen, setTutorialOpen] = useState(false)
  const { navigate } = useNav()

  // 外部跳转：指定自动化 / 新建自动化 / AI 问答
  useEffect(() => {
    if (openAutomationId) setView('automations')
    if (action === 'new-automation') setView('automations')
    if (action === 'ai-chat') setView('ai')
  }, [openAutomationId, action])

  const quickActions = [
    {
      label: 'AI 对话',
      desc: '问答 / 写稿',
      icon: <RobotOutlined />,
      onClick: () => setView('ai')
    },
    {
      label: '文件整理',
      desc: '整理 / 转换',
      icon: <FolderOpenOutlined />,
      onClick: () => navigate({ page: 'filetools' })
    },
    {
      label: '知识库问答',
      desc: '检索本地文档',
      icon: <BookOutlined />,
      onClick: () => navigate({ page: 'knowledge' })
    },
    {
      label: '新建笔记',
      desc: 'Ctrl+N',
      icon: <FileTextOutlined />,
      onClick: async () => {
        try {
          const list = await window.api.notes.create('新笔记')
          navigate({ page: 'notes', id: list[0]?.id })
        } catch {
          message.error('创建笔记失败')
        }
      }
    },
    {
      label: '新建自动化',
      desc: '定时 / 批处理',
      icon: <ThunderboltOutlined />,
      onClick: () => navigate({ page: 'dashboard', action: 'new-automation' })
    }
  ]

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="page-header" style={{ padding: '16px 24px 0', flexShrink: 0 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          自动工作台
        </Typography.Title>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Segmented
            value={view}
            onChange={(v) => setView(v as 'cards' | 'automations' | 'ai')}
            options={[
              { label: '快捷卡片', value: 'cards' },
              { label: '自动化命令', value: 'automations' },
              { label: 'AI 助手', value: 'ai' }
            ]}
          />
          <Button icon={<QuestionCircleOutlined />} onClick={() => setTutorialOpen(true)}>
            使用案例
          </Button>
        </div>
      </div>

      {/* 主页高频快捷操作区 */}
      <div className="quick-actions" style={{ padding: '16px 24px 4px', flexShrink: 0 }}>
        {quickActions.map((q) => (
          <button key={q.label} className="quick-action" onClick={q.onClick} type="button">
            <span className="quick-action-icon">{q.icon}</span>
            <span className="quick-action-text">
              <span className="quick-action-label">{q.label}</span>
              <span className="quick-action-desc">{q.desc}</span>
            </span>
          </button>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {view === 'cards' ? (
          <Dashboard />
        ) : view === 'automations' ? (
          <Automations openAutomationId={openAutomationId} openNew={action === 'new-automation'} />
        ) : (
          <AiAssistantPanel />
        )}
      </div>

      <Modal
        title="使用案例教程"
        open={tutorialOpen}
        onCancel={() => setTutorialOpen(false)}
        footer={<Button type="primary" onClick={() => setTutorialOpen(false)}>知道了</Button>}
        width={560}
      >
        {CASES.map((c, i) => (
          <div key={i} style={{ marginBottom: 16 }}>
            <Typography.Text strong>{c.title}</Typography.Text>
            <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
              {c.steps.map((s, j) => (
                <li key={j} style={{ fontSize: 13, lineHeight: 1.7 }}>
                  {s}
                </li>
              ))}
            </ul>
          </div>
        ))}
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
          更多玩法：便利贴任务日历 · 数据库看板 · OCR 批量识别 · AI 模型切换 · 个性化主题
        </Typography.Paragraph>
      </Modal>
    </div>
  )
}
