// 发布队列单测（node 24 type-stripping：node queue.test.mts）
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { backoffMs, PublishQueue } from '../src/main/publish/queue.ts'
import { registerAdapter, getAdapter, listAdapters, type PlatformAdapter, type PublishContext } from '../src/main/publish/adapter.ts'

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

const mockCtx: PublishContext = { session: {} as never, log: () => {} }

// 清理注册表，注入 mock 适配器
function clearAdapters(): void {
  for (const a of listAdapters()) {
    // 注册表内部 Map，无法直接删；用唯一 id 规避冲突
    void a
  }
}

// ---- backoff ----
assert(backoffMs(0) === 60_000, '退避：第 1 次重试 1min')
assert(backoffMs(1) === 300_000, '退避：第 2 次重试 5min')
assert(backoffMs(2) === 1_800_000, '退避：第 3 次重试 30min')

// ---- 队列核心 ----
const dir = await fs.mkdtemp(join(tmpdir(), 'lingmo-pub-'))
const file = join(dir, 'queue.json')

// mock 成功适配器
let successAdapter: PlatformAdapter = {
  id: 'mock-ok',
  name: 'MockOK',
  loginUrl: 'https://mock',
  status: 'ready',
  modeLabel: '直接发布',
  checkLogin: async () => true,
  publish: async (input) => ({ ok: true, platformId: 'mock-ok', mode: 'direct', externalId: 'ext-1' })
}
registerAdapter(successAdapter)

// mock 失败一次后成功适配器
let failOnce = 0
registerAdapter({
  id: 'mock-failonce',
  name: 'MockFailOnce',
  loginUrl: 'https://mock',
  status: 'ready',
  modeLabel: 'draft',
  checkLogin: async () => true,
  publish: async (input) => {
    failOnce++
    if (failOnce === 1) return { ok: false, platformId: 'mock-failonce', error: '限流，稍后再试' }
    return { ok: true, platformId: 'mock-failonce', mode: 'draft', externalId: 'ext-2' }
  }
})

// mock 骨架适配器
registerAdapter({
  id: 'mock-skeleton',
  name: 'MockSkeleton',
  loginUrl: 'https://mock',
  status: 'skeleton',
  modeLabel: '待适配',
  checkLogin: async () => false,
  publish: async () => ({ ok: false, platformId: 'mock-skeleton', error: 'x' })
})

const queue = new PublishQueue({ filePath: file, maxRetries: 2 })
await queue.load()

// 1. 成功任务
const j1 = await queue.add({ title: 't1', content: 'c1' }, 'mock-ok')
assert(j1.status === 'pending', '新增任务为 pending')
await queue.runJob(j1.id, mockCtx)
const r1 = queue.list().find((j) => j.id === j1.id)
assert(r1?.status === 'success' && r1.externalId === 'ext-1', '成功任务 status=success + externalId')
assert(r1?.mode === 'direct', '成功任务记录发布方式')

// 2. 失败一次后成功（重试）
const j2 = await queue.add({ title: 't2', content: 'c2' }, 'mock-failonce')
await queue.runJob(j2.id, mockCtx)
const r2a = queue.list().find((j) => j.id === j2.id)
assert(r2a?.status === 'failed' && r2a.retryCount === 1 && r2a.error === '限流，稍后再试', '首次失败：failed + retryCount=1 + 错误信息')
// 未到退避时间，pendingJobs 不应包含
assert(queue.pendingJobs().find((j) => j.id === j2.id) === undefined, '退避期内不自动重跑')
// 强制重试
await queue.retry(j2.id, true)
await queue.runJob(j2.id, mockCtx)
const r2b = queue.list().find((j) => j.id === j2.id)
assert(r2b?.status === 'success' && r2b.externalId === 'ext-2', '强制重试后成功')

// 3. 骨架适配器任务
const j3 = await queue.add({ title: 't3', content: 'c3' }, 'mock-skeleton')
await queue.runJob(j3.id, mockCtx)
const r3 = queue.list().find((j) => j.id === j3.id)
assert(r3?.status === 'failed' && (r3.error ?? '').includes('尚未完成'), '骨架适配器任务标记 failed（待适配）')

// 4. 持久化
const queue2 = new PublishQueue({ filePath: file, maxRetries: 2 })
await queue2.load()
assert(queue2.list().length === queue.list().length, '队列 JSON 持久化：重载后任务数一致')
assert(queue2.list().find((j) => j.id === j1.id)?.status === 'success', '持久化保留任务状态')

// 5. 未知平台
const j4 = await queue.add({ title: 't4', content: 'c4' }, 'no-such-platform')
await queue.runJob(j4.id, mockCtx)
const r4 = queue.list().find((j) => j.id === j4.id)
assert(r4?.status === 'failed' && (r4.error ?? '').includes('适配器不存在'), '未知平台任务标记 failed')

// ---- P2 排程 ----
const future = Date.now() + 60 * 60 * 1000
const past = Date.now() - 1000
const s1 = await queue.add({ title: 'sched-future', content: 'x' }, 'mock-ok', '', future)
const s2 = await queue.add({ title: 'sched-past', content: 'x' }, 'mock-ok', '', past)
assert(s1.scheduledAt === future, '排程任务记录 scheduledAt')
assert(queue.pendingJobs().find((j) => j.id === s1.id) === undefined, '未到预约时间的任务不进入待执行')
assert(queue.pendingJobs().find((j) => j.id === s2.id) !== undefined, '已到预约时间的任务进入待执行')
await queue.runJob(s1.id, mockCtx)
const rS1 = queue.list().find((j) => j.id === s1.id)
assert(rS1?.status === 'pending', '未到期任务 runJob 不执行（保持 pending）')
// 立即执行过去时间的任务
await queue.runJob(s2.id, mockCtx)
const rS2 = queue.list().find((j) => j.id === s2.id)
assert(rS2?.status === 'success', '到期任务执行成功')

await fs.rm(dir, { recursive: true, force: true })
void clearAdapters
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
