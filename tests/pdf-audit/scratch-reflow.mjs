import { readFile } from 'node:fs/promises'
import { PDFDocument, PDFRawStream, PDFName, PDFDict, PDFRef } from 'pdf-lib'
import { inflateSync, deflateSync } from 'node:zlib'

async function recompressStreams(d, level){
  const ctx = d.context
  let n = 0, saved = 0
  for (const [ref, obj] of ctx.enumerateIndirectObjects()){
    if (!(obj instanceof PDFRawStream)) continue
    const dct = obj.dict
    const f = dct.get(PDFName.of('Filter'))
    if (!(f instanceof PDFName) || f.toString() !== '/FlateDecode') continue
    const raw = obj.contents
    let plain
    try { plain = inflateSync(Buffer.from(raw)) } catch { continue }
    const re = deflateSync(plain, { level })
    if (re.length < raw.length){
      saved += raw.length - re.length
      const nd = PDFDict.withContext(ctx)
      for (const [k,v] of dct.entries()) nd.set(PDFName.of(k.asString().replace(/^\//,'')), v)
      ctx.assign(ref, PDFRawStream.of(nd, new Uint8Array(re)))
      n++
    }
  }
  return { n, saved }
}

for (const f of ['tests/pdf-audit/qa-fixtures/real-large-plain.pdf','tests/pdf-audit/fixtures/enhance-source.pdf']){
  const orig = await readFile(f)
  console.log('\n=== '+f+'  orig '+orig.length+' ===')
  for (const lvl of [9]){
    const d = await PDFDocument.load(orig, {ignoreEncryption:true})
    const { n, saved } = await recompressStreams(d, lvl)
    const out = await d.save({useObjectStreams:true, addDefaultPage:false})
    console.log('  deflate level '+lvl+': recompressed '+n+' streams, saved '+saved+' B, out '+out.length)
  }
}
