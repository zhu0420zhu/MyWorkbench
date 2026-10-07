import { readFile, readdir } from 'node:fs/promises'
import { isPdfEncrypted, describePdfSecurity } from '../../../src/renderer/src/utils/pdfSecurity.ts'
import { structureCompressPdf } from '../../../src/renderer/src/utils/pdfCompress.ts'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const files = [
  ...(await readdir('tests/pdf-audit/fixtures/encrypted')).map((f) => 'tests/pdf-audit/fixtures/encrypted/' + f),
  'tests/pdf-audit/qa-fixtures/real-large-aes128.pdf',
  'tests/pdf-audit/qa-fixtures/classic-xref-aes128.pdf',
  'tests/pdf-audit/qa-fixtures/incremental-aes128.pdf'
]

for (const p of files) {
  const bytes = await readFile(p)
  const enc = await isPdfEncrypted(bytes)
  let info = {}
  try { info = await describePdfSecurity(bytes) } catch { /* ignore */ }
  const r = {}
  for (const lv of ['low', 'high']) {
    try {
      const res = await structureCompressPdf(bytes, lv)
      r[lv] = { out: res.bytes.length, kept: res.stats.keptOriginal, encOut: await isPdfEncrypted(res.bytes) }
    } catch (e) { r[lv] = 'ERR ' + e.message.slice(0, 60) }
  }
  let js = ''
  try {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true }).promise
    js = 'OK pages=' + doc.numPages
  } catch (e) { js = (e && e.name) + ': ' + String(e && e.message).slice(0, 50) }
  console.log(p.split('/').pop().padEnd(26) + ' enc=' + enc + ' alg=' + (info.algorithm || '-') + ' sup=' + info.supported +
    ' | 结构low=' + JSON.stringify(r.low) + ' | 结构high=' + JSON.stringify(r.high) + ' | pdfjs=' + js)
}
