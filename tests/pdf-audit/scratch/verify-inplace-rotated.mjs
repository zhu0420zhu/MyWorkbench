/**
 * 旋转页（/Rotate 90）实测：就地改字在旋转页上到底能不能对齐。
 *
 * 做法：先把样本第 1 页设成 /Rotate 90（只改页面属性，不动内容流），
 * 再用 pdf.js 抽几何（item.transform 是**未旋转的用户坐标**），做一条
 * ASCII 替换，最后把改前/改后渲染成 PNG 供肉眼比对。
 *
 * 运行：node --experimental-loader=./tests/loader.mjs --experimental-strip-types \
 *       tests/pdf-audit/scratch/verify-inplace-rotated.mjs
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument, degrees } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const OUT = join(HERE, 'out')
const SRC = join(OUT, 'zh-edit-src.pdf')

globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error('替身未实现 createElement: ' + tag)
    const c = createCanvas(1, 1)
    c.toBlob = (cb, type) => cb(new Blob([c.toBuffer(type || 'image/png')], { type: type || 'image/png' }))
    return c
  }
}
const { replacePdfText } = await import('../../../src/renderer/src/utils/pdfInPlaceReplace.ts')

const KW = {
  isEvalSupported: false,
  disableFontFace: true,
  standardFontDataUrl: join(ROOT, 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/',
  cMapUrl: join(ROOT, 'node_modules', 'pdfjs-dist', 'cmaps') + '/',
  cMapPacked: true
}

/* 1) 造一份「第 1 页旋转 90 度」的样本 */
const srcBytes = new Uint8Array(await readFile(SRC))
const rotDoc = await PDFDocument.load(srcBytes)
rotDoc.getPage(0).setRotation(degrees(90))
const rotBytes = await rotDoc.save({ useObjectStreams: false })
const ROT_SRC = join(OUT, 'rot90-src.pdf')
await writeFile(ROT_SRC, rotBytes)
console.log('旋转样本: ' + ROT_SRC + ' (' + rotBytes.length + ' 字节)')

/* 2) pdf.js 抽几何（注意：/Rotate 不改变 item.transform 的坐标系） */
const task0 = pdfjs.getDocument({ data: new Uint8Array(rotBytes), ...KW })
const doc0 = await task0.promise
const page0 = await doc0.getPage(1)
const content = await page0.getTextContent()
const item = content.items.find((x) => 'str' in x && x.str.includes('DRAFT-2026'))
console.log('第1页 /Rotate = ' + page0.rotate + '  viewport = ' +
  Math.round(page0.getViewport({ scale: 1 }).width) + 'x' + Math.round(page0.getViewport({ scale: 1 }).height))
console.log('原文字 transform = [' + item.transform.map((v) => Number(v.toFixed(3))).join(', ') + ']')
await task0.destroy()

const rep = {
  page: 0,
  rect: {
    x: Number(item.transform[4].toFixed(3)),
    y: Number((item.transform[5] - item.height * 0.22).toFixed(3)),
    width: Number(item.width.toFixed(3)),
    height: Math.abs(item.transform[3])
  },
  baseline: item.transform[5],
  fontSize: Math.abs(item.transform[3]),
  color: { r: 0, g: 0, b: 0 },
  bgColor: { r: 1, g: 1, b: 1 },
  align: 'left',
  newText: 'ROTATED-OK'
}
console.log('替换: ' + JSON.stringify(rep))

const out = await replacePdfText(rotBytes, [rep])
const ROT_OUT = join(OUT, 'rot90-out.pdf')
await writeFile(ROT_OUT, out)

/* 3) 文本层核对 */
async function textOf(bytes) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), ...KW })
  const doc = await task.promise
  const page = await doc.getPage(1)
  const c = await page.getTextContent()
  const it = c.items.find((x) => 'str' in x && x.str.includes('ROTATED-OK'))
  const res = {
    text: c.items.filter((x) => 'str' in x).map((x) => x.str).join(''),
    newItem: it ? { x: it.transform[4], baseline: it.transform[5], size: Math.abs(it.transform[3]) } : null,
    rotate: page.rotate
  }
  await task.destroy()
  return res
}
const t = await textOf(out)
console.log('\n产物文本层: ' + JSON.stringify(t.text))
console.log('新文字几何: ' + JSON.stringify(t.newItem))
console.log('新文字是否可提取 = ' + (t.newItem ? '是' : '否'))
console.log('baseline 是否与原文一致 = ' + (t.newItem && Math.abs(t.newItem.baseline - rep.baseline) < 0.01))
console.log('产物: ' + ROT_OUT)
