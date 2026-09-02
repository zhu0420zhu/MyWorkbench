/* 微信公众号适配器（真实，官方开发者 API）：
 * 配置 AppID/Secret → access_token → 图文草稿 draft/add（草稿模式）
 * content 需 HTML（内置极简 markdown → HTML 转换） */
import { net } from 'electron'
import type { PlatformAdapter, PublishContext, PublishResult } from '../adapter.ts'
import { getGzhCredential } from '../gzhCredential.ts'

/** 极简 markdown → HTML（标题/粗体/段落/换行），满足公众号图文正文基本格式 */
function mdToHtml(md: string): string {
  const lines = md.split(/\r?\n/)
  let html = ''
  let inList = false
  const closeList = (): void => {
    if (inList) {
      html += '</ul>'
      inList = false
    }
  }
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    let escaped = t
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
    const h = escaped.match(/^(#{1,4})\s+(.+)$/)
    if (h) {
      closeList()
      const level = h[1].length
      html += `<h${level}>${h[2]}</h${level}>`
      continue
    }
    if (/^[-*]\s+/.test(escaped)) {
      if (!inList) {
        html += '<ul>'
        inList = true
      }
      html += `<li>${escaped.replace(/^[-*]\s+/, '')}</li>`
      continue
    }
    closeList()
    html += `<p>${escaped}</p>`
  }
  closeList()
  return html
}

async function getAccessToken(appId: string, secret: string): Promise<{ token: string; error?: string }> {
  try {
    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`
    const res = await net.fetch(url)
    const json = (await res.json()) as { access_token?: string; errmsg?: string }
    if (json?.access_token) return { token: json.access_token }
    return { token: '', error: json?.errmsg ?? `HTTP ${res.status}` }
  } catch (err) {
    return { token: '', error: (err as Error).message }
  }
}

export const gongzhonghaoAdapter: PlatformAdapter = {
  id: 'gongzhonghao',
  name: '公众号',
  loginUrl: 'https://mp.weixin.qq.com/',
  status: 'ready',
  modeLabel: '存草稿（官方接口，需配置 AppID/Secret）',

  async checkLogin(_ctx) {
    // 公众号为开发者模式：已配置凭证即视为"已登录"
    return (await getGzhCredential()) !== null
  },

  async publish(input, _ctx): Promise<PublishResult> {
    const cred = await getGzhCredential()
    if (!cred) {
      return { ok: false, platformId: 'gongzhonghao', error: '未配置 AppID/Secret（在发布面板「公众号」行配置）' }
    }
    const { token, error } = await getAccessToken(cred.appId, cred.secret)
    if (!token) return { ok: false, platformId: 'gongzhonghao', error: `获取 access_token 失败: ${error ?? ''}` }

    const article = {
      title: input.title.slice(0, 64),
      author: '',
      digest: input.title.slice(0, 120),
      content: mdToHtml(input.content),
      content_source_url: '',
      thumb_media_id: '',
      need_open_comment: 0,
      only_fans_can_comment: 0
    }
    try {
      const res = await net.fetch(`https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ articles: [article] })
      })
      const json = (await res.json()) as { media_id?: string; errcode?: number; errmsg?: string }
      if (json?.media_id) {
        return { ok: true, platformId: 'gongzhonghao', mode: 'draft', externalId: json.media_id, publishedAt: Date.now() }
      }
      const msg = json?.errmsg ?? `HTTP ${res.status}`
      const hint = (json?.errcode === 40007 || String(msg).includes('thumb')) ? '（draft/add 需要封面素材 thumb_media_id，请先上传封面或调整接口）' : ''
      return { ok: false, platformId: 'gongzhonghao', error: `${msg}${hint}` }
    } catch (err) {
      return { ok: false, platformId: 'gongzhonghao', error: (err as Error).message }
    }
  }
}
