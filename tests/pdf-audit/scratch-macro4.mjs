/* 探明 v4：预建 profile（不先初始化）能否单次运行宏 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'

const execFileP = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, 'scratch', 'macro4')
await rm(WORK, { recursive: true, force: true })
await mkdir(WORK, { recursive: true })
const SOFFICE = join(process.cwd(), 'resources', 'tools', 'soffice', 'program', 'soffice.com')
const CLEAN_ENV = { ...process.env }
delete CLEAN_ENV.PYTHONPATH
delete CLEAN_ENV.PYTHONHOME

async function run(args, profile) {
  try {
    const { stderr } = await execFileP(
      SOFFICE,
      ['-env:UserInstallation=file:///' + profile.replace(/\\/g, '/'), ...args],
      { timeout: 180000, windowsHide: true, env: CLEAN_ENV }
    )
    return stderr || ''
  } catch (e) {
    return 'ERR: ' + String(e.stderr || e.message).slice(0, 300)
  }
}

const csv = join(HERE, 'fixtures', 'sheet.csv')
const srcDir = join(WORK, 'src')
await mkdir(srcDir, { recursive: true })
await run(['--headless', '--norestore', '--convert-to', 'xlsx', '--outdir', srcDir, csv], join(WORK, 'prof-conv'))
const srcXlsx = join(srcDir, 'sheet.xlsx')
const srcUrl = srcXlsx.replace(/\\/g, '/')

// 先起一个干净的模板 profile 供拷贝
const tpl = join(WORK, 'tpl')
await run(['--headless', '--norestore', '--terminate_after_init'], tpl)
console.log('模板 profile:', existsSync(join(tpl, 'user', 'basic', 'Standard', 'script.xlb')) ? 'OK' : 'FAIL')

// 复制模板 -> 预建 profile，直接写入宏，单次运行
const profile = join(WORK, 'prof-once')
await cp(tpl, profile, { recursive: true })
const stdDir = join(profile, 'user', 'basic', 'Standard')
const outPdf = join(WORK, 'out.pdf')
const outUrl = outPdf.replace(/\\/g, '/')
const xba = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">REM  *****  BASIC  *****

Sub ConvertOriented
  Dim oDesk As Object, oDoc As Object, oStyles As Object
  Dim oSheets As Object, oSheet As Object
  Dim loadArgs(0) As New com.sun.star.beans.PropertyValue
  Dim saveArgs(0) As New com.sun.star.beans.PropertyValue
  Dim i As Integer
  oDesk = createUnoService("com.sun.star.frame.Desktop")
  loadArgs(0).Name = "Hidden"
  loadArgs(0).Value = True
  oDoc = oDesk.loadComponentFromURL("file:///${srcUrl}", "_blank", 0, loadArgs())
  oSheets = oDoc.Sheets
  oStyles = oDoc.StyleFamilies.getByName("PageStyles")
  For i = 0 To oSheets.Count - 1
    oSheet = oSheets.getByIndex(i)
    oSheet.PageStyle = "Default"
  Next i
  Dim sDef As Object
  sDef = oStyles.getByName("Default")
  sDef.Width = 29700
  sDef.Height = 21000
  saveArgs(0).Name = "FilterName"
  saveArgs(0).Value = "calc_pdf_Export"
  oDoc.storeToURL("file:///${outUrl}", saveArgs())
  oDoc.close(False)
End Sub</script:module>`
await writeFile(join(stdDir, 'Module1.xba'), xba, 'utf-8')
const err = await run(['--headless', '--norestore', '--invisible', 'vnd.sun.star.script:Standard.Module1.ConvertOriented?language=Basic&location=application'], profile)
console.log('单次运行 stderr:', err.slice(0, 200))
console.log('产出:', existsSync(outPdf) ? 'OK' : 'FAIL')
if (existsSync(outPdf)) {
  const doc = await PDFDocument.load(await readFile(outPdf))
  const s = doc.getPages()[0].getSize()
  console.log('结果:', doc.getPageCount() + ' 页, 首页 ' + Math.round(s.width) + 'x' + Math.round(s.height))
}
