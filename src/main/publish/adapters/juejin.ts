/* 掘金适配器（真实）：登录探测 + 创建文章草稿（草稿模式）
 * 接口：api.juejin.cn/content_api/v1/article_draft/create（Web 创作中心草稿）
 * 注意：若该接口后续加入签名校验（x-secu），调用将返回错误，需随平台调整 */
import type { PlatformAdapter, PublishContext, PublishResult } from '../adapter.ts'
import { sessionFetch } from './fetch.ts'

export const juejinAdapter: PlatformAdapter = {
  id: 'juejin',
  name: '掘金',
  loginUrl: 'https://juejin.cn/',
  status: 'ready',
  modeLabel: '存草稿（创建到掘金创作中心草稿箱）',

  async checkLogin(ctx) {
    try {
      const res = await sessionFetch(ctx, 'https://api.juejin.cn/user_api/v1/author/check?aid=2608')
      if (!res.ok) return false
      const json = (await res.json()) as { err_no?: number; data?: unknown }
      return json?.err_no === 0 && json?.data != null
    } catch {
      return false
    }
  },

  async publish(input, ctx): Promise<PublishResult> {
    const body = {
      title: input.title,
      mark_content: input.content,
      category_id: '',
      tag_ids: [] as number[],
      cover: '',
      brief: input.title
    }
    try {
      const res = await sessionFetch(ctx, 'https://api.juejin.cn/content_api/v1/article_draft/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Referer: 'https://juejin.cn/editor/drafts/new',
          Origin: 'https://juejin.cn'
        },
        body: JSON.stringify(body)
      })
      const json = (await res.json()) as { err_no?: number; err_msg?: string; data?: { id?: string } }
      if (json?.err_no === 0 && json?.data?.id) {
        return {
          ok: true,
          platformId: 'juejin',
          mode: 'draft',
          externalId: json.data.id,
          publishedAt: Date.now()
        }
      }
      return { ok: false, platformId: 'juejin', error: json?.err_msg ?? `HTTP ${res.status}` }
    } catch (err) {
      return { ok: false, platformId: 'juejin', error: (err as Error).message }
    }
  }
}
