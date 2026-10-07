/**
 * 把 PDF 指定页渲染成 PNG，用于肉眼核对「保版式改字」后的实际观感。
 * 用法：node tests/pdf-audit/scratch/render-pages.mjs <pdf> <page1based> <outPng> [scale]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodeRender } from '../lib/node-render-backend.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const [pdf, pageNo, outName, scaleArg] = process.argv.slice(2)
const bytes = readFileSync(pdf)
const rendered = await nodeRender(bytes, [Number(pageNo) - 1], { scale: Number(scaleArg) || 2, maxSide: 1600 })
const out = join(here, 'out', outName)
writeFileSync(out, rendered[0].canvas.toBuffer('image/png'))
console.log(pdf + ' 第' + pageNo + '页 → ' + out + '  (' + rendered[0].canvas.width + 'x' + rendered[0].canvas.height + ')')
