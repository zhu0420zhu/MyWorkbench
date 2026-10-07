import { readFile } from 'node:fs/promises'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

// 造一个典型「多小对象」文本 PDF（审计用的就是这类）
async function mkText(n) {
  const d = await PDFDocument.create()
  d.setTitle('样本'); d.setAuthor('Lingmo'); d.setSubject('t'); d.setKeywords(['a','b'])
  const f = await d.embedFont(StandardFonts.Helvetica)
  for (let i=0;i<n;i++){ const p=d.addPage([595,842]); p.drawText('Hello page '+i, {x:60,y:760,size:14,font:f,color:rgb(0,0,0)}) }
  return await d.save()
}

function removeInfo(d){
  const ti = d.context.trailerInfo
  try { delete ti.Info } catch {}
  try { delete ti.ID } catch {}
}

function pruneUnreachable(d){
  const ctx = d.context
  const seen = new Set()
  const stack = []
  const push = (o) => { stack.push(o) }
  push(d.catalog)
  if (ctx.trailerInfo.Info) push(ctx.trailerInfo.Info)
  while (stack.length){
    const o = stack.pop()
    if (!o || seen.has(o)) continue
    seen.add(o)
    const walk = (v) => {
      if (!v) return
      if (v.constructor && v.constructor.name === 'PDFRef'){ 
        const resolved = ctx.lookup(v); if (resolved) stack.push(resolved); return 
      }
      if (typeof v === 'object'){
        // PDFDict / PDFArray / PDFStream
        if (v.dict) push(v.dict)
        if (typeof v.entries === 'function'){ try { for (const [,val] of v.entries()) walk(val) } catch {} }
        if (Array.isArray(v.array)) for (const it of v.array) walk(it)
        if (v.contents && typeof v.contents === 'object') push(v.contents)
      }
    }
    if (typeof o.entries === 'function'){ try { for (const [,val] of o.entries()) walk(val) } catch {} }
    if (Array.isArray(o.array)) for (const it of o.array) walk(it)
  }
  let removed = 0
  for (const [ref, obj] of ctx.enumerateIndirectObjects()){
    if (!seen.has(obj)) { ctx.delete(ref); removed++ }
  }
  return removed
}

const cases = []
cases.push(['small-text-3p', await mkText(3)])
cases.push(['enhance-source.pdf', await readFile('tests/pdf-audit/fixtures/enhance-source.pdf')])
cases.push(['real-large-plain.pdf', await readFile('tests/pdf-audit/qa-fixtures/real-large-plain.pdf')])

for (const [name, orig] of cases){
  console.log('\n=== '+name+'  orig '+orig.length+' B ===')
  const load = () => PDFDocument.load(orig, {ignoreEncryption:true})
  // low
  let d = await load(); const low = (await d.save({useObjectStreams:true, addDefaultPage:false})).length
  // med
  d = await load(); removeInfo(d); const med = (await d.save({useObjectStreams:true, addDefaultPage:false})).length
  // high
  d = await load(); removeInfo(d); const pruned = pruneUnreachable(d); const high = (await d.save({useObjectStreams:true, addDefaultPage:false})).length
  console.log('  low  (objStreams)              '+low)
  console.log('  med  (+remove Info&ID)         '+med)
  console.log('  high (+prune unreachable x'+pruned+')  '+high)
  console.log('  旧: low=objStreams:false       '+(await (await load()).save({useObjectStreams:false,addDefaultPage:false})).length)
}
