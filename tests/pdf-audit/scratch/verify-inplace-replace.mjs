/**
 * 功能验收：pdfInPlaceReplace.replacePdfText 的两条渲染路径。
 *   ① 纯 ASCII 新文字 → StandardFonts 矢量路径（应能被 pdf.js 提取到）
 *   ② 中文新文字     → canvas 栅格化 + 嵌入 PNG（**不进文本层**，这是预期取舍）
 *
 * canvas 替身说明（重要，别当成端到端）：
 *   生产环境走浏览器 canvas（Chromium）；Node 下没有 DOM，这里把
 *   document.createElement('canvas') 替换成 @napi-rs/canvas（pdfjs-dist 的
 *   传递依赖，未新增 npm 包），并补上它缺失的 toBlob（用 toBuffer 包一个 Blob）。
 *   替身验证的是：调用链路、参数传递、对齐/基线换算、嵌入与绘制指令是否正确；
 *   它**没有**验证 Chromium 上的字体度量与真实 canvas 行为 —— 后者由
 *   scratch/pdfEditProbe 的 Electron 探针负责。
 *
 * 运行：
 *   node --experimental-loader=./tests/loader.mjs --experimental-strip-types \
 *        tests/pdf-audit/scratch/verify-inplace-replace.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const OUT = join(HERE, 'out')
const SRC = join(OUT, 'zh-edit-src.pdf')
const DST = join(OUT, 'zh-edit-out.pdf')

/* ---------- canvas 替身（必须在调用 replacePdfText 前装好） ---------- */
function installCanvasShim() {
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') throw new Error('替身未实现 createElement: ' + tag)
      const c = createCanvas(1, 1)
      c.toBlob = (cb, type) => {
        try {
          cb(new Blob([c.toBuffer(type || 'image/png')], { type: type || 'image/png' }))
        } catch (e) {
          cb(null)
        }
      }
      return c
    }
  }
}
installCanvasShim()

const { replacePdfText } = await import('../../../src/renderer/src/utils/pdfInPlaceReplace.ts')

const sha = (b) => createHash('sha256').update(b).digest('hex')
const head8 = (b) => Buffer.from(b.subarray(0, 8)).toString('latin1')

let pass = 0
let fail = 0
function check(label, cond, detail = '') {
  if (cond) {
    pass++
    console.log('  ✅ ' + label + (detail ? '  → ' + detail : ''))
  } else {
    fail++
    console.log('  ❌ ' + label + (detail ? '  → ' + detail : ''))
  }
}

const PDFJS_KW = {
  isEvalSupported: false,
  disableFontFace: true,
  standardFontDataUrl: join(ROOT, 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/',
  cMapUrl: join(ROOT, 'node_modules', 'pdfjs-dist', 'cmaps') + '/',
  cMapPacked: true
}

async function readText(bytes) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), ...PDFJS_KW })
  const doc = await task.promise
  const perPage = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    perPage.push(content.items.filter((x) => 'str' in x).map((x) => x.str).join(''))
  }
  const pages = doc.numPages
  await task.destroy()
  return { pages, perPage }
}

/** 页面上的图片绘制（含合成后的 CTM），用于核对栅格文字的落位 */
async function imageDraws(bytes, pageNo) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), ...PDFJS_KW })
  const doc = await task.promise
  const page = await doc.getPage(pageNo)
  const ops = await page.getOperatorList()
  // cm 的合成：pdf-lib 的 drawImage 会拆成 translate(cm) + scale(cm) 两条，
  // 只看最后一条会读到单位矩阵，所以这里按 q/Q 栈真实合成 CTM。
  const mul = (m1, m2) => [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5]
  ]
  const out = []
  const stack = [[1, 0, 0, 1, 0, 0]]
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]
    if (fn === pdfjs.OPS.save) stack.push(stack[stack.length - 1].slice())
    else if (fn === pdfjs.OPS.restore && stack.length > 1) stack.pop()
    else if (fn === pdfjs.OPS.transform) {
      const t = ops.argsArray[i].slice(0, 6).map(Number)
      stack[stack.length - 1] = mul(t, stack[stack.length - 1])
    } else if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject) {
      out.push({ name: ops.argsArray[i][0], ctm: stack[stack.length - 1].slice() })
    }
  }
  const pages = doc.numPages
  await task.destroy()
  return { pages, draws: out }
}

const srcBytes = new Uint8Array(await readFile(SRC))
const reps = JSON.parse(await readFile(join(OUT, 'candidate-reps.json'), 'utf8'))

const srcDoc = await PDFDocument.load(srcBytes)
const srcPages = srcDoc.getPageCount()

console.log('='.repeat(96))
console.log('功能验收：就地改字（ASCII 矢量 / 中文栅格）')
console.log('='.repeat(96))
console.log('样本      : ' + SRC + '  (' + srcBytes.length + ' 字节, ' + srcPages + ' 页, sha ' + sha(srcBytes).slice(0, 16) + ')')
console.log('替换清单  :')
for (const r of reps) {
  console.log(
    '  页' + (r.page + 1) + ' rect=(' + r.rect.x + ',' + r.rect.y + ',' + r.rect.width + 'x' + r.rect.height +
      ') baseline=' + r.baseline + ' size=' + r.fontSize + ' align=' + r.align +
      ' newText=' + JSON.stringify(r.newText) + '  路径=' + (/^[\x20-\x7e]*$/.test(r.newText) ? '矢量(ASCII)' : '栅格(非WinAnsi)')
  )
}

const t0 = Date.now()
const outBytes = await replacePdfText(srcBytes, reps)
const ms = Date.now() - t0
await mkdir(OUT, { recursive: true })
await writeFile(DST, outBytes)

const outDoc = await PDFDocument.load(outBytes)
const outPages = outDoc.getPageCount()

console.log('\n--- 产物 ---')
console.log('输出      : ' + DST)
console.log('字节       : ' + srcBytes.length + ' → ' + outBytes.length)
console.log('sha256     : ' + sha(outBytes))
console.log('前8字节    : ' + JSON.stringify(head8(outBytes)))
console.log('页数       : ' + srcPages + ' → ' + outPages)
console.log('耗时       : ' + ms + 'ms')

/* ---------- 文本层 ---------- */
const srcText = await readText(srcBytes)
const outText = await readText(outBytes)

console.log('\n--- 文本层（pdf.js getTextContent）---')
console.log('样本第1页: ' + JSON.stringify(srcText.perPage[0]))
console.log('产物第1页: ' + JSON.stringify(outText.perPage[0]))
console.log('样本第2页: ' + JSON.stringify(srcText.perPage[1]))
console.log('产物第2页: ' + JSON.stringify(outText.perPage[1]))
console.log('样本第3页: ' + JSON.stringify(srcText.perPage[2]))
console.log('产物第3页: ' + JSON.stringify(outText.perPage[2]))

/* ---------- 图片绘制（栅格文字）落位 ---------- */
const srcImgs = await imageDraws(srcBytes, 1)
const outImgs = await imageDraws(outBytes, 1)
console.log('\n--- 第1页图片绘制（cm 矩阵即为 drawImage 落位）---')
console.log('样本: ' + JSON.stringify(srcImgs.draws))
console.log('产物: ' + JSON.stringify(outImgs.draws))

/* ---------- 断言 ---------- */
console.log('\n' + '='.repeat(96))
console.log('断言')
console.log('='.repeat(96))

check('输出以 %PDF- 开头', head8(outBytes).startsWith('%PDF-'), JSON.stringify(head8(outBytes)))
check('页数不变', outPages === srcPages, srcPages + ' → ' + outPages)

check('① ASCII 新文字可被提取', outText.perPage[0].includes('FINAL-2026-APPROVED'),
  outText.perPage[0].includes('FINAL-2026-APPROVED') ? '命中 "FINAL-2026-APPROVED"' : '未命中')
check('① 原 ASCII 文字不再是页面唯一内容（仍留在文本层，见说明）',
  outText.perPage[0].includes('DRAFT-2026'),
  '原文字被覆盖矩形遮住，但内容流未改，故文本层仍能提取到 "DRAFT-2026"')
check('② 中文新文字不进文本层（栅格化预期行为）',
  !outText.perPage[0].includes('本合同已由双方于 2026 年 9 月 29 日签署并生效'),
  '文本层提取不到该中文串 = 符合栅格化取舍')
check('② 被替换掉的原中文行仍在文本层（同上，覆盖不改内容流）',
  outText.perPage[0].includes('本合同自双方签字之日起生效'),
  '命中原文说明内容流未被改写')

check('第1页新增了一张图片（栅格化的中文）', outImgs.draws.length === srcImgs.draws.length + 1,
  srcImgs.draws.length + ' → ' + outImgs.draws.length)
const added = outImgs.draws.find((d) => !srcImgs.draws.some((s) => s.name === d.name))
if (added) {
  const m = added.ctm || []
  const rep = reps.find((r) => /[^\x20-\x7e]/.test(r.newText))
  const w = m[0]
  const h = m[3]
  const x = m[4]
  const y = m[5]
  console.log('\n新增图片 cm 矩阵: [' + m.map((v) => Number(v).toFixed(3)).join(', ') + ']')
  console.log('  → 左上角 x=' + x.toFixed(3) + '  y=' + y.toFixed(3) + '  宽=' + w.toFixed(3) + '  高=' + h.toFixed(3))
  console.log('  → 底部 y + 高 = ' + (y + h).toFixed(3) + '（应 ≈ 原基线 ' + rep.baseline + ' + 图片内基线偏移的补偿）')
  console.log('  → 期望 x = rect.x = ' + rep.rect.x)
  check('② 栅格图 x 对齐到 rect.x', Math.abs(x - rep.rect.x) < 0.5, '实测 ' + x.toFixed(3) + ' vs 期望 ' + rep.rect.x)
  check('② 栅格图底边 = 基线 - baselineFromBottom（即底边低于基线）', y < rep.baseline && y + h > rep.baseline,
    '底边 ' + y.toFixed(3) + ' < 基线 ' + rep.baseline + ' < 顶边 ' + (y + h).toFixed(3))
  check('② 栅格图宽度与字号同量级（未异常缩放）', w > rep.fontSize * 5 && w < rep.fontSize * 40,
    '宽 ' + w.toFixed(2) + 'pt，字号 ' + rep.fontSize + 'pt，原 rect 宽 ' + rep.rect.width)
} else {
  check('② 找到新增图片', false, '未找到新增图片')
}

/* 矢量文字的基线核对 */
{
  const task = pdfjs.getDocument({ data: new Uint8Array(outBytes), ...PDFJS_KW })
  const doc = await task.promise
  const page = await doc.getPage(1)
  const content = await page.getTextContent()
  const item = content.items.find((x) => 'str' in x && x.str.includes('FINAL-2026-APPROVED'))
  const rep = reps.find((r) => r.newText === 'FINAL-2026-APPROVED')
  if (item) {
    console.log('\n新 ASCII 文字的 pdf.js 几何: x=' + item.transform[4].toFixed(3) + ' baseline=' + item.transform[5].toFixed(3) +
      ' size=' + Math.abs(item.transform[3]).toFixed(3) + ' width=' + item.width.toFixed(3))
    check('① 新 ASCII 文字基线 = 原 baseline', Math.abs(item.transform[5] - rep.baseline) < 0.01,
      item.transform[5].toFixed(3) + ' vs ' + rep.baseline)
    check('① 新 ASCII 文字 x = rect.x（align=left）', Math.abs(item.transform[4] - rep.rect.x) < 0.01,
      item.transform[4].toFixed(3) + ' vs ' + rep.rect.x)
    check('① 新 ASCII 文字字号 = 原字号', Math.abs(Math.abs(item.transform[3]) - rep.fontSize) < 0.01,
      Math.abs(item.transform[3]).toFixed(3) + ' vs ' + rep.fontSize)
  } else {
    check('① 找到新 ASCII 文字的几何', false, '未找到')
  }
  await task.destroy()
}

console.log('\n' + '='.repeat(96))
console.log('汇总: ' + pass + ' 项通过, ' + fail + ' 项失败')
console.log('='.repeat(96))
process.exit(fail ? 1 : 0)
