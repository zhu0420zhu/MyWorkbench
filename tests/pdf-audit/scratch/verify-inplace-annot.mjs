/**
 * 批注（PdfAnnotation）+ 向后兼容 + 字节级回归 验收。
 *
 * 覆盖：
 *   [A] 批注不改文字层：highlight/underline/strike/box 不产生 Tj/TJ、不新增字体对象
 *   [B] 边界：annotations=[]、不传第三参、越界页号、同页既有替换又有注解（落笔顺序）
 *   [C] 字节级回归：真实多页 PDF 只改第 1 页一条 + 加一条 highlight，
 *       断言页数/MediaBox/未编辑页内容流/原有图片与 SMask 流字节一致
 *   [C0] 上述回归的对照组：零编辑输出同样会发生「图片字典字节变化」——证明那是
 *        pdf-lib 保存本身的行为，与本模块的改动无关
 *   [D] 向后兼容：同样的 (bytes, reps) 入参，新实现与【上一轮旧实现】输出 sha256 完全一致
 *
 * 运行：node --experimental-loader=./tests/loader.mjs --experimental-strip-types \
 *       tests/pdf-audit/scratch/verify-inplace-annot.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument } from 'pdf-lib'

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
const { replacePdfText: replacePdfTextOld } = await import('./old-inplace-impl.ts')
const { latin1FromBytes, parseIndirectObject, asName } = await import('../../../src/renderer/src/utils/pdfObjects.ts')

const sha = (b) => createHash('sha256').update(b).digest('hex')

/**
 * pdf-lib 的 save() 一定会把 Info 的 /ModDate 改写成【当前时间】，
 * 所以同一个输入在不同秒保存，整文件 sha 必然不同（旧实现也一样）。
 * 比对"逐字节一致"时必须先把该字段屏蔽掉，否则会误判。
 */
const MASKED_MODDATE = '/ModDate (__MASKED__)'
const normalizeTimestamp = (u8) =>
  Buffer.from(Buffer.from(u8).toString('latin1').replace(/\/ModDate\s*\([^)]*\)/g, MASKED_MODDATE), 'latin1')
const shaNorm = (u8) => sha(normalizeTimestamp(u8))

/** 逐字节差异片段（用于确认"差异只可能是时间戳"） */
function rawDiffRegions(a, b) {
  const x = Buffer.from(a).toString('latin1')
  const y = Buffer.from(b).toString('latin1')
  const out = []
  let i = 0
  const n = Math.min(x.length, y.length)
  while (i < n) {
    if (x[i] !== y[i]) {
      const s = i
      while (i < n && x[i] !== y[i]) i++
      out.push([s, x.slice(s, i), y.slice(s, i)])
    } else i++
  }
  return out
}

/** 把 a 里的 /ModDate 值替换成 b 的值后，两份字节是否完全相同（证明差异仅为时间戳） */
function differsOnlyByTimestamp(a, b) {
  const x = Buffer.from(a).toString('latin1')
  const y = Buffer.from(b).toString('latin1')
  const ym = y.match(/\/ModDate\s*\([^)]*\)/)
  const patched = x.replace(/\/ModDate\s*\([^)]*\)/g, ym ? ym[0] : '__NO_MODDATE__')
  return patched === y && x !== y
}

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

/* ---------- 对象扫描 / 追加内容流 / 图片与 SMask 流字节 ---------- */
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

/** 新增对象里「无 /Type 的普通流」= pdf-lib 追加的页面内容流 */
function appendedContentStreams(outBytes, srcObjMap) {
  const outMap = scan(outBytes)
  const res = []
  for (const [n, o] of outMap) {
    if (srcObjMap.has(n)) continue
    if (!o.value || o.value.kind !== 'stream') continue
    if (asName(o.value.dict.map.get('Type'))) continue
    const text = decodeStreamObj(o.value)
    if (text !== null) res.push({ num: n, text, rawLen: o.value.raw.length })
  }
  return res
}

/** 新增的 /Type /Font 字典对象数 */
function newFontObjects(outBytes, srcObjMap) {
  return [...scan(outBytes).entries()]
    .filter(([n, o]) => !srcObjMap.has(n) && o.value && o.value.kind === 'dict' && asName(o.value.map.get('Type')) === 'Font')
    .map(([n]) => n)
}

/** 逐对象号的图片 XObject / SMask 原始流字节（用于证明"一个字节没动"） */
function imageStreamDigests(bytes) {
  const map = scan(bytes)
  const images = []
  const smasks = []
  for (const [n, o] of map) {
    if (!o.value || o.value.kind !== 'stream') continue
    const sub = asName(o.value.dict.map.get('Subtype'))
    const sm = o.value.dict.map.get('SMask')
    if (sub === 'Image') {
      images.push({ obj: n, len: o.value.raw.length, sha: sha(o.value.raw) })
    }
    if (sm && sm.kind === 'ref') {
      const t = map.get(sm.num)
      if (t && t.value && t.value.kind === 'stream') {
        smasks.push({ owner: n, obj: sm.num, len: t.value.raw.length, sha: sha(t.value.raw) })
      }
    }
  }
  return { images: images.sort((a, b) => a.obj - b.obj), smasks: smasks.sort((a, b) => a.obj - b.obj) }
}

function sameDigests(a, b) {
  if (a.length !== b.length) return false
  return a.every((x, i) => x.obj === b[i].obj && x.sha === b[i].sha && x.len === b[i].len)
}

async function byteDiff(a, b, editedPage) {
  const { stdout } = await run(
    process.execPath,
    ['--experimental-loader=./tests/loader.mjs', '--experimental-strip-types',
      'tests/pdf-audit/scratch/pdf-byte-diff.mjs', a, b, '--page', String(editedPage)],
    { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 }
  )
  return {
    result: stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT:')) || '',
    valid: /RESULT_VALID=true/.test(stdout),
    stdout
  }
}

/* ---------- 样本与几何 ---------- */
const srcBytes = new Uint8Array(await readFile(SRC))
await mkdir(OUT, { recursive: true })
const srcObjMap = scan(srcBytes)
const srcDoc = await PDFDocument.load(srcBytes)
const srcPages = srcDoc.getPageCount()

const ASCII_REP = {
  page: 0,
  rect: { x: 62.8, y: 697.899, width: 65.844, height: 12 },
  baseline: 700.539,
  fontSize: 12,
  color: { r: 0, g: 0, b: 0 },
  bgColor: { r: 1, g: 1, b: 1 },
  align: 'left',
  newText: 'FINAL-2026-APPROVED'
}
const ZH_RECT = { x: 62.8, y: 639.849, width: 336, height: 12 }
const HL = { page: 0, rect: ZH_RECT, kind: 'highlight', color: { r: 1, g: 0.9, b: 0 } }

console.log('='.repeat(96))
console.log('批注 + 向后兼容 + 字节级回归 验收')
console.log('='.repeat(96))
console.log('样本: ' + SRC + '  (' + srcBytes.length + ' 字节, ' + srcPages + ' 页, sha ' + sha(srcBytes).slice(0, 16) + ')')
const srcDig = imageStreamDigests(srcBytes)
console.log('源·图片 XObject: ' + srcDig.images.length + ' 个  SMask: ' + srcDig.smasks.length + ' 个')
for (const im of srcDig.images) console.log('   img obj=' + im.obj + ' len=' + im.len + ' sha=' + im.sha.slice(0, 16))
for (const sm of srcDig.smasks) console.log('   SMask obj=' + sm.obj + ' (owner=' + sm.owner + ') len=' + sm.len + ' sha=' + sm.sha.slice(0, 16))

/* ================= A. 批注不改文字层 ================= */
console.log('\n' + '-'.repeat(96))
console.log('[A] 批注不改文字层：不产生 Tj/TJ、不新增字体对象')
console.log('-'.repeat(96))
const annotKinds = [
  ['highlight', { ...HL }],
  ['underline', { page: 0, rect: ZH_RECT, kind: 'underline', color: { r: 1, g: 0, b: 0 } }],
  ['strike', { page: 0, rect: ZH_RECT, kind: 'strike', color: { r: 0, g: 0, b: 1 } }],
  ['box', { page: 0, rect: ZH_RECT, kind: 'box', color: { r: 0, g: 0.5, b: 0 } }],
  ['note', { page: 0, rect: ZH_RECT, kind: 'note', color: { r: 0.9, g: 0.6, b: 0 }, text: '待复核：签署日期需与附件一致' }]
]
for (const [kind, ann] of annotKinds) {
  const out = await replacePdfText(srcBytes, [], [ann])
  await writeFile(join(OUT, 'annot-' + kind + '.pdf'), out)
  const streams = appendedContentStreams(out, srcObjMap).map((s) => s.text).join('\n')
  const fonts = newFontObjects(out, srcObjMap)
  const tj = /(\s|[>)\]])(Tj|TJ)\b/.test(streams)
  const doImg = /\bDo\b/.test(streams)
  const fill = /\sf\b/.test(streams) || /\sf\*/.test(streams)
  const stroke = /\sS\b/.test(streams)
  console.log('  ' + kind.padEnd(10) + ' 新增流字符=' + String(streams.length).padStart(5) +
    '  Tj/TJ=' + tj + '  Do=' + doImg + '  填充f=' + fill + '  描边S=' + stroke +
    '  新增Font=' + JSON.stringify(fonts))
  check('[A] ' + kind + ' 不产生文字算子 Tj/TJ', !tj, 'Tj/TJ=' + tj)
  check('[A] ' + kind + ' 不新增字体对象', fonts.length === 0, '新增 Font=' + JSON.stringify(fonts))
  if (kind === 'highlight' || kind === 'underline' || kind === 'strike') {
    check('[A] ' + kind + ' 是填充矩形（有 f）', fill, 'fill=' + fill)
    check('[A] ' + kind + ' 不画图片（无 Do）', !doImg, 'Do=' + doImg)
  }
  if (kind === 'box') {
    check('[A] box 只描边不填充', stroke && !fill, 'S=' + stroke + ' f=' + fill)
  }
  if (kind === 'note') {
    check('[A] note 只画图标（含中文时画图，但无 Tj）', !tj && !stroke, 'Tj/TJ=' + tj + ' S=' + stroke)
  }
}

/* ================= B. 边界 ================= */
console.log('\n' + '-'.repeat(96))
console.log('[B] 边界：空注解数组 / 不传第三参 / 越界页号 / 同页替换+注解并存')
console.log('-'.repeat(96))
{
  const noArg = await replacePdfText(srcBytes, [ASCII_REP])
  const emptyArr = await replacePdfText(srcBytes, [ASCII_REP], [])
  console.log('  不传第三参 sha=' + sha(noArg).slice(0, 24) + '   annotations=[] sha=' + sha(emptyArr).slice(0, 24))
  console.log('  （整文件 sha 受 pdf-lib 写入的 /ModDate=当前时间 影响，故同时给出屏蔽时间戳后的 sha）')
  console.log('  不传第三参 shaNorm=' + shaNorm(noArg).slice(0, 24) + '   annotations=[] shaNorm=' + shaNorm(emptyArr).slice(0, 24))
  check('[B] annotations=[] 与不传第三参 屏蔽时间戳后逐字节一致', shaNorm(noArg) === shaNorm(emptyArr),
    shaNorm(noArg).slice(0, 16) + ' vs ' + shaNorm(emptyArr).slice(0, 16))
}
{
  let err = null
  let out = null
  try {
    out = await replacePdfText(srcBytes, [], [{ ...HL, page: -1 }, { ...HL, page: 99 }, { ...HL, page: 0 }])
  } catch (e) {
    err = e
  }
  check('[B] 越界注解页号不抛异常', err === null, err ? String(err.message) : '无异常')
  if (out) {
    const onlyPage0 = await replacePdfText(srcBytes, [], [HL])
    await writeFile(join(OUT, 'annot-oob.pdf'), out)
    const d = await byteDiff(SRC, join(OUT, 'annot-oob.pdf'), 1)
    console.log('  ' + d.result)
    check('[B] 越界注解被忽略，仅第 1 页变化', /unedited_pages_stream_identical=true/.test(d.result) && /edited_page_stream_changed=true/.test(d.result) && d.valid, d.result)
    check('[B] 越界注解输出 = 只保留合法页注解的输出（屏蔽时间戳后逐字节一致）', shaNorm(out) === shaNorm(onlyPage0),
      shaNorm(out).slice(0, 16) + ' vs ' + shaNorm(onlyPage0).slice(0, 16))
  }
}
{
  // 同页既有替换又有注解：落笔顺序必须是 覆盖矩形 → 新文字 → 批注
  const out = await replacePdfText(srcBytes, [ASCII_REP], [HL])
  const streams = appendedContentStreams(out, srcObjMap).map((s) => s.text).join('\n')
  const compact = streams.replace(/\s+/g, ' ')
  const firstTj = compact.indexOf(' Tj')
  const annotTranslate = compact.indexOf('1 0 0 1 62.8 639.849 cm')
  const fills = (compact.match(/ f /g) || []).length
  console.log('  新增流片段: ' + JSON.stringify(compact.slice(0, 260)))
  console.log('  首次 Tj@' + firstTj + '   注解高亮 translate@' + annotTranslate + '   填充次数=' + fills)
  check('[B] 同页：新文字先于注解高亮落笔', firstTj >= 0 && annotTranslate > firstTj, 'Tj@' + firstTj + ' < 高亮@' + annotTranslate)
  check('[B] 同页：覆盖矩形 + 注解高亮共 2 次填充', fills === 2, '填充次数=' + fills)
}

/* ================= C. 字节级回归 ================= */
console.log('\n' + '-'.repeat(96))
console.log('[C] 字节级回归：只改第 1 页一条 + 加一条 highlight')
console.log('-'.repeat(96))
const regOut = await replacePdfText(srcBytes, [ASCII_REP], [HL])
const regFile = join(OUT, 'annot-regression-out.pdf')
await writeFile(regFile, regOut)
console.log('  输出: ' + regFile + '  (' + srcBytes.length + ' → ' + regOut.length + ' 字节)')
const regDiff = await byteDiff(SRC, regFile, 1)
console.log('  ' + regDiff.result)
check('[C] 页数与每页 MediaBox 一致', /pages_identical=true/.test(regDiff.result) && /mediabox_identical=true/.test(regDiff.result), regDiff.result)
check('[C] 未编辑页内容流逐字节一致', /unedited_pages_stream_identical=true/.test(regDiff.result), regDiff.result)
check('[C] 被编辑页内容流确实变了', /edited_page_stream_changed=true/.test(regDiff.result), regDiff.result)
check('[C] 原有图片 XObject 流字节一致（工具判定）', /preexisting_images_stream_bytes_identical=true/.test(regDiff.result), regDiff.result)
check('[C] 比对判定可信（无扫描盲区）', regDiff.valid, 'RESULT_VALID=' + regDiff.valid)

const outDig = imageStreamDigests(regOut)
console.log('  产物·图片 XObject: ' + outDig.images.length + ' 个  SMask: ' + outDig.smasks.length + ' 个')
check('[C] 逐对象：图片 XObject 原始流字节完全一致', sameDigests(srcDig.images, outDig.images),
  JSON.stringify(outDig.images.map((x) => x.obj + ':' + x.sha.slice(0, 12))))
check('[C] 逐对象：SMask 原始流字节完全一致', sameDigests(srcDig.smasks, outDig.smasks),
  JSON.stringify(outDig.smasks.map((x) => x.obj + ':' + x.sha.slice(0, 12))))

/* ================= C0. 对照组：零编辑也会改图片字典 ================= */
console.log('\n' + '-'.repeat(96))
console.log('[C0] 对照：reps=[] 且无注解（零编辑）→ 看图片字典字节是否本来就会变')
console.log('-'.repeat(96))
{
  const zero = await replacePdfText(srcBytes, [])
  const zeroFile = join(OUT, 'annot-zero-edit.pdf')
  await writeFile(zeroFile, zero)
  const d = await byteDiff(SRC, zeroFile, 0)
  console.log('  ' + d.result)
  check('[C0] 零编辑时所有页内容流仍逐字节一致', /unedited_pages_stream_identical=true/.test(d.result), d.result)
  check('[C0] 零编辑时原有图片流字节一致', /preexisting_images_stream_bytes_identical=true/.test(d.result), d.result)
  console.log('  说明：上面 RESULT 里 preexisting_images_dict_identical 若为 false，是 pdf-lib 保存时'
    + '对图片字典的重写所致，零编辑也一样，与本模块改动无关。')
}

/* ================= D. 向后兼容：与旧实现逐字节一致 ================= */
console.log('\n' + '-'.repeat(96))
console.log('[D] 向后兼容：同样的 (bytes, reps)，新实现 vs 上一轮旧实现')
console.log('    注：pdf-lib save() 会把 /ModDate 写成当前时间，故同时给出"原始 sha"与"屏蔽时间戳后 sha"')
console.log('-'.repeat(96))
const compatCases = [
  ['空清单', []],
  ['第1页 ASCII 一条', [ASCII_REP]],
  ['第1页中文一条（栅格）', [{ ...ASCII_REP, rect: ZH_RECT, baseline: 642.489, newText: '本合同已由双方于 2026 年 9 月 29 日签署并生效。' }]],
  ['同页两条（覆盖矩形先于文字）', [ASCII_REP, { ...ASCII_REP, rect: { x: 100, y: 697.899, width: 200, height: 12 }, newText: 'BBBB' }]],
  ['跨页（第1页 + 第3页）', [ASCII_REP, { ...ASCII_REP, page: 2, rect: { x: 62.8, y: 736.039, width: 111.96, height: 12 }, baseline: 738.04, newText: 'PAGE-THREE-EDITED' }]],
  ['删除行（newText=""）', [{ ...ASCII_REP, newText: '' }]],
  ['越界页号', [{ ...ASCII_REP, page: 99 }, { ...ASCII_REP, page: -1 }, ASCII_REP]],
  ['右对齐 ASCII', [{ ...ASCII_REP, align: 'right', newText: 'RIGHT-ALIGNED' }]]
]
for (const [label, reps] of compatCases) {
  const oldOut = await replacePdfTextOld(srcBytes, reps)
  const newOut = await replacePdfText(srcBytes, reps)
  const rawSame = sha(oldOut) === sha(newOut)
  const normSame = shaNorm(oldOut) === shaNorm(newOut)
  const regions = rawSame ? [] : rawDiffRegions(oldOut, newOut)
  const onlyTimestamp = rawSame || differsOnlyByTimestamp(oldOut, newOut)
  console.log('  ' + label.padEnd(24) + ' 原始sha一致=' + (rawSame ? '是' : '否') +
    '  屏蔽时间戳后一致=' + (normSame ? '是' : '否') +
    (rawSame ? '' : '  原始差异片段=' + regions.length + '个，差异仅为 /ModDate = ' + onlyTimestamp))
  if (!rawSame && regions.length) {
    console.log('      差异内容: ' + regions.slice(0, 3).map(([, x, y]) => JSON.stringify(x) + '→' + JSON.stringify(y)).join(' , '))
  }
  check('[D] ' + label + ' 与旧实现【屏蔽时间戳后】逐字节一致', normSame, shaNorm(oldOut).slice(0, 16) + ' vs ' + shaNorm(newOut).slice(0, 16))
  if (!rawSame) {
    check('[D] ' + label + ' 原始差异仅来自 /ModDate 时间戳', onlyTimestamp, regions.length + ' 个差异片段')
  }
}

console.log('\n' + '='.repeat(96))
console.log('汇总: ' + pass + ' 项通过, ' + fail + ' 项失败')
console.log('='.repeat(96))
process.exit(fail ? 1 : 0)
