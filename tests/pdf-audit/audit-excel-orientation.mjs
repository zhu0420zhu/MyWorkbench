/**
 * 审计 pdfIpc.ts 的 pdf:excel-to-pdf —— pageOrientation 参数是否真正生效。
 *
 * 被审计代码（pdfIpc.ts:214-237）：
 *   const filter = {}
 *   if (input.pageOrientation === 'portrait') filter.SelectPdfVersion = 0
 *   const filterJson = JSON.stringify({
 *     ...filter,
 *     ...(pageOrientation !== 'auto' ? { SinglePageSheets: {type:'boolean', value:false} } : {})
 *   })
 *   const convertArg = pageOrientation !== 'auto'
 *     ? `pdf:calc_pdf_Export:${filterJson}`
 *     : 'pdf:calc_pdf_Export'
 *
 * 疑点：
 *   - SelectPdfVersion 控制的是 PDF 版本号，与页面方向无关
 *   - portrait 与 landscape 生成的 filterJson 只差 SelectPdfVersion，
 *     即「纵向/横向」在参数上几乎没有区别
 *   - 真正控制方向的是 calc_pdf_Export 的 PageOrientation / SinglePageSheets 等键
 *     （代码注释自己也写了「UsePageLayout 未直接暴露；...先转再说明」）
 *
 * 验证：实际调用 soffice，比对三种设置产出的页宽/页高。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'

const execFileP = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const FIX = join(HERE, 'fixtures')
const WORK = join(HERE, 'work')
await rm(WORK, { recursive: true, force: true })
await mkdir(WORK, { recursive: true })

const SOFFICE = join(process.cwd(), 'resources', 'tools', 'soffice', 'program', 'soffice.com')
console.log('soffice:', existsSync(SOFFICE) ? '✅ ' + SOFFICE : '❌ 未找到')

async function runSoffice(args, tag) {
  const profile = join(WORK, 'profile-' + tag)
  const { stderr } = await execFileP(
    SOFFICE,
    ['-env:UserInstallation=file:///' + profile.replace(/\\/g, '/'), ...args],
    { timeout: 180000, windowsHide: true }
  ).catch((e) => ({ stderr: String(e.stderr || e.message) }))
  return stderr || ''
}

/* ---------- 1. 先把 CSV 转成 XLSX，作为「源工作簿」 ---------- */
const csv = join(FIX, 'sheet.csv')
const xlsxDir = join(WORK, 'src')
await mkdir(xlsxDir, { recursive: true })
await runSoffice(['--headless', '--norestore', '--convert-to', 'xlsx', '--outdir', xlsxDir, csv], 'conv')
const srcXlsx = join(xlsxDir, 'sheet.xlsx')
console.log('源工作簿:', existsSync(srcXlsx) ? '✅ sheet.xlsx' : '❌ 生成失败')

/* ---------- 2. 按被审计代码原样复刻三种方向的调用 ---------- */
function buildArgs(pageOrientation, outDir, sourcePath) {
  const filter = {}
  if (pageOrientation === 'portrait') filter.SelectPdfVersion = 0
  const filterJson = JSON.stringify({
    ...filter,
    ...(pageOrientation && pageOrientation !== 'auto'
      ? { SinglePageSheets: { type: 'boolean', value: false } }
      : {})
  })
  const convertArg =
    pageOrientation && pageOrientation !== 'auto'
      ? 'pdf:calc_pdf_Export:' + filterJson
      : 'pdf:calc_pdf_Export'
  return ['--headless', '--norestore', '--convert-to', convertArg, '--outdir', outDir, sourcePath]
}

const results = {}
const orientations = ['auto', 'portrait', 'landscape']
console.log('\n' + '='.repeat(74))
console.log('复刻 pdfIpc.ts 的三种 pageOrientation 调用')
console.log('='.repeat(74))

for (const o of orientations) {
  const outDir = join(WORK, 'out-' + o)
  await mkdir(outDir, { recursive: true })
  const args = buildArgs(o, outDir, srcXlsx)
  const convertArg = args[args.indexOf('--convert-to') + 1]
  console.log('\n[' + o + ']')
  console.log('  --convert-to ' + convertArg)
  const err = await runSoffice(args, o)
  if (err.trim()) console.log('  stderr: ' + err.trim().slice(0, 200))
  const pdfPath = join(outDir, 'sheet.pdf')
  if (!existsSync(pdfPath)) {
    console.log('  ❌ 未产出 PDF')
    continue
  }
  const bytes = await readFile(pdfPath)
  const doc = await PDFDocument.load(bytes)
  const sizes = doc.getPages().map((p) => p.getSize())
  const first = sizes[0]
  results[o] = {
    bytes: bytes.length,
    pages: doc.getPageCount(),
    w: Math.round(first.width),
    h: Math.round(first.height),
    landscape: first.width > first.height
  }
  console.log('  产出: ' + doc.getPageCount() + ' 页, 首页 ' +
    Math.round(first.width) + '×' + Math.round(first.height) + 'pt → ' +
    (first.width > first.height ? '横向' : '纵向') + ', ' + bytes.length + ' 字节')
}

/* ---------- 3. 判定 ---------- */
console.log('\n' + '='.repeat(74))
console.log('判定：纵向 / 横向 是否产生不同结果')
console.log('='.repeat(74))
const p = results.portrait
const l = results.landscape
if (p && l) {
  console.log('  portrait  : ' + p.w + '×' + p.h + ' (' + (p.landscape ? '横向' : '纵向') + ') ' + p.bytes + 'B')
  console.log('  landscape : ' + l.w + '×' + l.h + ' (' + (l.landscape ? '横向' : '纵向') + ') ' + l.bytes + 'B')
  const sameSize = p.w === l.w && p.h === l.h
  console.log('\n  页尺寸是否相同 : ' + (sameSize ? '❌ 完全相同 —— 方向参数未生效' : '✅ 不同 —— 方向生效'))
  if (!sameSize) {
    console.log('  portrait 方向 : ' + (p.landscape ? '横向' : '纵向'))
    console.log('  landscape 方向: ' + (l.landscape ? '横向' : '纵向'))
  }
}
if (results.auto) {
  const a = results.auto
  console.log('\n  auto      : ' + a.w + '×' + a.h + ' (' + (a.landscape ? '横向' : '纵向') + ') ' + a.bytes + 'B')
}
