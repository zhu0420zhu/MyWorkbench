import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'

const files = [
  'tests/pdf-audit/qa-fixtures/real-large-plain.pdf',
  'tests/pdf-audit/fixtures/enhance-source.pdf',
]
for (const f of files) {
  const orig = await readFile(f)
  console.log('\n=== ' + f + '  (' + orig.length + ' B) ===')
  const mk = async (fn) => (await fn()).length
  const rep = async (label, fn) => {
    try { console.log('  ' + label.padEnd(34) + await mk(fn) + ' B') }
    catch (e) { console.log('  ' + label.padEnd(34) + 'ERR ' + e.message) }
  }
  await rep('save(objectStreams=true)', async () => (await PDFDocument.load(orig, {ignoreEncryption:true})).save({useObjectStreams:true, addDefaultPage:false}))
  await rep('save(objectStreams=false)', async () => (await PDFDocument.load(orig, {ignoreEncryption:true})).save({useObjectStreams:false, addDefaultPage:false}))
  await rep('clearMeta + save(true)', async () => { const d = await PDFDocument.load(orig, {ignoreEncryption:true}); d.setTitle(''); d.setAuthor(''); d.setSubject(''); d.setKeywords([]); return d.save({useObjectStreams:true, addDefaultPage:false}) })
  await rep('2 passes(true)', async () => { let b = await (await PDFDocument.load(orig,{ignoreEncryption:true})).save({useObjectStreams:true,addDefaultPage:false}); return (await PDFDocument.load(b,{ignoreEncryption:true})).save({useObjectStreams:true,addDefaultPage:false}) })
  await rep('3 passes(true)', async () => { let b = orig; for (let i=0;i<3;i++){ b = await (await PDFDocument.load(b,{ignoreEncryption:true})).save({useObjectStreams:true,addDefaultPage:false}) } return b })
  await rep('clearMeta+2pass', async () => { let b = await (await PDFDocument.load(orig,{ignoreEncryption:true})).save({useObjectStreams:true,addDefaultPage:false}); const d = await PDFDocument.load(b,{ignoreEncryption:true}); d.setTitle(''); d.setAuthor(''); d.setSubject(''); d.setKeywords([]); return d.save({useObjectStreams:true,addDefaultPage:false}) })
}
