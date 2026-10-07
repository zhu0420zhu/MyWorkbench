/**
 * 端到端验证：富文本 HTML → PDF 导出通道（走生产真实链路）。
 *
 * 链路：registerDocsIpc() 注册真 handler → 调用 'docs:save-as-format'
 *      （payload.source='html', format='pdf'）→ 内部 htmlWrap + htmlToPdfBytes
 *      → 保存对话框（替身）→ 二进制写出 → 断言产出。
 *
 * 运行：
 *   node --experimental-loader=./tests/pdf-audit/scratch/loader-full.mjs \
 *        --experimental-strip-types tests/pdf-audit/scratch/verify-docs-html-pdf.mjs
 */
import { mkdirSync, readFileSync, existsSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, dialog, handlers } from 'electron'
import { PDFDocument } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { registerDocsIpc } from '../../../src/main/docsIpc.ts'
import { htmlToPdfBytes } from '../../../src/main/docs/htmlToPdf.ts'
import { bundledSoffice, sofficeAvailable, toSofficePath } from '../../../src/main/pdf/sofficePath.ts'

const here = dirname(fileURLToPath(import.meta.url))
const work = join(here, 'qa-work')
mkdirSync(work, { recursive: true })

const OUT_PDF = join(work, 'docs-html2pdf-e2e.pdf')
rmSync(OUT_PDF, { force: true })

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

// ---- 输入：含中文标题、加粗、无序列表的富文本（模拟 Word 模式编辑器产出）----
const RICH = `<h1>灵墨工作台 文档导出测试</h1>
<p>这是一段<strong>加粗的中文文本</strong>，用于验证中文渲染与字体回退是否正常。</p>
<ul><li>项目一：富文本 HTML 转 PDF</li><li>项目二：加粗与无序列表保留</li><li>项目三：中文换行与分页</li></ul>`

console.log('=== 环境 ===')
console.log('node          :', process.version)
console.log('soffice 可用  :', sofficeAvailable())
console.log('soffice 路径  :', bundledSoffice())
console.log('PYTHONPATH    :', JSON.stringify(process.env.PYTHONPATH))

const evt = { sender: {} }
registerDocsIpc()
const handler = handlers.get('docs:save-as-format')
check("registerDocsIpc 注册了 'docs:save-as-format'", typeof handler === 'function')

// ---- 取消场景：不选路径 → cancelled ----
dialog._savePath = null
const cancelRes = await handler(evt, { source: 'html', content: RICH, defaultName: '取消测试.docx', format: 'pdf' })
check('用户取消时返回 cancelled', cancelRes.ok === false && cancelRes.error === 'cancelled', JSON.stringify(cancelRes))

// ---- 不支持格式仍被拒绝 ----
const badRes = await handler(evt, { source: 'html', content: RICH, defaultName: 'x.docx', format: 'zip' })
check('未支持格式仍被拒绝', badRes.ok === false && /不支持导出/.test(badRes.error || ''), JSON.stringify(badRes))

// ---- 主链路：Word 模式（source='html'）导出 pdf ----
const tmpBefore = readdirSync(tmpdir()).filter((n) => n.startsWith('lingmo-docs-html2pdf-')).length
dialog._savePath = OUT_PDF
const t0 = Date.now()
const res = await handler(evt, { source: 'html', content: RICH, defaultName: '测试文档.docx', format: 'pdf' })
const elapsed = Date.now() - t0
console.log('\n=== 主链路结果 ===')
console.log('handler 返回  :', JSON.stringify(res))
console.log('耗时          :', elapsed, 'ms')

check('handler 返回 ok=true', res.ok === true)
check('返回路径与落盘路径一致', res.path === OUT_PDF)
check('产物文件存在', existsSync(OUT_PDF))
if (!existsSync(OUT_PDF)) {
  console.log(`\n结论：FAIL（${failures} 项失败）`)
  process.exit(1)
}

const buf = readFileSync(OUT_PDF)
const head = buf.subarray(0, 5).toString('latin1')
console.log('字节数        :', buf.byteLength)
console.log('文件头(5字节) :', JSON.stringify(head), '= hex', buf.subarray(0, 5).toString('hex'))
check('字节数 > 1KB', buf.byteLength > 1024, `实际 ${buf.byteLength}`)
check("文件头为 '%PDF-'", head === '%PDF-', `实际 ${JSON.stringify(head)}`)
// 二进制写入的间接证据：若按 utf-8 文本写，非 ASCII 字节会被重编码，文件头/结构必然崩
check('前 8 字节为 %PDF-1.x（二进制未被 utf-8 改写）', /^%PDF-1\.\d/.test(buf.subarray(0, 8).toString('latin1')))

const pdf = await PDFDocument.load(buf, { ignoreEncryption: true })
const pages = pdf.getPageCount()
console.log('pdf-lib 页数  :', pages)
check('页数 ≥ 1', pages >= 1, `实际 ${pages}`)

// ---- 中文可见性证据：pdfjs 文本提取 ----
const doc = await getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise
const page = await doc.getPage(1)
const content = await page.getTextContent()
const text = content.items.map((i) => ('str' in i ? i.str : '')).join('')
try {
  await doc.cleanup()
} catch {
  /* 忽略：进程随后即退出 */
}
console.log('提取文本前 200 字:', JSON.stringify(text.slice(0, 200)))
const hasChinese = /灵墨|加粗|项目|文档导出/.test(text)
check('提取文本含中文（中文正常输出）', hasChinese)
check('加粗文本可见', /加粗的中文文本/.test(text))
check('列表项可见', /项目一|项目二|项目三/.test(text))

// ---- 临时目录清理 ----
const tmpAfter = readdirSync(tmpdir()).filter((n) => n.startsWith('lingmo-docs-html2pdf-')).length
console.log('\n=== 临时目录 ===')
console.log('调用前残留    :', tmpBefore, '  调用后残留:', tmpAfter)
check('临时目录已清理（无新增残留）', tmpAfter <= tmpBefore, `before=${tmpBefore} after=${tmpAfter}`)

// ---- 兜底包装：非完整 HTML 片段也能转（不影响生产的完整性）----
const frag = await htmlToPdfBytes(`<h2>片段兜底测试</h2><p>这是一段<strong>加粗中文</strong></p>`, { baseName: '片段' })
console.log('\n=== 片段兜底 ===')
console.log('ok:', frag.ok, ' bytes:', frag.bytes?.byteLength, ' error:', frag.error ?? '')
check('非完整 HTML 片段自动包装后可转出 PDF', frag.ok === true && (frag.bytes?.byteLength ?? 0) > 1024)
if (frag.ok && frag.bytes) {
  const fragPath = join(work, 'docs-html2pdf-fragment.pdf')
  writeFileSync(fragPath, Buffer.from(frag.bytes))
  const fdoc = await PDFDocument.load(Buffer.from(frag.bytes))
  console.log('片段 PDF 页数:', fdoc.getPageCount(), ' 已存:', fragPath)
}

// ---- soffice 路径辅助函数 ----
console.log('\n=== toSofficePath ===')
console.log('输入 D:\\\\a\\\\b.html →', JSON.stringify(toSofficePath(join('D:', 'a', 'b.html'))))
check('反斜杠被转成正斜杠', !toSofficePath(join('D:', 'a', 'b.html')).includes('\\'))

console.log(`\n结论：${failures === 0 ? 'PASS' : 'FAIL'}（${failures} 项失败）`)
console.log('app.getPath(temp) =', app.getPath('temp'))
process.exit(failures === 0 ? 0 : 1)
