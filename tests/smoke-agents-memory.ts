/* 无头冒烟：记忆核心 / 常驻智能体作业 / 调度到期 / QA 偏好 / Vision 图片入库回退
 * 用法：node --experimental-strip-types tests/smoke-agents-memory.ts
 * 仅依赖无 electron 的纯逻辑模块。 */
import { MemoryCore } from '../src/main/organize/memoryCore.ts'
import { fetchHnBriefing } from '../src/main/agents/jobs/hn.ts'
import { fetchReleaseRadar } from '../src/main/agents/jobs/releaseRadar.ts'
import { isJobDue } from '../src/main/agents/due.ts'
import { QaService } from '../src/main/searchIndex/qa.ts'
import { Indexer } from '../src/main/searchIndex/indexer.ts'
import type { AiChatMessage } from '../src/shared/types.ts'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++
    console.log(`✓ ${name}`)
  } else {
    fail++
    console.log(`✗ ${name} ${extra}`)
  }
}

const fakeFetch = (body: unknown): typeof fetch =>
  (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch

// 1) 分类记忆核心
{
  const m = new MemoryCore()
  m.record('a.pdf', '文档')
  check('记忆1次未达阈值→lookup null', m.lookup('b.pdf') === null)
  m.record('a.pdf', '文档')
  check('记忆2次达阈值→lookup 返回类别', m.lookup('x.PDF') === '文档')
  m.record('a.pdf', '其他')
  check('再次纠正→类别更新为最新', m.lookup('y.pdf') === '其他')
  check('无扩展名键为 __noext__', m.lookup('noext', 0) === null && m.lookup('noext', 1) === null)
}

// 2) HN 简报作业（注入 fetch）
{
  const hits = Array.from({ length: 10 }, (_, i) => ({
    title: `标题${i}`,
    url: `https://example.com/${i}`,
    points: 100 - i,
    author: `u${i}`,
    objectID: `${i}`
  }))
  const r = await fetchHnBriefing(fakeFetch({ hits }))
  check('HN ok', r.ok === true)
  check('HN items=10', r.items.length === 10)
  check('HN summary 含条数', r.summary.includes('10'))
  const failingFetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch
  const bad = await fetchHnBriefing(failingFetch)
  check('HN 异常→ok false', bad.ok === false)
}

// 3) Release Radar 作业（注入 fetch + lastKnown 对比）
{
  const body = [
    { tag_name: 'v2.0.0', html_url: 'https://x/2', published_at: '2026-01-02' }
  ]
  const r = await fetchReleaseRadar(
    ['o/r1', 'o/r2'],
    fakeFetch(body),
    { 'o/r1': 'v1.0.0' }
  )
  check('ReleaseRadar ok', r.ok === true)
  check('ReleaseRadar 发现1个新版本', (r.newReleases?.length ?? 0) === 1)
  check('ReleaseRadar summary 含新版本', r.summary.includes('新版本'))
  const none = await fetchReleaseRadar(['o/r1'], fakeFetch(body), { 'o/r1': 'v2.0.0' })
  check('版本未变→无新发布', (none.newReleases?.length ?? 0) === 0)
}

// 4) 调度到期纯函数
{
  check('isJobDue(null)→true', isJobDue(null, 1000, 0) === true)
  check('isJobDue 未到期→false', isJobDue(1000, 1000, 1500) === false)
  check('isJobDue 到期→true', isJobDue(1000, 1000, 2001) === true)
}

// 5) QA 个性化偏好
{
  const fakeLlm = (msgs: AiChatMessage[]) => {
    const sys = (msgs.find((m) => m.role === 'system')?.content ?? '') as string
    return Promise.resolve({ ok: true, text: `SYS[${sys.includes('详尽') ? 'D' : sys.includes('简洁') ? 'C' : '?'}]` })
  }
  const fakeIdx = { queryChunks: () => [{ id: 'c1', docId: 'd', filePath: 'f.txt', text: '内容', startChar: 0 }] }
  const detailed = await new QaService(fakeIdx, fakeLlm).ask({ question: 'q', prefs: { answerStyle: 'detailed' } })
  check('QA detailed→系统提示含「详尽」', detailed.answer?.includes('D') ?? false)
  const concise = await new QaService(fakeIdx, fakeLlm).ask({ question: 'q', prefs: { answerStyle: 'concise' } })
  check('QA concise→系统提示含「简洁」', concise.answer?.includes('C') ?? false)

  const manyIdx = {
    queryChunks: () =>
      Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, docId: 'd', filePath: 'f.txt', text: `内容${i}`, startChar: i }))
  }
  const capped = await new QaService(manyIdx, fakeLlm).ask({ question: 'q', prefs: { maxCitations: 1 } })
  check('QA maxCitations=1→引用截断为1', capped.citations.length === 1)
}

// 6) Vision 图片入库回退
{
  const idx = new Indexer(':memory:')
  // 视觉描述可用 → origin image
  const r1 = await idx.ingest('photo.png', async () => '一只橘猫坐在窗台')
  check('图片入库(视觉描述)成功', r1.success && r1.chunkCount > 0)
  const hits1 = idx.queryChunks('橘猫', 5)
  check('图片内容可被检索', hits1.length > 0 && hits1[0].origin === 'image')
  // 视觉描述不可用 → 退化文件名索引
  const r2 = await idx.ingest('screenshot.PNG', async () => null)
  check('图片退化文件名索引成功', r2.success === true)
  const hits2 = idx.queryChunks('screenshot', 5)
  check('退化文件名可被检索', hits2.some((c) => c.filePath.endsWith('screenshot.PNG')))
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) process.exit(1)
