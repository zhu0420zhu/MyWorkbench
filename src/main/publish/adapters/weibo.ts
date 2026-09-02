/* 微博适配器（真实实现）：登录探测 + 直接发布文字微博
 * 注意：微博 Web 无公开草稿 API，采用直接发布（mode='direct'），
 * 合规策略：仅发布用户确认的内容，频率受限 */
import type { PlatformAdapter, PublishContext, PublishResult } from '../adapter.ts'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

async function sessionFetch(ctx: PublishContext, url: string, init: RequestInit = {}): Promise<Response> {
  return ctx.session.fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, ...(init.headers as Record<string, string> | undefined) }
  })
}

export const weiboAdapter: PlatformAdapter = {
  id: 'weibo',
  name: '微博',
  loginUrl: 'https://weibo.com/login',
  status: 'ready',
  modeLabel: '直接发布（微博无草稿箱，请确认后再发）',

  async checkLogin(ctx) {
    try {
      const res = await sessionFetch(ctx, 'https://weibo.com/ajax/profile/info')
      if (!res.ok) return false
      const json = (await res.json()) as { data?: { user?: unknown } }
      return Boolean(json?.data?.user)
    } catch {
      return false
    }
  },

  async publish(input, ctx): Promise<PublishResult> {
    const text = `${input.title}\n${input.content}`.trim().slice(0, 2000)
    const body = new URLSearchParams({ status: text, is_photo: '0' }).toString()
    try {
      const res = await sessionFetch(ctx, 'https://weibo.com/ajax/statuses/update', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: 'https://weibo.com/',
          Origin: 'https://weibo.com'
        },
        body
      })
      const json = (await res.json()) as { ok?: number; idst?: string; msg?: string }
      if (json?.ok === 1) {
        return { ok: true, platformId: 'weibo', mode: 'direct', externalId: json.idst }
      }
      return { ok: false, platformId: 'weibo', error: json?.msg ?? `HTTP ${res.status}` }
    } catch (err) {
      return { ok: false, platformId: 'weibo', error: (err as Error).message }
    }
  }
}
