/* ============================================
 * 热点去重与排序模块（P0 聚合核心）
 * 标题归一化 → 64bit SimHash → 汉明距离去重合并 → 多源共识加权排序
 * ============================================ */

/* ---------- 输入条目（各平台原始数据统一字段） ---------- */
export interface HotSourceItem {
  platform: string // 平台 id（weibo/zhihu/...）
  title: string
  url: string
  hot: number // 原始热度值
}

/* ---------- 聚合事件 ---------- */
export interface HotEventSource {
  platform: string
  title: string
  url: string
  hot: number
}

export interface HotEvent {
  id: string // 稳定事件 id（simhash hex）
  title: string // 展示标题（取热度最高平台）
  score: number // 综合评分（降序排列依据）
  hot: number // 展示热度（各源最大值）
  sources: HotEventSource[] // 同题多平台来源
  firstSeen: number // 首次出现时间戳
}

export interface DedupeOptions {
  /** 平台权重（排序用），默认全 1 */
  platformWeights?: Record<string, number>
  /** SimHash 汉明距离阈值，默认 8（64bit 中 ≤8 位不同视为同题） */
  hammingThreshold?: number
  /** 多源共识加成系数，默认 6 */
  consensusBonus?: number
}

/* ---------- 标题归一化 ---------- */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    // 全角 → 半角
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    // 去除常见标点与空白
    .replace(/[\s,.;:!?'"()\[\]{}|/\\\-_+&$#@%*^~`，。！？；：、""''（）《》【】·…—～〈〉「」『』]/g, '')
    // 去除其余非常规字符（保留中日韩汉字、英数）
    .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')
}

/* ---------- SimHash（64bit，bigint 表示） ---------- */
function fnv1a64(input: string): bigint {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i))
    hash = (hash * prime) & 0xffffffffffffffffn
  }
  return hash
}

function tokenize(norm: string): string[] {
  if (norm.length <= 2) return norm ? [norm] : []
  const tokens: string[] = []
  for (let i = 0; i < norm.length - 1; i++) tokens.push(norm.slice(i, i + 2))
  return tokens
}

export function simhash64(text: string): bigint {
  const norm = normalizeTitle(text)
  const tokens = tokenize(norm)
  if (tokens.length === 0) return 0n
  const v = new Int32Array(64)
  for (const token of tokens) {
    const h = fnv1a64(token)
    for (let i = 0; i < 64; i++) {
      v[i] += (h >> BigInt(i)) & 1n ? 1 : -1
    }
  }
  let hash = 0n
  for (let i = 0; i < 64; i++) {
    if (v[i] > 0) hash |= 1n << BigInt(i)
  }
  return hash
}

/* ---------- 汉明距离 ---------- */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b
  let count = 0
  while (x !== 0n) {
    x &= x - 1n
    count++
  }
  return count
}

/* ---------- 去重合并 + 排序 ---------- */
export function dedupeAndRank(items: HotSourceItem[], opts: DedupeOptions = {}): HotEvent[] {
  const { platformWeights = {}, hammingThreshold = 8, consensusBonus = 6 } = opts

  const groups: { hash: bigint; items: HotSourceItem[] }[] = []
  for (const item of items) {
    if (!item.title?.trim()) continue
    const hash = simhash64(item.title)
    let placed = false
    for (const g of groups) {
      if (hammingDistance(hash, g.hash) <= hammingThreshold) {
        g.items.push(item)
        // 组指纹取条目数最多的标题哈希（简单多数）
        placed = true
        break
      }
    }
    if (!placed) groups.push({ hash, items: [item] })
  }

  const events: HotEvent[] = groups.map((g) => {
    const list = g.items
    // 按热度降序取展示标题
    const sorted = [...list].sort((a, b) => b.hot - a.hot)
    const top = sorted[0]
    // 多源共识：出现平台数
    const platformSet = new Set(list.map((i) => i.platform))
    // 评分：Σ(平台热度归一化 × 权重) + 共识加成
    let score = 0
    let maxHot = 0
    for (const item of list) {
      const w = platformWeights[item.platform] ?? 1
      // 热度归一化：log1p 压缩 + 平台内相对（用全局 max 归一）
      const h = Math.log1p(Math.max(0, item.hot)) * w
      score += h
      if (item.hot > maxHot) maxHot = item.hot
    }
    score += platformSet.size * consensusBonus

    const now = Date.now()
    return {
      id: g.hash.toString(16).padStart(16, '0'),
      title: top.title,
      score: Math.round(score * 100) / 100,
      hot: maxHot,
      sources: sorted.map((i) => ({ platform: i.platform, title: i.title, url: i.url, hot: i.hot })),
      firstSeen: now
    }
  })

  events.sort((a, b) => b.score - a.score)
  return events
}
