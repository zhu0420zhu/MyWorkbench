/**
 * 把生成的 PDF 第 1 页光栅化为 PNG，用于肉眼确认中文字形正常（不是豆腐块）。
 * 运行：node tests/pdf-audit/scratch/render-pdf-png.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodeRender } from '../lib/node-render-backend.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const targets = [
  ['docs-html2pdf-e2e.pdf', 'docs-html2pdf-e2e-page1.png'],
  ['docs-html2pdf-fragment.pdf', 'docs-html2pdf-fragment-page1.png']
]

for (const [src, out] of targets) {
  const bytes = readFileSync(join(here, 'qa-work', src))
  const rendered = await nodeRender(bytes, [0], { scale: 2, maxSide: 1400 })
  const png = join(here, 'qa-work', out)
  writeFileSync(png, rendered[0].canvas.toBuffer('image/png'))
  console.log(`${src} → ${png}  (${rendered[0].canvas.width}x${rendered[0].canvas.height})`)
}
