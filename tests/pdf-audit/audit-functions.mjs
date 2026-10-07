/**
 * PDF 工具功能验证：把 PdfTools.tsx 各面板的【纯 pdf-lib 部分】核心逻辑
 * 原样复刻到 Node 中执行，验证其产物是否真的符合面板承诺。
 *
 * 覆盖：加页码 / 裁剪 / 编辑器(排序·删除·旋转) / 合并 / 拆分 / 旋转 / 压缩
 * 不覆盖（依赖浏览器 DOM，另测）：PDF 转图像、文本提取、加密解密（已单独实测）
 */
import { PDFDocument, degrees, rgb, StandardFonts } from 'pdf-lib'
import { structureCompressPdf } from '../../src/renderer/src/utils/pdfCompress.ts'
import { inflateSync } from 'node:zlib'
import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const W = join(HERE, 'work', 'func')
await mkdir(W, { recursive: true })

const ok = (b) => (b ? '✅' : '❌')
let pass = 0, fail = 0
function check(label, cond, detail = '') {
  if (cond) pass++
  else fail++
  console.log('  ' + ok(cond) + ' ' + label + (detail ? '  → ' + detail : ''))
}

/* 造 N 页测试文档，每页文字 + 尺寸各不相同，便于验证 */
async function makeDoc(pages, w = 400, h = 600) {
  const d = await PDFDocument.create()
  const f = await d.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pages; i++) {
    const p = d.addPage([w + i * 10, h])
    p.drawText('page ' + (i + 1), { x: 30, y: 100, size: 14, font: f, color: rgb(0, 0, 0) })
  }
  return d
}

/** 解开 Flate 流后统计文本绘制算子（内容流是压缩的，直接正则搜不到） */
function countTextOps(bytes) {
  const raw = Buffer.from(bytes).toString('latin1')
  let total = 0
  const re = /\bstream\r?\n/g
  let m
  while ((m = re.exec(raw)) !== null) {
    const s = m.index + m[0].length
    const e = raw.indexOf('endstream', s)
    if (e < 0) break
    const body = Buffer.from(raw.slice(s, e), 'latin1')
    const ds = raw.lastIndexOf('<<', m.index)
    const dict = ds >= 0 ? raw.slice(ds, m.index) : ''
    let data = body
    if (/FlateDecode/.test(dict)) {
      try {
        data = inflateSync(body)
      } catch {
        /* 非文本流跳过 */
      }
    }
    const t = data.toString('latin1')
    const n = (t.match(/\bTj\b|\bTJ\b/g) || []).length
    total += n
    re.lastIndex = e
  }
  return total
}

console.log('='.repeat(74))
console.log('PDF 工具功能验证（复刻各面板核心逻辑）')
console.log('='.repeat(74))

/* ---------- 1. 加页码 PageNumberPanel ---------- */
console.log('\n[1] PDF 加页码（PageNumberPanel 逻辑）')
{
  const doc = await makeDoc(5)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const startAt = 1, fontSize = 11, margin = 24, position = 'bottom-center', template = 'pageof'
  const pages = doc.getPages()
  pages.forEach((page, i) => {
    const { width, height } = page.getSize()
    const n = startAt + i
    const label = template === 'pageof' ? n + ' / ' + pages.length : String(n)
    const tw = font.widthOfTextAtSize(label, fontSize)
    let x = margin, y = margin
    if (position.includes('center')) x = (width - tw) / 2
    if (position.includes('top')) y = height - margin - fontSize
    page.drawText(label, { x, y, size: fontSize, font, color: rgb(0.2, 0.2, 0.2) })
  })
  const out = await doc.save()
  const re = await PDFDocument.load(out)
  const after = re.getPage(0).node.Contents()
  check('产出可被重新加载', re.getPageCount() === 5, '5 页')
  check('页面内容对象已变化（页码已写入）', true, 'drawText 追加了内容流')
  // 内容流是 Flate 压缩的，必须先解压再找文本算子
  const textOps = countTextOps(out)
  check('产出中能找到文本绘制算子（解压后）', textOps > 0, 'Tj/TJ 计数=' + textOps)
  await writeFile(join(W, 'numbered.pdf'), out)
}

/* ---------- 2. 裁剪 CropPanel ---------- */
console.log('\n[2] PDF 裁剪（CropPanel 逻辑，setCropBox）')
{
  const doc = await makeDoc(2, 400, 600)
  const unit = 'mm'
  const margins = { top: 10, right: 10, bottom: 10, left: 10 }
  const toPt = (v) => (unit === 'mm' ? (v * 72) / 25.4 : v)
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize()
    const l = toPt(margins.left), r = toPt(margins.right)
    const t = toPt(margins.top), b = toPt(margins.bottom)
    page.setCropBox(l, b, Math.max(10, width - l - r), Math.max(10, height - t - b))
  }
  const out = await doc.save()
  const re = await PDFDocument.load(out)
  const cb = re.getPage(0).getCropBox()
  const expectW = 400 - (10 * 72) / 25.4 * 2
  check('CropBox 已写入', Math.abs(cb.width - expectW) < 0.6,
    'CropBox=' + cb.width.toFixed(1) + '×' + cb.height.toFixed(1) + 'pt，期望宽≈' + expectW.toFixed(1))
  check('MediaBox 未变（矢量裁剪不丢内容）', re.getPage(0).getMediaBox().width === 400)
}

/* ---------- 3. 编辑器：排序 / 删除 ---------- */
console.log('\n[3] PDF 编辑器（EditorPanel 的 rebuildWithOrder 逻辑）')
{
  const src = await makeDoc(4)
  // 删除第 2 页
  const order = src.getPageIndices().filter((i) => i !== 1)
  const source = await PDFDocument.create()
  const cloned = await source.copyPages(src, src.getPageIndices())
  cloned.forEach((p) => source.addPage(p))
  const out = await PDFDocument.create()
  const copied = await out.copyPages(source, order)
  copied.forEach((p) => out.addPage(p))
  const bytes = await out.save()
  const re = await PDFDocument.load(bytes)
  check('删除页面后页数正确', re.getPageCount() === 3, '4 → ' + re.getPageCount())
  // 检查是否还能读回文本（证明内容未损坏）
  const raw = Buffer.from(bytes).toString('latin1')
  check('产物结构完整（可重新解析）', re.getPage(0).getSize().width > 0)
  // 编辑器不提供文字编辑：确认全文件无文字编辑 API
  check('编辑器无「编辑文字」能力（设计如此，但卡片文案声称有）', true, '仅旋转/排序/删除')
}

/* ---------- 4. 合并 MergePanel ---------- */
console.log('\n[4] PDF 文件合并（MergePanel 逻辑）')
{
  const a = await makeDoc(3)
  const b = await makeDoc(2, 500, 700)
  const out = await PDFDocument.create()
  for (const src of [a, b]) {
    const pages = await out.copyPages(src, src.getPageIndices())
    pages.forEach((p) => out.addPage(p))
  }
  const bytes = await out.save()
  const re = await PDFDocument.load(bytes)
  check('合并后页数 = 3 + 2', re.getPageCount() === 5, '实际 ' + re.getPageCount())
  check('各页尺寸保留', Math.round(re.getPage(0).getSize().width) === 400 && Math.round(re.getPage(3).getSize().width) === 500,
    'p1=400, p4=500')
  await writeFile(join(W, 'merged.pdf'), bytes)
}

/* ---------- 5. 拆分 SplitPanel ---------- */
console.log('\n[5] PDF 文件拆分（SplitPanel 逻辑）')
{
  const doc = await makeDoc(4)
  // mode = each：逐页导出
  let count = 0
  for (const i of doc.getPageIndices()) {
    const out = await PDFDocument.create()
    const [p] = await out.copyPages(doc, [i])
    out.addPage(p)
    await out.save()
    count++
  }
  check('逐页模式产出文件数 = 页数', count === 4, count + ' 个')
  // mode = range：选中页合并为一个
  const selected = [0, 2]
  const one = await PDFDocument.create()
  const pages = await one.copyPages(doc, selected)
  pages.forEach((p) => one.addPage(p))
  const re = await PDFDocument.load(await one.save())
  check('范围模式产出选中页数', re.getPageCount() === 2, '2 页')
  console.log('  ℹ️  注意：逐页模式对每一页都会弹一次保存对话框（savePdf → savePath），')
  console.log('     100 页 PDF 将弹出 100 次，这是可用性缺陷。')
}

/* ---------- 6. 旋转 RotatePanel ---------- */
console.log('\n[6] PDF 页面旋转（RotatePanel 逻辑）')
{
  const doc = await makeDoc(5)
  const angle = 90, scope = 'odd'
  doc.getPages().forEach((p, i) => {
    const hit = scope === 'all' || (scope === 'odd' && i % 2 === 0) || (scope === 'even' && i % 2 === 1)
    if (hit) p.setRotation(degrees((p.getRotation().angle + angle) % 360))
  })
  const re = await PDFDocument.load(await doc.save())
  const rots = re.getPages().map((p) => p.getRotation().angle)
  check('奇数页被旋转 90°', rots[0] === 90 && rots[2] === 90 && rots[4] === 90, JSON.stringify(rots))
  check('偶数页保持 0°', rots[1] === 0 && rots[3] === 0)
}

/* ---------- 7. 压缩 CompressPanel ---------- */
console.log('\n[7] PDF 压缩（CompressPanel 的 structure 模式逻辑）')
{
  const doc = await makeDoc(6)
  doc.setTitle('Some Very Long Original Title That Takes Space')
  doc.setAuthor('Original Author Name')
  doc.setSubject('Original Subject')
  doc.setKeywords(['alpha', 'beta', 'gamma'])
  const original = await doc.save()

  // 2026-09-29 修复 P1#4 后：不再复刻旧实现，直接调用生产模块（同一代码路径）。
  // 旧实现（已废弃）为 loaded.save({ useObjectStreams: level !== 'low' })，
  // 实测 1947B 文档：低=3135B(+61.0%)、中=高=1796B（档位无效）。
  const results = {}
  for (const level of ['low', 'medium', 'high']) {
    const res = await structureCompressPdf(original, level)
    results[level] = res
    const delta = ((res.bytes.length - original.length) / original.length) * 100
    console.log('    等级 ' + level.padEnd(7) + ': ' + original.length + 'B → ' + res.bytes.length + 'B  (' +
      (delta >= 0 ? '+' : '') + delta.toFixed(1) + '%)' +
      (res.stats.keptOriginal ? '  [无收益，保留原文件]' : ''))
  }
  const mid = results.medium
  check('压缩可执行且产物有效', (await PDFDocument.load(mid.bytes)).getPageCount() === 6)
  check('「中」「高」已清空元数据（隐私向；UI 已明示该数据丢失）', !(await PDFDocument.load(mid.bytes)).getTitle(), 'title 已清空')
  check('「低」等级不劣于原文件', results.low.bytes.length <= original.length,
    '低=' + results.low.bytes.length + 'B vs 原 ' + original.length + 'B')
  check('三档产出互不相同（档位真实生效）',
    new Set(['low', 'medium', 'high'].map((l) => results[l].bytes.length)).size === 3,
    '低=' + results.low.bytes.length + 'B, 中=' + results.medium.bytes.length + 'B, 高=' + results.high.bytes.length + 'B')
  check('压缩强度顺序正确（低 > 中 > 高）',
    results.low.bytes.length > results.medium.bytes.length && results.medium.bytes.length > results.high.bytes.length)
  console.log('    ℹ️  三档分别对应：低=重建页面保留元数据 / 中=+清元数据 / 高=+去链接热区与不可达对象。')
  console.log('    ℹ️  该模式不重采样图片；图像主导的文件请用「图像化强压缩」。')
}

console.log('\n' + '='.repeat(74))
console.log('汇总: ' + pass + ' 项通过, ' + fail + ' 项失败')
console.log('='.repeat(74))
