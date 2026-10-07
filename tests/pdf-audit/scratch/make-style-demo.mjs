/**
 * 生成一张「样式 + 批注」总览页，供肉眼核对（不是断言，断言在
 * verify-inplace-style.mjs / verify-inplace-annot.mjs 里）。
 *
 * 运行：node --experimental-loader=./tests/loader.mjs --experimental-strip-types \
 *       tests/pdf-audit/scratch/make-style-demo.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')

globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error('替身未实现 createElement: ' + tag)
    const c = createCanvas(1, 1)
    c.toBlob = (cb, type) => {
      try {
        cb(new Blob([c.toBuffer(type || 'image/png')], { type: type || 'image/png' }))
      } catch {
        cb(null)
      }
    }
    return c
  }
}

const { replacePdfText } = await import('../../../src/renderer/src/utils/pdfInPlaceReplace.ts')
const srcBytes = new Uint8Array(await readFile(join(OUT, 'zh-edit-src.pdf')))
await mkdir(OUT, { recursive: true })

const base = {
  page: 0,
  fontSize: 12,
  color: { r: 0, g: 0, b: 0 },
  bgColor: { r: 1, g: 1, b: 1 },
  align: 'left'
}

const reps = [
  // ① 矢量路径：红色 + 粗体 + 斜体 + 下划线
  { ...base, rect: { x: 62.8, y: 697.899, width: 65.844, height: 12 }, baseline: 700.539,
    newText: 'RED-BOLD-ITALIC-UNDERLINE', fontSize: 14, bold: true, italic: true, underline: true,
    color: { r: 0.84, g: 0.1, b: 0.12 } },
  // ② 栅格路径（中文）：蓝色 + 粗体 + 下划线 + 指定字体族
  { ...base, rect: { x: 62.8, y: 669.989, width: 113.9, height: 12 }, baseline: 672.389,
    newText: '蓝色粗体下划线样式', fontSize: 14, bold: true, underline: true,
    fontFamily: 'Microsoft YaHei', color: { r: 0.09, g: 0.32, b: 0.85 } }
]

const annotations = [
  // ③ highlight（默认 0.35）
  { page: 0, rect: { x: 62.8, y: 638.849, width: 336, height: 15 }, kind: 'highlight',
    color: { r: 1, g: 0.92, b: 0.23 } },
  // ④ underline 注解：贴该行底边
  { page: 0, rect: { x: 62.8, y: 638.849, width: 336, height: 15 }, kind: 'underline',
    color: { r: 0.85, g: 0.2, b: 0.55 } },
  // ⑤ box 注解：框住上面那条矢量替换
  { page: 0, rect: { x: 60.8, y: 695.899, width: 172, height: 16 }, kind: 'box',
    color: { r: 0.1, g: 0.55, b: 0.35 } },
  // ⑥ note 注解（中文便签）
  { page: 0, rect: { x: 200, y: 669.989, width: 30, height: 12 }, kind: 'note',
    color: { r: 0.95, g: 0.6, b: 0.1 }, text: '此处需复核签署日期' },
  // ⑦ strike 注解
  { page: 0, rect: { x: 230, y: 753.189 - 2.4, width: 120, height: 20 }, kind: 'strike',
    color: { r: 0.9, g: 0.15, b: 0.15 } }
]

const out = await replacePdfText(srcBytes, reps, annotations)
const file = join(OUT, 'style-demo.pdf')
await writeFile(file, out)
console.log('demo: ' + file + '  (' + out.length + ' 字节)')
