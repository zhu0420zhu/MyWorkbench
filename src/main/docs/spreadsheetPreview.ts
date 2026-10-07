/* ============================================
 * 表格预览：xlsx/xls/ods → PDF（LibreOffice soffice headless，calc 系滤镜）
 *
 * 与 pptConvert.ts 同一模式，但有三点强化：
 *   1. 全局串行：模块级 promise 链排队，杜绝并发 soffice 实例抢锁；
 *   2. 独立 profile：每次转换用一次性 UserInstallation 目录；
 *   3. 三条件成功判定：退出码 0 + 产物存在 + 大小>0
 *      （rc=0 但零产物 = 滤镜不匹配静默落空，必须当失败处理）。
 *
 * 环境约束：调 soffice 前必须清掉 PYTHONPATH/PYTHONHOME（cleanSofficeEnv），
 * 否则内置 Python 被宿主环境破坏会静默失败。
 * stderr 出现 `Could not find platform independent libraries` 无害可忽略。
 * ============================================ */

import { spawn } from 'child_process'
import { existsSync, promises as fs } from 'fs'
import { basename, join } from 'path'
import { app } from 'electron'
import { cleanSofficeEnv } from '../pdf/sofficeOrient.ts'
import { bundledSoffice, sofficeAvailable, toSofficePath } from '../pdf/sofficePath.ts'
import { getLogger } from '../tools/logger.ts'

const logger = getLogger('docs')

/** 全局串行队列：所有 soffice 转换按序执行 */
let sofficeChain: Promise<unknown> = Promise.resolve()

function runSoffice(bin: string, args: string[], timeoutSec: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    // stdio 显式 ignore stdin：stdin 管道在部分宿主（ConPTY/无 stdin 环境）下 spawn 会 EBUSY
    const child = spawn(bin, args, {
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

/**
 * xlsx/xls/ods → PDF 字节（供 DocsViewer 表格预览复用 PDF 管线）。
 * .et 不支持（无滤镜），由 docsIpc 的 C 级拦截处理，不会进入本函数。
 */
export async function spreadsheetToPdfBytes(
  sourcePath: string
): Promise<{ ok: boolean; bytes?: Uint8Array; error?: string }> {
  if (!existsSync(sourcePath)) return { ok: false, error: '源文件不存在' }
  if (!sofficeAvailable()) return { ok: false, error: '未检测到 LibreOffice（soffice），无法预览表格文件' }

  const run = async (): Promise<{ ok: boolean; bytes?: Uint8Array; error?: string }> => {
    const tmpDir = join(app.getPath('temp'), `lingmo-sheet-${Date.now()}`)
    // 一次性 profile：每次转换用独立目录，彻底规避 profile 锁
    const profileDir = join(tmpDir, 'profile')
    try {
      await fs.mkdir(tmpDir, { recursive: true })
      const profileUrl = 'file:///' + profileDir.replace(/\\/g, '/')
      const outDir = join(tmpDir, 'out')
      await fs.mkdir(outDir, { recursive: true })
      const args = [
        '--headless',
        '--norestore',
        '-env:UserInstallation=' + profileUrl,
        '--convert-to',
        'pdf',
        '--outdir',
        toSofficePath(outDir),
        toSofficePath(sourcePath)
      ]
      const { ok, output } = await runSoffice(bundledSoffice(), args, 300)
      const expected = join(outDir, basename(sourcePath).replace(/\.(xlsx|xls|ods)$/i, '') + '.pdf')
      // 三条件判定：退出码 0 + 产物存在 + 大小>0
      const size = ok && existsSync(expected) ? (await fs.stat(expected).then((s) => s.size).catch(() => 0)) : 0
      if (ok && size > 0) {
        const buf = await fs.readFile(expected)
        return { ok: true, bytes: new Uint8Array(buf) }
      }
      logger.warning(`spreadsheetToPdfBytes 失败: ${output.slice(-400)}`)
      return {
        ok: false,
        error:
          output.slice(-300) ||
          (size === 0 && existsSync(expected) ? '转换产物为空（滤镜不匹配）' : 'soffice 转换失败')
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    } finally {
      void fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  const p = sofficeChain.then(run, run)
  sofficeChain = p.catch(() => undefined)
  return p
}
