/* ============================================================
 * 情报流（feed）渲染层公共工具
 * 由原「多媒体页」抽出，供 FeedCenter / FeedList / FeedItemCard /
 * SourceBrowser / PublishDrawer / SourceManager 共用，避免多处重复。
 * ============================================================ */

import type { FeedItemSource } from '@shared/types'

/** 平台/任务 id → 展示名（热点 16 平台 + 2 个智能体任务） */
export const PLATFORM_NAMES: Record<string, string> = {
  weibo: '微博',
  zhihu: '知乎',
  bilibili: 'B站',
  douyin: '抖音',
  toutiao: '头条',
  baidu: '百度',
  tieba: '贴吧',
  douban: '豆瓣',
  juejin: '掘金',
  gongzhonghao: '公众号',
  csdn: 'CSDN',
  ithome: 'IT之家',
  sspai: '少数派',
  '36kr': '36氪',
  huxiu: '虎嗅',
  ifanr: '爱范儿',
  geekpark: '极客公园',
  github: 'GitHub',
  'hn-briefing': 'Hacker News 简报',
  'release-radar': 'Release Radar'
}

/** 平台/任务 id → antd Tag 颜色 */
export const PLATFORM_COLORS: Record<string, string> = {
  weibo: 'red',
  zhihu: 'blue',
  bilibili: 'pink',
  douyin: 'magenta',
  toutiao: 'volcano',
  baidu: 'orange',
  tieba: 'cyan',
  douban: 'green',
  juejin: 'geekblue',
  gongzhonghao: 'green',
  csdn: 'purple',
  ithome: 'blue',
  sspai: 'cyan',
  '36kr': 'volcano',
  huxiu: 'orange',
  ifanr: 'magenta',
  geekpark: 'geekblue',
  github: 'purple',
  'hn-briefing': 'orange',
  'release-radar': 'geekblue'
}

/** 条目来源展示名：优先用主进程给的 name，其次本地映射，最后回退 id */
export function sourceLabel(s: FeedItemSource): string {
  return s.name || PLATFORM_NAMES[s.platform] || s.platform
}

/** 数据源 id → 展示名（FeedSourceStatus 只有 id，需要本地映射兜底） */
export function platformLabel(id: string, fallbackName?: string): string {
  return fallbackName || PLATFORM_NAMES[id] || id
}

/** 数据源 id → Tag 颜色 */
export function platformColor(id: string): string {
  return PLATFORM_COLORS[id] ?? 'default'
}

/** 热度数值格式化：10000 → 1.0万 */
export function formatHot(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  return String(n)
}

/** 时间戳 → HH:mm */
export function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

/** 仅接受绝对 http(s) 链接，过滤空值/相对路径/非常规协议，避免内置浏览器静默打不开 */
export function isValidHttpUrl(u: string): boolean {
  if (!u) return false
  try {
    const p = new URL(u)
    return p.protocol === 'http:' || p.protocol === 'https:'
  } catch {
    return false
  }
}

/** 毫秒 → 小时（用于数据源周期输入框展示） */
export function msToHours(ms: number): number {
  if (ms <= 0) return 0
  return Math.round((ms / 3600_000) * 10) / 10
}

/** 小时 → 毫秒 */
export function hoursToMs(h: number): number {
  if (!Number.isFinite(h) || h <= 0) return 0
  return Math.round(h * 3600_000)
}

/** 内置浏览器 加载中 / 失败 覆盖层样式 */
export const BROWSER_OVERLAY: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'var(--bg-elevated, #fff)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
  zIndex: 2
}
