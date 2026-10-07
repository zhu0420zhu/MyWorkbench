/**
 * 「另存为」空内容守卫的**处理器级** e2e：真实加载 src/main/docsIpc.ts，
 * 真实调用 docs:save-as-format 处理器，验证：
 *   1. 空内容（含只有标签壳的 HTML）→ ok:false 且**一次都不弹保存对话框**；
 *   2. 有内容 → 照旧走到 showSaveDialog（未被误伤）；
 *   3. text 源导出 PDF 时 <、& 、换行不再破坏结构（产出 PDF 里能看到原字符）。
 *
 * 运行：
 *   node --experimental-loader=./tests/docs-save-guard-loader.mjs --experimental-strip-types tests/docs-save-as-empty-e2e.mjs
 */
import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { dialogCalls, dialogResponse, handlers } from './docs-save-guard-electron.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const OUT = join(HERE, 'pdf-audit', 'work', 'docs-save-guard')

const { registerDocsIpc } = await import('../src/main/docsIpc.ts')
registerDocsIpc()
const handler = handlers.get('docs:save-as-format')
if (!handler) throw new Error('docs:save-as-format 未注册')

await fs.mkdir(OUT, { recursive: true })

let pass = 0
let fail = 0
const check = (ok, label, detail) => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
}

const call = (payload) => handler({ sender: {} }, payload)

console.log('=== 1) 空内容必须被拦下，且不得弹保存对话框 ===')
const EMPTY_CASES = [
  { label: 'pdf / html / ""', payload: { source: 'html', content: '', format: 'pdf', defaultName: 'a.md' } },
  { label: 'pdf / html / "   "', payload: { source: 'html', content: '   ', format: 'pdf', defaultName: 'a.md' } },
  { label: 'pdf / html / "<p><br></p>"', payload: { source: 'html', content: '<p><br></p>', format: 'pdf', defaultName: 'a.md' } },
  { label: 'pdf / html / "<br>"', payload: { source: 'html', content: '<br>', format: 'pdf', defaultName: 'a.md' } },
  { label: 'pdf / html / "<div>&nbsp;</div>"', payload: { source: 'html', content: '<div>&nbsp;</div>', format: 'pdf', defaultName: 'a.md' } },
  { label: 'pdf / html / "<p>&#160;</p>"', payload: { source: 'html', content: '<p>&#160;</p>', format: 'pdf', defaultName: 'a.md' } },
  { label: 'pdf / html / "<style>p{color:red}</style>"', payload: { source: 'html', content: '<style>p{color:red}</style>', format: 'pdf', defaultName: 'a.md' } },
  { label: 'pdf / text / "\\n\\t"', payload: { source: 'text', content: '\n\t', format: 'pdf', defaultName: 'a.txt' } },
  { label: 'html / html / ""', payload: { source: 'html', content: '', format: 'html', defaultName: 'a.md' } },
  { label: 'htm / html / "<p>  </p>"', payload: { source: 'html', content: '<p>  </p>', format: 'htm', defaultName: 'a.md' } }
]
for (const c of EMPTY_CASES) {
  const before = dialogCalls.length
  const r = await call(c.payload)
  const ok = r.ok === false && /没有可导出的内容/.test(r.error ?? '') && dialogCalls.length === before
  check(ok, c.label, `→ ${JSON.stringify(r)}  对话框调用增量=${dialogCalls.length - before}`)
}

console.log('\n=== 2) 有内容不得被误伤（仍应走到 showSaveDialog，此处置为取消）===')
const NON_EMPTY_CASES = [
  { label: 'pdf / html / "<p>正文</p>"', payload: { source: 'html', content: '<p>正文</p>', format: 'pdf', defaultName: 'a.md' } },
  { label: 'pdf / html / "<p>中文&nbsp;正文</p>"', payload: { source: 'html', content: '<p>中文&nbsp;正文</p>', format: 'pdf', defaultName: 'a.md' } },
  { label: 'html / html / "<p>正文</p>"', payload: { source: 'html', content: '<p>正文</p>', format: 'html', defaultName: 'a.md' } },
  { label: 'txt / text / "正常文字"（未加守卫，行为不变）', payload: { source: 'text', content: '正常文字', format: 'txt', defaultName: 'a.md' } }
]
for (const c of NON_EMPTY_CASES) {
  const before = dialogCalls.length
  const r = await call(c.payload)
  const delta = dialogCalls.length - before
  const ok = r.ok === false && (r.error === 'cancelled' || r.error === '成功') && delta === 1
  check(ok, c.label, `→ ${JSON.stringify(r)}  对话框调用增量=${delta}`)
}

console.log('\n=== 3) source=text 导出 PDF：<、&、换行必须原样保留 ===')
const outPdf = join(OUT, 'text-source.pdf')
await fs.rm(outPdf, { force: true })
dialogResponse.value = { canceled: false, filePath: outPdf }
const LINES = ['第一行 <b>加粗</b> & 符号', '第二行用来看换行', '', '第四行']
const r3 = await call({
  source: 'text',
  content: LINES.join('\n'),
  format: 'pdf',
  defaultName: 'plain.txt'
})
check(r3.ok === true, 'text→pdf 返回 ok:true', JSON.stringify(r3))

let extracted = ''
if (r3.ok) {
  const task = pdfjs.getDocument({
    data: new Uint8Array(await fs.readFile(outPdf)),
    standardFontDataUrl: join(ROOT, 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/',
    cMapUrl: join(ROOT, 'node_modules', 'pdfjs-dist', 'cmaps') + '/',
    cMapPacked: true,
    useSystemFonts: false,
    isEvalSupported: false
  })
  const pdf = await task.promise
  const pages = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i)
    pages.push((await p.getTextContent()).items.map((it) => it.str).join(''))
  }
  await task.destroy()
  extracted = pages.join('\n')
  console.log(`   字节=${(await fs.stat(outPdf)).size} 页数=${pdf.numPages}`)
  console.log(`   提取内容=${JSON.stringify(extracted)}`)
  check(extracted.includes('<b>加粗</b>'), '字面量 <b>...</b> 未被当标签吞掉')
  check(extracted.includes('&'), '字面量 & 未被转义破坏')
  check(extracted.includes('第一行') && extracted.includes('第二行'), '多行内容都保留')
}

// 复位对话框替身：第 3 组为了落盘把返回值改成了真实路径，后续所有用例必须回到「用户取消」
dialogResponse.value = { canceled: true, filePath: undefined }

console.log('\n=== 4) Pandoc 系（docx/odt/rtf/epub）空内容必须被拦下且不弹对话框 ===')
const PANDOC_EMPTY = []
for (const format of ['docx', 'odt', 'rtf', 'epub']) {
  PANDOC_EMPTY.push({ label: `${format} / html / "<p><br></p>"`, payload: { source: 'html', content: '<p><br></p>', format, defaultName: 'a.md' } })
  PANDOC_EMPTY.push({ label: `${format} / text / ""`, payload: { source: 'text', content: '', format, defaultName: 'a.md' } })
}
for (const c of PANDOC_EMPTY) {
  const before = dialogCalls.length
  const r = await call(c.payload)
  const ok = r.ok === false && r.error === '没有可导出的内容（编辑区是空的），已取消' && dialogCalls.length === before
  check(ok, c.label, `→ ${JSON.stringify(r)}  对话框调用增量=${dialogCalls.length - before}`)
}

console.log('\n=== 5) 文本源另存为 html/htm：空内容必须被拦下且不弹对话框 ===')
const TEXT_HTML_EMPTY = [
  { label: 'html / text / "   "（defaultName=a.md → Markdown 子分支）', payload: { source: 'text', content: '   ', format: 'html', defaultName: 'a.md' } },
  { label: 'htm / text / ""（defaultName=a.md → Markdown 子分支）', payload: { source: 'text', content: '', format: 'htm', defaultName: 'a.md' } },
  { label: 'html / text / "\\n\\t"（defaultName=a.txt → <pre> 子分支）', payload: { source: 'text', content: '\n\t', format: 'html', defaultName: 'a.txt' } }
]
for (const c of TEXT_HTML_EMPTY) {
  const before = dialogCalls.length
  const r = await call(c.payload)
  const ok = r.ok === false && r.error === '没有可导出的内容（编辑区是空的），已取消' && dialogCalls.length === before
  check(ok, c.label, `→ ${JSON.stringify(r)}  对话框调用增量=${dialogCalls.length - before}`)
}

console.log('\n=== 6) 对照组：非空的 Pandoc 系 / 文本源→html 不得被新守卫误拦 ===')
const CONTROLS = [
  { label: 'docx / html / "<p>正文</p>"', payload: { source: 'html', content: '<p>正文</p>', format: 'docx', defaultName: 'a.md' } },
  { label: 'epub / text / "正常文字"', payload: { source: 'text', content: '正常文字', format: 'epub', defaultName: 'a.md' } },
  { label: 'html / text / "# 标题"（defaultName=a.md）', payload: { source: 'text', content: '# 标题', format: 'html', defaultName: 'a.md' } },
  { label: 'html / text / "正文"（defaultName=a.txt）', payload: { source: 'text', content: '正文', format: 'html', defaultName: 'a.txt' } }
]
for (const c of CONTROLS) {
  const before = dialogCalls.length
  const r = await call(c.payload)
  const delta = dialogCalls.length - before
  // 未装 Pandoc 时提前返回「未检测到 Pandoc」也是合格结果（说明没被空守卫拦下）
  const ok = !/没有可导出的内容/.test(r.error ?? '') && (r.error === 'cancelled' || /未检测到 Pandoc/.test(r.error ?? ''))
  check(ok, c.label, `→ ${JSON.stringify(r)}  对话框调用增量=${delta}`)
}

console.log('\n=== 7) 边界（刻意不加守卫）：.md / .txt 纯文本直写，空内容仍应走到保存对话框 ===')
const TXT_BOUNDARY = [
  { label: 'txt / text / ""', payload: { source: 'text', content: '', format: 'txt', defaultName: 'a.txt' } },
  { label: 'md / text / ""', payload: { source: 'text', content: '', format: 'md', defaultName: 'a.md' } }
]
for (const c of TXT_BOUNDARY) {
  const before = dialogCalls.length
  const r = await call(c.payload)
  const delta = dialogCalls.length - before
  const ok = r.error === 'cancelled' && delta === 1
  check(ok, c.label, `→ ${JSON.stringify(r)}  对话框调用增量=${delta}`)
}

// ===== 扩展名规范化（format 是唯一事实来源，路径只是落点）=====
const exists = async (p) => {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}
const head = async (p, n = 4) => {
  try {
    return (await fs.readFile(p)).subarray(0, n).toString('latin1')
  } catch {
    return '<读不到>'
  }
}

console.log('\n=== 8) 对话框返回的扩展名与 format 不符时必须被纠正 ===')
// 8a：用户选「Word 文档(.docx)」，却在保存对话框把文件名写成 xxx.pdf
const userPath8a = join(OUT, 'mismatch.pdf')
await fs.rm(userPath8a, { force: true })
dialogResponse.value = { canceled: false, filePath: userPath8a }
const r8a = await call({ source: 'text', content: '这是一段正文内容', format: 'docx', defaultName: 'a.md' })
console.log(`   返回=${JSON.stringify(r8a)}`)
check(
  r8a.ok === true && typeof r8a.path === 'string' && r8a.path.toLowerCase().endsWith('.docx'),
  '8a docx：返回的 path 已纠正为 .docx',
  `path=${r8a.path}`
)
check((await head(r8a.path)) === 'PK\x03\x04', '8a docx：落盘文件魔数 = PK\\x03\\x04（真 DOCX，不是 PDF）', JSON.stringify(await head(r8a.path)))
check(!(await exists(userPath8a)), '8a docx：用户输入的 .pdf 路径未被写入（没有留下名不副实的文件）')
check(await exists(r8a.path), '8a docx：返回的 path 与真正落盘的文件一致')

// 8b：用户选 PDF，却在保存对话框把文件名写成 xxx.txt
const userPath8b = join(OUT, 'mismatch.txt')
await fs.rm(userPath8b, { force: true })
dialogResponse.value = { canceled: false, filePath: userPath8b }
const r8b = await call({ source: 'html', content: '<p>这是一段正文内容</p>', format: 'pdf', defaultName: 'a.md' })
console.log(`   返回=${JSON.stringify(r8b)}`)
check(
  r8b.ok === true && typeof r8b.path === 'string' && r8b.path.toLowerCase().endsWith('.pdf'),
  '8b pdf：返回的 path 已纠正为 .pdf',
  `path=${r8b.path}`
)
check((await head(r8b.path, 5)) === '%PDF-', '8b pdf：落盘文件头 = %PDF-', JSON.stringify(await head(r8b.path, 5)))
check(!(await exists(userPath8b)), '8b pdf：用户输入的 .txt 路径未被写入')

console.log('\n=== 9) 对话框返回无扩展名路径时必须追加 format 扩展名 ===')
const userPath9 = join(OUT, 'noext')
await fs.rm(userPath9, { force: true })
await fs.rm(join(OUT, 'noext.epub'), { force: true })
dialogResponse.value = { canceled: false, filePath: userPath9 }
const r9 = await call({ source: 'text', content: '这是一段正文内容', format: 'epub', defaultName: 'a.md' })
console.log(`   返回=${JSON.stringify(r9)}`)
check(
  r9.ok === true && typeof r9.path === 'string' && r9.path.toLowerCase().endsWith('.epub'),
  '9 epub：返回的 path 已追加 .epub',
  `path=${r9.path}`
)
check((await head(r9.path)) === 'PK\x03\x04', '9 epub：落盘文件是 zip 容器（魔数 PK\\x03\\x04）')
let epubEntries = ''
try {
  epubEntries = (await fs.readFile(r9.path)).toString('latin1')
} catch {
  /* ignore */
}
check(
  epubEntries.includes('mimetype') && epubEntries.includes('META-INF/container.xml'),
  '9 epub：zip 中央目录含 mimetype 与 META-INF/container.xml（结构合法）'
)
check(!(await exists(userPath9)), '9 epub：无扩展名的原路径未被写入')

console.log('\n=== 10) 正常路径不受影响（format 与扩展名本来就一致）===')
const okPath10 = join(OUT, 'normal.docx')
await fs.rm(okPath10, { force: true })
dialogResponse.value = { canceled: false, filePath: okPath10 }
const r10 = await call({ source: 'text', content: '这是一段正文内容', format: 'docx', defaultName: 'a.md' })
console.log(`   返回=${JSON.stringify(r10)}`)
check(r10.ok === true && r10.path === okPath10, '10 docx：path 与对话框返回路径逐字符相同（行为不变）', `path=${r10.path}`)
check((await head(okPath10)) === 'PK\x03\x04', '10 docx：内容仍是真 DOCX')

console.log(`\n===== 合计 pass=${pass} fail=${fail} =====`)
process.exitCode = fail === 0 ? 0 : 1
