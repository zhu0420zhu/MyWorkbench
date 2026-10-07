/**
 * `docs:save-docx-as` / `docs:save-html-as` 落盘扩展名规范化验收。
 *
 * 背景：这两个通道的内容格式是固定的（DOCX / HTML），但用户仍可在保存对话框里
 * 手打别的扩展名，于是会落下「名字与内容不符」的文件（最典型：把 HTML 源码落成 .txt）。
 * 规则：format 由通道本身决定，路径只是落点；例外是 .htm 与 .html 等价，不得改写。
 *
 * 运行：
 *   node --experimental-loader=./tests/docs-save-guard-loader.mjs --experimental-strip-types tests/docs-save-ext-normalize.mjs
 */
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dialogCalls, dialogResponse, handlers } from './docs-save-guard-electron.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'pdf-audit', 'work', 'docs-save-ext')
const DOCX_HTML = '<h1>标题</h1><p>这是一段正文内容</p>'

const { registerDocsIpc } = await import('../src/main/docsIpc.ts')
registerDocsIpc()
const saveDocxAs = handlers.get('docs:save-docx-as')
const saveHtmlAs = handlers.get('docs:save-html-as')
if (!saveDocxAs || !saveHtmlAs) throw new Error('docs:save-docx-as / docs:save-html-as 未注册')

await fs.mkdir(OUT, { recursive: true })

let pass = 0
let fail = 0
const check = (ok, label, detail) => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
}
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
const text = async (p) => {
  try {
    return await fs.readFile(p, 'utf-8')
  } catch {
    return '<读不到>'
  }
}
/** 每个用例前清掉相关文件，避免残留误判 */
const fresh = async (...paths) => {
  for (const p of paths) await fs.rm(p, { force: true })
}

console.log('=== A) docs:save-docx-as：内容恒为 DOCX，扩展名必须对齐 .docx ===')

// A1 用户手打 .pdf
const a1User = join(OUT, 'a1.pdf')
const a1Out = join(OUT, 'a1.docx')
await fresh(a1User, a1Out)
dialogResponse.value = { canceled: false, filePath: a1User }
const a1 = await saveDocxAs({ sender: {} }, DOCX_HTML, 'a1.docx')
console.log(`   A1 返回=${JSON.stringify(a1)}  用户输入路径=${a1User}`)
check(a1.ok === true && a1.path.toLowerCase().endsWith('.docx'), 'A1 返回的 path 以 .docx 结尾', `path=${a1.path}`)
check((await head(a1.path)) === 'PK\x03\x04', 'A1 落盘魔数 = PK\\x03\\x04（真 DOCX）', JSON.stringify(await head(a1.path)))
check(!(await exists(a1User)), 'A1 用户输入的 .pdf 路径未被写入')
check(await exists(a1.path), 'A1 返回的 path 与真正落盘的文件一致')

// A2 无扩展名
const a2User = join(OUT, 'a2noext')
const a2Out = join(OUT, 'a2noext.docx')
await fresh(a2User, a2Out)
dialogResponse.value = { canceled: false, filePath: a2User }
const a2 = await saveDocxAs({ sender: {} }, DOCX_HTML, 'a2.docx')
console.log(`   A2 返回=${JSON.stringify(a2)}`)
check(a2.ok === true && a2.path.toLowerCase().endsWith('.docx'), 'A2 无扩展名 → 追加 .docx', `path=${a2.path}`)
check((await head(a2.path)) === 'PK\x03\x04', 'A2 落盘仍是真 DOCX')

// A3 本来就带 .docx（行为不得改变）
const a3User = join(OUT, 'a3.docx')
await fresh(a3User)
dialogResponse.value = { canceled: false, filePath: a3User }
const a3 = await saveDocxAs({ sender: {} }, DOCX_HTML, 'a3.docx')
console.log(`   A3 返回=${JSON.stringify(a3)}`)
check(a3.ok === true && a3.path === a3User, 'A3 path 与对话框返回路径逐字符相同（行为不变）', `path=${a3.path}`)

console.log('\n=== B) docs:save-html-as：内容恒为 HTML；.htm 必须保持 .htm ===')

// B1 用户手打 .txt → 纠正为 .html，且 title 用规范化后的文件名
const b1User = join(OUT, 'b1.txt')
const b1Out = join(OUT, 'b1.html')
await fresh(b1User, b1Out)
dialogResponse.value = { canceled: false, filePath: b1User }
const b1 = await saveHtmlAs({ sender: {} }, '<p>正文</p>', 'b1.html')
console.log(`   B1 返回=${JSON.stringify(b1)}`)
const b1Content = await text(b1.path)
console.log(`   B1 内容前 80 字符=${JSON.stringify(b1Content.slice(0, 80))}`)
check(b1.ok === true && b1.path.toLowerCase().endsWith('.html'), 'B1 返回的 path 以 .html 结尾', `path=${b1.path}`)
check(b1Content.startsWith('<!DOCTYPE html>'), 'B1 内容以 <!DOCTYPE html> 开头')
check(b1Content.includes(`<title>${b1.path.split(/[\\/]/).pop()}</title>`), 'B1 <title> 用的就是规范化后落盘的文件名')
check(!(await exists(b1User)), 'B1 用户输入的 .txt 路径未被写入（没有把 HTML 源码伪装成文本）')

// B2 返回 .htm → 必须原样保留（防回归）
const b2User = join(OUT, 'b2.htm')
const b2Wrong = join(OUT, 'b2.html')
await fresh(b2User, b2Wrong)
dialogResponse.value = { canceled: false, filePath: b2User }
const b2 = await saveHtmlAs({ sender: {} }, '<p>正文</p>', 'b2.htm')
console.log(`   B2 返回=${JSON.stringify(b2)}`)
check(b2.ok === true && b2.path === b2User, 'B2 .htm 未被改写成 .html（逐字符相同）', `path=${b2.path}`)
check(!(await exists(b2Wrong)), 'B2 没有额外生成 .html 副本')
check((await text(b2.path)).startsWith('<!DOCTYPE html>'), 'B2 .htm 文件内容仍是完整 HTML')

// B3 无扩展名
const b3User = join(OUT, 'b3noext')
const b3Out = join(OUT, 'b3noext.html')
await fresh(b3User, b3Out)
dialogResponse.value = { canceled: false, filePath: b3User }
const b3 = await saveHtmlAs({ sender: {} }, '<p>正文</p>', 'b3.html')
console.log(`   B3 返回=${JSON.stringify(b3)}`)
check(b3.ok === true && b3.path.toLowerCase().endsWith('.html'), 'B3 无扩展名 → 追加 .html', `path=${b3.path}`)

// B4 本来就带 .html（行为不得改变）
const b4User = join(OUT, 'b4.html')
await fresh(b4User)
dialogResponse.value = { canceled: false, filePath: b4User }
const b4 = await saveHtmlAs({ sender: {} }, '<p>正文</p>', 'b4.html')
console.log(`   B4 返回=${JSON.stringify(b4)}`)
check(b4.ok === true && b4.path === b4User, 'B4 path 逐字符相同（行为不变）', `path=${b4.path}`)

console.log('\n=== C) 用户取消仍返回 cancelled，且不落盘 ===')
const before = dialogCalls.length
dialogResponse.value = { canceled: true, filePath: undefined }
const c1 = await saveDocxAs({ sender: {} }, DOCX_HTML, 'c.docx')
const c2 = await saveHtmlAs({ sender: {} }, '<p>正文</p>', 'c.html')
console.log(`   C 返回=${JSON.stringify(c1)} / ${JSON.stringify(c2)}  对话框调用增量=${dialogCalls.length - before}`)
check(c1.error === 'cancelled' && c2.error === 'cancelled', 'C 两个通道取消时都返回 cancelled')

console.log(`\n===== 合计 pass=${pass} fail=${fail} =====`)
process.exitCode = fail === 0 ? 0 : 1
