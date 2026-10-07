/* ============================================
 * PPT 工具主进程：pptx/ppt → PDF（LibreOffice soffice headless）
 *
 * 架构约定：主进程零第三方依赖——pptx 的解包（文本/图片提取）、重打包（压缩）、
 * 生成（AI 草稿）由渲染层的 jszip / pptxgenjs 承担；这里只负责必须用本机
 * LibreOffice 做的格式转换（pptx → pdf），转换结果供渲染层预览与导出。
 *
 * 环境约束：调 soffice 前必须清掉 PYTHONPATH/PYTHONHOME（见 cleanSofficeEnv），
 * 否则 soffice 内置 Python 被破坏会静默失败。
 * ============================================ */

import { spawn } from 'child_process'
import { existsSync, promises as fs } from 'fs'
import { basename, join } from 'path'
import { app, ipcMain } from 'electron'
import { cleanSofficeEnv } from '../pdf/sofficeOrient.ts'
import { getLogger } from '../tools/logger.ts'

const logger = getLogger('ppt')

function bundledToolsDir(): string {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return join(base, 'resources', 'tools')
}

function sofficeBin(): string {
  const bundled = join(bundledToolsDir(), 'soffice', 'program', 'soffice.exe')
  if (existsSync(bundled)) return bundled
  // 回退系统 PATH（win 下 spawn 会自动解析 .exe）
  return 'soffice'
}

export function isPptConvertAvailable(): boolean {
  return existsSync(join(bundledToolsDir(), 'soffice', 'program', 'soffice.exe'))
}

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
 * pptx/ppt/odp → pdf。
 * 使用一次性 UserInstallation profile，避免与运行中的 soffice 实例抢锁。
 */
export async function convertPptToPdf(
  sourcePath: string,
  outDir: string,
  timeoutSec = 300
): Promise<{ ok: boolean; pdfPath?: string; error?: string }> {
  if (!existsSync(sourcePath)) return { ok: false, error: '源文件不存在' }
  if (!isPptConvertAvailable()) return { ok: false, error: '未检测到 LibreOffice（soffice），无法转换 PPT' }
  try {
    await fs.mkdir(outDir, { recursive: true })
    // 一次性 profile：每次转换用独立目录，彻底规避 profile 锁
    const profileDir = join(app.getPath('temp'), `lingmo-ppt-profile-${Date.now()}`)
    const profileUrl = 'file:///' + profileDir.replace(/\\/g, '/')
    const bin = sofficeBin()
    const args = [
      '--headless',
      '--norestore',
      '-env:UserInstallation=' + profileUrl,
      '--convert-to',
      'pdf',
      '--outdir',
      outDir,
      sourcePath
    ]
    const { ok, output } = await runSoffice(bin, args, timeoutSec)
    void fs.rm(profileDir, { recursive: true, force: true }).catch(() => undefined)
    const expected = join(outDir, basename(sourcePath).replace(/\.(pptx|ppt|odp)$/i, '') + '.pdf')
    if (ok && existsSync(expected)) {
      return { ok: true, pdfPath: expected }
    }
    logger.warning(`convertPptToPdf 失败: ${output.slice(-400)}`)
    return { ok: false, error: output.slice(-300) || 'soffice 转换失败' }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** 渲染层入口：pptx/ppt → pdf 字节（供 DocsViewer 预览与导出） */
export async function pptToPdfBytes(
  sourcePath: string
): Promise<{ ok: boolean; bytes?: Uint8Array; error?: string }> {
  const tmpDir = join(app.getPath('temp'), `lingmo-ppt-${Date.now()}`)
  try {
    const r = await convertPptToPdf(sourcePath, tmpDir)
    if (!r.ok || !r.pdfPath) return { ok: false, error: r.error ?? '转换失败' }
    const buf = await fs.readFile(r.pdfPath)
    return { ok: true, bytes: new Uint8Array(buf) }
  } finally {
    void fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export function registerPptIpc(): void {
  ipcMain.handle('ppt:available', () => isPptConvertAvailable())
  ipcMain.handle('ppt:to-pdf', (_e, sourcePath: string) => {
    if (!sourcePath) return { ok: false, error: '无源文件路径' }
    return pptToPdfBytes(sourcePath)
  })
}
