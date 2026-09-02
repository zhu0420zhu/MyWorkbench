/* 平台适配器公共工具：session fetch（自动携带持久化登录 Cookie） */
import type { PublishContext } from '../adapter.ts'

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

export async function sessionFetch(
  ctx: PublishContext,
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  return ctx.session.fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, ...(init.headers as Record<string, string> | undefined) }
  })
}
