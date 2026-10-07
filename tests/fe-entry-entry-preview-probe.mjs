/**
 * fe-entry 入口/预览链路探针（不进 Electron，直接复刻主进程两段转换逻辑）：
 *   A. XLSX → PDF：串行 + 独立 UserInstallation profile + 三条件判定
 *      （与 src/main/docs/spreadsheetPreview.ts spreadsheetToPdfBytes 完全同参）
 *   B. TIFF → PNG：ffmpeg 一帧转换 + 三条件判定
 *      （与 src/main/docsIpc.ts openDocPath 的 TIFF 分支完全同参）
 *
 * 运行：node tests/fe-entry-entry-preview-probe.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync, mkdirSync, rmSync, copyFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const ROOT = 'd:/YM/MyWorkbench'
const SOFFICE = join(ROOT, 'resources/tools/soffice/program/soffice.com')
const FFMPEG = join(ROOT, 'resources/tools/ffmpeg/ffmpeg.exe')
const XLSX = join(ROOT, 'tests/pdf-audit/scratch/format-probe/samples/source-table.xlsx')

const TMP = join(ROOT, 'tests/pdf-audit/scratch/fe-entry-probe-' + Date.now())
mkdirSync(TMP, { recursive: true })

function run(bin, args, timeoutSec) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, output: output + '\n[timeout]' })
    }, timeoutSec * 1000)
    child.stdout?.on('data', (d) => (output += String(d)))
    child.stderr?.on('data', (d) => (output += String(d)))
    child.on('exit', (code) => { clearTimeout(timer); resolve({ ok: code === 0, output }) })
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, output: output + String(err) }) })
  })
}

/** 三条件判定：退出码 0 + 产物存在 + 大小>0 */
function check3(ok, file) {
  const size = ok && existsSync(file) ? statSync(file).size : 0
  return { pass: ok && size > 0, size }
}

let failed = false

// ---------- A. XLSX → PDF ----------
{
  const outDir = join(TMP, 'xlsx-out')
  const profile = join(TMP, 'xlsx-profile')
  mkdirSync(outDir, { recursive: true })
  const args = [
    '--headless', '--norestore',
    '-env:UserInstallation=file:///' + profile.replace(/\\/g, '/'),
    '--convert-to', 'pdf',
    '--outdir', outDir.replace(/\\/g, '/'),
    XLSX.replace(/\\/g, '/')
  ]
  const t0 = Date.now()
  const r = await run(SOFFICE, args, 300)
  const expected = join(outDir, basename(XLSX).replace(/\.(xlsx|xls|ods)$/i, '') + '.pdf')
  const { pass, size } = check3(r.ok, expected)
  console.log(`[A] XLSX→PDF pass=${pass} rc=${r.ok} pdfSize=${size}B elapsed=${Date.now() - t0}ms file=${expected}`)
  if (!pass) { console.log('[A] stderr tail:', r.output.slice(-500)); failed = true }
  // PDF 头校验
  if (pass) {
    const head = await import('node:fs').then((fs) => fs.readFileSync(expected).subarray(0, 5).toString())
    console.log(`[A] PDF magic=${head!=='%PDF-' ? head : '%PDF- OK'}`)
    if (head !== '%PDF-') failed = true
  }
}

// ---------- B. TIFF 生成 + TIFF → PNG ----------
{
  // 先用 ffmpeg lavfi 生成一张 PNG，再转成 TIFF 当样本（保证是真 TIFF）
  const pngSrc = join(TMP, 'gen.png')
  const tiff = join(TMP, 'sample.tiff')
  let r1 = await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=c=steelblue:s=320x200:d=1', '-frames:v', '1', pngSrc], 60)
  let c1 = check3(r1.ok, pngSrc)
  console.log(`[B1] 生成 PNG 样本 pass=${c1.pass} size=${c1.size}B`)
  if (!c1.pass) { console.log('[B1] stderr tail:', r1.output.slice(-400)); failed = true }
  let r2 = await run(FFMPEG, ['-y', '-i', pngSrc, tiff], 60)
  let c2 = check3(r2.ok, tiff)
  console.log(`[B2] PNG→TIFF 样本 pass=${c2.pass} size=${c2.size}B`)
  if (!c2.pass) { console.log('[B2] stderr tail:', r2.output.slice(-400)); failed = true }

  // 与 docsIpc TIFF 分支同参：['-y','-i',file,outPng]
  const outPng = join(TMP, basename(tiff).replace(/\.(tiff?|tif)$/i, '') + '.png')
  const t0 = Date.now()
  const r3 = await run(FFMPEG, ['-y', '-i', tiff, outPng], 120)
  const c3 = check3(r3.ok, outPng)
  console.log(`[B3] TIFF→PNG pass=${c3.pass} size=${c3.size}B elapsed=${Date.now() - t0}ms`)
  if (!c3.pass) { console.log('[B3] stderr tail:', r3.output.slice(-400)); failed = true }
  else {
    const head = await import('node:fs').then((fs) => fs.readFileSync(outPng).subarray(0, 8))
    const isPng = head[0] === 0x89 && head[1] === 0x50
    console.log(`[B3] PNG magic=${isPng ? 'OK' : 'BAD'}`)
    if (!isPng) failed = true
  }
  copyFileSync(tiff, join(TMP, 'sample-keep.tiff'))
}

console.log(failed ? 'PROBE RESULT: FAIL' : 'PROBE RESULT: ALL PASS')
process.exit(failed ? 1 : 0)
