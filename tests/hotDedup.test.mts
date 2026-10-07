// hotDedup 单测（node 24 type-stripping 直接运行：node hotDedup.test.mts）
import {
  normalizeTitle,
  simhash64,
  hammingDistance,
  dedupeAndRank
} from '../src/main/hotDedup.ts'

let passed = 0
let failed = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log('  ✓ ' + msg)
  } else {
    failed++
    console.error('  ✗ FAIL: ' + msg)
  }
}

// ---- 归一化 ----
assert(normalizeTitle('【微博】测试 热点！') === '微博测试热点', '归一化：去标点/空白')
assert(normalizeTitle('ＡＢＣ１２３') === 'abc123', '归一化：全角转半角')
assert(normalizeTitle('Hello World！') === 'helloworld', '归一化：英文小写')
assert(normalizeTitle('  ') === '', '归一化：纯空白为空')

// ---- SimHash ----
const h1 = simhash64('某地发生重大事件引发关注')
const h2 = simhash64('某地发生重大事件引发关注')
assert(h1 === h2, 'SimHash：相同标题哈希一致')
const h3 = simhash64('某地发生重大事件引发广泛关注')
assert(hammingDistance(h1, h3) < 20, `SimHash：相似标题距离较小（实际 ${hammingDistance(h1, h3)}）`)
const h4 = simhash64('完全无关的另一个话题内容xyz')
assert(hammingDistance(h1, h4) > hammingDistance(h1, h3), 'SimHash：无关标题距离更大')
assert(hammingDistance(0n, 0n) === 0, '汉明距离：相同为 0')
assert(hammingDistance(1n, 3n) === 1, '汉明距离：1^3=2 有 1 位')

// ---- 去重合并 + 排序 ----
const sameA = { platform: 'weibo', title: '某地发生重大事件引发关注', url: 'http://weibo/1', hot: 800000 }
const sameB = { platform: 'zhihu', title: '某地发生重大事件引发关注，你怎么看？', url: 'http://zhihu/2', hot: 3000000 }
const other = { platform: 'bilibili', title: '完全不同的视频标题内容', url: 'http://bili/3', hot: 100000 }

const events = dedupeAndRank([sameA, sameB, other], { platformWeights: { weibo: 1, zhihu: 0.95, bilibili: 0.9 } })
assert(events.length === 2, `去重：同题合并为 2 个事件（实际 ${events.length}）`)
const merged = events.find((e) => e.sources.length === 2)
assert(merged !== undefined, '同题事件含 2 个平台来源')
assert(merged !== undefined && merged.sources[0].platform === 'zhihu', '同题事件展示标题取热度最高（zhihu）')
assert(events[0] === merged, '多源事件评分更高，排前')
assert(merged !== undefined && merged.id.length === 16, '事件 id 为 16 位 hex')
assert(merged !== undefined && merged.hot === 3000000, '事件热度取最大值')

// ---- 边界 ----
assert(dedupeAndRank([]).length === 0, '空输入返回空')
assert(dedupeAndRank([{ platform: 'x', title: '  ', url: '', hot: 0 }]).length === 0, '空标题条目被过滤')

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
