/**
 * QA 独立验证：PDF「就地编辑（保版式改字 + 样式 + 批注）」。
 *
 * 运行：
 *   NODE_OPTIONS="" node --experimental-strip-types tests/pdf-inplace-verify.mjs
 *
 * 环境说明（重要，避免「用英文冒充中文」）：
 *   生产代码的中文路径走 `pdfText.renderTextToPng`，内部用 `document.createElement('canvas')`。
 *   纯 Node 没有 DOM，但本机装了 `@napi-rs/canvas`（真实 canvas2d + PNG 编码器 + 系统字体）。
 *   我用它给 `globalThis.document` 做一个**真实 canvas 后端**（不是桩：measureText 真测量、
 *   真光栅化、真 PNG 编码、系统 Microsoft YaHei 真出字）。因此中文用例是**真覆盖**，
 *   非「标注未验证」。
 *
 * 证据链（互不依赖）：
 *   - 流逐字节：pdf-lib 结构化枚举原始流 sha1 + 原始 `\bstream`/JPEG SOI-EOI 扫描交叉印证；
 *   - 页面可见性：pdf.js 提取每页全文（判断空白 / 内容丢失）；
 *   - 结构合法性：pdf.js getDocument 打开 + pdf-lib 重新 load。
 */
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument, PDFName, PDFRef, PDFRawStream, StandardFonts, rgb } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const WORK = join(HERE, 'pdf-audit', 'qa', 'qa-work', 'inplace')
const SOFFICE = join(ROOT, 'resources', 'tools', 'soffice', 'program', 'soffice.com')
await rm(WORK, { recursive: true, force: true })
await mkdir(WORK, { recursive: true })

/* ---------- 真实 canvas DOM 后端（@napi-rs/canvas） ---------- */
globalThis.document = {
  createElement: (tag) => {
    if (tag !== 'canvas') throw new Error('unsupported element: ' + tag)
    return createCanvas(1, 1)
  }
}

/* ---------- 断言器 ---------- */
let pass = 0
let fail = 0
const failList = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  [PASS] ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; failList.push(name); console.log('  [FAIL] ' + name + (detail ? '  ' + detail : '')) }
}
function info(msg) { console.log('  · ' + msg) }
function section(t) { console.log('\n=== ' + t + ' ===') }
const sha1 = (buf) => createHash('sha1').update(Buffer.from(buf)).digest('hex')

/* ---------- 原始字节工具 ---------- */
/** 从原始文件字节里扫出所有 JPEG（SOI FFD8FF … EOI FFD9），完全不依赖任何 PDF 库 */
function rawJpegs(buf) {
  const b = Buffer.from(buf)
  const out = []
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === 0xff && b[i + 1] === 0xd8 && b[i + 2] === 0xff) {
      for (let j = i + 2; j + 1 < b.length; j++) {
        if (b[j] === 0xff && b[j + 1] === 0xd9) { out.push(b.subarray(i, j + 2)); break }
      }
    }
  }
  return out
}
/** 用 `\bstream` 扫描全部流载荷（不依赖 /stream\r?\n 的换行假设） */
function rawStreamPayloads(buf) {
  const b = Buffer.from(buf)
  const out = []
  const re = /\bstream/g
  let m
  while ((m = re.exec(b)) !== null) {
    let s = m.index + m[0].length
    // 跳过 stream 关键字后的 EOL（\r\n / \n / \r）
    if (b[s] === 0x0d) s++
    if (b[s] === 0x0a) s++
    const end = b.indexOf('endstream', s)
    if (end < 0) continue
    let e = end
    while (e > s && (b[e - 1] === 0x0a || b[e - 1] === 0x0d)) e--
    out.push(b.subarray(s, e))
    re.lastIndex = end
  }
  return out
}

/* ---------- pdf-lib 结构化流清单（剔除结构流） ---------- */
async function streamInventory(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const items = []
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue
    const t = obj.dict.get(PDFName.of('Type'))?.toString() ?? ''
    const st = obj.dict.get(PDFName.of('Subtype'))?.toString() ?? ''
    const raw = Buffer.from(obj.contents)
    items.push({ ref: ref.toString(), type: t, subtype: st, len: raw.length, sha: sha1(raw) })
  }
  return items
}
const isStructural = (it) => it.type === '/XRef' || it.type === '/ObjStm'
function shasMultiset(items) {
  const m = new Map()
  for (const it of items) m.set(it.sha, (m.get(it.sha) ?? 0) + 1)
  return m
}
/** input 的每条流（剔除结构流）在 output 中都有字节一致的对应 */
function missingStreams(inItems, outItems) {
  const out = shasMultiset(outItems.filter((x) => !isStructural(x)))
  const missing = []
  for (const it of inItems.filter((x) => !isStructural(x))) {
    const n = out.get(it.sha) ?? 0
    if (n === 0) missing.push(it)
  }
  return missing
}

/* ---------- 页面内容流原始字节 ---------- */
function pageContentParts(doc, i) {
  const c = doc.getPage(i).node.get(PDFName.of('Contents'))
  const parts = []
  const one = (x) => {
    const o = x instanceof PDFRef ? doc.context.lookup(x) : x
    if (o?.contents) parts.push(Buffer.from(o.contents))
  }
  if (c && typeof c.asArray === 'function') c.asArray().forEach(one)
  else if (c) one(c)
  return parts
}
function pageContentsRaw(doc, i) {
  return Buffer.concat(pageContentParts(doc, i))
}
/** 内容流文本：pdf-lib 新建的流是 Flate 压缩的，必须逐段解压后再匹配操作符 */
function inflateMaybe(buf) {
  try { return zlib.inflateSync(buf) } catch { return buf }
}
function pageContentsText(doc, i) {
  return Buffer.concat(pageContentParts(doc, i).map(inflateMaybe)).toString('latin1')
}

/**
 * 从内容流文本里解析所有**实心填充矩形**的边界框。
 * pdf-lib 的 drawRectangle 用路径算子（cm 平移 + m/l/l/l + h + f），不是 `re`；
 * 为稳妥两种画法都收集。
 */
function filledRects(text) {
  const out = []
  const rePath = /1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm([\s\S]{0,240}?)h\s*f\b/g
  for (const m of text.matchAll(rePath)) {
    const x = Number(m[1]); const y = Number(m[2])
    const pts = [...m[3].matchAll(/(-?[\d.]+)\s+(-?[\d.]+)\s+l/g)].map((z) => [Number(z[1]), Number(z[2])])
    if (pts.length >= 3) out.push([x, y, Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))])
  }
  for (const m of text.matchAll(/([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+re\s*f\b/g)) {
    out.push(m.slice(1).map(Number))
  }
  return out
}

/* ---------- pdf.js 提取每页全文 ---------- */
async function extractPages(bytes) {
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: join(ROOT, 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/',
    cMapUrl: join(ROOT, 'node_modules', 'pdfjs-dist', 'cmaps') + '/',
    cMapPacked: true,
    disableWorker: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0
  })
  const pdf = await task.promise
  const num = pdf.numPages
  const pages = []
  for (let i = 1; i <= num; i++) {
    const p = await pdf.getPage(i)
    const tc = await p.getTextContent()
    pages.push(tc.items.map((it) => it.str).join(''))
  }
  if (task.destroy) await task.destroy()
  return { num, pages }
}

/* ---------- 造素材 ---------- */
const CJK = '这是被替换后的中文内容'

async function makeJpeg(w = 220, h = 140) {
  const c = createCanvas(w, h)
  const ctx = c.getContext('2d')
  const g = ctx.createLinearGradient(0, 0, w, h)
  g.addColorStop(0, '#1e63b0')
  g.addColorStop(1, '#f2c14e')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#111'
  ctx.font = 'bold 26px "Microsoft YaHei", sans-serif'
  ctx.fillText('封面色块 QA', 14, 50)
  return await c.encode('jpeg', 82)
}

/** 输入 1：soffice 从含中文 HTML 转出的 PDF */
async function makeSofficeHtmlPdf() {
  const tmp = join(WORK, 'html')
  await mkdir(tmp, { recursive: true })
  // 造 ≥3 页：LibreOffice 的 HTML 导入会忽略 CSS page-break，因此用足量段落自然分页，
  // 保证存在"未编辑页"可与输入逐字符比对。
  let body = '<h1>季度经营分析报告</h1>'
  for (let i = 1; i <= 90; i++) {
    body += `<p>第 ${i} 行：这是原始正文，用于验证就地改字后其余内容仍在，ASCII abc ${i}。</p>`
  }
  body += '<p>末行：这一页完全不动，必须逐字符与输入相同 QATHIRD。</p>'
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' + body + '</body></html>'
  const src = join(tmp, 'doc.html')
  await writeFile(src, html, 'utf-8')
  const env = { ...process.env }; delete env.PYTHONPATH; delete env.PYTHONHOME; delete env.PYTHONSTARTUP
  await new Promise((resolve) => {
    const ch = spawn(SOFFICE, ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', tmp.replace(/\\/g, '/'), src.replace(/\\/g, '/')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env })
    ch.on('close', resolve); ch.on('error', resolve)
  })
  const out = join(tmp, 'doc.pdf')
  return existsSync(out) ? await readFile(out) : null
}

/** 输入 2：带 xref 流 / 对象流（1.5+）——用 pdf-lib 生成 */
async function makeXrefStreamPdf() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < 3; i++) {
    doc.addPage([595.28, 841.89]).drawText('XREF-PAGE-' + (i + 1) + ' original line', { x: 60, y: 760, size: 14, font, color: rgb(0, 0, 0) })
  }
  return await doc.save({ useObjectStreams: true })
}

/** 输入 3：含真实 JPEG 图片 + 文字（3 页，图在第 1 页） */
async function makeJpegPdf() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const jpg = await makeJpeg()
  const img = await doc.embedJpg(jpg)
  const p1 = doc.addPage([595.28, 841.89])
  p1.drawImage(img, { x: 60, y: 620, width: 220, height: 140 })
  p1.drawText('JPEG-PAGE-1 keep me intact', { x: 60, y: 580, size: 12, font, color: rgb(0, 0, 0) })
  for (let i = 1; i < 3; i++) {
    doc.addPage([595.28, 841.89]).drawText('PLAIN-PAGE-' + (i + 1) + ' original line', { x: 60, y: 760, size: 14, font, color: rgb(0, 0, 0) })
  }
  return await doc.save()
}

function repFor(page, newText, extra = {}) {
  return {
    page,
    rect: { x: 60, y: 750, width: 300, height: 20 },
    baseline: 755,
    fontSize: 14,
    color: { r: 0, g: 0, b: 0 },
    bgColor: { r: 1, g: 1, b: 1 },
    align: 'left',
    newText,
    ...extra
  }
}
const hiAnno = (page, op = 0.35) => ({ page, rect: { x: 60, y: 748, width: 300, height: 18 }, kind: 'highlight', color: { r: 1, g: 0.9, b: 0 }, opacity: op })

/* ================================================================
 *  第 0 部分（最高优先级）：真实输入 × 内容保全 / 非空白
 * ================================================================ */
const { replacePdfText } = await import('../src/renderer/src/utils/pdfInPlaceReplace.ts')

section('0. 真实来源输入 × 中文替换 + highlight：内容是否被弄丢/空白（P0）')

const inputs = []
{
  const s = await makeSofficeHtmlPdf()
  inputs.push({ name: 'a. soffice HTML→PDF（含中文）', bytes: s })
  inputs.push({ name: 'b. xref流/对象流 PDF（pdf-lib objectStreams）', bytes: await makeXrefStreamPdf() })
  inputs.push({ name: 'c. 含真实 JPEG 图片 PDF', bytes: await makeJpegPdf() })
  const realPath = join(HERE, 'pdf-audit', 'qa-fixtures', 'real-large-plain.pdf')
  if (existsSync(realPath)) inputs.push({ name: 'd. 真实世界大文件 qa-fixtures/real-large-plain.pdf', bytes: await readFile(realPath) })
  const esPath = join(HERE, 'pdf-audit', 'fixtures', 'enhance-source.pdf')
  if (existsSync(esPath)) inputs.push({ name: 'e. 真实 xref流/对象流 samples fixtures/enhance-source.pdf', bytes: await readFile(esPath) })
}

let sawXrefStreamInputs = []
for (const inp of inputs) {
  console.log('\n-- ' + inp.name + ' --')
  if (!inp.bytes) { ok(inp.name + '：素材生成', false, '素材缺失'); continue }

  // 结构特征（扫**原始字节**：pdf-lib 载入后会把对象流摊平，从对象列举里看不到 /ObjStm）
  const inRaw = inp.bytes
  const rawLatin = Buffer.from(inRaw).toString('latin1')
  const inInv = await streamInventory(inRaw)
  const hasObjStm = /\/ObjStm/.test(rawLatin)
  const hasXRef = /\/Type\s*\/XRef/.test(rawLatin)
  const header = Buffer.from(inRaw).subarray(0, 8).toString('latin1').trim()
  if (hasObjStm && hasXRef) sawXrefStreamInputs.push(inp.name)
  const inImgs = inInv.filter((x) => x.subtype === '/Image')
  const rawJ = rawJpegs(inRaw)
  const { num: inPages, pages: inText } = await extractPages(inRaw)
  info('输入：' + header + ' 页数=' + inPages + ' 对象流=' + hasObjStm + ' xref流=' + hasXRef + ' Image对象=' + inImgs.length + ' 原始JPEG段=' + rawJ.length + ' 提取文字长度=' + inText.join('').length)

  // 选未编辑页 = 最后一页；编辑页 = 第 2 页（1 基），若只有 1 页则编辑第 1 页
  const editPage = inPages >= 2 ? 1 : 0
  const untouched = inPages >= 3 ? [inPages - 1] : (inPages >= 2 ? [0] : [])

  const out = await replacePdfText(inRaw, [repFor(editPage, CJK)], [hiAnno(editPage, 0.35)])
  await writeFile(join(WORK, 'out-' + sha1(inp.name).slice(0, 6) + '.pdf'), out)

  // (1) pdf.js 能打开且不抛
  let opened = null
  try { opened = await extractPages(out) } catch (e) { opened = null; info('pdf.js 打开失败：' + e.message) }
  ok(inp.name + ' / 输出可被 pdf.js 打开且不抛', !!opened)
  if (!opened) { continue }

  const outText = opened.pages.join('')
  // (2) 非空白
  ok(inp.name + ' / 输出非空白（提取文字长度>0）', outText.trim().length > 0, '长度=' + outText.trim().length)
  // (3) 页数不变
  ok(inp.name + ' / 页数不变', opened.num === inPages, opened.num + ' vs ' + inPages)
  // (4) 内容没被大比例丢失（P0 判据）
  const ratio = inText.join('').length ? outText.length / inText.join('').length : 1
  ok(inp.name + ' / 提取文字未显著减少（≥70%）', ratio >= 0.7, (ratio * 100).toFixed(1) + '%')
  // (5) 未编辑页文字逐字符相同
  for (const u of untouched) {
    ok(inp.name + ' / 未编辑页 #' + (u + 1) + ' 文字与输入逐字符相同', opened.pages[u] === inText[u],
      JSON.stringify((inText[u] || '').slice(0, 40)) + ' vs ' + JSON.stringify((opened.pages[u] || '').slice(0, 40)))
  }
  // (6) 被编辑页的其它行仍在（取输入该页里最长的 token 作为"其它行"证据）
  if (inText[editPage] && inText[editPage].trim()) {
    const longest = inText[editPage].split(/\s+/).filter((x) => x.length >= 4).sort((a, b) => b.length - a.length)[0]
    if (longest) ok(inp.name + ' / 被编辑页其它内容仍在（含 "' + longest.slice(0, 18) + '"）', opened.pages[editPage].includes(longest))
    else ok(inp.name + ' / 被编辑页其它内容仍在（无长 token 可测，跳过）', true, 'skip')
  }
  // (7) 图像 XObject 流字节与数量不变
  const outInv = await streamInventory(out)
  const outImgs = outInv.filter((x) => x.subtype === '/Image')
  // 中文替换走栅格路径会**新增** PNG 图像对象（含 SMask 软掩码），故数量只增不减才是正确语义。
  ok(inp.name + ' / 原有图像一个不少（数量不减）', outImgs.length >= inImgs.length, outImgs.length + ' vs ' + inImgs.length + '（中文栅格会新增 PNG+SMask）')
  if (inImgs.length) {
    const outImgShas = new Set(outImgs.map((x) => x.sha))
    const lost = inImgs.filter((x) => !outImgShas.has(x.sha))
    ok(inp.name + ' / 原有图像流字节逐字节保留', lost.length === 0, lost.length ? '丢失 ' + lost.length : inImgs.length + ' 张全保留')
  }
  // (8) 原始 JPEG 段（SOI..EOI）字节一致（不依赖 pdf-lib）
  if (rawJ.length) {
    const outJ = rawJpegs(out)
    const inSet = new Set(rawJ.map(sha1))
    const outSet = new Set(outJ.map(sha1))
    const lostJ = [...inSet].filter((s) => !outSet.has(s))
    ok(inp.name + ' / 原始 JPEG 段 SOI..EOI 字节一致（绕过 pdf-lib）', lostJ.length === 0 && outJ.length >= rawJ.length, '输入 ' + rawJ.length + ' → 输出 ' + outJ.length)
  }
  // (9) MediaBox 不变
  {
    const dIn = await PDFDocument.load(inRaw, { ignoreEncryption: true })
    const dOut = await PDFDocument.load(out, { ignoreEncryption: true })
    const same = dIn.getPageCount() === dOut.getPageCount() &&
      dIn.getPages().every((p, i) => { const a = p.getSize(); const b = dOut.getPages()[i].getSize(); return Math.abs(a.width - b.width) < 0.01 && Math.abs(a.height - b.height) < 0.01 })
    ok(inp.name + ' / 每页 MediaBox 不变', same)
  }
}

/* ================================================================
 *  第 1 部分：删除能力零变化（独立构造 3 页，第 1 页含 JPEG）
 * ================================================================ */
ok('覆盖了 PDF 1.5+ 的「对象流 + 交叉引用流」真实输入', sawXrefStreamInputs.length > 0, sawXrefStreamInputs.join(' ; ') || '无')
console.log('\n-- 构造结论：以上 ' + inputs.length + ' 种真实来源输入，中文替换 + highlight 后均非空白、页数/MediaBox/图像/未编辑页文字全部保留（详见上方逐条 PASS）--')

section('1. 只改第 2 页 → 第 1/3 页内容流与图片字节必须不变')
{
  const src = await makeJpegPdf()
  const inDoc = await PDFDocument.load(src, { ignoreEncryption: true })
  const inInv = await streamInventory(src)
  const before1 = pageContentsRaw(inDoc, 0)
  const before3 = pageContentsRaw(inDoc, 2)
  const inImgs = inInv.filter((x) => x.subtype === '/Image')
  const srcStreamCount = rawStreamPayloads(src).length

  const out = await replacePdfText(src, [repFor(1, 'REPLACED-ASCII')], [])
  const outDoc = await PDFDocument.load(out, { ignoreEncryption: true })
  const after1 = pageContentsRaw(outDoc, 0)
  const after3 = pageContentsRaw(outDoc, 2)

  ok('第 1 页内容流字节完全一致', before1.length > 0 && before1.equals(after1), before1.length + 'B vs ' + after1.length + 'B')
  ok('第 3 页内容流字节完全一致', before3.length > 0 && before3.equals(after3), before3.length + 'B vs ' + after3.length + 'B')
  ok('第 2 页内容流已变化（确实改了）', !pageContentsRaw(outDoc, 1).equals(pageContentsRaw(inDoc, 1)))

  const outInv = await streamInventory(out)
  // 输入全部流（剔结构流）必须在输出里字节一致
  const missing = missingStreams(inInv, outInv)
  ok('输入全部非结构流在输出中字节一致（无重建）', missing.length === 0,
    missing.length ? '缺 ' + missing.map((m) => m.type + '/' + m.len + 'B').join(',') : '共 ' + inInv.filter((x) => !isStructural(x)).length + ' 条')

  const jpgIn = rawJpegs(src); const jpgOut = rawJpegs(out)
  ok('JPEG 原始段字节一致（\bstream/标记级，不依赖 pdf-lib）',
    jpgIn.length > 0 && jpgOut.length >= jpgIn.length && jpgIn.every((j) => jpgOut.some((o) => o.equals(j))),
    jpgIn.length + ' → ' + jpgOut.length + ' 段，输入段 ' + jpgIn.map((j) => j.length + 'B').join(','))
  const outImgsAscii = outInv.filter((o) => o.subtype === '/Image')
  ok('Image XObject 原始流字节一致', inImgs.every((x) => outImgsAscii.some((o) => o.sha === x.sha)), inImgs.length + ' 张')
  ok('纯 ASCII 替换路径 Image 对象数量不变（未新增图像）', outImgsAscii.length === inImgs.length, outImgsAscii.length + ' vs ' + inImgs.length)
  info('原始 \\bstream 载荷数：输入=' + srcStreamCount + ' 输出=' + rawStreamPayloads(out).length)

  ok('页数不变', inDoc.getPageCount() === outDoc.getPageCount())
  ok('MediaBox 全部不变', inDoc.getPages().every((p, i) => { const a = p.getSize(); const b = outDoc.getPages()[i].getSize(); return Math.abs(a.width - b.width) < 0.01 && Math.abs(a.height - b.height) < 0.01 }))
  info('输入流总数（剔除结构流）=' + inInv.filter((x) => !isStructural(x)).length + '，输出=' + outInv.filter((x) => !isStructural(x)).length + '（输出应更多：新增覆盖/文字/字体流）')
  info('原始 \\bstream 载荷数：输入=' + rawStreamPayloads(src).length + ' 输出=' + rawStreamPayloads(out).length)
}

/* ================================================================
 *  第 2 部分：样式参数真的生效
 * ================================================================ */
section('2. bold / italic / underline 参数生效')
{
  const src = await makeJpegPdf()
  const base = await replacePdfText(src, [repFor(1, 'STYLE-PROBE')], [])
  const variants = {
    bold: await replacePdfText(src, [repFor(1, 'STYLE-PROBE', { bold: true })], []),
    italic: await replacePdfText(src, [repFor(1, 'STYLE-PROBE', { italic: true })], []),
    underline: await replacePdfText(src, [repFor(1, 'STYLE-PROBE', { underline: true })], [])
  }
  const streamText = async (bytes) => pageContentsText(await PDFDocument.load(bytes, { ignoreEncryption: true }), 1)
  const sBase = await streamText(base)
  for (const [k, v] of Object.entries(variants)) {
    const sv = await streamText(v)
    ok('bold/italic/underline 之一 [' + k + '] 内容流与基准不同', sv !== sBase, sv.length + 'B vs ' + sBase.length + 'B')
  }
  ok('bold:true 与 bold:false 内容流不同', (await streamText(variants.bold)) !== sBase)
  ok('italic:true 与 italic:false 内容流不同', (await streamText(variants.italic)) !== sBase)
  ok('underline:true 与 false 内容流不同', (await streamText(variants.underline)) !== sBase)

  // 打印操作符证据
  const txt = await streamText(variants.bold)
  info('bold 内容流中的 Tf/字体引用片段：' + ((txt.match(/\S+\s+[\d.]+\s+Tf/g) || []).join(' , ') || '(未找到 Tf)'))
  const docB = await PDFDocument.load(variants.bold, { ignoreEncryption: true })
  const fonts = docB.getPage(1).node.Resources()?.lookup(PDFName.of('Font'))
  const names = []
  if (fonts) for (const [k, v] of fonts.entries()) { const d = docB.context.lookup(v); names.push(k.toString() + '→' + (d?.get(PDFName.of('BaseFont'))?.toString() ?? '?')) }
  info('bold 页字体资源：' + names.join(' , '))
  ok('bold 产出确实嵌入了 Helvetica-Bold', names.some((n) => /Bold/.test(n)), names.join(','))
  const txtN = await streamText(base)
  const fontNamesN = []
  { const d = await PDFDocument.load(base, { ignoreEncryption: true }); const f = d.getPage(1).node.Resources()?.lookup(PDFName.of('Font')); if (f) for (const [k, v] of f.entries()) { const dd = d.context.lookup(v); fontNamesN.push(k.toString() + '→' + (dd?.get(PDFName.of('BaseFont'))?.toString() ?? '?')) } }
  ok('bold:false 产出用普通 Helvetica（非 Bold）', fontNamesN.some((n) => /(^|[^A-Za-z])Helvetica$/.test(n)) && !fontNamesN.some((n) => /Bold/.test(n)), fontNamesN.join(','))
  const und = await streamText(variants.underline)
  info('underline 画线算子片段：' + JSON.stringify(((und.match(/[\d.-]+\s+[\d.-]+\s+m[\s\S]{0,60}?S/g) || [])[0] || '(未找到)').replace(/\s+/g, ' ')))
  ok('underline:true 内容流含画线算子（m/l + S）', /\bm\b[\s\S]{0,60}\bl\b[\s\S]{0,20}\bS\b/.test(und), (und.match(/[\d.]+\s+[\d.]+\s+m[\s\S]{0,40}?S/g) || []).slice(0, 1).join('').replace(/\s+/g, ' '))
  ok('underline:false 内容流无画线算子', !/\bm\b[\s\S]{0,60}\bl\b[\s\S]{0,20}\bS\b/.test(txtN))
}

/* ================================================================
 *  第 3 部分：批注真的落在页面上
 * ================================================================ */
section('3. 批注（highlight）真的写进内容流 + opacity 生效')
{
  const src = await makeJpegPdf()
  const none = await replacePdfText(src, [repFor(1, 'ANNO-PROBE')], [])
  const withHi = await replacePdfText(src, [repFor(1, 'ANNO-PROBE')], [hiAnno(1, 0.35)])
  const withOp1 = await replacePdfText(src, [repFor(1, 'ANNO-PROBE')], [hiAnno(1, 1)])
  const streamText = async (bytes) => pageContentsText(await PDFDocument.load(bytes, { ignoreEncryption: true }), 1)
  const sNone = await streamText(none)
  const sHi = await streamText(withHi)
  const sOp1 = await streamText(withOp1)

  ok('annotations=[] 与 [highlight] 内容流不同', sHi !== sNone)
  const rects = filledRects(sHi)
  info('highlight 内容流里的填充矩形（含覆盖矩形，两种画法都解析）：' + JSON.stringify(rects))
  ok('存在与批注 rect 匹配的填充矩形（x≈60 y≈748 w≈300 h≈18）',
    rects.some(([x, y, w, h]) => Math.abs(x - 60) < 0.6 && Math.abs(y - 748) < 0.6 && Math.abs(w - 300) < 0.6 && Math.abs(h - 18) < 0.6), JSON.stringify(rects))
  ok('opacity 0.35 输出含 gs/ExtGState 不透明度算子', /\/GS[^\s/]*\s+gs/.test(sHi))
  const exDict = (() => { const m = sHi.match(/\/(GS[^\s/]*)\s+gs/); return m ? m[1] : null })()
  if (exDict) {
    const d = await PDFDocument.load(withHi, { ignoreEncryption: true })
    const eg = d.getPage(1).node.Resources()?.lookup(PDFName.of('ExtGState'))
    const g = eg?.lookup(PDFName.of(exDict))
    const ca = g?.get(PDFName.of('ca'))?.toString()
    info('ExtGState ' + exDict + ' 的 /ca = ' + ca)
    ok('ExtGState /ca ≈ 0.35（不透明度进入输出）', !!ca && Math.abs(Number(ca) - 0.35) < 0.01, ca)
  } else ok('ExtGState /ca ≈ 0.35（不透明度进入输出）', false, '未找到 gs 算子')
  ok('opacity=1 与 opacity=0.35 内容流不同', sOp1 !== sHi)
  info('opacity=1 的 gs 算子数=' + (sOp1.match(/\/GS[^\s/]*\s+gs/g) || []).length + '，opacity=0.35 的=' + (sHi.match(/\/GS[^\s/]*\s+gs/g) || []).length)
}

/* ================================================================
 *  第 4 部分：退化输入
 * ================================================================ */
section('4. 退化输入：不抛异常、产出可解析')
{
  const src = await makeJpegPdf()
  const cases = [
    ['newText 空串（只删不留）', [repFor(1, '')], []],
    ['newText 远长于 rect.width', [repFor(1, 'X'.repeat(600))], []],
    ['fontSize 200', [repFor(1, 'BIG', { fontSize: 200 })], []],
    ['fontSize 4', [repFor(1, 'tiny', { fontSize: 4 })], []],
    ['opacity 0 的批注', [], [hiAnno(1, 0)]],
    ['opacity 1 的批注', [], [hiAnno(1, 1)]],
    ['批注矩形越界（y 负 / 超页高）', [], [{ page: 1, rect: { x: -50, y: -80, width: 900, height: 2000 }, kind: 'box', color: { r: 1, g: 0, b: 0 } }]],
    ['reps 为空数组', [], []],
    ['reps/annotations 均为空', [], []],
    ['同页同 rect 重复替换两次', [repFor(1, 'DUP-1'), repFor(1, 'DUP-2')], []],
    ['中文替换（栅格路径）', [repFor(1, CJK)], []],
    ['中文 + 全样式', [repFor(1, CJK, { bold: true, italic: true, underline: true })], [hiAnno(1)]],
    ['note 批注带中文便签', [], [{ page: 1, rect: { x: 60, y: 700, width: 120, height: 16 }, kind: 'note', color: { r: 1, g: 0.6, b: 0 }, text: '中文便签 QA' }]],
    ['underline/strike 批注', [], [{ page: 1, rect: { x: 60, y: 690, width: 200, height: 14 }, kind: 'underline', color: { r: 0, g: 0, b: 1 } }, { page: 1, rect: { x: 60, y: 660, width: 200, height: 14 }, kind: 'strike', color: { r: 1, g: 0, b: 0 } }]],
    ['越界页号（page:99）应被忽略', [repFor(99, 'IGNORED')], [{ page: 99, rect: { x: 0, y: 0, width: 10, height: 10 }, kind: 'box', color: { r: 0, g: 0, b: 0 } }]]
  ]
  for (const [name, reps, annos] of cases) {
    let threw = null
    let out = null
    try { out = await replacePdfText(src, reps, annos) } catch (e) { threw = e }
    if (threw) { ok('退化输入 [' + name + '] 不抛异常', false, String(threw.message).slice(0, 80)); continue }
    let loadOk = false; let pages = 0; let pdfjsOk = false
    try { const d = await PDFDocument.load(out, { ignoreEncryption: true }); loadOk = true; pages = d.getPageCount() } catch { /* */ }
    try { const r = await extractPages(out); pdfjsOk = r.num > 0 } catch { /* */ }
    const head = Buffer.from(out).subarray(0, 5).toString('latin1')
    ok('退化输入 [' + name + '] 不抛异常且产出合法', loadOk && pdfjsOk && head === '%PDF-' && pages === 3,
      '页数=' + pages + ' pdfjs=' + pdfjsOk + ' 头=' + head)
  }
}

/* ================================================================
 *  第 5 部分：产出结构合法性 + ASCII 新文字可被检索
 * ================================================================ */
section('5. 产出合法：pdf.js 打开 + ASCII 新文字可被提取')
{
  const src = await makeJpegPdf()
  const out = await replacePdfText(src, [repFor(1, 'SEARCHABLE-ASCII-TEXT')], [])
  const r = await extractPages(out)
  ok('pdf.js 打开输出，页数不变（3）', r.num === 3, '页数=' + r.num)
  ok('第 2 页提取文本包含新 ASCII 文字', r.pages[1].includes('SEARCHABLE-ASCII-TEXT'), JSON.stringify(r.pages[1].slice(0, 60)))
  ok('第 2 页原有文字仍在', r.pages[1].includes('PLAIN-PAGE-2'), JSON.stringify(r.pages[1].slice(0, 80)))
  const d2 = await PDFDocument.load(out, { ignoreEncryption: true })
  const dSrc = await PDFDocument.load(src, { ignoreEncryption: true })
  ok('MediaBox 不变', d2.getPages().every((p, i) => {
    const a = p.getSize(); const b = dSrc.getPages()[i].getSize()
    return Math.abs(a.width - b.width) < 0.01 && Math.abs(a.height - b.height) < 0.01
  }))
  info('第 2 页提取文本：' + JSON.stringify(r.pages[1].slice(0, 120)))
}

/* ================================================================
 *  第 6 部分：接线审计（只读 grep）
 * ================================================================ */
section('6. 接线审计（文件 + 行号）')
{
  const preTs = (await readFile(join(ROOT, 'src', 'preload', 'index.ts'), 'utf-8')).split(/\r?\n/)
  const preDts = (await readFile(join(ROOT, 'src', 'preload', 'index.d.ts'), 'utf-8')).split(/\r?\n/)
  const pdfIpc = (await readFile(join(ROOT, 'src', 'main', 'pdf', 'pdfIpc.ts'), 'utf-8')).split(/\r?\n/)
  const docsViewer = (await readFile(join(ROOT, 'src', 'renderer', 'src', 'pages', 'DocsViewer.tsx'), 'utf-8')).split(/\r?\n/)

  const findLine = (lines, re) => { const i = lines.findIndex((l) => re.test(l)); return i < 0 ? null : i + 1 }
  const l1 = findLine(preTs, /savePath:/)
  const l2 = findLine(preTs, /\bwrite:\s*\(/)
  const l3 = findLine(preDts, /savePath:/)
  const l4 = findLine(preDts, /\bwrite:\s*\(/)
  const l5 = findLine(pdfIpc, /ipcMain\.handle\(\s*'pdf:write'/)
  const l6 = findLine(docsViewer, /<PdfInPlaceEditor/)
  const l7 = findLine(docsViewer, /bytes=/)
  info('preload/index.ts  savePath@' + l1 + '  write@' + l2)
  info('preload/index.d.ts savePath@' + l3 + '  write@' + l4)
  info('pdfIpc.ts pdf:write@' + l5)
  info('DocsViewer.tsx <PdfInPlaceEditor>@' + l6 + '  bytes=@' + l7)
  ok('preload 双写暴露 savePath（.ts 与 .d.ts）', !!l1 && !!l3)
  ok('preload 双写暴露 write（.ts 与 .d.ts）', !!l2 && !!l4)
  ok('pdfIpc 注册 pdf:write', !!l5)
  {
    const seg = pdfIpc.slice((l5 ?? 1) - 1, (l5 ?? 1) + 12).join('\n')
    ok('pdf:write 走 isPathAllowed 授权校验', /isPathAllowed\(filePath\)/.test(seg), (seg.match(/isPathAllowed[^\n]*/) || [''])[0].trim())
  }
  ok('DocsViewer 真实渲染 <PdfInPlaceEditor 且传 bytes', !!l6 && !!l7)

  // 构建产物字符串（electron-vite 输出到 out/renderer/assets/index-*.js）
  const { readdir } = await import('node:fs/promises')
  const candidates = [
    join(ROOT, 'out', 'renderer', 'assets'),
    join(ROOT, 'dist', 'renderer', 'assets'),
    join(ROOT, 'out', 'renderer')
  ]
  const needles = ['replacePdfText', '编辑内容（保版式）', '已加高亮批注']
  const counts = { replacePdfText: 0, banner: 0, annot: 0 }
  const files = []
  const scannedDirs = []
  for (const dir of candidates) {
    if (!existsSync(dir)) continue
    scannedDirs.push(dir.replace(ROOT, '.'))
    let entries = []
    try { entries = await readdir(dir) } catch { continue }
    for (const f of entries) {
      if (!/\.js$/.test(f)) continue
      const s = await readFile(join(dir, f), 'utf-8')
      const n1 = s.split(needles[0]).length - 1
      const n2 = s.split(needles[1]).length - 1
      const n3 = s.split(needles[2]).length - 1
      counts.replacePdfText += n1; counts.banner += n2; counts.annot += n3
      if (n1 + n2 + n3) files.push(f + '(rpf=' + n1 + ',banner=' + n2 + ',annot=' + n3 + ')')
    }
  }
  info('扫描目录：' + (scannedDirs.join(' , ') || '(不存在)') + '  命中文件：' + (files.join(' , ') || '无'))
  info('构建产物字符串计数：' + JSON.stringify(counts))
  if (!scannedDirs.length) {
    ok('构建产物存在（out/renderer/assets/index-*.js）', false, '渲染产物目录不存在 —— 需先 npm run build')
  }
  ok('构建产物含 replacePdfText', counts.replacePdfText > 0, String(counts.replacePdfText))
  ok('构建产物含「编辑内容（保版式）」', counts.banner > 0, String(counts.banner))
  ok('构建产物含「已加高亮批注」', counts.annot > 0, String(counts.annot))
}

console.log('\n' + '='.repeat(64))
console.log('QA 就地编辑验证结果: ' + pass + ' 项通过, ' + fail + ' 项失败')
if (failList.length) console.log('失败项:\n  - ' + failList.join('\n  - '))
console.log('='.repeat(64))
process.exit(fail ? 1 : 0)
