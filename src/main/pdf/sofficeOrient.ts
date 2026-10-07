/**
 * Excel → PDF 的「页面方向」实现。
 *
 * 背景：LibreOffice 的 `calc_pdf_Export` / `writer_pdf_Export` 过滤器**没有方向键**
 * （`SinglePageSheets` 是「是否单页表格」、`SelectPdfVersion` 是 PDF 版本号，都与方向无关）。
 * 要真正改变页面方向，唯一可靠路径是：导出前用 LibreOffice Basic 宏改写页面样式的
 * `Width` / `Height`（单位 1/100 mm），再 storeToURL 导出。
 *
 * 本模块零第三方依赖，只用 node 内建能力：
 *   1. 首次调用用 `soffice --terminate_after_init` 生成一个「模板用户配置」并缓存；
 *   2. 每次转换把模板复制成独立的一次性 profile，注入宏后以
 *      `vnd.sun.star.script:...` 调用宏导出到目标路径；
 *   3. 结束清理一次性 profile，避免残留与并发互相干扰。
 *
 * 关键环境约束：调 soffice 前必须清掉 `PYTHONPATH` / `PYTHONHOME`，
 * 否则宿主注入的 Python 路径会破坏 soffice 内置 Python 并**静默失败**。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const execFileP = promisify(execFile)

export type PageOrientation = 'auto' | 'portrait' | 'landscape'
export type ConcreteOrientation = Exclude<PageOrientation, 'auto'>

/** 调用宏所需的脚本 URL（宏位于用户 profile 的 Standard.Module1）。 */
export const ORIENT_MACRO_URL =
  'vnd.sun.star.script:Standard.Module1.ConvertOriented?language=Basic&location=application'

/** 模板 profile 的缓存目录名。 */
const TEMPLATE_NAME = 'lingmo-soffice-orient-tpl'

/**
 * 清掉会破坏 soffice 内置 Python 的环境变量，返回可用于 spawn 的 env。
 * 不修改入参，返回浅拷贝。
 */
export function cleanSofficeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  delete env.PYTHONPATH
  delete env.PYTHONHOME
  return env
}

/**
 * 本地文件系统路径 → file:/// URL。
 *
 * 故意**不做百分号编码**：路径以原始 UTF-8 写入 .xba（文件声明 UTF-8），
 * 这样含空格 / 中文的路径也能被 LibreOffice 正确加载（实测有效）。
 */
export function toFileUrl(p: string): string {
  let s = p.replace(/\\/g, '/')
  if (!s.startsWith('/')) s = '/' + s
  return 'file://' + s
}

/** Basic 字符串字面量转义：只保留单行、去掉会破坏字面量的双引号与换行。 */
function basicLiteral(s: string): string {
  return s.replace(/[\r\n]+/g, '').replace(/"/g, '')
}

/**
 * 构建 Basic 宏模块文件（.xba）内容。
 *
 * 宏逻辑：加载源文件（隐藏）→ 逐个工作表取其当前页样式 → 读原 Width/Height →
 * 按目标方向令宽高分别为 (大 / 小)，从而**既改变方向、又保留原纸张尺寸**
 * （A4 源 → 横向仍是 A4，只是宽高互换）→ 逐个申请表样式 → 用 calc_pdf_Export 导出。
 */
export function buildOrientMacroXba(
  srcUrl: string,
  outUrl: string,
  orientation: ConcreteOrientation
): string {
  const landscape = orientation === 'landscape' ? 'True' : 'False'
  const src = basicLiteral(srcUrl)
  const out = basicLiteral(outUrl)
  const body = `REM  *****  BASIC  *****

Sub ConvertOriented
  Dim oDesk As Object, oDoc As Object, oStyles As Object, oStyle As Object
  Dim oSheets As Object, oSheet As Object
  Dim loadArgs(0) As New com.sun.star.beans.PropertyValue
  Dim saveArgs(0) As New com.sun.star.beans.PropertyValue
  Dim i As Integer, w As Long, h As Long, big As Long, small As Long
  On Error Goto Fail
  oDesk = createUnoService("com.sun.star.frame.Desktop")
  loadArgs(0).Name = "Hidden"
  loadArgs(0).Value = True
  oDoc = oDesk.loadComponentFromURL("${src}", "_blank", 0, loadArgs())
  oSheets = oDoc.Sheets
  oStyles = oDoc.StyleFamilies.getByName("PageStyles")
  For i = 0 To oSheets.Count - 1
    oSheet = oSheets.getByIndex(i)
    oStyle = oStyles.getByName(oSheet.PageStyle)
    w = oStyle.Width
    h = oStyle.Height
    If w > h Then
      big = w
      small = h
    Else
      big = h
      small = w
    End If
    If ${landscape} Then
      oStyle.Width = big
      oStyle.Height = small
    Else
      oStyle.Width = small
      oStyle.Height = big
    End If
  Next i
  saveArgs(0).Name = "FilterName"
  saveArgs(0).Value = "calc_pdf_Export"
  oDoc.storeToURL("${out}", saveArgs())
  oDoc.close(False)
  Exit Sub
Fail:
  On Error Resume Next
  oDoc.close(False)
End Sub`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">${body}</script:module>`
}

/** 确保模板 profile 存在（含 Basic 库骨架），返回其路径。 */
async function ensureTemplate(soffice: string, cacheDir: string): Promise<string> {
  const tpl = join(cacheDir, TEMPLATE_NAME)
  const marker = join(tpl, 'user', 'basic', 'Standard', 'script.xlb')
  if (existsSync(marker)) return tpl
  await rm(tpl, { recursive: true, force: true })
  await mkdir(tpl, { recursive: true })
  await execFileP(
    soffice,
    ['-env:UserInstallation=' + toFileUrl(tpl), '--headless', '--norestore', '--terminate_after_init'],
    { timeout: 120000, windowsHide: true, env: cleanSofficeEnv() }
  )
  return tpl
}

export interface OrientConvertResult {
  ok: boolean
  stderr: string
}

/**
 * 用 Basic 宏按指定方向把 Excel 转成 PDF（写往 outPath）。
 * 失败时返回 ok=false 与 stderr 摘要；调用方据此给出可行动提示。
 */
export async function convertExcelOriented(
  soffice: string,
  srcPath: string,
  outPath: string,
  orientation: ConcreteOrientation,
  cacheDir: string
): Promise<OrientConvertResult> {
  let runProfile = ''
  try {
    const tpl = await ensureTemplate(soffice, cacheDir)
    runProfile = join(cacheDir, `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await rm(runProfile, { recursive: true, force: true })
    await cp(tpl, runProfile, { recursive: true })
    // 清掉可能被复制过来的锁文件，避免 soffice 认为 profile 正在使用
    await rm(join(runProfile, '.lock'), { force: true })
    const stdDir = join(runProfile, 'user', 'basic', 'Standard')
    await mkdir(stdDir, { recursive: true })
    await writeFile(join(stdDir, 'Module1.xba'), buildOrientMacroXba(toFileUrl(srcPath), toFileUrl(outPath), orientation), 'utf-8')

    const { stderr } = await execFileP(
      soffice,
      ['-env:UserInstallation=' + toFileUrl(runProfile), '--headless', '--norestore', '--invisible', ORIENT_MACRO_URL],
      { timeout: 180000, windowsHide: true, env: cleanSofficeEnv() }
    )
    return { ok: existsSync(outPath), stderr: stderr ?? '' }
  } catch (e) {
    const err = e as { stderr?: string; message?: string }
    return { ok: existsSync(outPath), stderr: String(err.stderr || err.message || e) }
  } finally {
    if (runProfile) await rm(runProfile, { recursive: true, force: true }).catch(() => undefined)
  }
}
