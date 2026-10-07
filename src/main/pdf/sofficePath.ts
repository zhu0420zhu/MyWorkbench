/**
 * LibreOffice（soffice）可执行文件定位的**唯一来源**。
 *
 * 之前这段逻辑内联在 `pdfIpc.ts` 里，现在 HTML→PDF（docs 模块）也要用同一套定位，
 * 因此抽到本模块统一导出，禁止再复制第二份。
 *
 * 关键约定（Windows）：优先 `soffice.com`。
 * `soffice.exe` 是 GUI 入口，配合 `--headless` 仍会挂住不返回；
 * `soffice.com` 是 console 入口，才适合程序化调用。
 */
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 返回 soffice 可执行文件路径：优先内置 `resources/tools/soffice/...`，
 * 都没有时回退到裸文件名（交给系统 PATH 解析）。
 */
export function bundledSoffice(): string {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  // Windows 优先 soffice.com：console 入口适合 --headless，soffice.exe 是 GUI 会挂住
  const candidates =
    process.platform === 'win32'
      ? [
          join(base, 'resources', 'tools', 'soffice', 'program', 'soffice.com'),
          join(base, 'resources', 'tools', 'soffice', 'program', 'soffice.exe'),
          join(base, 'resources', 'tools', 'soffice', 'soffice.com'),
          join(base, 'resources', 'tools', 'soffice', 'soffice.exe')
        ]
      : [join(base, 'resources', 'tools', 'soffice', 'program', 'soffice'), join(base, 'resources', 'tools', 'soffice', 'soffice')]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return process.platform === 'win32' ? 'soffice.com' : 'soffice'
}

/** 检测 LibreOffice 是否真实可用（内置或系统 PATH） */
export function sofficeAvailable(): boolean {
  const bundled = bundledSoffice()
  if (bundled !== 'soffice' && bundled !== 'soffice.exe' && existsSync(bundled)) return true
  const pathEnv = process.env.PATH ?? ''
  const sep = process.platform === 'win32' ? ';' : ':'
  const names = process.platform === 'win32' ? ['soffice.exe', 'soffice.com'] : ['soffice']
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue
    for (const n of names) {
      if (existsSync(join(dir, n))) return true
    }
  }
  return false
}

/**
 * 传给 soffice 的路径必须转成正斜杠。
 * Windows 下反斜杠路径会让 soffice 报 "source file could not be loaded"
 * ——与「格式不支持」是同一句错误文案，极易误判。
 */
export function toSofficePath(p: string): string {
  return p.replace(/\\/g, '/')
}
