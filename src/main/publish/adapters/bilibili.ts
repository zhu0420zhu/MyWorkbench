/* B站适配器（真实）：wbi 签名自实现 + 专栏草稿创建（草稿模式）
 * 签名算法为 B站前端公开逻辑：nav 取 img_key/sub_key → mixinKey → 参数排序 + md5 */
import { createHash } from 'node:crypto'
import type { PlatformAdapter, PublishContext, PublishResult } from '../adapter.ts'
import { sessionFetch, UA } from './fetch.ts'

/* ---------- wbi 签名 ---------- */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52
]

export function getMixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey
  let key = ''
  for (const i of MIXIN_KEY_ENC_TAB) key += raw[i] ?? ''
  return key.slice(0, 32)
}

export function signWbi(
  params: Record<string, string | number>,
  imgKey: string,
  subKey: string,
  wtsOverride?: number
): { wts: number; w_rid: string } {
  const mixinKey = getMixinKey(imgKey, subKey)
  const wts = wtsOverride ?? Math.floor(Date.now() / 1000)
  const all: Record<string, string | number> = { ...params, wts }
  const sorted = Object.keys(all)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(String(all[k]))}`)
    .join('&')
  const w_rid = createHash('md5').update(sorted + mixinKey).digest('hex')
  return { wts, w_rid }
}

/** 从 nav 接口获取 wbi key（img_key/sub_key 为文件名去掉扩展名） */
async function getWbiKeys(ctx: PublishContext): Promise<{ imgKey: string; subKey: string } | null> {
  try {
    const res = await sessionFetch(ctx, 'https://api.bilibili.com/x/web-interface/nav')
    const json = (await res.json()) as {
      code?: number
      data?: { wbi_img?: { img_url?: string; sub_url?: string } }
    }
    const img = json?.data?.wbi_img?.img_url ?? ''
    const sub = json?.data?.wbi_img?.sub_url ?? ''
    if (!img || !sub) return null
    const imgKey = img.split('/').pop()?.split('.')[0] ?? ''
    const subKey = sub.split('/').pop()?.split('.')[0] ?? ''
    return imgKey && subKey ? { imgKey, subKey } : null
  } catch {
    return null
  }
}

async function getCsrf(ctx: PublishContext): Promise<string> {
  const cookies = await ctx.session.cookies.get({ domain: '.bilibili.com', name: 'bili_jct' })
  return cookies[0]?.value ?? ''
}

export const bilibiliAdapter: PlatformAdapter = {
  id: 'bilibili',
  name: 'B站',
  loginUrl: 'https://www.bilibili.com/',
  status: 'ready',
  modeLabel: '存草稿（专栏草稿，wbi 签名）',

  async checkLogin(ctx) {
    try {
      const res = await sessionFetch(ctx, 'https://api.bilibili.com/x/web-interface/nav')
      const json = (await res.json()) as { code?: number; data?: { isLogin?: boolean } }
      return json?.code === 0 && json?.data?.isLogin === true
    } catch {
      return false
    }
  },

  async publish(input, ctx): Promise<PublishResult> {
    try {
      const keys = await getWbiKeys(ctx)
      if (!keys) return { ok: false, platformId: 'bilibili', error: '获取 wbi 密钥失败（未登录或接口变化）' }
      const csrf = await getCsrf(ctx)
      if (!csrf) return { ok: false, platformId: 'bilibili', error: '缺少 bili_jct（请重新登录）' }

      const params: Record<string, string | number> = {
        title: input.title.slice(0, 80),
        content: input.content,
        category: 0, // 分区 id：0 可能不被接受，需按创作中心实际分区调整
        list: '',
        tags: '热点',
        origin: 0,
        original: 1,
        reprint: 0,
        image_urls: '',
        summary: input.title.slice(0, 100),
        csrf
      }
      const { wts, w_rid } = signWbi(params, keys.imgKey, keys.subKey)
      const body = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), wts: String(wts), w_rid })

      const res = await sessionFetch(ctx, 'https://api.bilibili.com/x/article/creative/draft/edit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: 'https://www.bilibili.com/'
        },
        body: body.toString()
      })
      const json = (await res.json()) as { code?: number; message?: string; data?: { aid?: number | string } }
      if (json?.code === 0) {
        return {
          ok: true,
          platformId: 'bilibili',
          mode: 'draft',
          externalId: String(json?.data?.aid ?? ''),
          publishedAt: Date.now()
        }
      }
      return { ok: false, platformId: 'bilibili', error: json?.message ?? `HTTP ${res.status}` }
    } catch (err) {
      return { ok: false, platformId: 'bilibili', error: (err as Error).message }
    }
  }
}
