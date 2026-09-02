import { listShortcuts } from './shortcuts'
import { listNotes } from './notes'
import { listAutomations } from './automations'
import type { SearchResult, AppCommand } from '../shared/types'

interface NavEntry {
  page: string
  title: string
  keywords: string
}

const PAGES: NavEntry[] = [
  { page: 'dashboard', title: '自动工作台', keywords: 'dashboard home 主页 工作台 首页 ai 助手 对话 问答 智能多媒体' },
  { page: 'knowledge', title: '本地知识库', keywords: 'knowledge 知识库 检索 rag 文档 智能多媒体' },
  { page: 'filetools', title: '文件工具', keywords: 'file tools 文件 整理 转换 清理 智能工具' },
  { page: 'notes', title: '笔记', keywords: 'note 笔记 记录 备忘' },
  { page: 'stickies', title: '便利贴', keywords: 'sticky 便利贴 便签 贴纸' },
  { page: 'database', title: '数据整理', keywords: 'data 数据库 表格 看板 统计' },
  { page: 'analytics', title: '数据分析', keywords: 'analytics 图表 统计 csv echarts 可视化 数据 分析' },
  { page: 'boards', title: '白板', keywords: 'board 白板 画布 绘图' },
  { page: 'texttools', title: '文本工具', keywords: 'text 文本 批处理 ocr 翻译 智能工具' },
  { page: 'hotspots', title: '多媒体', keywords: 'hot media 多媒体 热点 热点跟进 agent 智能体 代理 常驻 智能多媒体' },
  { page: 'settings', title: '设置', keywords: 'setting 设置 配置 偏好' },
  { page: 'writing', title: '写作', keywords: 'writing 写作 写稿 创作 编辑 笔记 文本 润色' },
  { page: 'copywriting', title: '文案', keywords: 'copy 文案 营销 推广 宣传 带货 小红书 公众号 热点分发' },
  { page: 'gameui', title: '游戏UI设计', keywords: 'game ui 游戏 界面 设计 sprite 雪碧图 拆分 原型 交互 整页' },
  { page: 'novel', title: '长篇作品', keywords: 'novel 长篇 小说 作品 章节 角色 设定 世界观 伏笔' }
]

interface CommandEntry {
  command: AppCommand
  title: string
  subtitle: string
  keywords: string
  shortcut: string
}

const COMMANDS: CommandEntry[] = [
  { command: 'new-note', title: '新建笔记', subtitle: '创建一篇新笔记', keywords: 'new note 新建 笔记 记录', shortcut: 'Ctrl+N' },
  { command: 'ai-chat', title: '发起 AI 问答', subtitle: '在自动工作台打开 AI 助手并开始对话', keywords: 'ai chat 问答 对话 助手', shortcut: 'Ctrl+/' },
  { command: 'new-automation', title: '新建自动化', subtitle: '创建一条自动化命令', keywords: 'new automation 自动化 命令 定时', shortcut: '' },
  { command: 'filetools', title: '打开文件工具', subtitle: '整理 / 转换 / 清理文件', keywords: 'file tools 文件 整理 转换', shortcut: '' },
  { command: 'knowledge', title: '知识库问答', subtitle: '向本地知识库提问', keywords: 'knowledge 知识库 问答 检索', shortcut: '' },
  { command: 'toggle-theme', title: '切换深浅色', subtitle: '在深色 / 浅色主题间切换', keywords: 'theme 主题 深色 浅色 切换', shortcut: '' },
  { command: 'open-search', title: '打开全局搜索', subtitle: '命令面板（Ctrl+K）', keywords: 'search 搜索 命令 面板 查找', shortcut: 'Ctrl+K' }
]

function match(text: string, q: string): boolean {
  return text.toLowerCase().includes(q)
}

export async function searchAll(query: string): Promise<SearchResult[]> {
  const q = query.trim().toLowerCase()

  // 空查询：返回常用启动项（高频页面 + 操作），让 Ctrl+K 无需输入即可当启动器
  if (!q) {
    const def: SearchResult[] = []
    for (const p of PAGES) {
      if (p.page === 'knowledge' || p.page === 'filetools' || p.page === 'dashboard' || p.page === 'writing' || p.page === 'copywriting' || p.page === 'gameui' || p.page === 'novel' || p.page === 'analytics') {
        def.push({ kind: 'page', id: 'page:' + p.page, title: p.title, subtitle: '页面', page: p.page })
      }
    }
    for (const c of COMMANDS) {
      def.push({
        kind: 'command',
        id: 'cmd:' + c.command,
        title: c.title,
        subtitle: c.subtitle,
        command: c.command,
        shortcut: c.shortcut
      })
    }
    return def
  }

  const [shorts, notes, autos] = await Promise.all([listShortcuts(), listNotes(), listAutomations()])
  const results: SearchResult[] = []

  for (const s of shorts) {
    if (match(s.name, q) || match(s.target, q)) {
      results.push({
        kind: 'shortcut',
        id: s.id,
        title: s.name,
        subtitle: s.target,
        action: s.type,
        target: s.target
      })
    }
  }

  for (const n of notes) {
    if (match(n.title, q)) {
      results.push({ kind: 'note', id: n.id, title: n.title, subtitle: '笔记' })
    }
  }

  for (const a of autos) {
    if (match(a.name, q) || match(a.command, q)) {
      results.push({ kind: 'automation', id: a.id, title: a.name, subtitle: a.command })
    }
  }

  for (const p of PAGES) {
    if (match(p.title, q) || match(p.keywords, q)) {
      results.push({ kind: 'page', id: 'page:' + p.page, title: p.title, subtitle: '页面', page: p.page })
    }
  }

  for (const c of COMMANDS) {
    if (match(c.title, q) || match(c.keywords, q)) {
      results.push({
        kind: 'command',
        id: 'cmd:' + c.command,
        title: c.title,
        subtitle: c.subtitle,
        command: c.command,
        shortcut: c.shortcut
      })
    }
  }

  return results.slice(0, 24)
}
