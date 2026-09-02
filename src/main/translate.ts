import { net } from 'electron'

export const TRANSLATE_LANGS: Array<{ code: string; label: string }> = [
  { code: 'zh-CN', label: '中文' },
  { code: 'en', label: '英文' },
  { code: 'ja', label: '日文' },
  { code: 'ko', label: '韩文' },
  { code: 'fr', label: '法文' },
  { code: 'de', label: '德文' },
  { code: 'ru', label: '俄文' },
  { code: 'es', label: '西班牙文' }
]

/** 解码 MyMemory 返回的 HTML 实体 */
function decodeEntities(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
}

export async function translateText(
  text: string,
  source: string,
  target: string
): Promise<string> {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(
    trimmed
  )}&langpair=${encodeURIComponent(source)}|${encodeURIComponent(target)}`
  const res = await net.fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0' }
  })
  if (!res.ok) throw new Error(`翻译请求失败 HTTP ${res.status}`)
  const j = (await res.json()) as {
    responseStatus?: number
    responseData?: { translatedText?: string }
  }
  if (j.responseStatus !== 200) {
    throw new Error(`翻译失败（状态 ${j.responseStatus ?? '未知'}，可能超出免费额度）`)
  }
  const out = j.responseData?.translatedText ?? ''
  if (!out) throw new Error('翻译结果为空')
  return decodeEntities(out)
}
