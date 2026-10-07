/**
 * 生成 _gen-pdftools.ts：从 src/.../PdfTools.tsx 【原样抽取】两个未导出的编排函数
 *   enhancePdf()      —— 文字增强全流程
 *   applyTextStamp()  —— 水印/页眉页脚全流程
 * 并按函数名重导出，使 QA 能在无头环境驱动【真实函数体】而非复刻品。
 *
 * 之所以要抽取：这两个函数是 PdfTools.tsx 的模块私有函数（未 export），而 PdfTools.tsx
 * 是 React 组件文件，直接 import 会碰到 JSX / antd / React 与 Vite 专有的 `?worker` 导入。
 * 它们本身只依赖 pdf-lib 与已导出的工具函数，故按大括号配平「整段剪切」最忠实。
 *
 * 生成的 .ts 用 Node --experimental-strip-types 运行；类型名一律以 `type X = any`
 * 占位（strip-types 只做语法剥离、不做类型解析，不会报未定义类型）。
 * 渲染步骤 renderPdfPages 由 qa-render.mjs 提供等价实现（见该文件说明）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', '..', '..', 'src', 'renderer', 'src', 'pages', 'PdfTools.tsx')
const OUT = join(HERE, '_gen-pdftools.ts')

/** 跳字符串/注释：返回下一个未被引号/注释遮蔽的位置（用于稳健扫描） */
function skipNonCode(src, p) {
  const c = src[p]
  const n = src[p + 1]
  if (c === '/' && n === '/') {
    while (p < src.length && src[p] !== '\n') p++
    return p
  }
  if (c === '/' && n === '*') {
    p += 2
    while (p < src.length && !(src[p] === '*' && src[p + 1] === '/')) p++
    return p + 2
  }
  if (c === "'" || c === '"' || c === '`') {
    const q = c
    p++
    while (p < src.length) {
      if (src[p] === '\\') {
        p += 2
        continue
      }
      if (src[p] === q) return p + 1
      p++
    }
    return p
  }
  return -1
}

/** 从 src 中抽取 `async function <name>(` … 的完整函数文本（含函数体大括号） */
function extractFunction(src, name) {
  const sig = `async function ${name}(`
  const start = src.indexOf(sig)
  if (start < 0) throw new Error(`未找到函数 ${name}`)

  // 1) 配平参数括号，找到参数表结束
  let p = start + sig.length - 1 // 指向 '('
  let pdepth = 0
  for (; p < src.length; p++) {
    const skipped = skipNonCode(src, p)
    if (skipped >= 0) {
      p = skipped - 1
      continue
    }
    if (src[p] === '(') pdepth++
    else if (src[p] === ')') {
      pdepth--
      if (pdepth === 0) break
    }
  }

  // 2) 参数之后可能是返回类型（可能含 `{ }`，如 Promise<{...}>）；
  //    函数体大括号的特征是「前一个非空白字符是 ) 或 >」
  let bodyStart = -1
  let lastNonSpace = ''
  for (let q = p + 1; q < src.length; q++) {
    const skipped = skipNonCode(src, q)
    if (skipped >= 0) {
      const seg = src.slice(q, skipped)
      for (const ch of seg) if (!/\s/.test(ch)) lastNonSpace = ch
      q = skipped - 1
      continue
    }
    const ch = src[q]
    if (/\s/.test(ch)) continue
    if (ch === '{' && (lastNonSpace === ')' || lastNonSpace === '>')) {
      bodyStart = q
      break
    }
    lastNonSpace = ch
  }
  if (bodyStart < 0) throw new Error(`${name} 未找到函数体`)

  // 3) 配平函数体大括号
  let depth = 0
  for (let q = bodyStart; q < src.length; q++) {
    const skipped = skipNonCode(src, q)
    if (skipped >= 0) {
      q = skipped - 1
      continue
    }
    if (src[q] === '{') depth++
    else if (src[q] === '}') {
      depth--
      if (depth === 0) return src.slice(start, q + 1)
    }
  }
  throw new Error(`${name} 大括号未配平`)
}

const src = readFileSync(SRC, 'utf8')
const enhance = extractFunction(src, 'enhancePdf')
const stamp = extractFunction(src, 'applyTextStamp')

const header = `/**
 * 【自动生成，勿手改】由 tests/pdf-audit/qa/qa-gen-tools.mjs 从
 * src/renderer/src/pages/PdfTools.tsx 原样抽取。函数体与产品代码逐字节一致。
 */
import { PDFDocument, degrees, rgb, StandardFonts } from 'pdf-lib'
import { renderPdfPages } from './qa-render.mjs'
import { enhanceImageData, analyze, STRENGTH_PRESETS } from '../../../src/renderer/src/utils/pdfEnhance.ts'
import {
  createStampContext,
  parsePageRanges,
  expandPlaceholders,
  stampWatermarkTile,
  stampTextAtCenter,
  stampTextAuto
} from '../../../src/renderer/src/utils/pdfText.ts'

/* 类型占位：strip-types 只剥离语法、不解析类型，故 any 即可 */
type EnhanceStat = any
type EnhanceStrength = 'light' | 'medium' | 'strong'
type TextRenderMode = any
type TextStyle = any
type TextAlign = any
type Rgb = any
type StampKind = any
type WatermarkLayout = any
type StampOptions = any
type StampResult = any
type ImageStats = any

/* ==================== 以下为原样抽取 ==================== */

`

const footer = `\n\nexport { enhancePdf, applyTextStamp }\n`

writeFileSync(OUT, header + enhance + '\n\n' + stamp + footer, 'utf8')
console.log('已生成 ' + OUT)
console.log('enhancePdf   : ' + enhance.split('\n').length + ' 行')
console.log('applyTextStamp: ' + stamp.split('\n').length + ' 行')
