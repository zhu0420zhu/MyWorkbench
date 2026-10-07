/**
 * 文件监控 fileCache 清理探针
 * ==========================
 * 复现并验证「removeWatch 只删 watchedDirs、不清 fileCache」缺陷的修复：
 *   ① addWatch 后 fileCache 应出现该目录的文件条目；
 *   ② removeWatch 后该目录前缀的缓存条目必须清零（否则移除后缓存无限累积）；
 *   ③ 前缀隔离：删 `…/probe-W1` 不得误删 `…/probe-W10` 的缓存（不能用裸 startsWith(dirKey)）；
 *   ④ 竞态：addWatch 后立即 removeWatch，loadFileCache 的异步回填不得把已删目录塞回 cache。
 *
 * 运行（emit 前 / 复跑）：
 *   NODE_OPTIONS="" node --experimental-loader=./tests/loader.mjs --experimental-strip-types tests/watcher-cache-probe.mjs
 * 或（package.json 由 fix-package-res 维护，probe:watcher-cache 由 team-lead 统一添加）
 */
import { promises as fs, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getFileWatcher } from '../src/main/tools/fileWatcher'

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log('  [PASS] ' + name + (detail ? '  ' + detail : ''))
  } else {
    fail++
    console.log('  [FAIL] ' + name + (detail ? '  ' + detail : ''))
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const norm = (p) => p.replace(/[\\/]+$/, '')

/** fileCache 键格式固定为 `${dirKey}/${name}`，前缀固定带 '/' */
function countPrefix(cache, dirKey) {
  const prefix = `${dirKey}/`
  let n = 0
  for (const k of cache.keys()) if (k.startsWith(prefix)) n++
  return n
}

async function waitFor(fn, timeout = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (fn()) return true
    await sleep(20)
  }
  return fn()
}

async function makeDirWithFiles(root, name, n) {
  const d = join(root, name)
  await fs.mkdir(d, { recursive: true })
  for (let i = 0; i < n; i++) await fs.writeFile(join(d, `f${i}.txt`), `content-${i}`)
  return d
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'lm-wcache-'))
  const fw = getFileWatcher()
  const cache = fw.fileCache // TS private，运行期是普通属性

  /* ============ ① addWatch 填充缓存 ============ */
  console.log('\n[1] addWatch → fileCache 出现条目')
  const d1 = await makeDirWithFiles(root, 'probe-W1', 3)
  const k1 = norm(d1)
  ok('addWatch 返回 true', (await fw.addWatch(d1)) === true)
  const filled = await waitFor(() => countPrefix(cache, k1) >= 3)
  ok('缓存出现该目录的 3 条文件条目', filled, `got=${countPrefix(cache, k1)}`)

  /* ============ ② removeWatch 清空缓存 ============ */
  console.log('\n[2] removeWatch → 该目录缓存清零')
  ok('removeWatch 返回 true', (await fw.removeWatch(d1)) === true)
  ok('移除后该目录前缀缓存 = 0', countPrefix(cache, k1) === 0, `got=${countPrefix(cache, k1)}`)

  /* ============ ③ 前缀隔离（W1 vs W10） ============ */
  console.log('\n[3] 前缀隔离：删 probe-W1 不误伤 probe-W10')
  const d10 = await makeDirWithFiles(root, 'probe-W10', 2)
  const k10 = norm(d10)
  await fw.addWatch(d1) // 重新加入 W1
  await fw.addWatch(d10)
  const bothFilled = await waitFor(
    () => countPrefix(cache, k1) >= 3 && countPrefix(cache, k10) >= 2
  )
  ok('W1/W10 缓存均已填充', bothFilled, `w1=${countPrefix(cache, k1)} w10=${countPrefix(cache, k10)}`)
  await fw.removeWatch(d1)
  ok('删除 W1 后其缓存 = 0', countPrefix(cache, k1) === 0, `got=${countPrefix(cache, k1)}`)
  ok('W10 缓存原样保留 = 2', countPrefix(cache, k10) === 2, `got=${countPrefix(cache, k10)}`)
  await fw.removeWatch(d10) // 清理

  /* ============ ④ 竞态：addWatch 后立即 removeWatch ============ */
  console.log('\n[4] 竞态：立即移除后异步回填不得复活缓存')
  const dr = await makeDirWithFiles(root, 'probe-race', 4)
  const kr = norm(dr)
  await fw.addWatch(dr)
  await fw.removeWatch(dr) // 不给 loadFileCache 完成的机会
  await sleep(200)
  ok('立即移除 200ms 后该目录缓存仍 = 0', countPrefix(cache, kr) === 0, `got=${countPrefix(cache, kr)}`)

  /* ---------- 汇总 ---------- */
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  console.log(`\n==== watcher-cache-probe: ${pass} passed, ${fail} failed ====`)
  if (fail > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('probe crashed:', e)
  process.exitCode = 1
})
