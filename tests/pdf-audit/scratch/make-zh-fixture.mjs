/**
 * 生成「就地改字」验收用的中文多页样本 PDF。
 *
 * 输出：tests/pdf-audit/scratch/out/zh-edit-src.pdf
 *   - 3 页；第 1 页含内嵌位图（图片 XObject，用于验证图片字节不变）、
 *     一条纯 ASCII 行、一条中文行、一个中文标题。
 *
 * 走 soffice 把 HTML 转 PDF（与用户实际「Word/HTML → PDF」的来源一致），
 * 幂等：重复执行会覆盖产物。
 *
 * 运行：node tests/pdf-audit/scratch/make-zh-fixture.mjs
 */
import { execFile } from 'node:child_process'
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { createCanvas } from '@napi-rs/canvas'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const OUT = join(HERE, 'out')
const SOFFICE = join(ROOT, 'resources', 'tools', 'soffice', 'program', 'soffice.com')

await mkdir(OUT, { recursive: true })

/* ---------- 1. 先造一张位图（保证样本里确实有图片 XObject） ---------- */
const c = createCanvas(360, 160)
const ctx = c.getContext('2d')
ctx.fillStyle = '#e8f0fe'
ctx.fillRect(0, 0, 360, 160)
ctx.fillStyle = '#1a73e8'
ctx.fillRect(16, 16, 328, 40)
ctx.fillStyle = '#ffffff'
ctx.font = '20px "Microsoft YaHei", SimSun, sans-serif'
ctx.fillText('FIXTURE IMAGE', 40, 46)
ctx.strokeStyle = '#1a73e8'
ctx.lineWidth = 3
ctx.strokeRect(16, 72, 150, 70)
ctx.beginPath()
ctx.arc(250, 107, 35, 0, Math.PI * 2)
ctx.fillStyle = '#fbbc04'
ctx.fill()
const png = c.toBuffer('image/png')
await writeFile(join(OUT, 'fixture-image.png'), png)
console.log('位图        : ' + join(OUT, 'fixture-image.png') + '  (' + png.length + ' 字节, 360x160)')

/* ---------- 2. HTML（含中文 + ASCII + 图片 + 强制分页） ---------- */
const html = `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  @page { margin: 2cm; }
  body { font-family: "Microsoft YaHei", "SimSun", sans-serif; font-size: 12pt; line-height: 1.8; }
  h1 { font-size: 20pt; margin: 0 0 12pt 0; }
  p { margin: 6pt 0; }
  .ascii { font-family: Consolas, "Courier New", monospace; }
  img { width: 300px; height: 133px; }
</style></head>
<body>
  <h1>采购合同 · 灵墨工作台</h1>
  <p class="ascii">DRAFT-2026</p>
  <p class="ascii">合同编号 ABCD-1234</p>
  <p>本合同自双方签字之日起生效，未尽事宜由双方另行协商解决。</p>
  <p><img src="fixture-image.png" alt="fixture"></p>
  <p style="page-break-before: always">第二页：乙方应于签署后三十日内交付全部货物，逾期按日计收违约金。</p>
  <p class="ascii">SHIPMENT-QTY-1000</p>
  <p style="page-break-before: always">第三页：本页仅用于验证「未编辑页一个字节不变」，不参与任何替换。</p>
  <p class="ascii">PAGE-THREE-MARKER</p>
</body></html>
`
const htmlPath = join(OUT, 'zh-edit-src.html')
await writeFile(htmlPath, html, 'utf8')
console.log('HTML        : ' + htmlPath)

/* ---------- 3. soffice 转 PDF ---------- */
const args = [
  '--headless',
  '--norestore',
  `-env:UserInstallation=file:///${join(OUT, 'soffice-profile').replace(/\\/g, '/')}`,
  '--convert-to',
  'pdf',
  '--outdir',
  OUT,
  htmlPath
]
const { stdout, stderr } = await run(SOFFICE, args, { timeout: 120000, windowsHide: true })
console.log('soffice out : ' + JSON.stringify(stdout.trim()))
if (stderr.trim()) console.log('soffice err : ' + JSON.stringify(stderr.trim()))

const pdfPath = join(OUT, 'zh-edit-src.pdf')
const st = await stat(pdfPath)
console.log('PDF         : ' + pdfPath + '  (' + st.size + ' 字节)')
