/**
 * 默认监控目录「已移除」持久化探针
 * ================================
 * 复现并验证缺陷：getFileWatcher() 在单例创建时无条件注册「桌面/下载」，移除只活在内存里，
 * 重启必复活（UI 显示「已移除」但下次开又在）。修复后：
 *   ① 初次 initFileWatcher() → 列表含「桌面」「下载」；
 *   ② removeWatch(桌面) → 列表不含桌面，且 userData/watcher-dirs.json 落盘记录该「已移除」键；
 *   ③ 用**全新模块实例**（查询串导入模拟重启）重新 init → 仍不含桌面（证明真从 JSON 重读）；
 *   ④ addWatch(桌面) → 列表又含桌面，且 JSON 里 removedDefaults 不再包含它（撤销「已移除」意图）；
 *   ⑤ 再起一个全新实例 → 含桌面（撤销也已落盘）。
 *
 * 运行（emit 前 / 复跑）：
 *   NODE_OPTIONS="" node --experimental-loader=./tests/loader.mjs --experimental-strip-types tests/watcher-persist-probe.mjs
 * 或（package.json 由 fix-package-res 维护，probe:watcher-persist 由 team-lead 统一添加）
 */
import { promises as fs, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* 沙箱 HOME：必须在导入 fileWatcher 之前设置（模块加载时会用 homedir() 计算默认目录），
   这样既不触碰真实用户目录，也让「桌面/下载」路径可控。 */
const sandboxHome = mkdtempSync(join(tmpdir(), 'lm-whome-'))
process.env.USERPROFILE = sandboxHome
process.env.HOME = sandboxHome

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

const norm = (p) => p.replace(/[\\/]+$/, '')
const keyOf = (p) => (process.platform === 'win32' ? norm(p).toLowerCase() : norm(p))

async function main() {
  await fs.mkdir(join(sandboxHome, 'Desktop'), { recursive: true })
  await fs.mkdir(join(sandboxHome, 'Downloads'), { recursive: true })

  const m1 = await import('../src/main/tools/fileWatcher.ts?persist=first')
  const desktop = m1.getDesktopDirectory()
  const downloads = m1.getDownloadsDirectory()
  const kd = norm(desktop)
  const kdl = norm(downloads)

  ok(
    '沙箱 HOME 生效（Desktop 落在沙箱内）',
    keyOf(desktop).startsWith(keyOf(sandboxHome)),
    `desktop=${desktop}`
  )
  // 默认目录必须真实存在，否则 addWatch 会拒绝（探针自己保证）
  await fs.mkdir(desktop, { recursive: true })
  await fs.mkdir(downloads, { recursive: true })

  const stub = await import('./electron-stub.mjs')
  const prefsFile = join(stub.app.getPath('userData'), 'watcher-dirs.json')
  await fs.rm(prefsFile, { force: true }) // 干净起点

  /* ============ ① 初次初始化 ============ */
  console.log('\n[1] 初次 initFileWatcher() → 含桌面/下载')
  await m1.initFileWatcher()
  let list1 = m1.getFileWatcher().watchedDirectories.map((w) => w.path)
  ok('列表含桌面', list1.includes(kd), `list=${JSON.stringify(list1)}`)
  ok('列表含下载', list1.includes(kdl))
  ok('列表恰好 2 个默认目录', list1.length === 2, `len=${list1.length}`)

  /* ============ ② 移除桌面并落盘 ============ */
  console.log('\n[2] removeWatch(桌面) → 列表移除 + JSON 落盘')
  ok('removeWatch 返回 true', (await m1.getFileWatcher().removeWatch(kd)) === true)
  let list2 = m1.getFileWatcher().watchedDirectories.map((w) => w.path)
  ok('移除后列表不含桌面', !list2.includes(kd))
  ok('移除后列表仍含下载', list2.includes(kdl))
  const raw1 = JSON.parse(await fs.readFile(prefsFile, 'utf-8'))
  ok(
    'JSON 已落盘 removedDefaults 含桌面键',
    Array.isArray(raw1.removedDefaults) && raw1.removedDefaults.includes(keyOf(kd)),
    `raw=${JSON.stringify(raw1)}`
  )

  /* ============ ③ 模拟重启（全新模块实例，从 JSON 重读） ============ */
  console.log('\n[3] 全新实例重新 init → 仍不含桌面（持久化生效）')
  const m2 = await import('../src/main/tools/fileWatcher.ts?persist=restart1')
  await m2.initFileWatcher()
  let list3 = m2.getFileWatcher().watchedDirectories.map((w) => w.path)
  ok('重启后仍不含桌面', !list3.includes(kd), `list=${JSON.stringify(list3)}`)
  ok('重启后仍含下载', list3.includes(kdl))

  /* ============ ④ 手动加回桌面 → 撤销「已移除」 ============ */
  console.log('\n[4] addWatch(桌面) → 列表恢复 + JSON 撤销记录')
  ok('addWatch 返回 true', (await m2.getFileWatcher().addWatch(kd, '桌面')) === true)
  let list4 = m2.getFileWatcher().watchedDirectories.map((w) => w.path)
  ok('加回后列表含桌面', list4.includes(kd))
  const raw2 = JSON.parse(await fs.readFile(prefsFile, 'utf-8'))
  ok(
    'JSON removedDefaults 不再含桌面键',
    !raw2.removedDefaults.includes(keyOf(kd)),
    `raw=${JSON.stringify(raw2)}`
  )

  /* ============ ⑤ 再重启 → 桌面已回归 ============ */
  console.log('\n[5] 再次全新实例 init → 桌面已回归')
  const m3 = await import('../src/main/tools/fileWatcher.ts?persist=restart2')
  await m3.initFileWatcher()
  const list5 = m3.getFileWatcher().watchedDirectories.map((w) => w.path)
  ok('再次重启含桌面', list5.includes(kd))
  ok('再次重启含下载', list5.includes(kdl))

  /* ---------- 汇总 ---------- */
  await fs.rm(sandboxHome, { recursive: true, force: true }).catch(() => undefined)
  await fs.rm(prefsFile, { force: true }).catch(() => undefined)
  console.log(`\n==== watcher-persist-probe: ${pass} passed, ${fail} failed ====`)
  if (fail > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('probe crashed:', e)
  process.exitCode = 1
})
