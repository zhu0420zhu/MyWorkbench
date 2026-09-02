/* ============================================
 * CJK 感知分词器
 * 中文：单字 unigram + 相邻字 bigram（兼顾「文件」「文件管理」这类短语召回）
 * 英文/数字：按词（连续 [a-z0-9]）
 * 完全本地、无外部依赖，满足灵墨「离线优先 / 数据自主」约定。
 * ============================================================ */

const CJK_RE = /[一-鿿㐀-䶿豈-﫿]/

export function isCjk(ch: string): boolean {
  return CJK_RE.test(ch)
}

export function tokenize(text: string): string[] {
  const tokens = new Set<string>()
  if (!text) return []

  // 英文 / 数字词
  const ascii = text.toLowerCase().match(/[a-z0-9]+/g)
  if (ascii) for (const t of ascii) tokens.add(t)

  // CJK：单字 + 相邻 bigram
  const chars = [...text]
  let prev = ''
  for (const ch of chars) {
    if (isCjk(ch)) {
      tokens.add(ch)
      if (prev) tokens.add(prev + ch)
      prev = ch
    } else {
      prev = ''
    }
  }
  return [...tokens]
}
