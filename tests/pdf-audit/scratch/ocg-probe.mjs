/**
 * 路线 B 前提实测：pdf.js 的 getTextContent() 是否返回「被关闭的可选内容组（OCG）」里的文字？
 * 同时检查页面渲染是否跳过它。
 */
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

async function build(mode) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([595.28, 841.89])
  page.node.setFontDictionary(PDFName.of('F1'), font.ref)

  const ops =
    `BT /F1 14 Tf 1 0 0 1 60 700 Tm (VISIBLE-AAA) Tj ET\n` +
    `/OC /MC0 BDC\n` +
    `BT /F1 14 Tf 1 0 0 1 60 650 Tm (HIDDEN-BBB) Tj ET\n` +
    `EMC\n`

  const streamRef = doc.context.register(doc.context.flateStream(Buffer.from(ops, 'latin1')))
  page.node.set(PDFName.of('Contents'), streamRef)

  // 资源里登记可选内容组
  const ocg = doc.context.obj({ Type: 'OCG', Name: PDFString.of('probe') })
  const ocgRef = doc.context.register(ocg)
  const ocgsArr = doc.context.obj([ocgRef])
  page.node.Resources().set(PDFName.of('Properties'), doc.context.obj({ MC0: ocgRef }))

  const d = doc.context.obj({})
  if (mode === 'off') d.set(PDFName.of('OFF'), ocgsArr)
  else d.set(PDFName.of('ON'), ocgsArr)
  d.set(PDFName.of('Order'), ocgsArr)
  const ocProps = doc.context.obj({})
  ocProps.set(PDFName.of('OCGs'), ocgsArr)
  ocProps.set(PDFName.of('D'), d)
  doc.catalog.set(PDFName.of('OCProperties'), ocProps)

  return await doc.save({ useObjectStreams: false })
}

async function probe(bytes, label) {
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: join(ROOT, 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/',
    cMapUrl: join(ROOT, 'node_modules', 'pdfjs-dist', 'cmaps') + '/',
    cMapPacked: true,
    disableWorker: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0
  })
  const pdf = await task.promise
  const p = await pdf.getPage(1)
  const tc = await p.getTextContent()
  const text = tc.items.map((it) => it.str).join('')
  const opList = await p.getOperatorList()
  console.log(`[${label}] getTextContent = ${JSON.stringify(text)}`)
  console.log(`[${label}] getOperatorList fnArray 长度 = ${opList.fnArray.length}`)
  if (task.destroy) await task.destroy()
  return text
}

const off = await build('off')
const on = await build('on')
await writeFile(join(HERE, 'ocg-off.pdf'), off)
await writeFile(join(HERE, 'ocg-on.pdf'), on)

const tOff = await probe(off, 'OCG-OFF（默认关闭）')
const tOn = await probe(on, 'OCG-ON（默认打开）')
console.log('\n结论：OCG 关闭时 pdf.js 文本提取' + (tOff.includes('HIDDEN-BBB') ? '**仍然包含** HIDDEN-BBB → 路线 B 的文本层前提不成立' : '不含 HIDDEN-BBB'))
console.log('对照：OCG 打开时' + (tOn.includes('HIDDEN-BBB') ? '包含' : '不含') + ' HIDDEN-BBB')
