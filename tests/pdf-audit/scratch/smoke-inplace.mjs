/**
 * 冒烟：pdfInPlaceReplace.replacePdfText 在 Node 下能否真实跑通（纯 ASCII → 矢量路径）。
 * 只做「能跑通 + 页数不变 + 输出是合法 PDF」的粗检；逐页字节比对见 pdf-byte-diff.mjs。
 *
 * 运行：
 *   node --experimental-loader=./tests/loader.mjs --experimental-strip-types \
 *        tests/pdf-audit/scratch/smoke-inplace.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import { replacePdfText } from '../../../src/renderer/src/utils/pdfInPlaceReplace.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const SRC = join(ROOT, 'tests', 'pdf-audit', 'fixtures', 'enhance-source.pdf')
const OUT_DIR = join(HERE, 'out')

const sha = (b) => createHash('sha256').update(b).digest('hex')
const asciiHead = (b) => Buffer.from(b.subarray(0, 8)).toString('latin1')

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

await mkdir(OUT_DIR, { recursive: true })

const srcBytes = new Uint8Array(await readFile(SRC))
const srcDoc = await PDFDocument.load(srcBytes)
const srcPages = srcDoc.getPageCount()
const srcSize = srcDoc.getPage(0).getSize()

console.log('='.repeat(74))
console.log('冒烟：replacePdfText（ASCII → 矢量路径）')
console.log('='.repeat(74))
console.log('输入      : ' + SRC)
console.log('输入字节  : ' + srcBytes.length)
console.log('输入 sha  : ' + sha(srcBytes).slice(0, 16))
console.log('输入页数  : ' + srcPages)
console.log('第1页尺寸 : ' + srcSize.width + ' x ' + srcSize.height + ' pt')
console.log('前8字节   : ' + JSON.stringify(asciiHead(srcBytes)))

const reps = [
  {
    page: 0,
    rect: { x: 72, y: 700, width: 160, height: 12 },
    baseline: 703,
    fontSize: 12,
    color: { r: 0, g: 0, b: 0 },
    bgColor: { r: 1, g: 1, b: 1 },
    align: 'left',
    newText: 'REPLACED-2026'
  }
]

const t0 = Date.now()
const outBytes = await replacePdfText(srcBytes, reps)
const ms = Date.now() - t0

console.log('\n--- 输出 ---')
console.log('输出字节  : ' + outBytes.length)
console.log('输出 sha  : ' + sha(outBytes).slice(0, 16))
console.log('前8字节   : ' + JSON.stringify(asciiHead(outBytes)))
console.log('耗时      : ' + ms + 'ms')

const outDoc = await PDFDocument.load(outBytes)
const outPages = outDoc.getPageCount()
const outSize = outDoc.getPage(0).getSize()
console.log('输出页数  : ' + outPages)
console.log('第1页尺寸 : ' + outSize.width + ' x ' + outSize.height + ' pt')

await writeFile(join(OUT_DIR, 'smoke-out.pdf'), outBytes)

console.log('\n--- 断言 ---')
check('输出以 %PDF- 开头', asciiHead(outBytes).startsWith('%PDF-'), JSON.stringify(asciiHead(outBytes)))
check('页数不变', outPages === srcPages, srcPages + ' → ' + outPages)
check('第1页 MediaBox 不变', outSize.width === srcSize.width && outSize.height === srcSize.height)
check('输出可被 pdf-lib 重新解析', outBytes.length > 1000, outBytes.length + ' 字节')

console.log('\n' + '='.repeat(74))
console.log('汇总: ' + pass + ' 项通过, ' + fail + ' 项失败')
console.log('='.repeat(74))
process.exit(fail ? 1 : 0)
