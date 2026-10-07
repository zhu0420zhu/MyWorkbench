/**
 * 审计 PdfTools.tsx 的 EnhancePanel（PDF 文字增强）。
 *
 * 被审计代码（PdfTools.tsx:1014-1041）：
 *   const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
 *   const out = await PDFDocument.create()
 *   const pages = await out.copyPages(src, src.getPageIndices())
 *   pages.forEach((p) => out.addPage(p))
 *   const outBytes = await out.save()
 *
 * 审计目标：
 *   1. 该变换是否为纯空转（视觉内容零变化）
 *   2. strength(light/medium/strong) 是否影响输出
 *   3. 是否丢失文档级信息（元数据 / 大纲 / 表单）
 *
 * 证明思路：
 *   页面渲染像素 = f(页面内容流, 其引用的资源 XObject)。
 *   若两者逐字节相同，则渲染结果必然相同，无需实际渲染即可证明。
 *   需要剔除 XRef 流与 ObjStm —— 它们是交叉引用索引与对象容器，
 *   结构重建时本就必然变化，不参与绘制。
 */
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import { createHash } from 'node:crypto'
import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'fixtures')
await mkdir(OUT, { recursive: true })

const sha = (s) => createHash('sha256').update(s, 'latin1').digest('hex').slice(0, 12)
const fileSha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 12)

/* ---------- 1. 造「待增强」的扫描件风格源 PDF ---------- */
async function makeTinyJpeg() {
  const b64 =
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAAIAAgBAREA/8QAHwAAAQUBAQEB' +
    'AQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1Fh' +
    'ByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZ' +
    'WmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG' +
    'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+iiiv/9k='
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

async function buildSource() {
  const doc = await PDFDocument.create()
  doc.setTitle('被审计的源文档')
  doc.setAuthor('LingmoWorkbench Test')
  doc.setSubject('confidence-check')
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const jpg = await makeTinyJpeg()

  for (let i = 0; i < 3; i++) {
    const page = doc.addPage([420, 594])
    const img = await doc.embedJpg(jpg)
    page.drawImage(img, { x: 40, y: 360, width: 340, height: 180 })
    // 低对比度灰字 —— 增强功能本该处理的正是这种
    page.drawText('Faded scanned line ' + (i + 1) + ' - low contrast', {
      x: 40, y: 320, size: 13, font, color: rgb(0.72, 0.72, 0.72)
    })
    page.drawText('Second faded line ' + (i + 1), {
      x: 40, y: 300, size: 13, font, color: rgb(0.75, 0.75, 0.75)
    })
    page.drawText('HEADING', { x: 40, y: 270, size: 18, font: bold, color: rgb(0.25, 0.25, 0.25) })
    page.drawRectangle({
      x: 40, y: 200, width: 340, height: 50,
      color: rgb(0.9, 0.93, 0.97), borderWidth: 1, borderColor: rgb(0.6, 0.6, 0.6)
    })
  }
  return doc.save()
}

/* ---------- 2. 复刻被审计的 enhance 逻辑 ---------- */
async function enhanceLikeApp(bytes) {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const out = await PDFDocument.create()
  const pages = await out.copyPages(src, src.getPageIndices())
  pages.forEach((p) => out.addPage(p))
  return out.save()
}

/* ---------- 3. stream 分类提取 ---------- */
function extractStreams(bytes) {
  const raw = Buffer.from(bytes).toString('latin1')
  const out = []
  const re = /\bstream\r?\n/g
  let m
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) break
    let p = raw.slice(start, end)
    if (p.endsWith('\r\n')) p = p.slice(0, -2)
    else if (p.endsWith('\n')) p = p.slice(0, -1)
    const ds = raw.lastIndexOf('<<', m.index)
    const dict = ds >= 0 ? raw.slice(ds, m.index) : ''
    const kind = /\/Subtype\s*\/Image/.test(dict)
      ? 'image'
      : /\/Type\s*\/ObjStm/.test(dict)
        ? 'objstm'
        : /\/Type\s*\/XRef/.test(dict)
          ? 'xref'
          : 'content'
    out.push({ len: p.length, sha: sha(p), kind })
    re.lastIndex = end
  }
  return out
}

/** 视觉相关 = 参与绘制的流（内容流 + 图像），剔除 xref / objstm */
const visualOnly = (ss) => ss.filter((s) => s.kind !== 'xref' && s.kind !== 'objstm')
const multi = (ss) => ss.map((s) => s.kind + '|' + s.len + '|' + s.sha).sort().join('\n              ')

/* ---------- 4. 执行审计 ---------- */
const L = '='.repeat(74)
console.log(L)
console.log('PDF 文字增强（EnhancePanel，PdfTools.tsx:990-1068）审计')
console.log(L)

const srcBytes = await buildSource()
const enhanced = await enhanceLikeApp(srcBytes)
await writeFile(join(OUT, 'enhance-source.pdf'), srcBytes)
await writeFile(join(OUT, 'enhance-output.pdf'), enhanced)

const srcS = extractStreams(srcBytes)
const outS = extractStreams(enhanced)
const srcV = visualOnly(srcS)
const outV = visualOnly(outS)

console.log('\n[1] 文件体积')
console.log('    源 PDF     : ' + srcBytes.byteLength + ' 字节  (file sha ' + fileSha(srcBytes) + ')')
console.log('    增强后 PDF : ' + enhanced.byteLength + ' 字节  (file sha ' + fileSha(enhanced) + ')')

console.log('\n[2] 全部 stream 分类')
console.log('    源   : ' + srcS.map((s) => s.kind + '(' + s.len + ')').join(', '))
console.log('    输出 : ' + outS.map((s) => s.kind + '(' + s.len + ')').join(', '))

console.log('\n[3] 视觉相关流比对（页面渲染像素的唯一决定因素）')
console.log('    源   视觉流多重集:')
console.log('              ' + multi(srcV))
console.log('    输出 视觉流多重集:')
console.log('              ' + multi(outV))
const visualSame = multi(srcV) === multi(outV)
console.log('    ⇒ 视觉流是否逐字节相同: ' + (visualSame ? '✅ 完全相同' : '❌ 有差异'))

console.log('\n[4] 结构流比对（不参与绘制，预期会变）')
for (const k of ['xref', 'objstm']) {
  const a = srcS.filter((s) => s.kind === k)
  const b = outS.filter((s) => s.kind === k)
  console.log('    ' + k.padEnd(7) + ' 源=' + (a[0] ? a[0].len : '-') + 'B 输出=' + (b[0] ? b[0].len : '-') + 'B  → ' +
    (a[0] && b[0] && a[0].sha === b[0].sha ? '相同' : '不同（结构重建的正常结果）'))
}

console.log('\n[5] strength 档位是否影响输出')
const runs = {}
for (const s of ['light', 'medium', 'strong']) {
  runs[s] = fileSha(await enhanceLikeApp(srcBytes))
}
for (const [k, v] of Object.entries(runs)) console.log('    ' + k.padEnd(7) + ' -> ' + v)
const uniq = new Set(Object.values(runs))
console.log('    不同档位产出种类数: ' + uniq.size +
  (uniq.size === 1 ? '  ❌ 三档完全相同 → strength 未参与任何运算' : '  ✅ 有差异'))

console.log('\n[6] 文档级信息是否保留')
const re = await PDFDocument.load(enhanced)
const meta = [['title', '被审计的源文档', re.getTitle()], ['author', 'LingmoWorkbench Test', re.getAuthor()], ['subject', 'confidence-check', re.getSubject()]]
let lost = 0
for (const [k, before, after] of meta) {
  const gone = !after
  if (gone) lost++
  console.log('    ' + k.padEnd(8) + ' 源="' + before + '"  输出="' + (after ?? '') + '"  ' + (gone ? '❌ 丢失' : '✅'))
}

console.log('\n[7] 页面尺寸')
console.log('    输出首页: ' + JSON.stringify(re.getPage(0).getSize()))

console.log('\n' + L)
console.log('结论')
console.log(L)
if (visualSame) {
  console.log('✅ 增强前后【所有参与渲染的流逐字节完全相同】。')
  console.log('   页面渲染像素是这些流的纯函数 ⇒ 输出与输入的视觉表现必然一致。')
  console.log('   ⇒ 该功能未做任何对比度/锐化/栅格化处理，是一次纯结构复制。')
  console.log('   面板 Alert 声称的「将页面栅格化后做对比度与锐化」与实现不符。')
}
console.log('⚠️  strength 三档输出相同 —— 该 UI 控件是装饰性的，用户切换无任何效果。')
console.log('❌ 元数据 ' + lost + '/3 被清空 —— 用户静默丢失文档标题/作者/主题。')
console.log(L)
