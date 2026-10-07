/**
 * 硬件信息缓存冒烟：实证 TTL 缓存与 force 绕过行为。
 * 跑法：NODE_OPTIONS="" node --experimental-strip-types tests/smoke-hw-cache.ts
 */
import { getSystemOverview, getDiskHealth } from '../src/main/hardware/hardwareInfo.ts'

const timed = async (label: string, fn: () => Promise<unknown>) => {
  const t0 = Date.now()
  const r = (await fn()) as { ok: boolean }
  console.log(`${label}: ${Date.now() - t0}ms ok=${r.ok}`)
  return Date.now() - t0
}

let failed = 0
const expect = (cond: boolean, msg: string) => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${msg}`)
  if (!cond) failed++
}

// 静态类（disk 探测最慢，最能体现差距）
const first = await timed('磁盘 首次采集 ', () => getDiskHealth())
const second = await timed('磁盘 缓存命中', () => getDiskHealth())
expect(second < Math.max(30, first * 0.2), `缓存命中应显著快于首次（${first}ms → ${second}ms）`)

// force 绕过缓存
const forced = await timed('磁盘 force 重采', () => getDiskHealth(true))
expect(forced > second, `force 应重新探测（${forced}ms > ${second}ms）`)

// 整机概览（含 system/bios/baseboard 等）
await timed('整机 首次采集 ', () => getSystemOverview())
const ovSecond = await timed('整机 缓存命中', () => getSystemOverview())
expect(ovSecond < 50, `整机缓存命中应 <50ms（实际 ${ovSecond}ms）`)

console.log(failed === 0 ? '\n结论: ✅ 缓存/预热/force 全部符合预期' : `\n结论: ❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
