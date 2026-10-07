/**
 * 边界与设计约束验收（就地改字）。
 *
 * 覆盖：空清单 / 删除行（newText=''）/ 越界页号 / 编辑末页的对称性 /
 *       同页重叠替换的落笔顺序（所有覆盖矩形必须先于所有新文字）。
 *
 * 运行：node --experimental-loader=./tests/loader.mjs --experimental-strip-types \
 *       tests/pdf-audit/scratch/verify-inplace-edge.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const OUT = join(HERE, 'out')
const SRC = join(OUT, 'zh-edit-src.pdf')

globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error('替身未实现 createElement: ' + tag)
    const c = createCanvas(1, 1)
    c.toBlob = (cb, type) => {
      try {
        cb(new Blob([c.toBuffer(type || 'image/png')], { type: type || 'image/png' }))
      } catch {
        cb(null)
      }
    }
    return c
  }
}

const { replacePdfText } = await import('../../../src/renderer/src/utils/pdfInPlaceReplace.ts')
const { latin1FromBytes, parseIndirectObject, asName } =
  await import('../../../src/renderer/src/utils/pdfObjects.ts')

let pass = 0
let fail = 0
function check(label, cond, detail = '') {
  if (cond) {
    pass++
    console.log('  ✅ ' + label + (detail ? '  → ' + detail : ''))
  } else {
    fail++
    console.log('  ❌ ' + label + (detail ? '  → ' + detail : ''))
  }
}

const srcBytes = new Uint8Array(await readFile(SRC))
await mkdir(OUT, { recursive: true })

/* ---------- 工具：对象扫描 + 新增对象 + 页面追加内容流 ---------- */
function scan(bytes) {
  const src = latin1FromBytes(bytes)
  const re = /(\d+)[\s\x00]+(\d+)[\s\x00]+obj\b/g
  const map = new Map()
  let m
  while ((m = re.exec(src)) !== null) {
    const offset = m.index
    let p
    try {
      p = parseIndirectObject(src, offset)
    } catch {
      continue
    }
    const host = [...map.values()].find((k) => k.value && k.value.kind === 'stream' && offset > k.offset && offset < k.end)
    if (host) continue
    map.set(p.num, { offset, value: p.value, end: p.end })
    re.lastIndex = offset + m[0].length
  }
  return map
}

function decodeStreamObj(stream) {
  if (!stream || stream.kind !== 'stream') return null
  const f = stream.dict.map.get('Filter')
  const name = f && f.kind === 'name' ? f.name : null
  if (name === 'FlateDecode') return inflateSync(Buffer.from(stream.raw)).toString('latin1')
  if (!name) return latin1FromBytes(stream.raw)
  return null
}

/** 新增对象中「无 /Type 的普通流」= pdf-lib 追加的页面内容流 */
function appendedContentStreams(outBytes, srcObjMap) {
  const outMap = scan(outBytes)
  const res = []
  for (const [n, o] of outMap) {
    if (srcObjMap.has(n)) continue
    if (!o.value || o.value.kind !== 'stream') continue
    const t = asName(o.value.dict.map.get('Type'))
    if (t) continue
    const text = decodeStreamObj(o.value)
    if (text) res.push({ num: n, text, rawLen: o.value.raw.length })
  }
  return res
}

async function countImageDraws(bytes, pageNo) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false })
  const doc = await task.promise
  const page = await doc.getPage(pageNo)
  const ops = await page.getOperatorList()
  const n = ops.fnArray.filter((f) => f === pdfjs.OPS.paintImageXObject || f === pdfjs.OPS.paintInlineImageXObject).length
  await task.destroy()
  return n
}

async function runDiff(a, b, editedPage) {
  const { stdout } = await run(
    process.execPath,
    [
      '--experimental-loader=./tests/loader.mjs',
      '--experimental-strip-types',
      'tests/pdf-audit/scratch/pdf-byte-diff.mjs',
      a,
      b,
      '--page',
      String(editedPage)
    ],
    { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 }
  )
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT:')) || ''
  const valid = /RESULT_VALID=true/.test(stdout)
  return { line, valid }
}

const srcObjMap = scan(srcBytes)
const srcDoc = await PDFDocument.load(srcBytes)
const srcPages = srcDoc.getPageCount()

console.log('='.repeat(96))
console.log('边界与设计约束验收')
console.log('='.repeat(96))
console.log('样本: ' + SRC + ' (' + srcBytes.length + ' 字节, ' + srcPages + ' 页)')

const rep = {
  page: 0,
  rect: { x: 62.8, y: 697.899, width: 65.844, height: 12 },
  baseline: 700.539,
  fontSize: 12,
  color: { r: 0, g: 0, b: 0 },
  bgColor: { r: 1, g: 1, b: 1 },
  align: 'left',
  newText: 'FINAL-2026-APPROVED'
}

/* ---------- A. 空清单 ---------- */
console.log('\n[A] reps = [] （不做任何替换）')
{
  const out = await replacePdfText(srcBytes, [])
  const outFile = join(OUT, 'edge-none.pdf')
  await writeFile(outFile, out)
  const outDoc = await PDFDocument.load(out)
  const outMap = scan(out)
  console.log('  字节 ' + srcBytes.length + ' → ' + out.length + '；对象 ' + srcObjMap.size + ' → ' + outMap.size)
  const d = await runDiff(SRC, outFile, 0)
  console.log('  ' + d.line)
  check('页数不变', outDoc.getPageCount() === srcPages, String(outDoc.getPageCount()))
  check('无新增对象', outMap.size === srcObjMap.size, srcObjMap.size + ' → ' + outMap.size)
  check('所有页内容流一致（无被编辑页）', /unedited_pages_stream_identical=true/.test(d.line) && d.valid, d.line)
}

/* ---------- B. 删除行 ---------- */
console.log('\n[B] newText = "" （只覆盖不绘制 = 删除该行）')
{
  const out = await replacePdfText(srcBytes, [{ ...rep, newText: '' }])
  const outFile = join(OUT, 'edge-delete.pdf')
  await writeFile(outFile, out)
  const streams = appendedContentStreams(out, srcObjMap)
  const joined = streams.map((s) => s.text).join('\n')
  const outMap = scan(out)
  const newObjs = [...outMap.keys()].filter((n) => !srcObjMap.has(n))
  const newFonts = [...outMap.entries()].filter(
    ([n, o]) => !srcObjMap.has(n) && o.value?.kind === 'dict' && asName(o.value.map.get('Type')) === 'Font'
  )
  console.log('  新增对象: ' + JSON.stringify(newObjs))
  console.log('  新增内容流 ' + streams.length + ' 条，合计 ' + joined.length + ' 字符')
  console.log('  含填充路径(f): ' + /f\s/.test(joined) + '   含文字(Tj): ' + /Tj/.test(joined) + '   含图片(Do): ' + /Do/.test(joined))
  console.log('  新增 Font 对象数: ' + newFonts.length)
  const srcImgs = await countImageDraws(srcBytes, 1)
  const outImgs = await countImageDraws(out, 1)
  check('只覆盖不画字（无 Tj）', !/Tj/.test(joined), 'Tj 出现=' + /Tj/.test(joined))
  check('没有新增图片（无 Do）', !/Do/.test(joined), 'Do 出现=' + /Do/.test(joined))
  check('没有嵌入字体对象', newFonts.length === 0, '新增 Font=' + newFonts.length)
  check('覆盖矩形确实画了', /f\s/.test(joined))
  check('页面图片数不变', srcImgs === outImgs, srcImgs + ' → ' + outImgs)
}

/* ---------- C. 越界页号 ---------- */
console.log('\n[C] 越界页号（page = -1 与 page = 99）不抛异常')
{
  let err = null
  let out = null
  try {
    out = await replacePdfText(srcBytes, [
      { ...rep, page: -1 },
      { ...rep, page: 99, newText: 'X' },
      { ...rep, page: 0, newText: 'ONLY-THIS-PAGE-1' }
    ])
  } catch (e) {
    err = e
  }
  check('未抛异常', err === null, err ? String(err.message) : '无异常')
  if (out) {
    const outFile = join(OUT, 'edge-oob.pdf')
    await writeFile(outFile, out)
    const outDoc = await PDFDocument.load(out)
    const d = await runDiff(SRC, outFile, 1)
    console.log('  ' + d.line)
    check('页数不变', outDoc.getPageCount() === srcPages, String(outDoc.getPageCount()))
    check('越界条目被忽略，仅第1页变化', /unedited_pages_stream_identical=true/.test(d.line) && d.valid, d.line)
  }
}

/* ---------- D. 编辑末页：未编辑页仍逐字节一致 ---------- */
console.log('\n[D] 只改第 3 页（末页）→ 第 1、2 页内容流应逐字节不变')
{
  const out = await replacePdfText(srcBytes, [
    { ...rep, page: 2, rect: { x: 62.8, y: 736.039, width: 111.96, height: 12 }, baseline: 738.04, newText: 'PAGE-THREE-EDITED' }
  ])
  const outFile = join(OUT, 'edge-page3.pdf')
  await writeFile(outFile, out)
  const d = await runDiff(SRC, outFile, 3)
  console.log('  ' + d.line)
  check('第 1、2 页（未编辑页）内容流一致', /unedited_pages_stream_identical=true/.test(d.line), d.line)
  check('第 3 页内容流确实变了', /edited_page_stream_changed=true/.test(d.line), d.line)
  check('MediaBox 全一致', /mediabox_identical=true/.test(d.line), d.line)
}

/* ---------- E. 同页重叠替换的落笔顺序 ---------- */
console.log('\n[E] 同页两条重叠替换：所有覆盖矩形必须先于所有新文字')
{
  const reps = [
    { ...rep, rect: { x: 62.8, y: 697.899, width: 200, height: 12 }, baseline: 700.539, newText: 'AAAA' },
    { ...rep, rect: { x: 100, y: 697.899, width: 200, height: 12 }, baseline: 700.539, newText: 'BBBB' }
  ]
  const out = await replacePdfText(srcBytes, reps)
  const streams = appendedContentStreams(out, srcObjMap)
  const joined = streams.map((s) => s.text).join('\n')
  const lastFill = joined.lastIndexOf('\nf\n')
  const firstTj = joined.indexOf(' Tj')
  console.log('  新增内容流 ' + streams.length + ' 条；最后一段文字指令位置 = ' + firstTj + '；最后一个覆盖填充位置 = ' + lastFill)
  console.log('  片段: ' + JSON.stringify(joined.replace(/\s+/g, ' ').slice(0, 200)))
  check('所有覆盖填充先于第一条文字指令', lastFill >= 0 && firstTj >= 0 && lastFill < firstTj, '末次填充@' + lastFill + ' < 首次 Tj@' + firstTj)
  const fills = (joined.match(/\nf\n/g) || []).length
  check('画了两个覆盖矩形', fills === 2, '填充次数=' + fills)
  const hexes = joined.match(/<[0-9A-F]+> Tj/g) || []
  console.log('  十六进制文字串: ' + JSON.stringify(hexes))
  check('画了两段新文字', hexes.length === 2, 'Tj 次数=' + hexes.length)
}

console.log('\n' + '='.repeat(96))
console.log('汇总: ' + pass + ' 项通过, ' + fail + ' 项失败')
console.log('='.repeat(96))
process.exit(fail ? 1 : 0)
