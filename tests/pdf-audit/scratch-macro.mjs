/* 探明 v3：用 insertByName 新建横向页样式并赋给 sheet */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'

const execFileP = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, 'scratch', 'macro3')
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
    return 'ERR: ' + String(e.stderr || e.message).slice(0, 400)
  }
}

const csv = join(HERE, 'fixtures', 'sheet.csv')
const srcDir = join(WORK, 'src')
await mkdir(srcDir, { recursive: true })
await run(['--headless', '--norestore', '--convert-to', 'xlsx', '--outdir', srcDir, csv], join(WORK, 'prof-conv'))
const srcXlsx = join(srcDir, 'sheet.xlsx')
const profile = join(WORK, 'prof-macro')
await run(['--headless', '--norestore', '--terminate_after_init'], profile)
const stdDir = join(profile, 'user', 'basic', 'Standard')
const srcUrl = srcXlsx.replace(/\\/g, '/')

const runCase = async (tag, body) => {
  const outPdf = join(WORK, 'out-' + tag + '.pdf')
  const outUrl = outPdf.replace(/\\/g, '/')
  const macro = `Sub ConvertOriented
  Dim oDesk As Object, oDoc As Object, oStyles As Object, oStyle As Object
  Dim oSheets As Object, oSheet As Object
  Dim loadArgs(0) As New com.sun.star.beans.PropertyValue
  Dim saveArgs(0) As New com.sun.star.beans.PropertyValue
  Dim i As Integer
  oDesk = createUnoService("com.sun.star.frame.Desktop")
  loadArgs(0).Name = "Hidden"
  loadArgs(0).Value = True
  oDoc = oDesk.loadComponentFromURL("file:///${srcUrl}", "_blank", 0, loadArgs())
  oSheets = oDoc.Sheets
${body}
  saveArgs(0).Name = "FilterName"
  saveArgs(0).Value = "calc_pdf_Export"
  oDoc.storeToURL("file:///${outUrl}", saveArgs())
  oDoc.close(False)
End Sub`
  const xba = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">REM  *****  BASIC  *****

${macro}</script:module>`
  await writeFile(join(stdDir, 'Module1.xba'), xba, 'utf-8')
  await run(['--headless', '--norestore', '--invisible', 'vnd.sun.star.script:Standard.Module1.ConvertOriented?language=Basic&location=application'], profile)
  if (!existsSync(outPdf)) {
    console.log(tag + ': FAIL (no output)')
    return
  }
  const doc = await PDFDocument.load(await readFile(outPdf))
  const s = doc.getPages()[0].getSize()
  console.log(tag + ': ' + doc.getPageCount() + ' 页, 首页 ' + Math.round(s.width) + 'x' + Math.round(s.height))
}

// case A: 直接对所有 PageStyles 设 IsLandscape
await runCase('A-setStyleIsLandscape', `  oStyles = oDoc.StyleFamilies.getByName("PageStyles")
  For i = 0 To oStyles.Count - 1
    oStyle = oStyles.getByIndex(i)
    oStyle.IsLandscape = True
  Next i`)

// case B: 新建横向样式并赋给每个 sheet
await runCase('B-newStyle', `  oStyles = oDoc.StyleFamilies.getByName("PageStyles")
  oStyles.insertByName("LandscapeX", oDoc.createInstance("com.sun.star.style.PageStyle"))
  oStyle = oStyles.getByName("LandscapeX")
  oStyle.IsLandscape = True
  For i = 0 To oSheets.Count - 1
    oSheet = oSheets.getByIndex(i)
    oSheet.PageStyle = "LandscapeX"
  Next i`)

// case C: 显式 Width/Height 交换（A4 横向 297x210mm，单位 1/100 mm）
await runCase('C-wh', `  oStyles = oDoc.StyleFamilies.getByName("PageStyles")
  oStyles.insertByName("LandscapeY", oDoc.createInstance("com.sun.star.style.PageStyle"))
  oStyle = oStyles.getByName("LandscapeY")
  oStyle.Width = 29700
  oStyle.Height = 21000
  For i = 0 To oSheets.Count - 1
    oSheet = oSheets.getByIndex(i)
    oSheet.PageStyle = "LandscapeY"
  Next i`)

// case F: 新建样式并整体拷贝原样式属性，再交换 W/H（横向）
const copyBody = (orient) => `  oStyles = oDoc.StyleFamilies.getByName("PageStyles")
  Dim sSrc As Object, sNew As Object, props As Object, p As Object
  oSheet = oSheets.getByIndex(0)
  sSrc = oStyles.getByName(oSheet.PageStyle)
  If Not oStyles.HasByName("LingmoOrient") Then
    oStyles.insertByName("LingmoOrient", oDoc.createInstance("com.sun.star.style.PageStyle"))
  End If
  sNew = oStyles.getByName("LingmoOrient")
  props = sSrc.PropertySetInfo.Properties
  Dim k As Integer
  For k = 0 To UBound(props)
    On Error Resume Next
    p = props(k)
    sNew.setPropertyValue(p.Name, sSrc.getPropertyValue(p.Name))
    On Error Goto 0
  Next k
  Dim w As Long, h As Long, big As Long, small As Long
  w = sSrc.Width
  h = sSrc.Height
  If w > h Then
    big = w : small = h
  Else
    big = h : small = w
  End If
  ${orient === 'landscape' ? 'sNew.Width = big : sNew.Height = small' : 'sNew.Width = small : sNew.Height = big'}
  For i = 0 To oSheets.Count - 1
    oSheet = oSheets.getByIndex(i)
    oSheet.PageStyle = "LingmoOrient"
  Next i`
await runCase('F-copy-landscape', copyBody('landscape'))
await runCase('G-copy-portrait', copyBody('portrait'))

// case D: 就地交换既有页样式的 Width/Height（保留边距等设置）
await runCase('D-inplace-wh', `  oStyles = oDoc.StyleFamilies.getByName("PageStyles")
  For i = 0 To oSheets.Count - 1
    oSheet = oSheets.getByIndex(i)
    oStyle = oStyles.getByName(oSheet.PageStyle)
    Dim w As Long, h As Long
    w = oStyle.Width
    h = oStyle.Height
    If w < h Then
      oStyle.Width = h
      oStyle.Height = w
    End If
  Next i`)

// case E: 就地按需设置为纵向
await runCase('E-inplace-portrait', `  oStyles = oDoc.StyleFamilies.getByName("PageStyles")
  For i = 0 To oSheets.Count - 1
    oSheet = oSheets.getByIndex(i)
    oStyle = oStyles.getByName(oSheet.PageStyle)
    If oStyle.IsLandscape Then
      oStyle.IsLandscape = False
    End If
  Next i`)
