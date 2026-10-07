/**
 * §7.2 交叉验证（独立实现 B：pdf.js / pdfjs-dist）。
 *
 * 判定原则：
 *   1) 解密产物 / 我们的密文（带口令）→ pdf.js 提取文本，必须与原文件【一致】。
 *   2) 我们的密文【不传口令】→ 必须抛 PasswordException。
 *
 * 运行：
 *   NODE_OPTIONS="" "<node>" tests/pdf-audit/verify-cross-pdfjs.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, 'work')
const FIX = join(HERE, 'fixtures')
const PDFJS_ROOT = join(HERE, '..', '..', 'node_modules', 'pdfjs-dist')
const STD_FONTS = join(PDFJS_ROOT, 'standard_fonts') + '/'
const CMAPS = join(PDFJS_ROOT, 'cmaps') + '/'
const USER = 'LingmoAuditPass123'

let passed = 0
let failed = 0
const fails = []
const check = (ok, msg) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + msg)
  if (ok) passed++
  else {
    failed++
    fails.push(msg)
  }
}

/** 用 pdf.js 提取全文（逐页），password 可选 */
async function extractText(bytes, password) {
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    password,
    isEvalSupported: false,
    disableFontFace: true,
    standardFontDataUrl: STD_FONTS,
    cMapUrl: CMAPS,
    cMapPacked: true
  })
  const doc = await task.promise
  const numPages = doc.numPages
  let out = ''
  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    out += content.items.map((it) => ('str' in it ? it.str : '')).join('')
  }
  await task.destroy()
  return { text: out, pages: numPages }
}

const srcBytes = readFileSync(join(FIX, 'enhance-source.pdf'))
const { text: srcText, pages: srcPages } = await extractText(srcBytes)
console.log('=' .repeat(74))
console.log('交叉验证 B：pdf.js（pdfjs-dist）')
console.log('='.repeat(74))
console.log(`\n原文件文本：${srcText.length} 字 / ${srcPages} 页`)
console.log(`  预览: ${JSON.stringify(srcText.slice(0, 60))}…`)

console.log('\n[1] 解密产物 → pdf.js 提取文本应与原文件一致')
for (const name of [
  'decrypted-rc4-40-r2.pdf',
  'decrypted-rc4-128-r3.pdf',
  'decrypted-rc4-128-r4.pdf',
  'decrypted-aes128-r4.pdf',
  'decrypted-aes128-r4-nometa.pdf'
]) {
  const bytes = readFileSync(join(WORK, name))
  try {
    const { text, pages } = await extractText(bytes)
    check(
      text === srcText && pages === srcPages,
      `${name.padEnd(32)} ${pages} 页 / ${text.length} 字 ${text === srcText ? '一致' : '★不一致★'}`
    )
  } catch (e) {
    check(false, `${name.padEnd(32)} 提取失败: ${String(e).slice(0, 100)}`)
  }
}

console.log('\n[2] 我们的加密产物（AES-128）→ 带口令文本应一致')
const encBytes = readFileSync(join(WORK, 'encrypted-aes128.pdf'))
try {
  const { text, pages } = await extractText(encBytes, USER)
  check(
    text === srcText && pages === srcPages,
    `encrypted-aes128.pdf（带口令）  ${pages} 页 / ${text.length} 字 ${text === srcText ? '一致' : '★不一致★'}`
  )
} catch (e) {
  check(false, `带口令提取失败: ${String(e).slice(0, 120)}`)
}

console.log('\n[3] 我们的加密产物 → 不传口令应抛 PasswordException')
try {
  await extractText(encBytes)
  check(false, '未传口令竟然读出了文本（应抛异常）')
} catch (e) {
  const isPwd = e && (e.name === 'PasswordException' || /password/i.test(String(e.message)))
  check(isPwd, `不传口令抛异常: name=${e && e.name} (${String((e && e.message) || '').slice(0, 60)})`)
}

console.log('\n' + '='.repeat(74))
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed) console.log('  - ' + fails.join('\n  - '))
console.log('='.repeat(74))
process.exit(failed ? 1 : 0)
