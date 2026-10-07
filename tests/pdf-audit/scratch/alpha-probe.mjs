import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const PDFJS_ROOT = join(ROOT, 'node_modules', 'pdfjs-dist')

const doc = await PDFDocument.create()
const font = await doc.embedFont(StandardFonts.Helvetica)
const p = doc.addPage([595, 842])
p.drawText('Alpha probe', { x: 60, y: 760, size: 20, font, color: rgb(0, 0, 0) })
const bytes = await doc.save()

const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, standardFontDataUrl: join(PDFJS_ROOT, 'standard_fonts') + '/' })
const d = await task.promise
const pg = await d.getPage(1)
const vp = pg.getViewport({ scale: 2 })
const canvas = createCanvas(Math.round(vp.width), Math.round(vp.height))
const ctx = canvas.getContext('2d')
await pg.render({ canvas, canvasContext: ctx, viewport: pg.getViewport({ scale: (2 * canvas.width) / vp.width }) }).promise
const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
let transparent = 0, white = 0, black = 0
for (let i = 0; i < data.length; i += 4) {
  if (data[i+3] < 255) transparent++
  else if (data[i] > 250 && data[i+1] > 250 && data[i+2] > 250) white++
  else if (data[i] < 50 && data[i+1] < 50 && data[i+2] < 50) black++
}
console.log('node(napi canvas): 透明=' + transparent, '不透明白=' + white, '不透明黑/墨=' + black, '总=' + (canvas.width*canvas.height))
// 直接看 (0,0)
console.log('(0,0) RGBA =', data[0], data[1], data[2], data[3])
await task.destroy()
