/**
 * 通用 PDF 对象级字节比对工具（就地改字验收的核心）。
 *
 * 目的：证明「未编辑部分一个字节没变」。因此不看渲染像素，而是下到字节层：
 *   1. 逐页内容流【解压后的原始字节】的 sha256（页面内容是否被重写）
 *   2. 逐页 MediaBox / CropBox / Rotate / 资源键（版式参数是否被动过）
 *   3. 每个间接对象的原始字节长度 + sha256（哪些对象是新增的、哪些被改了）
 *   4. 每页图片 XObject 的原始流字节（图片是否被重编码）
 *
 * 对象枚举策略：正则扫描 `N G obj` + 两趟过滤（第二轮丢掉落在某个流数据区
 * 内的伪命中），再与 xref 声明的对象号集合交叉核对；若 xref 里有而扫描里没有，
 * 说明存在对象流（/ObjStm），会在输出里显式报告（该类对象扫描不到）。
 *
 * 用法：
 *   node --experimental-loader=./tests/loader.mjs --experimental-strip-types \
 *        tests/pdf-audit/scratch/pdf-byte-diff.mjs <a.pdf> <b.pdf> [--page 1]
 * `--page` 指定「被编辑页」（1 基，默认 1）；其余页视作未编辑页参与一致性判定。
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import {
  latin1FromBytes,
  parseIndirectObject,
  parseValueAt,
  asArray,
  asDict,
  asName,
  asNumber,
  asRef,
  asStream,
  serializeValue
} from '../../../src/renderer/src/utils/pdfObjects.ts'

const argv = process.argv.slice(2)
const editedPageArg = argv.indexOf('--page')
const editedPage = editedPageArg >= 0 ? Number(argv[editedPageArg + 1]) : 1
const files = argv.filter((a, i) => editedPageArg < 0 || (i !== editedPageArg && i !== editedPageArg + 1))
if (files.length < 2) {
  console.error('用法: pdf-byte-diff.mjs <a.pdf> <b.pdf> [--page 1]')
  process.exit(2)
}

const sha = (b) => createHash('sha256').update(b).digest('hex')

/** 对象的可打印描述：流只序列化字典（流数据走 sha 比对，避免终端里喷二进制） */
const describeObj = (o) => {
  if (!o) return ''
  if (o.kind === 'stream') {
    return (
      'stream(rawLen=' + o.raw.length + ', rawSha=' + sha(o.raw).slice(0, 16) + ') ' +
      serializeValue({ kind: 'dict', map: o.dict.map })
    )
  }
  return serializeValue(o)
}

/* ==================== 对象枚举 ==================== */

function scanObjects(src) {
  const re = /(\d+)[\s\x00]+(\d+)[\s\x00]+obj\b/g
  const cands = []
  let m
  while ((m = re.exec(src)) !== null) {
    const offset = m.index
    try {
      const p = parseIndirectObject(src, offset)
      cands.push({ offset, num: p.num, gen: p.gen, value: p.value, end: p.end })
    } catch (e) {
      cands.push({ offset, num: Number(m[1]), gen: Number(m[2]), value: null, end: offset, error: String(e.message || e) })
    }
    re.lastIndex = offset + m[0].length
  }
  cands.sort((a, b) => a.offset - b.offset)
  const kept = []
  const dropped = []
  for (const c of cands) {
    const host = kept.find((k) => k.value && k.value.kind === 'stream' && c.offset > k.offset && c.offset < k.end)
    if (host) dropped.push({ ...c, inStreamOf: host.num })
    else kept.push(c)
  }
  const map = new Map()
  for (const k of kept) map.set(k.num, k)
  return { list: kept, map, dropped }
}

function readXref(src) {
  const declared = new Set()
  const type2 = []
  let sawObjStm = false
  let kind = 'none'
  let trailer = null
  let pos = src.lastIndexOf('startxref')
  if (pos < 0) return { declared, type2, sawObjStm, kind }
  const parsed = parseValueAt(src, pos + 'startxref'.length)
  let offset = parsed.value.kind === 'number' ? parsed.value.value : -1
  const seenOffsets = new Set()
  while (offset >= 0 && !seenOffsets.has(offset)) {
    seenOffsets.add(offset)
    if (src.startsWith('xref', offset)) {
      kind = kind === 'none' ? 'classic' : kind + '+classic'
      let q = offset + 4
      for (;;) {
        const tok = parseValueAt(src, q)
        if (tok.value.kind !== 'number') break
        const start = tok.value.value
        const cntParsed = parseValueAt(src, tok.end)
        if (cntParsed.value.kind !== 'number') break
        const count = cntParsed.value.value
        let r = cntParsed.end
        for (let i = 0; i < count; i++) {
          const ent = parseValueAt(src, r)
          const off = ent.value.kind === 'number' ? ent.value.value : -1
          const genP = parseValueAt(src, ent.end)
          const gen = genP.value.kind === 'number' ? genP.value.value : 0
          // 第三列是关键字 n / f（不是 name，parseValueAt 会把它读成 null），故直接看原文
          const tail = src.slice(genP.end, genP.end + 8)
          const m2 = /^\s*(f|n)\b/.exec(tail)
          const isFree = m2 ? m2[1] === 'f' : false
          if (!isFree && !(gen === 0 && off === 0)) declared.add(start + i)
          r = genP.end + (m2 ? m2[0].length : 0)
        }
        q = r
      }
      const trIdx = src.indexOf('trailer', q)
      if (trIdx >= 0 && trIdx - q < 200) {
        const tr = parseValueAt(src, trIdx + 'trailer'.length)
        if (tr.value.kind === 'dict') trailer = tr.value
        const prev = tr.value.kind === 'dict' ? tr.value.map.get('Prev') : undefined
        offset = prev && prev.kind === 'number' ? prev.value : -1
      } else offset = -1
    } else {
      try {
        const p = parseIndirectObject(src, offset)
        if (p.value.kind === 'stream') {
          kind = kind === 'none' ? 'stream' : kind + '+stream'
          const d = p.value.dict
          if (asName(d.map.get('Type')) === 'XRef') {
            trailer = d
            const w = asArray(d.map.get('W'))
            const widths = w ? w.items.map((x) => (x.kind === 'number' ? x.value : 0)) : []
            const size = asNumber(d.map.get('Size')) ?? 0
            const idx = asArray(d.map.get('Index'))
            const pairs = idx
              ? idx.items.map((x) => (x.kind === 'number' ? x.value : 0))
              : [0, size]
            const dec = decodeStream(p.value)
            const data = dec.data
            if (dec.error) console.log('  ⚠ xref 流解码失败: ' + dec.error)
            let cursor = 0
            for (let k = 0; k + 1 < pairs.length; k += 2) {
              const first = pairs[k]
              const count = pairs[k + 1]
              for (let i = 0; i < count; i++) {
                const nums = []
                for (const wd of widths) {
                  let v = 0
                  for (let b = 0; b < wd; b++) v = v * 256 + (data[cursor++] ?? 0)
                  nums.push(v)
                }
                if (nums[0] === 1) declared.add(first + i)
                else if (nums[0] === 2) {
                  declared.add(first + i)
                  type2.push({ obj: first + i, objstm: nums[1], index: nums[2] })
                }
              }
            }
          }
          if (d.map.has('ObjStm')) sawObjStm = true
          const prev = d.map.get('Prev')
          offset = prev && prev.kind === 'number' ? prev.value : -1
        } else offset = -1
      } catch {
        offset = -1
      }
    }
  }
  return { declared, type2, sawObjStm, kind, trailer }
}

/* ==================== 流解码 ==================== */

function filtersOf(dict) {
  const f = dict.map.get('Filter')
  if (!f) return []
  if (f.kind === 'name') return [f.name]
  if (f.kind === 'array') return f.items.filter((x) => x.kind === 'name').map((x) => x.name)
  return []
}

function decodeStream(stream) {
  let data = stream.raw
  const filters = filtersOf(stream.dict)
  for (const f of filters) {
    if (f === 'FlateDecode' || f === 'Fl') {
      try {
        data = new Uint8Array(inflateSync(Buffer.from(data)))
      } catch (e) {
        return { data, error: 'inflate 失败: ' + (e.message || e) }
      }
    } else if (f === 'ASCIIHexDecode' || f === 'AHx') {
      const s = latin1FromBytes(data).replace(/[^0-9A-Fa-f>]/g, '')
      const hex = s.split('>')[0]
      data = Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex')
    } else {
      return { data, error: '未支持的 Filter: ' + f }
    }
  }
  return { data, filters }
}

/* ==================== 对象流（/ObjStm）展开 ==================== */

/**
 * 把打包在 /ObjStm 里的对象解出来补进对象表。
 * 不展开的话，对象流格式的 PDF（如 pdf-lib 的 useObjectStreams:true 产物、
 * 部分 Word/浏览器导出）会「一个页面对象都找不到」，比对就会假绿。
 */
function expandObjStms(objs) {
  const added = []
  for (const [, o] of [...objs.map]) {
    if (!o.value || o.value.kind !== 'stream') continue
    if (asName(o.value.dict.map.get('Type')) !== 'ObjStm') continue
    const dec = decodeStream(o.value)
    if (dec.error) continue
    const s = latin1FromBytes(dec.data)
    const n = asNumber(o.value.dict.map.get('N')) ?? 0
    const first = asNumber(o.value.dict.map.get('First')) ?? 0
    let cursor = 0
    for (let i = 0; i < n; i++) {
      const p1 = parseValueAt(s, cursor)
      const num = p1.value.kind === 'number' ? p1.value.value : -1
      const p2 = parseValueAt(s, p1.end)
      const off = p2.value.kind === 'number' ? p2.value.value : -1
      cursor = p2.end
      if (num < 0 || off < 0) continue
      if (objs.map.has(num)) continue
      const parsed = parseValueAt(s, first + off)
      objs.map.set(num, { offset: -1, num, gen: 0, value: parsed.value, end: -1, inObjStm: true })
      added.push(num)
    }
  }
  return added
}

/* ==================== 页面树（含继承属性） ==================== */

const INHERIT = ['Resources', 'MediaBox', 'CropBox', 'Rotate']

function collectPages(objs, trailer) {
  let root = null
  const rootRef = trailer ? trailer.map.get('Root') : undefined
  if (rootRef && rootRef.kind === 'ref') root = objs.map.get(rootRef.num)?.value
  if (!root) {
    for (const [, o] of objs.map) {
      const d = o.value && o.value.kind === 'stream' ? o.value.dict : o.value && o.value.kind === 'dict' ? o.value : null
      if (d && asName(d.map.get('Type')) === 'Catalog') root = d
    }
  }
  if (!root) return []
  const rootDict = root.kind === 'stream' ? root.dict : root
  if (rootDict.kind !== 'dict') return []
  const pagesRef = rootDict.map.get('Pages')
  const pagesNode = pagesRef && pagesRef.kind === 'ref' ? objs.map.get(pagesRef.num)?.value : pagesRef
  const out = []
  const walk = (nodeObj, inherited) => {
    if (!nodeObj) return
    const d = nodeObj.kind === 'stream' ? nodeObj.dict : nodeObj.kind === 'dict' ? nodeObj : null
    if (!d) return
    const inh = { ...inherited }
    for (const key of INHERIT) if (d.map.has(key)) inh[key] = d.map.get(key)
    const type = asName(d.map.get('Type'))
    if (type === 'Page') {
      out.push({ dict: d, inh })
      return
    }
    const kids = asArray(d.map.get('Kids'))
    if (kids) {
      for (const k of kids.items) {
        const kid = k.kind === 'ref' ? objs.map.get(k.num)?.value : k
        walk(kid, inh)
      }
    }
  }
  walk(pagesNode, {})
  return out
}

const resolve = (objs, o) => {
  let cur = o
  for (let i = 0; i < 32 && cur && cur.kind === 'ref'; i++) cur = objs.map.get(cur.num)?.value
  return cur
}

/* ==================== 单文件摘要 ==================== */

function summarize(bytes, label) {
  const src = latin1FromBytes(bytes)
  const objs = scanObjects(src)
  const xref = readXref(src)
  const topLevelCount = objs.list.length
  const fromObjStm = expandObjStms(objs)
  const pages = collectPages(objs, xref.trailer)

  const pageInfo = pages.map((pg, i) => {
    const mediaBox = resolve(objs, pg.inh.MediaBox)
    const cropBox = resolve(objs, pg.inh.CropBox)
    const rotate = resolve(objs, pg.inh.Rotate)
    const res = resolve(objs, pg.inh.Resources)
    const resKeys = res && res.kind === 'dict' ? [...res.map.keys()].sort().join(',') : ''

    // 内容流
    const contents = resolve(objs, pg.dict.map.get('Contents'))
    const streams = []
    if (contents && contents.kind === 'stream') streams.push(contents)
    else if (contents && contents.kind === 'array') {
      for (const c of contents.items) {
        const s = resolve(objs, c)
        if (s && s.kind === 'stream') streams.push(s)
      }
    }
    let contentBytes = Buffer.alloc(0)
    const decodeNotes = []
    for (const s of streams) {
      const dec = decodeStream(s)
      if (dec.error) decodeNotes.push(dec.error)
      contentBytes = Buffer.concat([contentBytes, Buffer.from(dec.data)])
    }

    // 图片 XObject
    const xobjects = []
    const xo = res && res.kind === 'dict' ? resolve(objs, res.map.get('XObject')) : null
    if (xo && xo.kind === 'dict') {
      for (const [name, ref] of xo.map) {
        const target = resolve(objs, ref)
        if (target && target.kind === 'stream' && asName(target.dict.map.get('Subtype')) === 'Image') {
          xobjects.push({
            name,
            objNum: ref.kind === 'ref' ? ref.num : -1,
            dict: serializeValue({ kind: 'dict', map: target.dict.map }),
            rawLen: target.raw.length,
            rawSha: sha(target.raw)
          })
        }
      }
    }

    return {
      index: i,
      mediaBox: mediaBox ? serializeValue(mediaBox) : '(inherit-none)',
      cropBox: cropBox ? serializeValue(cropBox) : '(none)',
      rotate: rotate ? serializeValue(rotate) : '0',
      resKeys,
      contentLen: contentBytes.length,
      contentSha: sha(contentBytes),
      contentNotes: decodeNotes,
      xobjects
    }
  })

  return {
    label,
    bytes,
    len: bytes.length,
    sha: sha(bytes),
    head: Buffer.from(bytes.subarray(0, 8)).toString('latin1'),
    objCount: objs.list.length,
    topLevelCount,
    objInStm: fromObjStm.length,
    objMap: objs.map,
    droppedFalse: objs.dropped.length,
    xrefDeclared: xref.declared.size,
    xrefKind: xref.kind,
    sawObjStm: objs.list.some(
      (o) => o.value && o.value.kind === 'stream' && asName(o.value.dict.map.get('Type')) === 'ObjStm'
    ) || xref.sawObjStm,
    type2Count: xref.type2.length,
    missingFromScan: [...xref.declared].filter((n) => !objs.map.has(n)).sort((a, b) => a - b),
    pageInfo,
    pageCount: pageInfo.length
  }
}

/* ==================== 比对 ==================== */

const A = summarize(new Uint8Array(readFileSync(files[0])), files[0])
const B = summarize(new Uint8Array(readFileSync(files[1])), files[1])

console.log('='.repeat(96))
console.log('PDF 对象级字节比对')
console.log('='.repeat(96))
for (const s of [A, B]) {
  console.log('\n--- ' + s.label + ' ---')
  console.log('  字节数        : ' + s.len)
  console.log('  sha256        : ' + s.sha)
  console.log('  文件头        : ' + JSON.stringify(s.head) + '  以%PDF-开头=' + s.head.startsWith('%PDF-'))
  console.log('  页数          : ' + s.pageCount)
  console.log('  顶层扫描对象数: ' + s.topLevelCount + '  (丢弃伪命中 ' + s.droppedFalse + ' 个)')
  console.log('  对象流解出对象: ' + s.objInStm + '   → 对象表合计 ' + s.objCount)
  console.log('  xref 类型     : ' + s.xrefKind + '  声明对象数=' + s.xrefDeclared + '  type2(对象流内)=' + s.type2Count)
  console.log('  含 /ObjStm    : ' + s.sawObjStm)
  console.log('  xref 有但扫描未命中: ' + (s.missingFromScan.length ? JSON.stringify(s.missingFromScan) : '无') +
    (s.missingFromScan.length ? '  ⚠ 这些对象扫描不到（对象流或解析盲区），比对存在偏差风险' : ''))
}

console.log('\n' + '='.repeat(96))
console.log('逐页比对（--page ' + editedPage + ' 视为被编辑页，其余为未编辑页）')
console.log('='.repeat(96))
console.log(
  '页 | MediaBox一致 | CropBox一致 | Rotate一致 | 资源键一致 | 内容流(解码后)一致 | A长度/sha | B长度/sha'
)
let mediaBoxAll = true
let contentSameOnUnedited = true
let contentDiffOnEdited = false
const maxPages = Math.max(A.pageCount, B.pageCount)
for (let i = 0; i < maxPages; i++) {
  const a = A.pageInfo[i]
  const b = B.pageInfo[i]
  if (!a || !b) {
    console.log((i + 1) + ' | 页缺失(A=' + !!a + ',B=' + !!b + ')')
    mediaBoxAll = false
    contentSameOnUnedited = false
    continue
  }
  const mbSame = a.mediaBox === b.mediaBox
  const cbSame = a.cropBox === b.cropBox
  const rotSame = a.rotate === b.rotate
  const resSame = a.resKeys === b.resKeys
  const csSame = a.contentSha === b.contentSha
  if (!mbSame) mediaBoxAll = false
  const isEdited = i + 1 === editedPage
  if (isEdited && !csSame) contentDiffOnEdited = true
  if (!isEdited && !csSame) contentSameOnUnedited = false
  console.log(
    (i + 1).toString().padStart(2) + ' | ' + (mbSame ? '是' : '否').padEnd(12) + ' | ' +
      (cbSame ? '是' : '否').padEnd(10) + ' | ' + (rotSame ? '是' : '否').padEnd(10) + ' | ' +
      (resSame ? '是' : '否').padEnd(10) + ' | ' + (csSame ? '是' : '否').padEnd(18) + ' | ' +
      a.contentLen + '/' + a.contentSha.slice(0, 16) + ' | ' + b.contentLen + '/' + b.contentSha.slice(0, 16) +
      (a.contentNotes.length || b.contentNotes.length ? '  notes=' + JSON.stringify([...a.contentNotes, ...b.contentNotes]) : '') +
      (isEdited ? '   ← 被编辑页' : '')
  )
  if (!resSame) {
    console.log('      资源键 A: ' + (a.resKeys || '(空)'))
    console.log('      资源键 B: ' + (b.resKeys || '(空)'))
  }
}

console.log('\n' + '='.repeat(96))
console.log('对象级比对')
console.log('='.repeat(96))
const aNums = [...A.objMap.keys()].sort((x, y) => x - y)
const bNums = [...B.objMap.keys()].sort((x, y) => x - y)
const onlyA = aNums.filter((n) => !B.objMap.has(n))
const onlyB = bNums.filter((n) => !A.objMap.has(n))
const both = aNums.filter((n) => B.objMap.has(n))
const changed = []
for (const n of both) {
  const a = A.objMap.get(n)
  const b = B.objMap.get(n)
  const aSer = describeObj(a.value)
  const bSer = describeObj(b.value)
  if (aSer !== bSer) changed.push({ n, aLen: aSer.length, bLen: bSer.length, aSer, bSer, kind: classifyChange(a.value, b.value) })
}

/**
 * 变化分类：把「流数据字节没变、只是 /Length 的写法从间接引用变成直接数字」
 * 这类无害重写单独拎出来，避免和「内容真的被改了」混为一谈。
 */
function classifyChange(av, bv) {
  const isStream = (o) => o && o.kind === 'stream'
  if (isStream(av) && isStream(bv)) {
    const rawSame = sha(av.raw) === sha(bv.raw)
    const dictWithoutLength = (o) =>
      serializeValue({ kind: 'dict', map: new Map([...o.dict.map].filter(([k]) => k !== 'Length')) })
    const dictSameIgnoringLength = dictWithoutLength(av) === dictWithoutLength(bv)
    if (rawSame && dictSameIgnoringLength) return '仅 /Length 写法变化（流数据字节完全一致）'
    if (rawSame) return '流数据字节一致，但字典有其它变化'
    return '⚠ 流数据字节已变化'
  }
  if (isStream(av) !== isStream(bv)) return '⚠ 对象类型从流变非流（或反之）'
  return '非流对象，字节有变化'
}

console.log('A 对象数=' + aNums.length + '  B 对象数=' + bNums.length)
console.log('只在 A 有 (被删除/改号) : ' + (onlyA.length ? JSON.stringify(onlyA) : '无'))
console.log('只在 B 有 (新增对象)    : ' + (onlyB.length ? JSON.stringify(onlyB) : '无'))
for (const n of onlyB) {
  console.log('    + 对象 ' + n + ': ' + describeObj(B.objMap.get(n).value).slice(0, 150))
}
console.log('两边都有但字节不同      : ' + (changed.length ? changed.length + ' 个 ' + JSON.stringify(changed.map((c) => c.n)) : '无'))
const byKind = {}
for (const c of changed) byKind[c.kind] = (byKind[c.kind] || 0) + 1
for (const [k, v] of Object.entries(byKind)) console.log('    分类: ' + k + ' × ' + v)
for (const c of changed.slice(0, 20)) {
  console.log('  对象 ' + c.n + ': A 长度 ' + c.aLen + ' → B 长度 ' + c.bLen + '   [' + c.kind + ']')
  console.log('    A: ' + c.aSer.slice(0, 180))
  console.log('    B: ' + c.bSer.slice(0, 180))
}

console.log('\n' + '='.repeat(96))
console.log('图片 XObject 比对（逐页）')
console.log('注意：资源字典被多页共享（或从 Pages 节点继承）时，同一 XObject 会在多页重复出现')
console.log('='.repeat(96))
let imagesStreamSame = true
let imagesDictSame = true
const newImageObjs = new Set()
const removedImageObjs = new Set()
for (let i = 0; i < maxPages; i++) {
  const a = A.pageInfo[i]
  const b = B.pageInfo[i]
  if (!a || !b) continue
  console.log('第 ' + (i + 1) + ' 页: A 图片数=' + a.xobjects.length + '  B 图片数=' + b.xobjects.length)
  const names = [...new Set([...a.xobjects.map((x) => x.name), ...b.xobjects.map((x) => x.name)])]
  for (const nm of names) {
    const xa = a.xobjects.find((x) => x.name === nm)
    const xb = b.xobjects.find((x) => x.name === nm)
    if (!xa && xb) {
      newImageObjs.add(xb.objNum)
      console.log('  ' + nm + ' obj=' + xb.objNum + '  【新增图片】流字节=' + xb.rawLen + '/' + xb.rawSha.slice(0, 12))
      continue
    }
    if (xa && !xb) {
      removedImageObjs.add(xa.objNum)
      imagesStreamSame = false
      console.log('  ' + nm + ' obj=' + xa.objNum + '  ⚠ 【图片被移除】')
      continue
    }
    const streamSame = xa.rawSha === xb.rawSha && xa.rawLen === xb.rawLen
    const dictSame = xa.dict === xb.dict
    if (!streamSame) imagesStreamSame = false
    if (!dictSame) imagesDictSame = false
    console.log(
      '  ' + nm + ' obj=' + xa.objNum + '  流数据字节一致=' + (streamSame ? '是' : '否') +
        '  字典字节一致=' + (dictSame ? '是' : '否') +
        '  (' + xa.rawLen + '/' + xa.rawSha.slice(0, 12) + ' vs ' + xb.rawLen + '/' + xb.rawSha.slice(0, 12) + ')'
    )
    if (!dictSame) {
      console.log('    A dict: ' + xa.dict.slice(0, 160))
      console.log('    B dict: ' + xb.dict.slice(0, 160))
    }
  }
}

const trustworthy =
  A.pageCount > 0 && B.pageCount > 0 && A.missingFromScan.length === 0 && B.missingFromScan.length === 0
console.log('\n' + '='.repeat(96))
console.log(
  'RESULT: pages_identical=' + (A.pageCount === B.pageCount) +
    ' mediabox_identical=' + mediaBoxAll +
    ' unedited_pages_stream_identical=' + contentSameOnUnedited +
    ' edited_page_stream_changed=' + contentDiffOnEdited +
    ' preexisting_images_stream_bytes_identical=' + imagesStreamSame +
    ' preexisting_images_dict_identical=' + imagesDictSame +
    ' new_images=' + newImageObjs.size + ' (对象号 ' + [...newImageObjs].join(',') + ')' +
    ' removed_images=' + removedImageObjs.size
)
console.log('RESULT_VALID=' + trustworthy + (trustworthy ? '' : '  ⚠ 判定不可信：页数为 0 或存在扫描不到的对象（见上文警告）'))
console.log('='.repeat(96))
