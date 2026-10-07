/**
 * 确定性降级探针：验证 legacyContainer 的「持久 profile 不可用 → 一次性临时 profile 兜底」路径。
 *
 * 为什么需要它：profile 复用把单次转换从 20~60s 降到 ~8s，但代价是引入了「持久 profile 被锁/损坏/
 * 建不起来」这个新的失败面。降级兜底是「可靠性优先」的保险，但一条**从未被执行过**的错误路径本身
 * 就是风险（可能抛异常、可能不清理临时目录、可能把本可成功的转换判成失败）。本探针用**占位法**
 * 精确、确定地制造失败，逼真地跑一遍兜底路径。
 *
 * 手法（不靠并发抢 profile 那种不确定手法）：
 *   在 profile 应有的路径上放一个**同名普通文件**（不是目录）→
 *   `fs.mkdir(profileDir, { recursive: true })` 稳定抛 EEXIST → 触发「准备失败 → 降级」。
 *
 * 用例：
 *   A. 降级路径：占位 profile 路径 → toContainer **仍成功**；产物存在且 size>0；日志出现 warning；
 *      一次性 fallback 目录结束后**无残留**；占位文件**原样还在**（证明持久 profile 确实没被使用）。
 *   B. 反向对照：移除占位 → 走**持久 profile 分支**；profile 被真正创建为**目录**；
 *      不产生 fallback 目录；不产生 warning。（确保降级不是无条件总在跑）
 *
 * ⚠️ 用例顺序**必须 A→B**：`ensureProfile` 缓存「同一进程内每个 profile 只建一次」，
 *    若先跑 B，A 的 ensureProfile 会命中缓存直接成功，占位法就失效了。
 *
 * ⚠️ 与其它 soffice 脚本（probe:surgical-legacy / test:pdf-excel-orient / test:pdf-split-batch …）
 *    **串行**运行，勿并行——会互相抢 soffice / profile 锁。
 *
 * 运行（必须带 loader，无头 electron 替身）：
 *   NODE_OPTIONS="" node --experimental-loader=./tests/loader.mjs --experimental-strip-types tests/legacy-profile-fallback-probe.mjs
 * 预计耗时：2 次 soffice 转换（各含一次 profile 首次创建）≈ 40~60s。
 */
import { existsSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { containerToLegacySupport, toContainer } from '../src/main/docs/surgical/legacyContainer.ts'

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  [PASS] ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? '  ' + detail : '')) }
}

const WORK = join(app.getPath('temp'), 'lingmo-fallback-probe')
const RTF = join(WORK, 'sample.rtf')
/** 持久 forward profile 路径（与 legacyContainer.surgicalProfileDir(false) 同构） */
const PROFILE = join(app.getPath('userData'), 'soffice-surgical-profile')

/** 临时目录里遗留的一次性 fallback 目录数（降级只会临时建、随即清理） */
async function countFallbackDirs() {
  try {
    return (await fs.readdir(tmpdir())).filter((n) => n.startsWith('lingmo-surgical-fallback-')).length
  } catch {
    return -1
  }
}

/** 捕获 getLogger('docs') 的 warning（logger 的 warning 级走 console.warn） */
const warnings = []
const origWarn = console.warn
console.warn = (...a) => { warnings.push(a.map((x) => String(x)).join(' ')) }
function takeWarnings() {
  const w = warnings.slice()
  warnings.length = 0
  return w
}

const RTF_TEXT = '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times New Roman;}}\\f0\\fs24 fallback probe sample\\par}\n'

async function main() {
  await fs.mkdir(WORK, { recursive: true })
  await fs.writeFile(RTF, RTF_TEXT, 'latin1')
  const support = containerToLegacySupport('.rtf')
  ok('RTF → 容器支持映射存在', !!support, JSON.stringify(support))

  /* ---------------- A. 降级路径（占位法强制 profile 准备失败） ---------------- */
  console.log('\n== A. 降级路径：profile 路径被同名文件占位 ==')
  await fs.rm(PROFILE, { recursive: true, force: true }).catch(() => undefined)
  await fs.writeFile(PROFILE, 'occupied-by-probe') // 普通文件，不是目录
  const fbBefore = await countFallbackDirs()
  takeWarnings() // 清空

  const a = await toContainer(RTF, support)
  const aWarn = takeWarnings()
  ok('toContainer 仍然成功（未因 profile 准备失败短路成硬错误）', a.ok === true, a.ok ? '' : String(a.error))
  if (a.ok) {
    const exists = existsSync(a.tempPath)
    const size = exists ? (await fs.stat(a.tempPath)).size : 0
    ok('产物存在且 size > 0', exists && size > 0, a.tempPath + '  ' + size + 'B')
    const inProfile = (await fs.stat(PROFILE)).isFile()
    ok('★ 占位文件原样还在（持久 profile 确实没被使用，走了一次性临时 profile）', inProfile)
    ok('★ 日志出现降级 warning', aWarn.some((w) => w.includes('[legacyContainer]') && w.includes('重试')), aWarn.find((w) => w.includes('[legacyContainer]')) || '（无）')
    ok('★ 一次性 fallback 目录已清理（无残留）', (await countFallbackDirs()) === fbBefore, (await countFallbackDirs()) + '（期望 ' + fbBefore + '）')
    await fs.rm(a.tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }

  /* ---------------- B. 反向对照：不制造占位 → 走持久 profile ---------------- */
  console.log('\n== B. 反向对照：移除占位 → 应走持久 profile 分支，不产生 fallback ==')
  await fs.rm(PROFILE, { recursive: true, force: true }).catch(() => undefined)
  const fbBefore2 = await countFallbackDirs()
  takeWarnings()

  const b = await toContainer(RTF, support)
  const bWarn = takeWarnings()
  ok('toContainer 成功', b.ok === true, b.ok ? '' : String(b.error))
  if (b.ok) {
    const exists = existsSync(b.tempPath)
    const size = exists ? (await fs.stat(b.tempPath)).size : 0
    ok('产物存在且 size > 0', exists && size > 0, b.tempPath + '  ' + size + 'B')
    const isDir = existsSync(PROFILE) && (await fs.stat(PROFILE)).isDirectory()
    ok('★ 持久 profile 被真正创建为目录（走的是持久分支）', isDir, PROFILE)
    ok('★ 未产生 fallback 目录（降级不是无条件总在跑）', (await countFallbackDirs()) === fbBefore2, (await countFallbackDirs()) + '（期望 ' + fbBefore2 + '）')
    ok('★ 未出现降级 warning', !bWarn.some((w) => w.includes('[legacyContainer]')), bWarn.join(' | ') || '（无）')
    await fs.rm(b.tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

main()
  .catch((e) => { fail++; console.error('未捕获错误:', e) })
  .finally(async () => {
    console.warn = origWarn
    await fs.rm(WORK, { recursive: true, force: true }).catch(() => undefined)
    console.log('\n通过 ' + pass + '，失败 ' + fail)
    if (fail > 0) process.exitCode = 1
    else console.log('\n★ 结论：持久 profile 不可用时降级到一次性临时 profile 的兜底路径，确实能跑通、能清理、并如实记 warning；无占位时不会误触发降级。')
  })
