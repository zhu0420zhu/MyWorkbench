// 无头测试：feed 聚合（合并 / 去重 / 排序）纯逻辑
// 运行：node --experimental-strip-types tests/feed-aggregator.test.ts
import { dedupeAndRank, normalizeTitle, simhash64, hammingDistance } from '../src/main/hotDedup.ts'
import { buildFeedResult } from '../src/main/feed/aggregateCore.ts'
import type { FeedItem, FeedItemSource, FeedSourceMeta, FeedSource } from '../src/shared/types.ts'

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error('  FAIL -', msg)
    process.exit(1)
  }
  console.log('  ok  -', msg)
}

/* ---------- 工厂 ---------- */
function meta(id: string, name: string, kind: 'hot' | 'agent'): FeedSourceMeta {
  return {
    id,
    name,
    kind,
    enabled: true,
    intervalMs: 0,
    lastRunAt: null,
    lastStatus: 'idle' as const,
    lastItemCount: 0
  }
}

function item(
  id: string,
  sourceId: string,
  sourceKind: 'hot' | 'agent',
  title: string,
  hot: number,
  category = '综合'
): FeedItem {
  return {
    id,
    title,
    url: '',
    hot,
    sources: [] as FeedItemSource[],
    sourceKind,
    sourceId,
    category,
    firstSeen: 0
  }
}

// buildFeedResult 仅用到 FeedSource.id / kind，运行时类型擦除，构造最小桩即可
function src(id: string, kind: 'hot' | 'agent'): FeedSource {
  return { id, kind } as FeedSource
}

/* ============================================================
 * dedupeAndRank / normalizeTitle
 * ============================================================ */
function testDedupe(): void {
  console.log('=== dedupeAndRank / normalizeTitle ===')

  // 1. 跨源合并：同标题不同平台 → 合并为 1 条，sources.length === 2
  {
    const items = [
      { platform: 'weibo', title: '苹果发布新机', url: 'https://weibo/x', hot: 100 },
      { platform: 'zhihu', title: '苹果发布新机', url: 'https://zhihu/x', hot: 100 }
    ]
    const r = dedupeAndRank(items)
    assert(r.length === 1, '跨源同标题合并为 1 条')
    assert(r[0].sources.length === 2, '合并后 sources.length === 2')
    const plats = r[0].sources.map((s) => s.platform)
    assert(plats.includes('weibo') && plats.includes('zhihu'), '两个平台都在 sources 中')
  }

  // 2. 标点 / 空格变体合并（normalizeTitle 归一后 SimHash 一致）
  {
    const items = [
      { platform: 'weibo', title: '苹果 发布 新机', url: '', hot: 100 },
      { platform: 'zhihu', title: '苹果发布新机！', url: '', hot: 100 }
    ]
    const r = dedupeAndRank(items)
    assert(r.length === 1, '空格/标点变体归一后合并为 1 条')
  }

  // 3. URL 不是去重键：同 URL 但标题明显不同 → 2 条（文档行为：url 不参与去重）
  {
    const sameUrl = 'https://news.example.com/same'
    const items = [
      { platform: 'a', title: '苹果发布新款iPhone', url: sameUrl, hot: 100 },
      { platform: 'b', title: '央行宣布降准降息', url: sameUrl, hot: 100 }
    ]
    const r = dedupeAndRank(items)
    assert(r.length === 2, '同 URL 不同标题 → 2 条（url 非去重键）')
  }

  // 4. 汉明阈值：近义长标题默认合并；阈值 0 不合并
  {
    const near = [
      { platform: 'a', title: '人工智能大模型技术迎来重大突破与广泛应用前景广阔', url: '', hot: 100 },
      { platform: 'b', title: '人工智能大模型技术迎来重大突破和广泛应用前景广阔', url: '', hot: 100 }
    ]
    assert(hammingDistance(simhash64(near[0].title), simhash64(near[1].title)) > 0, '近义标题汉明距离 > 0')
    const merged = dedupeAndRank(near)
    assert(merged.length === 1, '默认阈值(8)下近义标题合并为 1 条')
    const strict = dedupeAndRank(near, { hammingThreshold: 0 })
    assert(strict.length === 2, 'hammingThreshold=0 时同对标题不合并（长度 2）')
  }

  // 5. 按 score 降序：2 源(共识+12) 应排在 1 源(共识+6) 之前
  {
    const oneTitle = '科技板块领涨两市半导体爆发'
    const twoTitle = '新能源补贴政策落地车企普遍受益'
    const items = [
      { platform: 'p1', title: oneTitle, url: '', hot: 100 },
      { platform: 'p2a', title: twoTitle, url: '', hot: 100 },
      { platform: 'p2b', title: twoTitle, url: '', hot: 100 }
    ]
    const r = dedupeAndRank(items)
    assert(r.length === 2, '两个不同标题 → 2 条事件')
    assert(r[0].sources.length === 2 && r[1].sources.length === 1, '多源事件 sources.length=2 排在前')
    assert(r[0].score >= r[1].score, 'events 按 score 降序排列')
  }

  // 6. 共识加成量级：3 平台同题 vs 1 平台同题（每平台 hot 相同）
  {
    const aTitle = 'A平台独家报道某突发事件'
    const bTitle = 'B平台聚合热点事件标题唯一'
    const items = [
      { platform: 'p1', title: aTitle, url: '', hot: 100 },
      { platform: 'p2', title: bTitle, url: '', hot: 100 },
      { platform: 'p3', title: bTitle, url: '', hot: 100 },
      { platform: 'p4', title: bTitle, url: '', hot: 100 }
    ]
    const r = dedupeAndRank(items)
    const a = r.find((e) => e.title === aTitle)!
    const b = r.find((e) => e.title === bTitle)!
    assert(b.score - a.score >= 11, `3 源共识加成比 1 源高 ≥11（实际 ${b.score - a.score}）`)
  }

  // 7. 空输入返回 [] 不抛错
  {
    const r = dedupeAndRank([])
    assert(Array.isArray(r) && r.length === 0, '空输入 dedupeAndRank 返回 []')
  }

  // 8. 空白标题被跳过，其余仍处理
  {
    const items = [
      { platform: 'x', title: '   ', url: '', hot: 5 },
      { platform: 'y', title: '有效新闻标题内容', url: '', hot: 3 }
    ]
    const r = dedupeAndRank(items)
    assert(r.length === 1, '空白标题被跳过，仅保留有效条目')
    assert(r[0].title === '有效新闻标题内容', '有效条目正常输出')
  }

  // 9. id 稳定性 = simhash64(title) 的 16 位 hex
  {
    const T = '测试标题唯一性稳定性'
    const r = dedupeAndRank([{ platform: 'x', title: T, url: '', hot: 1 }])
    assert(
      r[0].id === simhash64(T).toString(16).padStart(16, '0'),
      'event.id === simhash64(title) 的 16 位 hex'
    )
  }

  // 10. 多源来源归属保留：platform/title/url/hot 一一对应
  {
    const items = [
      { platform: 'weibo', title: '东京奥运会开幕式今晚举行', url: 'https://weibo/o', hot: 80 },
      { platform: 'zhihu', title: '东京奥运会开幕式今晚举行', url: 'https://zhihu/o', hot: 120 }
    ]
    const r = dedupeAndRank(items)
    assert(r.length === 1, '多源同题合并为 1 条')
    const srcs = r[0].sources
    assert(srcs.length === 2, 'sources.length === 2')
    const w = srcs.find((s) => s.platform === 'weibo')!
    const z = srcs.find((s) => s.platform === 'zhihu')!
    assert(w.title === '东京奥运会开幕式今晚举行' && w.url === 'https://weibo/o' && w.hot === 80, 'weibo 源 title/url/hot 正确')
    assert(z.title === '东京奥运会开幕式今晚举行' && z.url === 'https://zhihu/o' && z.hot === 120, 'zhihu 源 title/url/hot 正确')
  }
}

/* ============================================================
 * buildFeedResult
 * ============================================================ */
function testBuildFeedResult(): void {
  console.log('=== buildFeedResult ===')

  // 11. sourceKind 保留（agent / hot 不串）
  // 注意：标题需足够长且明显不同，否则 SimHash 短串易碰撞（汉明≤8 被误并）
  {
    const a1 = item('a1', 'hn', 'agent', '智能体自动生成每周工作周报内容', 5, '科技')
    const h1 = item('h1', 'weibo', 'hot', '微博热议多座城市遭遇极端高温天气', 50, '综合')
    const metaMap = new Map<string, FeedSourceMeta>([
      ['hn', meta('hn', 'HN', 'agent')],
      ['weibo', meta('weibo', '微博', 'hot')]
    ])
    const enabled = [src('hn', 'agent'), src('weibo', 'hot')]
    const r = buildFeedResult([a1, h1], metaMap, enabled)
    assert(r.items.length === 2, '两个明显不同的标题 → 2 条 FeedItem（不误并）')
    const agents = r.items.filter((i) => i.sourceKind === 'agent')
    const hots = r.items.filter((i) => i.sourceKind === 'hot')
    assert(agents.length === 1 && hots.length === 1, '输出各保留 1 个 agent 与 1 个 hot')
    assert(agents[0].sourceId === 'hn' && hots[0].sourceId === 'weibo', 'sourceKind 未串：agent=hn, hot=weibo')
  }

  // 12. metaMap 来源展示名归因：同题多源 → sources.name 取自 metaMap
  {
    const wi = item('w1', 'weibo', 'hot', '共同标题内容一致', 10)
    const zi = item('z1', 'zhihu', 'hot', '共同标题内容一致', 20)
    const metaMap = new Map<string, FeedSourceMeta>([
      ['weibo', meta('weibo', '微博', 'hot')],
      ['zhihu', meta('zhihu', '知乎', 'hot')]
    ])
    const enabled = [src('weibo', 'hot'), src('zhihu', 'hot')]
    const r = buildFeedResult([wi, zi], metaMap, enabled)
    assert(r.items.length === 1, '同题两源合并为 1 条 FeedItem')
    assert(r.items[0].sources.length === 2, 'FeedItem.sources.length === 2')
    const names = r.items[0].sources.map((s) => s.name)
    assert(names.includes('微博') && names.includes('知乎'), 'sources.name 取自 metaMap（微博/知乎）')
  }

  // 13. 空 collected → items 空，sources 全 ok，count 0，updatedAt 为 number
  {
    const metaMap = new Map<string, FeedSourceMeta>()
    const enabled = [src('a', 'hot'), src('b', 'agent')]
    const r = buildFeedResult([], metaMap, enabled)
    assert(r.items.length === 0, '空 collected → items.length === 0')
    assert(r.sources.length === enabled.length, 'sources.length === enabled.length')
    assert(
      r.sources.every((s) => s.status === 'ok' && s.count === 0),
      '每个 source status=ok 且 count=0'
    )
    assert(typeof r.updatedAt === 'number', 'updatedAt 为 number')
  }

  // 14. firstSeen 存在
  {
    const wi = item('w1', 'weibo', 'hot', '共同标题内容一致', 10)
    const zi = item('z1', 'zhihu', 'hot', '共同标题内容一致', 20)
    const metaMap = new Map<string, FeedSourceMeta>([
      ['weibo', meta('weibo', '微博', 'hot')],
      ['zhihu', meta('zhihu', '知乎', 'hot')]
    ])
    const enabled = [src('weibo', 'hot'), src('zhihu', 'hot')]
    const r = buildFeedResult([wi, zi], metaMap, enabled)
    assert(r.items.every((i) => typeof i.firstSeen === 'number'), '非空结果每条均含 firstSeen(number)')
  }
}

function run(): void {
  testDedupe()
  testBuildFeedResult()
  console.log('\nfeed 聚合全部通过：dedupeAndRank 去重/排序语义 + buildFeedResult 归并语义均符合预期。')
}

run()
