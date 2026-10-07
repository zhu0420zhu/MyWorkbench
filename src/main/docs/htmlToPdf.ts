/**
 * 富文本 HTML → PDF 字节流。
 *
 * 走**内置 LibreOffice**：把完整 HTML 写入临时目录，用
 * `soffice --headless --norestore --convert-to pdf --outdir <tmpOut> <tmpHtml>`
 * 转换后读回字节；临时目录在 finally 里清理。
 *
 * 三个必须遵守的坑（都是实测踩出来的）：
 *   1. 传给 soffice 的路径必须是**正斜杠**。Windows 反斜杠路径会让 soffice 报
 *      "source file could not be loaded"，与「格式不支持」是同一句错误文案，极易误判。
 *   2. spawn 必须 `stdio: ['ignore', 'pipe', 'pipe']`。stdin 留 pipe 时，
 *      ConPTY 宿主下会出现 EBUSY。
 *   3. 必须 `cleanSofficeEnv()` 清掉 PYTHONPATH / PYTHONHOME，否则宿主注入的
 *      Python 路径会破坏 soffice 内置 Python，转换**静默失败**。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { bundledSoffice, sofficeAvailable, toSofficePath } from '../pdf/sofficePath'
import { cleanSofficeEnv } from '../pdf/sofficeOrient'

/** 单次转换超时（ms）。首次启动 soffice 较慢，但 120s 足够。 */
const CONVERT_TIMEOUT_MS = 120000
/** 临时源文件名（固定名，便于推断 LibreOffice 的产出名）。 */
const SOURCE_NAME = 'doc.html'
/** 产出子目录名。 */
const OUT_DIR_NAME = 'out'
/** 未检测到内置 soffice 时的统一提示。 */
const NO_SOFFICE =
  '未检测到内置 LibreOffice，无法导出 PDF。请安装 LibreOffice 或将 soffice 放入 resources/tools/soffice/'

function wrapDocument(inner: string, title: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${inner}</body></html>`
}

interface RunResult {
  ok: boolean
  stderr: string
}

/** 异步 spawn soffice 并等待退出（含超时兜底），禁用同步 exec。 */
function runSoffice(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let done = false
    let stderr = ''
    const child = spawn(bin, args, {
      // stdin 必须 ignore：ConPTY 宿主下留 pipe 会 EBUSY
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: cleanSofficeEnv()
    })
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      resolve({ ok: false, stderr: `转换超时（${Math.round(timeoutMs / 1000)}s）` })
    }, timeoutMs)
    child.stdout?.on('data', () => undefined)
    child.stderr?.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, stderr: err.message })
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: code === 0, stderr })
    })
  })
}

/**
 * 把富文本 HTML 转成 PDF 字节。
 *
 * @param html 完整 HTML 文档；若不是完整文档（不以 `<!DOCTYPE` / `<html` 开头），
 *             会用带 `meta charset=utf-8` 的骨架包一层，避免中文乱码。
 * @param opts.baseName 仅用于兜底包装时的 `<title>`。
 */
export async function htmlToPdfBytes(
  html: string,
  opts?: { baseName?: string }
): Promise<{ ok: boolean; bytes?: Uint8Array; error?: string }> {
  if (!sofficeAvailable()) return { ok: false, error: NO_SOFFICE }
  const bin = bundledSoffice()
  const tmpDir = join(
    app.getPath('temp'),
    `lingmo-docs-html2pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  )
  try {
    const outDir = join(tmpDir, OUT_DIR_NAME)
    await fs.mkdir(outDir, { recursive: true })
    const srcPath = join(tmpDir, SOURCE_NAME)
    const raw = html ?? ''
    const doc = /^\s*(<!doctype|<html)/i.test(raw) ? raw : wrapDocument(raw, opts?.baseName || '文档')
    await fs.writeFile(srcPath, doc, 'utf-8')

    const result = await runSoffice(
      bin,
      [
        '--headless',
        '--norestore',
        '--convert-to',
        'pdf',
        '--outdir',
        toSofficePath(outDir),
        toSofficePath(srcPath)
      ],
      CONVERT_TIMEOUT_MS
    )
    if (!result.ok) return { ok: false, error: result.stderr.slice(-400) || '导出 PDF 失败' }

    // LibreOffice 以源文件基名输出：doc.html → out/doc.pdf
    const outPath = join(outDir, SOURCE_NAME.replace(/\.html$/, '.pdf'))
    let buf: Buffer
    try {
      buf = await fs.readFile(outPath)
    } catch {
      return { ok: false, error: result.stderr.slice(-400) || '转换失败：soffice 未产出 PDF' }
    }
    if (buf.byteLength < 5 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return { ok: false, error: '转换失败：产出不是有效 PDF' }
    }
    return { ok: true, bytes: new Uint8Array(buf) }
  } catch (err) {
    return { ok: false, error: (err as Error).message || '导出 PDF 失败' }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
