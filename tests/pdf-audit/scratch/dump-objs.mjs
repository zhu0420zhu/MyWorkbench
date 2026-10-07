/**
 * 小工具：打印指定对象号的内容（流会尝试解压），用于确认「新增对象到底是什么」。
 * 用法：node --experimental-loader=./tests/loader.mjs --experimental-strip-types \
 *       tests/pdf-audit/scratch/dump-objs.mjs <pdf> 74 75 76 [--max 400]
 */
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import {
  latin1FromBytes,
  parseIndirectObject,
  parseValueAt,
  asName,
  asArray,
  asNumber,
  serializeValue
} from '../../../src/renderer/src/utils/pdfObjects.ts'

const argv = process.argv.slice(2)
const maxArg = argv.indexOf('--max')
const max = maxArg >= 0 ? Number(argv[maxArg + 1]) : 400
const rest = argv.filter((a, i) => maxArg < 0 || (i !== maxArg && i !== maxArg + 1))
const file = rest[0]
const wanted = rest.slice(1).map(Number)

const bytes = new Uint8Array(readFileSync(file))
const src = latin1FromBytes(bytes)

// 复用与 pdf-byte-diff 相同的枚举方式
const re = /(\d+)[\s\x00]+(\d+)[\s\x00]+obj\b/g
const found = new Map()
let m
while ((m = re.exec(src)) !== null) {
  const offset = m.index
  let p
  try {
    p = parseIndirectObject(src, offset)
  } catch {
    continue
  }
  const host = [...found.values()].find((k) => k.value && k.value.kind === 'stream' && offset > k.offset && offset < k.end)
  if (host) continue
  found.set(p.num, { offset, num: p.num, gen: p.gen, value: p.value, end: p.end })
  re.lastIndex = offset + m[0].length
}
// 对象流里的对象也解出来
for (const [, o] of [...found]) {
  if (!o.value || o.value.kind !== 'stream') continue
  if (asName(o.value.dict.map.get('Type')) !== 'ObjStm') continue
  const s = latin1FromBytes(new Uint8Array(inflateSync(Buffer.from(o.value.raw))))
  const n = asNumber(o.value.dict.map.get('N')) ?? 0
  const first = asNumber(o.value.dict.map.get('First')) ?? 0
  let cursor = 0
  const heads = []
  for (let i = 0; i < n; i++) {
    const p1 = parseValueAt(s, cursor)
    const p2 = parseValueAt(s, p1.end)
    heads.push([p1.value.value, p2.value.value])
    cursor = p2.end
  }
  for (const [num, off] of heads) {
    if (found.has(num)) continue
    const parsed = parseValueAt(s, first + off)
    found.set(num, { offset: -1, num, gen: 0, value: parsed.value, end: -1 })
  }
}

console.log('文件: ' + file)
console.log('对象总数(含对象流内): ' + found.size)
for (const num of wanted) {
  const o = found.get(num)
  console.log('\n===== 对象 ' + num + ' =====')
  if (!o) {
    console.log('(不存在)')
    continue
  }
  if (o.value && o.value.kind === 'stream') {
    console.log('字典: ' + serializeValue({ kind: 'dict', map: o.value.dict.map }))
    const filters = asArray(o.value.dict.map.get('Filter'))
    const fnames = filters ? filters.items.map((x) => (x.kind === 'name' ? x.name : '?')).join(',') : asName(o.value.dict.map.get('Filter')) || '(none)'
    let data = Buffer.from(o.value.raw)
    if (fnames.includes('FlateDecode')) {
      try {
        data = inflateSync(data)
      } catch (e) {
        console.log('解压失败: ' + e.message)
      }
    }
    console.log('Filter: ' + fnames + '  原始 ' + o.value.raw.length + ' 字节 → 解压后 ' + data.length + ' 字节')
    const txt = data.toString('latin1')
    const printable = /[\x00-\x08\x0e-\x1f]/.test(txt.slice(0, 200))
    console.log('内容' + (printable ? '(二进制，仅展示前 ' + max + ' 字节的可见字符)' : '') + ':')
    if (printable) {
      console.log(txt.replace(/[^\x20-\x7e]/g, '.').slice(0, max))
    } else {
      console.log(data.toString('utf8').slice(0, max))
    }
  } else {
    console.log(serializeValue(o.value).slice(0, max * 2))
  }
}
