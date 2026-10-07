/* ============================================================
 * 手术式文档编辑 · B 级链路：DOC/XLS/RTF 高保真转换编辑
 *
 * legacy 格式（DOC/XLS/RTF）无法逐字节手术（二进制 OLE/专有结构），
 * 采用「容器手术」：soffice 转成 docx/xlsx 容器 → 复用 A 级手术链
 * 改字 → 用回写滤镜转回原格式覆写。如实标注为高保真转换编辑，
 * 不承诺逐字节保真；覆写前由调用方（legacyApply）生成 .bak 备份。
 *
 * 实测滤镜（LibreOffice 26.2.5.2）：
 *   .doc → 容器 docx（读取默认滤镜即可），回写 'MS Word 97'
 *   .xls → 容器 xlsx，回写 'MS Excel 97'
 *   .rtf → 容器 docx，回写 'Rich Text Format'
 *
 * 纪律：soffice 全局串行（模块级 promise 链）+ **持久化 UserInstallation profile**
 * + 三条件成功判定（rc=0 + 产物存在 + 大小>0）。
 * profile 在 userData 下持久复用（正向 forward / 回写 back 各自一个，互不共用），
 * 避免每次转换都冷启动重建用户配置（Windows 实测单次 20~60s）。
 * 若持久 profile 准备失败（目录建不起来）或转换疑似被锁/损坏，自动改用一次性临时 profile
 * 重试一次并记 warning——可靠性优先于速度，绝不因复用 profile 把本可成功的转换变成失败。
 * 容器缓存在 extract 与 apply 之间复用同一份容器，避免二次转换导致
 * unit id 漂移；apply 成功后删除缓存与临时目录。
 * ============================================================ */

import { spawn } from 'child_process'
import { existsSync, promises as fs } from 'fs'
import { basename, extname, join } from 'path'
import { app } from 'electron'
import { cleanSofficeEnv } from '../../pdf/sofficeOrient.ts'
import { bundledSoffice, sofficeAvailable, toSofficePath } from '../../pdf/sofficePath.ts'
import type { SurgicalApplyResult, SurgicalEdit, SurgicalExtractResult } from '../../../shared/types'
import { getLogger } from '../../tools/logger.ts'
import { surgicalApply, surgicalExtract } from './index'

export interface LegacySupport {
  /** 中间容器格式 */
  container: 'docx' | 'xlsx'
  /** soffice 回写滤镜名（--convert-to <ext>:<filter>） */
  filter: string
  /** 原格式扩展名（带点，小写） */
  legacyExt: '.doc' | '.xls' | '.rtf'
}

/** legacy 扩展名 → 容器与回写滤镜；非 legacy 返回 null */
export function containerToLegacySupport(ext: string): LegacySupport | null {
  const e = String(ext || '').toLowerCase().replace(/^\./, '')
  if (e === 'doc') return { container: 'docx', filter: 'MS Word 97', legacyExt: '.doc' }
  if (e === 'xls') return { container: 'xlsx', filter: 'MS Excel 97', legacyExt: '.xls' }
  if (e === 'rtf') return { container: 'docx', filter: 'Rich Text Format', legacyExt: '.rtf' }
  return null
}

/** 容器缓存：origPath → 临时容器信息（extract/apply 之间复用，防止 id 漂移） */
const containerCache = new Map<string, { tempPath: string; tmpDir: string; containerExt: string }>()

/* ---------------- soffice 运行器（全局串行） ---------------- */

let sofficeChain: Promise<unknown> = Promise.resolve()

function runSoffice(args: string[], timeoutSec: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(bundledSoffice(), args, {
      env: cleanSofficeEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, output: output + '\n[soffice 超时]' })
    }, timeoutSec * 1000)
    child.stdout?.on('data', (d) => (output += String(d)))
    child.stderr?.on('data', (d) => (output += String(d)))
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, output })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, output: output + String(err) })
    })
  })
}

/** 三条件判定：rc=0 + 产物存在 + 大小>0（rc=0 但零产物 = 滤镜静默落空） */
async function verifyProduct(expected: string, output: string): Promise<{ ok: true; size: number } | { ok: false; error: string }> {
  if (!existsSync(expected)) {
    return { ok: false, error: output.slice(-300) || 'soffice 转换失败（无产物）' }
  }
  const size = await fs.stat(expected).then((s) => s.size).catch(() => 0)
  if (size === 0) return { ok: false, error: '转换产物为空（滤镜不匹配）' }
  return { ok: true, size }
}

let tmpSeq = 0

/** 递归删除临时目录：Windows 下 soffice 刚退出时 profile 文件可能短暂被锁，重试兜底 */
async function rmRf(target: string): Promise<void> {
  for (let i = 0; i < 8; i++) {
    try {
      await fs.rm(target, { recursive: true, force: true })
      if (!existsSync(target)) return
    } catch {
      /* 忽略，重试 */
    }
    await new Promise((r) => setTimeout(r, 400))
  }
}

/* ---------------- UserInstallation profile（持久复用 + 降级兜底） ----------------
 *
 * 每次转换都新建 profile 会让 soffice 反复冷启动重建用户配置（Windows 实测单次 20~60s）。
 * 改为在 userData 下持久化两个 profile：
 *   · forward —— 原文件 → 容器（docx/xlsx）
 *   · back    —— 容器 → 原格式（MS Word 97 / MS Excel 97 / Rich Text Format 滤镜）
 * 两者**必须分开**：回写用的是不同的导入/导出滤镜进程族，共用 profile 会互相污染注册状态。
 * profile 绝不能放临时容器目录——那里会被 rmRf 删掉。
 *
 * 可靠性优先于速度：**准备阶段（mkdir profile）与转换阶段同样受降级保护**——只要持久 profile
 * 目录建不起来（被同名文件占位 / 权限异常等），或转换疑似被锁/损坏（见 PROFILE_FAIL_RE），
 * 就自动改用一次性临时 profile 重试一次（回到旧的 per-run profile 行为）并记 warning。
 * 绝不因复用 profile 把原本能跑通的转换变成失败。
 */

/** 持久 profile 目录（惰性求值 app.getPath，不在模块顶层做副作用——模块会被无头探针 import） */
function surgicalProfileDir(useBack: boolean): string {
  return join(app.getPath('userData'), useBack ? 'soffice-surgical-profile-back' : 'soffice-surgical-profile')
}

/**
 * 惰性建目录，同一进程内每个 profile 只建一次。
 * 失败**不吞**：异常向上抛，由 convertWithFallback 捕获后降级到一次性临时 profile；
 * 且失败不写进缓存（删掉条目），下次调用可重试，避免一次抖动把 profile 永久钉死。
 */
const profileReady = new Map<string, Promise<void>>()
function ensureProfile(dir: string): Promise<void> {
  let p = profileReady.get(dir)
  if (!p) {
    p = fs.mkdir(dir, { recursive: true }).then(() => undefined)
    profileReady.set(dir, p)
    p.catch(() => profileReady.delete(dir))
  }
  return p
}

/**
 * 「持久 profile 疑似锁/损坏」判据：
 *   · rc≠0 且输出命中 profile/lock/UserInstallation 之类关键字（含 zh-CN 的「锁定/占用/超时」）；
 *   · 或 rc=0 但产物缺失 / 0 字节（profile 未就绪时滤镜静默落空）。
 * 命中才触发一次性临时 profile 重试；纯粹的关键字不相关的 rc≠0（真·滤镜错误）不重试。
 */
const PROFILE_FAIL_RE =
  /userinstallation|profile|\.lock|lock file|already (?:in use|running)|being used by another|锁定|占用|超时/i

interface ConvertOnce {
  ok: boolean
  productPath: string
  error: string
  profileRelated: boolean
}

/** 单次转换：把 srcPath 用 toSpec 转到 outDir，用给定 profileDir 启动 soffice（profileDir 须由调用方先行准备好） */
async function convertOnce(srcPath: string, toSpec: string, outExt: string, profileDir: string, outDir: string): Promise<ConvertOnce> {
  const expected = join(outDir, basename(srcPath).replace(/\.[^.]+$/, '') + outExt)
  try {
    await fs.mkdir(outDir, { recursive: true })
    const profileUrl = 'file:///' + profileDir.replace(/\\/g, '/')
    const args = [
      '--headless',
      '--norestore',
      '-env:UserInstallation=' + profileUrl,
      '--convert-to',
      toSpec,
      '--outdir',
      toSofficePath(outDir),
      toSofficePath(srcPath)
    ]
    const { ok, output } = await runSoffice(args, 300)
    if (!ok) {
      return { ok: false, productPath: expected, error: output.slice(-300) || 'soffice 转换失败（rc≠0）', profileRelated: PROFILE_FAIL_RE.test(output) }
    }
    const v = await verifyProduct(expected, output)
    // rc=0 但产物缺失/0 字节：视为可降级信号（也覆盖 profile 未就绪导致的滤镜静默落空）
    if (!v.ok) return { ok: false, productPath: expected, error: v.error, profileRelated: true }
    return { ok: true, productPath: expected, error: '', profileRelated: false }
  } catch (err) {
    return { ok: false, productPath: expected, error: (err as Error).message, profileRelated: false }
  }
}

/** 带降级兜底的转换：先持久 profile，失败且疑似 profile 问题时用一次性临时 profile 重试一次 */
async function convertWithFallback(
  srcPath: string,
  toSpec: string,
  outExt: string,
  outDir: string,
  useBack: boolean,
  label: string
): Promise<{ ok: true; productPath: string } | { ok: false; error: string }> {
  // 1) 持久 profile：**准备 + 转换放在同一 try 范围**——profile 目录建不起来（被同名文件占位、
  //    权限异常等）也要走降级，绝不因准备失败短路成硬错误。
  const persistentDir = surgicalProfileDir(useBack)
  let firstError = ''
  let profileRelated = true
  try {
    await ensureProfile(persistentDir)
    const first = await convertOnce(srcPath, toSpec, outExt, persistentDir, outDir)
    if (first.ok) return { ok: true, productPath: first.productPath }
    firstError = first.error
    profileRelated = first.profileRelated
  } catch (err) {
    firstError = (err as Error).message || String(err)
    profileRelated = true
  }
  if (!profileRelated) return { ok: false, error: firstError }

  // 2) 降级：一次性临时 profile（回到旧的 per-run 行为）
  const fallbackDir = join(app.getPath('temp'), `lingmo-surgical-fallback-${Date.now()}-${tmpSeq++}`)
  getLogger('docs').warning(
    `[legacyContainer] 持久 profile 不可用/转换失败，改用一次性临时 profile 重试：${label}；原因：${firstError}`
  )
  let second: ConvertOnce
  try {
    const fallbackProfile = join(fallbackDir, 'profile')
    await ensureProfile(fallbackProfile)
    second = await convertOnce(srcPath, toSpec, outExt, fallbackProfile, outDir)
  } catch (err) {
    second = { ok: false, productPath: '', error: (err as Error).message || String(err), profileRelated: false }
  }
  await rmRf(fallbackDir)
  return second.ok ? { ok: true, productPath: second.productPath } : { ok: false, error: second.error }
}

/**
 * 原文件 → 临时容器。产物：<temp>/lingmo-surgical-<ts>-<seq>/<原名>.<container>
 */
export async function toContainer(
  origPath: string,
  support: LegacySupport
): Promise<{ ok: true; tempPath: string; tmpDir: string; containerExt: string } | { ok: false; error: string }> {
  if (!sofficeAvailable()) return { ok: false, error: `未检测到 LibreOffice（soffice），无法编辑 ${support.legacyExt} 文件` }
  const run = async (): Promise<ReturnType<typeof toContainer>> => {
    const tmpDir = join(app.getPath('temp'), `lingmo-surgical-${Date.now()}-${tmpSeq++}`)
    const outDir = join(tmpDir, 'out')
    const conv = await convertWithFallback(
      origPath,
      support.container,
      '.' + support.container,
      outDir,
      false,
      `${support.legacyExt} → ${support.container}`
    )
    if (!conv.ok) {
      await rmRf(tmpDir)
      return { ok: false, error: `${support.legacyExt} 转换容器失败：${conv.error}` }
    }
    return { ok: true, tempPath: conv.productPath, tmpDir, containerExt: support.container }
  }
  const p = sofficeChain.then(run, run)
  sofficeChain = p.catch(() => undefined)
  return p
}

/**
 * 容器 → 原格式（用回写滤镜），成功后覆写 origPath。
 * 覆写前调用方必须已生成 .bak。临时目录由调用方统一清理。
 */
export async function backToLegacy(
  tempPath: string,
  tmpDir: string,
  support: LegacySupport,
  origPath: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const run = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    const outDir = join(tmpDir, 'out-back')
    const conv = await convertWithFallback(
      tempPath,
      `${support.legacyExt.slice(1)}:${support.filter}`,
      support.legacyExt,
      outDir,
      true,
      `容器 → ${support.legacyExt}`
    )
    if (!conv.ok) return { ok: false, error: `转回 ${support.legacyExt} 失败：${conv.error}` }
    try {
      await fs.copyFile(conv.productPath, origPath)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: `转回 ${support.legacyExt} 失败：${(err as Error).message}` }
    }
  }
  const p = sofficeChain.then(run, run)
  sofficeChain = p.catch(() => undefined)
  return p
}

/* ---------------- 编排：extract / apply（含缓存与备份语义） ---------------- */

const LEGACY_NOTE = 'DOC/XLS/RTF 为高保真转换编辑：经容器格式手术修改后转回原格式'

/** legacy 抽取：容器缓存复用（同一路径第二次 extract 不再转换，id 稳定） */
export async function legacyExtract(origPath: string): Promise<SurgicalExtractResult> {
  const support = containerToLegacySupport(extname(origPath))
  if (!support) return { ok: false, error: `不支持的 legacy 格式: ${origPath}` }
  if (!existsSync(origPath)) return { ok: false, error: '文件不存在' }

  let c = containerCache.get(origPath)
  if (!c) {
    const r = await toContainer(origPath, support)
    if (!r.ok) return { ok: false, error: r.error }
    c = { tempPath: r.tempPath, tmpDir: r.tmpDir, containerExt: r.containerExt }
    containerCache.set(origPath, c)
  }
  try {
    const buf = await fs.readFile(c.tempPath)
    const r = await surgicalExtract(buf, support.container)
    if (!r.ok) return r
    return { ...r, note: LEGACY_NOTE }
  } catch (err) {
    // 容器文件丢失：清缓存让下次重新转换
    containerCache.delete(origPath)
    await rmRf(c.tmpDir)
    return { ok: false, error: `容器读取失败：${(err as Error).message}` }
  }
}

/** legacy 应用：对缓存容器手术 → .bak 备份 → 转回原格式覆写 → 清缓存。changed=0 时不落盘不备份 */
export async function legacyApply(origPath: string, edits: SurgicalEdit[]): Promise<SurgicalApplyResult> {
  const support = containerToLegacySupport(extname(origPath))
  if (!support) return { ok: false, error: `不支持的 legacy 格式: ${origPath}` }
  const c = containerCache.get(origPath)
  if (!c) {
    return { ok: false, error: '容器缓存不存在或已失效，请重新执行提取后再保存' }
  }
  try {
    const buf = await fs.readFile(c.tempPath)
    const r = await surgicalApply(buf, support.container, edits ?? [])
    if (!r.ok) return { ok: false, error: r.error }
    if (!r.bytes) {
      // 无变更：不转换、不备份、不覆写（对齐 A 级语义），缓存保留
      return { ok: true, changedCount: 0, skipped: r.skipped }
    }
    await fs.writeFile(c.tempPath, r.bytes)
    const backupPath = origPath + '.bak'
    await fs.copyFile(origPath, backupPath)
    const back = await backToLegacy(c.tempPath, c.tmpDir, support, origPath)
    if (!back.ok) {
      // 原文件未被破坏（覆写失败即保持原样），容器改动留在缓存里可重试
      return { ok: false, error: back.error }
    }
    // 成功：清理缓存与临时目录（下次 extract 重新转换）
    containerCache.delete(origPath)
    await rmRf(c.tmpDir)
    return { ok: true, backupPath, changedCount: r.changedCount, skipped: r.skipped }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
