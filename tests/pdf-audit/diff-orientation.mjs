/**
 * 判定 portrait / landscape 两个产出的差异性质。
 * 展开 Flate 流后逐条比对，区分「内容/几何差异」与「字体子集差异」。
 */
import { readFile } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'

function streams(bytes) {
  const raw = Buffer.from(bytes).toString('latin1')
  const out = []
  const re = /\bstream\r?\n/g
  let m
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) break
    let body = Buffer.from(raw.slice(start, end), 'latin1')
    const ds = raw.lastIndexOf('<<', m.index)
    const dict = ds >= 0 ? raw.slice(ds, m.index).replace(/\s+/g, ' ') : ''
    let data = body
    let inflated = false
    if (/FlateDecode/.test(dict)) {
      try {
        data = inflateSync(body)
        inflated = true
      } catch {
        /* 保持原样 */
      }
    }
    out.push({
      dict: dict.slice(0, 110),
      rawLen: body.length,
      inflated,
      dataLen: data.length,
      sha: createHash('sha256').update(data).digest('hex').slice(0, 12),
      text: inflated && data.length < 100000 ? data.toString('latin1') : null
    })
    re.lastIndex = end
  }
  return out
}

const A = streams(await readFile('tests/pdf-audit/work/out-portrait/sheet.pdf'))
const B = streams(await readFile('tests/pdf-audit/work/out-landscape/sheet.pdf'))

console.log('='.repeat(74))
console.log('portrait 与 landscape 产出差异的性质')
console.log('='.repeat(74))
console.log('\nportrait 流数=' + A.length + '  landscape 流数=' + B.length)

let geomDiff = 0
let fontDiff = 0
let otherDiff = 0
const n = Math.max(A.length, B.length)
for (let i = 0; i < n; i++) {
  const a = A[i], b = B[i]
  if (!a || !b) {
    otherDiff++
    continue
  }
  if (a.sha === b.sha) continue
  const isFont = /FontFile|FontDescriptor|CIDFont|Type0/.test(a.dict + b.dict)
  const isContent = /Contents|Page/.test(a.dict + b.dict)
  const tag = isFont ? '字体程序' : isContent ? '页面内容/几何' : '其它'
  if (isFont) fontDiff++
  else if (isContent) geomDiff++
  else otherDiff++
  if (i < 12 || isContent) {
    console.log('\n[流 ' + i + '] 差异类型: ' + tag)
    console.log('  portrait  dict: ' + a.dict)
    console.log('           展开后 ' + a.dataLen + 'B sha=' + a.sha)
    console.log('  landscape dict: ' + b.dict)
    console.log('           展开后 ' + b.dataLen + 'B sha=' + b.sha)
  }
}

console.log('\n' + '-'.repeat(74))
console.log('差异归类统计：')
console.log('  页面内容/几何流差异 : ' + geomDiff)
console.log('  字体程序流差异       : ' + fontDiff)
console.log('  其它流差异           : ' + otherDiff)

// 关键：页面几何对象（MediaBox）是否相同
const mediaA = [...Buffer.from(await readFile('tests/pdf-audit/work/out-portrait/sheet.pdf')).toString('latin1').matchAll(/\/MediaBox\s*\[([^\]]+)\]/g)].map((m) => m[1].trim())
const mediaB = [...Buffer.from(await readFile('tests/pdf-audit/work/out-landscape/sheet.pdf')).toString('latin1').matchAll(/\/MediaBox\s*\[([^\]]+)\]/g)].map((m) => m[1].trim())
console.log('\nportrait  的 MediaBox: ' + JSON.stringify(mediaA))
console.log('landscape 的 MediaBox: ' + JSON.stringify(mediaB))
console.log('MediaBox 是否相同    : ' + (JSON.stringify(mediaA) === JSON.stringify(mediaB) ? '✅ 完全相同 → 页面几何未变' : '❌ 不同'))
