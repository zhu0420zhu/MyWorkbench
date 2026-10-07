/**
 * PPT 工具链路冒烟：pptxgenjs 生成 → JSZip 解包文本 → soffice 转 PDF → pdf-lib 验证。
 * 对应 DocsViewer PPT 工具下拉的三个关键后端能力。
 * 跑法：NODE_OPTIONS="" node tests/smoke-ppt.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import PptxGenJS from 'pptxgenjs'
import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'

let failed = 0
const expect = (cond, msg) => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${msg}`)
  if (!cond) failed++
}

const work = mkdtempSync(join(tmpdir(), 'ppt-smoke-'))
const soffice = 'D:/YM/MyWorkbench/resources/tools/soffice/program/soffice.exe'
console.log('工作目录:', work)

// 1) pptxgenjs 生成样本（AI 草稿链路的生成端）
const pres = new PptxGenJS()
pres.defineLayout({ name: 'W16x9', width: 13.333, height: 7.5 })
pres.layout = 'W16x9'
const sample = [
  { title: '季度经营回顾', bullets: ['营收同比增长 23%', '新增客户 128 家'] },
  { title: '产品进展', bullets: ['v2.0 发布', '崩溃率下降 40%'] },
  { title: '下季度计划', bullets: ['国际化', '企业版'] }
]
for (const s of sample) {
  const slide = pres.addSlide()
  slide.addText(s.title, { x: 0.6, y: 0.5, w: 12, h: 1, fontSize: 28, bold: true })
  slide.addText(s.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })), {
    x: 0.9,
    y: 1.8,
    w: 11.5,
    h: 5,
    fontSize: 16
  })
}
const pptxPath = join(work, 'sample.pptx')
await pres.writeFile({ fileName: pptxPath })
expect(existsSync(pptxPath) && readFileSync(pptxPath).length > 5000, `pptxgenjs 生成 PPTX（${readFileSync(pptxPath).length} B）`)

// 2) JSZip 解包文本（文本提取链路）
const zip = await JSZip.loadAsync(readFileSync(pptxPath))
const slideNames = Object.keys(zip.files)
  .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
  .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]))
expect(slideNames.length === 3, `JSZip 解出 ${slideNames.length} 张 slide XML`)
const page1 = await zip.files[slideNames[0]].async('string')
const texts = Array.from(page1.matchAll(/<a:t>([^<]*)<\/a:t>/g)).map((m) => m[1])
expect(texts.includes('季度经营回顾') && texts.includes('营收同比增长 23%'), 'slide1 文本提取含标题与要点')

// 3) soffice pptx → pdf（转换链路，与生产 convertPptToPdf 同参数）
if (existsSync(soffice)) {
  // stdio 显式 ignore stdin：默认 stdin 管道在 ConPTY 宿主下 spawn 会报 EBUSY
  const r = spawnSync(soffice, [
    '--headless', '--norestore',
    '-env:UserInstallation=file:///' + join(work, 'profile').replace(/\\/g, '/'),
    '--convert-to', 'pdf', '--outdir', work, pptxPath
  ], { timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONPATH: '', PYTHONHOME: '' } })
  const pdfPath = join(work, 'sample.pdf')
  expect(r.status === 0 && existsSync(pdfPath), 'soffice 转 PDF 成功')
  if (existsSync(pdfPath)) {
    const pdf = await PDFDocument.load(readFileSync(pdfPath))
    expect(pdf.getPageCount() === 3, `PDF 页数 = 3（实际 ${pdf.getPageCount()}）`)
  }
} else {
  console.log('  [SKIP] 本机无 soffice，跳过转换段')
}

rmSync(work, { recursive: true, force: true })
console.log(failed === 0 ? '\n结论: ✅ PPT 工具链路全通' : `\n结论: ❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
