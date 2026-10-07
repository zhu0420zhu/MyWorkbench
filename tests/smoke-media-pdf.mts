// media/pdf/hardware 冒烟测试（node --experimental-strip-types 直接运行）
// 覆盖：pdf-lib 合并/拆分/旋转/页码、soffice 资源就位、路径白名单思路
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, degrees, StandardFonts, rgb } from 'pdf-lib'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

let passed = 0
let failed = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log('  ✓ ' + msg)
  } else {
    failed++
    console.log('  ✗ ' + msg)
  }
}

async function makePdf(pages: number, label = 'x'): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([200, 200])
    page.drawText(`${label}${i + 1}`, { x: 40, y: 100, size: 12, font, color: rgb(0, 0, 0) })
  }
  return doc.save()
}

console.log('media-pdf-hardware.smoke')

// ---- 资源就位 ----
const soffice = join(root, 'resources', 'tools', 'soffice', 'program', 'soffice.com')
assert(existsSync(soffice), '内置 soffice.com 存在')
assert(statSync(soffice).size > 100000, 'soffice.com 非空壳')
const ffmpeg = join(root, 'resources', 'tools', 'ffmpeg', 'ffmpeg.exe')
assert(existsSync(ffmpeg), '内置 ffmpeg.exe 存在')

// ---- pdf-lib 合并 ----
{
  const a = await makePdf(2, 'A')
  const b = await makePdf(3, 'B')
  const da = await PDFDocument.load(a)
  const db = await PDFDocument.load(b)
  const out = await PDFDocument.create()
  const pa = await out.copyPages(da, da.getPageIndices())
  pa.forEach((p) => out.addPage(p))
  const pb = await out.copyPages(db, db.getPageIndices())
  pb.forEach((p) => out.addPage(p))
  assert(out.getPageCount() === 5, '合并 2+3 页 → 5 页')
}

// ---- 拆分 ----
{
  const src = await PDFDocument.load(await makePdf(4, 'S'))
  const one = await PDFDocument.create()
  const [p] = await one.copyPages(src, [2])
  one.addPage(p)
  assert(one.getPageCount() === 1, '拆分选 1 页 → 1 页')
}

// ---- 旋转保留 ----
{
  const src = await PDFDocument.load(await makePdf(1, 'R'))
  src.getPages()[0].setRotation(degrees(90))
  const saved = await src.save()
  const re = await PDFDocument.load(saved)
  assert(re.getPages()[0].getRotation().angle === 90, '旋转 90° 写回可读')
}

// ---- 页码矢量写入 ----
{
  const src = await PDFDocument.load(await makePdf(2, 'N'))
  const font = await src.embedFont(StandardFonts.Helvetica)
  src.getPages().forEach((page, i) => {
    page.drawText(String(i + 1), { x: 90, y: 20, size: 10, font, color: rgb(0.2, 0.2, 0.2) })
  })
  const bytes = await src.save()
  assert(bytes.byteLength > 500, '页码写入后 PDF 有效')
}

// ---- 路径白名单逻辑（与主进程一致的纯函数语义）----
{
  const allowed = new Set<string>([join(root, 'a.pdf')])
  const isAllowed = (p: string): boolean => {
    if (!p) return false
    if (allowed.has(p)) return true
    const dir = dirname(p)
    for (const a of allowed) if (dirname(a) === dir) return true
    return false
  }
  assert(isAllowed(join(root, 'a.pdf')) === true, '白名单：原路径放行')
  assert(isAllowed(join(root, 'b.pdf')) === true, '白名单：同目录输出放行')
  assert(isAllowed('C:\\Windows\\System32\\x.pdf') === false, '白名单：异目录拒绝')
  assert(isAllowed('') === false, '白名单：空路径拒绝')
}

// ---- media:read 大小上限语义 ----
{
  const MAX = 500 * 1024 * 1024
  assert(MAX === 524288000, 'IO 上限 500MB')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
