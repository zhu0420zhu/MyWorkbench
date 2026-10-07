/* PDF 工具 IPC：合并/拆分/旋转/页码/加密/解密/压缩/文本提取/转图/Excel→PDF */
import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { convertExcelOriented, cleanSofficeEnv } from './sofficeOrient'
import { bundledSoffice, sofficeAvailable } from './sofficePath'
import { allowPath, allowDir, isPathAllowed } from '../pathAcl'

export interface PdfFilePick {
  path: string
  name: string
  size: number
}

const MAX_IO_BYTES = 500 * 1024 * 1024

async function pickFiles(
  event: Electron.IpcMainInvokeEvent,
  title: string,
  filters: Electron.FileFilter[],
  multi: boolean
): Promise<PdfFilePick[]> {
  const win = BrowserWindow.fromWebContents(event.sender)
  const opts: Electron.OpenDialogOptions = {
    title,
    filters,
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile']
  }
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (result.canceled) return []
  const out: PdfFilePick[] = []
  for (const p of result.filePaths) {
    try {
      const buf = await readFile(p)
      allowPath(p)
      out.push({ path: p, name: basename(p), size: buf.byteLength })
    } catch {
      allowPath(p)
      out.push({ path: p, name: basename(p), size: 0 })
    }
  }
  return out
}

function runCmd(bin: string, args: string[], timeoutMs = 300000): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    let done = false
    let stderr = ''
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        resolve({ ok: false, stderr: stderr + '\n超时' })
      }
    }, timeoutMs)
    const child = spawn(bin, args, { windowsHide: true, env: cleanSofficeEnv() })
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

export function registerPdfIpc(): void {
  ipcMain.handle('pdf:soffice-available', () => sofficeAvailable())

  ipcMain.handle('pdf:pick-pdfs', (e) =>
    pickFiles(
      e,
      '选择 PDF 文件',
      [
        { name: 'PDF', extensions: ['pdf'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      true
    )
  )

  ipcMain.handle('pdf:pick-excel', (e) =>
    pickFiles(
      e,
      '选择 Excel 文件',
      [
        { name: 'Excel', extensions: ['xlsx', 'xls', 'ods'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      true
    )
  )

  /** 选择批量导出的目标目录（选中即登记为可写目录） */
  ipcMain.handle('pdf:pick-dir', async (e, title?: string): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      title: title || '选择导出目录',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || !result.filePaths.length) return null
    allowDir(result.filePaths[0])
    return result.filePaths[0]
  })

  /** 批量写入前探测重名（只对已授权路径返回真实结果） */
  ipcMain.handle('pdf:exists', async (_e, paths: string[]): Promise<boolean[]> =>
    (Array.isArray(paths) ? paths : []).map((p) => (isPathAllowed(p) ? existsSync(p) : false))
  )

  ipcMain.handle('pdf:read', async (_e, filePath: string): Promise<Uint8Array | null> => {
    if (!isPathAllowed(filePath)) {
      console.warn('[pdf:read] 路径未授权（需先经对话框选中或由 docs 等模块 allowPath 登记）:', filePath)
      return null
    }
    try {
      const buf = await readFile(filePath)
      if (buf.byteLength > MAX_IO_BYTES) {
        console.warn('[pdf:read] 文件超过 500MB 上限:', filePath, buf.byteLength)
        return null
      }
      return new Uint8Array(buf)
    } catch (err) {
      console.warn('[pdf:read] 读取失败:', filePath, (err as Error).message)
      return null
    }
  })

  ipcMain.handle('pdf:write', async (_e, filePath: string, data: Uint8Array): Promise<boolean> => {
    if (!isPathAllowed(filePath)) return false
    if (data.byteLength > MAX_IO_BYTES) return false
    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, Buffer.from(data))
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('pdf:save-path', async (e, defaultName: string, exts: string[]): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.SaveDialogOptions = {
      title: '导出文件',
      defaultPath: defaultName,
      filters: [
        {
          name: '文件',
          extensions: exts.length ? exts.map((x) => x.replace(/^\./, '')) : ['pdf']
        }
      ]
    }
    const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (result.canceled || !result.filePath) return null
    allowPath(result.filePath)
    return result.filePath
  })

  /** Excel → PDF：走内置 LibreOffice（成熟稳定） */
  ipcMain.handle(
    'pdf:excel-to-pdf',
    async (
      _e,
      input: {
        sourcePath: string
        outputPath?: string
        pageOrientation?: 'auto' | 'portrait' | 'landscape'
      }
    ): Promise<{ ok: boolean; error?: string; outputPath?: string; sizeBytes?: number }> => {
      if (!existsSync(input.sourcePath)) return { ok: false, error: '源文件不存在' }
      if (!sofficeAvailable()) {
        return { ok: false, error: '未检测到 LibreOffice。请安装 LibreOffice 或将 soffice 放入 resources/tools/soffice/' }
      }
      const outDir = dirname(input.sourcePath)
      const baseName = basename(input.sourcePath).replace(/\.[^.]+$/, '')
      const target = input.outputPath || join(outDir, `${baseName}.pdf`)
      const soffice = bundledSoffice()

      const finalize = async (): Promise<{ ok: boolean; error?: string; outputPath?: string; sizeBytes?: number }> => {
        try {
          const st = await readFile(target)
          return { ok: true, outputPath: target, sizeBytes: st.byteLength }
        } catch {
          return { ok: true, outputPath: target, sizeBytes: 0 }
        }
      }

      // 方向：calc_pdf_Export 过滤器没有方向键，必须走 Basic 宏改写页面样式后再导出
      if (input.pageOrientation === 'portrait' || input.pageOrientation === 'landscape') {
        const cacheDir = join(app.getPath('temp'), 'lingmo-pdf')
        await mkdir(cacheDir, { recursive: true })
        // 清掉可能存在的旧产出，避免把上一次的残留误判为本次成功
        await rm(target, { force: true }).catch(() => undefined)
        const { ok, stderr } = await convertExcelOriented(
          soffice,
          input.sourcePath,
          target,
          input.pageOrientation,
          cacheDir
        )
        if (!ok) return { ok: false, error: stderr.slice(-400) || '转换失败' }
        return finalize()
      }

      // 跟随源文件：原生 --convert-to（不带方向参数，保留工作簿自身页面设置）
      const args = [
        '--headless',
        '--norestore',
        '--convert-to',
        'pdf:calc_pdf_Export',
        '--outdir',
        outDir,
        input.sourcePath
      ]
      const { ok, stderr } = await runCmd(soffice, args, 180000)
      // LibreOffice 默认输出到 outdir/<name>.pdf
      const generated = join(outDir, `${baseName}.pdf`)
      if (!ok || !existsSync(generated)) {
        return { ok: false, error: stderr.slice(-400) || '转换失败' }
      }
      if (target !== generated) {
        const buf = await readFile(generated)
        await writeFile(target, buf)
        await rm(generated, { force: true }).catch(() => undefined)
      }
      return finalize()
    }
  )
}
