import { readFile } from 'node:fs/promises'
import { isPdfEncrypted, describePdfSecurity } from '../../../src/renderer/src/utils/pdfSecurity.ts'
import { structureCompressPdf } from '../../../src/renderer/src/utils/pdfCompress.ts'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

for (const f of ['owner-only-r4.pdf', 'long-pwd-aes128.pdf', 'classic-xref-rc4.pdf']) {
  const p = 'tests/pdf-audit/qa-fixtures/' + f
  const bytes = await readFile(p)
  const enc = await isPdfEncrypted(bytes)
  let info = {}
  try { info = await describePdfSecurity(bytes) } catch { /* ignore */ }
  let js = ''
  try {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true }).promise
    js = '可无口令渲染 pages=' + doc.numPages
  } catch (e) { js = (e && e.name) + ': ' + String(e && e.message).slice(0, 40) }
  let str = ''
  try {
    const r = await structureCompressPdf(bytes, 'high')
    str = 'out=' + r.bytes.length + ' encOut=' + (await isPdfEncrypted(r.bytes))
  } catch (e) { str = 'ERR ' + e.message.slice(0, 50) }
  console.log(f.padEnd(24) + ' enc=' + enc + ' alg=' + (info.algorithm || '-') + ' | 结构high: ' + str + ' | pdfjs: ' + js)
}
