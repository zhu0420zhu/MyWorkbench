/* ============================================
 * 多平台发布 · 适配器框架（P1）
 * PlatformAdapter 接口 + 注册表
 * 设计参考：Wechatsync 平台适配器规范 + ArtiPub 插件化工作流
 * ============================================ */

import type { Session } from 'electron'

export interface PublishInput {
  title: string
  content: string
}

export interface PublishResult {
  ok: boolean
  platformId: string
  /** 草稿/发布后的平台侧 ID */
  externalId?: string
  /** 发布方式说明：draft（存草稿）/ direct（直接发布） */
  mode?: 'draft' | 'direct'
  error?: string
  publishedAt?: number
}

export interface AdapterStatus {
  /** 适配器实现状态：ready=可发布；skeleton=仅登录探测，发布待适配 */
  status: 'ready' | 'skeleton'
  /** 当前是否已登录（运行时由 checkLogin 填充） */
  loggedIn: boolean
}

export interface PublishContext {
  session: Session
  log: (msg: string) => void
}

export interface PlatformAdapter {
  id: string
  name: string
  /** 登录页 URL（登录窗口打开） */
  loginUrl: string
  status: 'ready' | 'skeleton'
  /** 发布方式说明（供 UI 展示） */
  modeLabel: string
  /** 检查当前 session 是否已登录 */
  checkLogin(ctx: PublishContext): Promise<boolean>
  /** 发布内容：优先存草稿，无法存草稿则直接发布（实现须在 modeLabel 注明） */
  publish(input: PublishInput, ctx: PublishContext): Promise<PublishResult>
}

/* ---------- 注册表 ---------- */
const registry = new Map<string, PlatformAdapter>()

export function registerAdapter(adapter: PlatformAdapter): void {
  registry.set(adapter.id, adapter)
}

export function getAdapter(id: string): PlatformAdapter | undefined {
  return registry.get(id)
}

export function listAdapters(): PlatformAdapter[] {
  return [...registry.values()]
}

/** 发布状态枚举（队列用） */
export type JobStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped'

export interface PublishJob {
  id: string
  contentId: string // 关联热点事件 id（可为空=手动内容）
  title: string
  content: string
  platformId: string
  status: JobStatus
  /** 预约发布时间（毫秒时间戳），未到时间不执行 */
  scheduledAt?: number
  mode?: 'draft' | 'direct'
  externalId?: string
  error?: string
  retryCount: number
  createdAt: number
  updatedAt: number
}
