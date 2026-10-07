/**
 * IM 协议适配（EvoFlow C2 完整版）
 * - feishu：自定义机器人 text / 飞书应用 token（app_id+secret）发 text
 * - dingtalk：加签/关键词机器人 text & markdown
 * - wecom：群机器人 text/markdown；企业应用 agent 需 corpid+corpsecret（骨架）
 * - telegram：Bot API sendMessage
 * - webhook：通用 JSON
 */
import type { ImChannel } from '../../shared/types.ts'

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; error?: string; json?: unknown }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const text = await res.text()
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      /* plain */
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 200)}` }
    return { ok: true, json }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** 飞书：优先应用身份 tenant_access_token，否则 webhook */
export async function sendFeishu(ch: ImChannel, title: string, body: string): Promise<{ ok: boolean; error?: string }> {
  const text = `${title}\n${body}`
  if (ch.appId && ch.appSecret) {
    const tok = await postJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: ch.appId,
      app_secret: ch.appSecret
    })
    const token = (tok.json as { tenant_access_token?: string } | null)?.tenant_access_token
    if (!token) return { ok: false, error: tok.error || '飞书取 token 失败' }
    // chatId 或 webhook 作 receive_id
    const receiveId = ch.chatId || ch.webhookUrl
    if (!receiveId) return { ok: false, error: '缺少 receive_id / chat_id' }
    return postJson(
      `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${ch.chatId ? 'chat_id' : 'open_id'}`,
      {
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text })
      }
    )
      .then((r) => (r.ok ? { ok: true } : { ok: false, error: r.error }))
  }
  if (!ch.webhookUrl) return { ok: false, error: '缺少飞书 Webhook 或应用凭证' }
  return postJson(ch.webhookUrl, { msg_type: 'text', content: { text } }).then((r) =>
    r.ok ? { ok: true } : { ok: false, error: r.error }
  )
}

/** 钉钉：机器人 text / markdown */
export async function sendDingtalk(ch: ImChannel, title: string, body: string): Promise<{ ok: boolean; error?: string }> {
  if (!ch.webhookUrl) return { ok: false, error: '缺少钉钉 Webhook' }
  return postJson(ch.webhookUrl, {
    msgtype: 'markdown',
    markdown: { title, text: `### ${title}\n\n${body}` }
  }).then((r) => (r.ok ? { ok: true } : { ok: false, error: r.error }))
}

/** 企业微信：群机器人；应用消息需 corpid+secret（可用 webhook 兜底） */
export async function sendWecom(ch: ImChannel, title: string, body: string): Promise<{ ok: boolean; error?: string }> {
  if (ch.corpSecret && ch.agentId) {
    // 企业应用：需 corpid，暂用 webhookUrl 存 corpid 或要求已有 token；完整链路需 client_ip 与可信域名
    return {
      ok: false,
      error: '企业微信应用直发需在渠道配置中提供完整 corpId/secret/agentId 并完成可信域名校验；当前请用群机器人 Webhook'
    }
  }
  if (!ch.webhookUrl) return { ok: false, error: '缺少企微 Webhook' }
  return postJson(ch.webhookUrl, {
    msgtype: 'markdown',
    markdown: { content: `**${title}**\n\n${body}` }
  }).then((r) => (r.ok ? { ok: true } : { ok: false, error: r.error }))
}

/** Telegram Bot API */
export async function sendTelegram(ch: ImChannel, title: string, body: string): Promise<{ ok: boolean; error?: string }> {
  const token = (ch.botToken || '').trim()
  const chatId = (ch.chatId || '').trim()
  if (!token || !chatId) return { ok: false, error: '缺少 Telegram botToken 或 chatId' }
  return postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text: `*${title}*\n${body}`.slice(0, 3800),
    parse_mode: 'Markdown'
  }).then((r) => (r.ok ? { ok: true } : { ok: false, error: r.error }))
}

export async function dispatchToIm(
  channel: ImChannel,
  title: string,
  body: string
): Promise<{ ok: boolean; error?: string }> {
  switch (channel.kind) {
    case 'feishu':
      return sendFeishu(channel, title, body)
    case 'dingtalk':
      return sendDingtalk(channel, title, body)
    case 'wecom':
      return sendWecom(channel, title, body)
    case 'telegram':
      return sendTelegram(channel, title, body)
    default:
      return postJson(channel.webhookUrl, {
        title,
        body,
        text: { content: `${title}\n${body}` }
      }).then((r) => (r.ok ? { ok: true } : { ok: false, error: r.error || 'Webhook 发送失败' }))
  }
}

export async function testImChannel(ch: ImChannel): Promise<{ ok: boolean; error?: string }> {
  return dispatchToIm(ch, '灵墨工作台 · 连接测试', `渠道「${ch.name}」协议适配成功（${ch.kind}）`)
}
