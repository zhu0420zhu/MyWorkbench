import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

/**
 * 正确提取 PDF 的 stream 载荷。
 * 坑：/stream\r?\n/ 会匹配到 endstream 内部的 "stream"，导致切片级联错位。
 * 用 \bstream 排除（endstream 中 s 前是 d，同为 word char，无词边界）。
 */
function extractStreams(bytes) {
  const raw = Buffer.from(bytes).toString('latin1')
  const out = []
  const re = /\bstream\r?\n/g
  let m
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) break
    let p = raw.slice(start, end)
    if (p.endsWith('\r\n')) p = p.slice(0, -2)
    else if (p.endsWith('\n')) p = p.slice(0, -1)

    // 向前找最近的 "N 0 obj" 作为对象头，并取其字典
    const objStart = raw.lastIndexOf(' 0 obj', m.index)
    const dictStart = objStart >= 0 ? raw.lastIndexOf('<<', m.index) : -1
    const dict = dictStart >= 0 ? raw.slice(dictStart, m.index).replace(/\s+/g, ' ') : '(?)'
    const isContent = /\/Type\s*\/XObject/.test(dict) || /\/Contents/.test(dict)

    out.push({
      len: p.length,
      sha: createHash('sha256').update(p, 'latin1').digest('hex').slice(0, 12),
      kind: /\/Subtype\s*\/Image/.test(dict)
        ? 'image'
        : /\/Type\s*\/ObjStm/.test(dict)
          ? 'objstm'
          : /FlateDecode/.test(dict)
            ? 'flate-?'
            : 'content',
      dict: dict.slice(0, 96),
      head: p.slice(0, 40).replace(/\n/g, '\\n'),
      _raw: p
    })
    re.lastIndex = end
  }
  return out
}

const files = ['enhance-source', 'enhance-output']
const all = {}
for (const f of files) {
  const b = await readFile('tests/pdf-audit/fixtures/' + f + '.pdf')
  all[f] = extractStreams(b)
  console.log('\n===== ' + f + '.pdf (' + b.byteLength + 'B, ' + all[f].length + ' streams) =====')
  all[f].forEach((s, i) => {
    console.log(
      '[' + i + '] len=' + String(s.len).padStart(5) + ' sha=' + s.sha + ' kind=' + s.kind
    )
    console.log('     dict: ' + s.dict)
    console.log('     head: ' + s.head)
  })
}

// 按 kind+len+sha 做多重集比对
console.log('\n===== 多重集比对 =====')
const key = (s) => s.kind + '|' + s.len + '|' + s.sha
const a = all['enhance-source'].map(key).sort()
const b = all['enhance-output'].map(key).sort()
console.log('源  多重集:', a.join('\n            '))
console.log('输出多重集:', b.join('\n            '))
console.log('\n完全一致:', JSON.stringify(a) === JSON.stringify(b) ? '✅' : '❌')

// 内容流专项：把两边「content」类的原始字节直接对比
const ca = all['enhance-source'].filter((s) => s.kind !== 'image' && s.kind !== 'objstm')
const cb = all['enhance-output'].filter((s) => s.kind !== 'image' && s.kind !== 'objstm')
console.log('\n非图片流数量: 源=' + ca.length + ' 输出=' + cb.length)
console.log('非图片流字节逐条相同:', ca.length === cb.length && ca.every((s, i) => s.sha === cb[i].sha) ? '✅' : '❌')
