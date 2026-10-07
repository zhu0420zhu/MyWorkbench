/**
 * 页面中文名 —— 单一权威来源。
 *
 * 背景：此前同一份「页面 key → 中文名」散落在四处硬编码：
 *   1. renderer/src/navItems.tsx 的 NAV（侧边栏 / 独立窗标题）
 *   2. main/pageWindows.ts 的 PAGE_TITLES（主进程窗口 title）
 *   3. main/search.ts 的 PAGES.title（命令面板）
 *   4. renderer/src/pages/Settings.tsx 的默认页 options
 * 四份靠人工同步，2026-09-28 的审计就发现 novel 已在 2/3/4 存在但漏在 1。
 *
 * 现在统一收敛到这里：渲染层经 `@shared/pageMeta`、主进程经 `../shared/pageMeta` 引用。
 * 新增页面只需在 PAGE_LABELS 加一行，各处自动跟随。
 *
 * 注意：本文件必须保持**零依赖纯数据**（不含 React / Node API），
 * 否则会被同时打进渲染层与主进程两个 bundle。
 */

/** 页面 key → 中文名。作侧边栏、窗口标题、命令面板、设置项的统一来源。 */
export const PAGE_LABELS = {
  dashboard: '自动工作台',
  knowledge: '本地知识库',
  filetools: '文件工具',
  toolbox: '开发工具箱',
  docs: '文档处理',
  writing: '写作',
  novel: '长篇作品',
  copywriting: '文案',
  notes: '笔记',
  stickies: '便利贴',
  texttools: '文本工具',
  database: '数据整理',
  boards: '白板',
  hotspots: '情报中心',
  agents: '智能体任务',
  analytics: '数据分析',
  settings: '设置',
  /* ---- 无侧边栏入口的页面：仍需中文名，供窗口标题与命令面板使用 ---- */
  /** 已并入自动工作台（dashboard），保留 key 以兼容历史跳转 */
  ai: 'AI 助手',
  /** 有意隐藏，四处入口均已注释；恢复时取消注释即可 */
  gameui: '游戏UI设计'
} as const

export type PageLabelKey = keyof typeof PAGE_LABELS

/**
 * 取页面中文名；未知 key 回退为 key 本身。
 *
 * 注意：**不要**再用「在 NAV 里查找、找不到就回退 key」的写法——
 * NAV 只收录有侧边栏入口的页面，隐藏页会因此显示成英文 key。
 */
export function pageLabelOf(page: string): string {
  return (PAGE_LABELS as Record<string, string>)[page] ?? page
}
