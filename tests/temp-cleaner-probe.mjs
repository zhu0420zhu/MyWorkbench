/**
 * 临时目录清理探针（无头：靠 tests/loader.mjs 把 electron 解析到替身）
 *
 * 验证 TempCleaner.cleanupExpired() 的判定与统计：
 *   1. 「已过期」（mtime 往前拨 48h）的文件 / 目录被清掉；
 *   2. 「未过期」的文件 / 目录原样保留；
 *   3. 返回的 cleanedFiles / cleanedDirs / freedSpace 与实际相符；
 *   4. expireHours 参数生效（48h 前的东西在 expireHours=72 时不应被清）；
 *   5. 重复清理幂等（第二次为 0）。
 *
 * 运行：npm run probe:temp-cleaner
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TempCleaner } from '../src/main/convert/tempCleaner.ts'

const H = 3600 * 1000
const now = Date.now()
const ago = (hours) => new Date(now - hours * H)

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`)
  } else {
    fail++
    console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`)
  }
}

function makeBase() {
  return mkdtempSync(join(tmpdir(), 'lingmo-tc-probe-'))
}

/* ---------- 场景 1：默认 24h 阈值 ---------- */
console.log('== 场景 1：cleanupExpired()（默认 24h）==')
const root1 = makeBase()

// 已过期：文件 100B
const expiredFile = join(root1, 'expired-file.txt')
writeFileSync(expiredFile, 'x'.repeat(100))
utimesSync(expiredFile, ago(48), ago(48))

// 已过期：目录 内含 50B + 150B
const expiredDir = join(root1, 'expired-dir')
mkdirSync(expiredDir)
writeFileSync(join(expiredDir, 'a.txt'), 'a'.repeat(50))
writeFileSync(join(expiredDir, 'b.txt'), 'b'.repeat(150))
utimesSync(expiredDir, ago(48), ago(48)) // 必须在写完内容后设置，否则会被内容写入刷新

// 未过期：文件 30B
const freshFile = join(root1, 'fresh-file.txt')
writeFileSync(freshFile, 'y'.repeat(30))
utimesSync(freshFile, ago(1), ago(1))

// 未过期：目录 70B
const freshDir = join(root1, 'fresh-dir')
mkdirSync(freshDir)
writeFileSync(join(freshDir, 'c.txt'), 'c'.repeat(70))
utimesSync(freshDir, ago(1), ago(1))

const cleaner1 = new TempCleaner(root1)
const r1 = cleaner1.cleanupExpired()

check('cleanedFiles = 1（仅过期文件）', r1.cleanedFiles === 1, `实际 ${r1.cleanedFiles}`)
check('cleanedDirs = 1（仅过期目录）', r1.cleanedDirs === 1, `实际 ${r1.cleanedDirs}`)
check('freedSpace = 300（100 + 50 + 150）', r1.freedSpace === 300, `实际 ${r1.freedSpace}`)
check('过期文件已删除', !existsSync(expiredFile))
check('过期目录已删除', !existsSync(expiredDir))
check('未过期文件保留', existsSync(freshFile) && statSync(freshFile).size === 30)
check('未过期目录保留', existsSync(join(freshDir, 'c.txt')) && statSync(join(freshDir, 'c.txt')).size === 70)

/* ---------- 场景 2：重复清理幂等 ---------- */
const r1b = cleaner1.cleanupExpired()
check('重复清理 cleanedFiles = 0', r1b.cleanedFiles === 0, `实际 ${r1b.cleanedFiles}`)
check('重复清理 cleanedDirs = 0', r1b.cleanedDirs === 0, `实际 ${r1b.cleanedDirs}`)
check('重复清理 freedSpace = 0', r1b.freedSpace === 0, `实际 ${r1b.freedSpace}`)

/* ---------- 场景 3：expireHours 参数生效 ---------- */
console.log('== 场景 3：expireHours 参数 ==')
const root2 = makeBase()
const edgeFile = join(root2, 'edge-48h.txt')
writeFileSync(edgeFile, 'z'.repeat(10))
utimesSync(edgeFile, ago(48), ago(48))
const cleaner2 = new TempCleaner(root2)

const r72 = cleaner2.cleanupExpired(72) // 48h < 72h → 不应清
check('expireHours=72 时 48h 前文件不被清', r72.cleanedFiles === 0 && existsSync(edgeFile), `cleanedFiles=${r72.cleanedFiles}`)

const r24 = cleaner2.cleanupExpired(24) // 48h > 24h → 应清
check('expireHours=24 时 48h 前文件被清', r24.cleanedFiles === 1 && !existsSync(edgeFile), `cleanedFiles=${r24.cleanedFiles}`)

/* ---------- 场景 4：getTempStatus 与实际一致 ---------- */
console.log('== 场景 4：getTempStatus ==')
const status = new TempCleaner(root1).getTempStatus()
// root1 现存 fresh-file.txt(30) + fresh-dir/(目录不计入 totalFiles，仅顶层文件)
check('getTempStatus.exists = true', status.exists === true)
check('getTempStatus.totalFiles = 1（顶层仅 fresh-file）', status.totalFiles === 1, `实际 ${status.totalFiles}`)
check('getTempStatus.totalSize = 30', status.totalSize === 30, `实际 ${status.totalSize}`)

/* ---------- 清理 ---------- */
rmSync(root1, { recursive: true, force: true })
rmSync(root2, { recursive: true, force: true })

console.log(`\n========================================`)
console.log(`结果: ${pass} 项通过, ${fail} 项失败`)
console.log(`========================================`)
if (fail > 0) process.exit(1)
