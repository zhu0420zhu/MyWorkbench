/**
 * 审计 PdfTools.tsx 的 CryptoPanel（PdfTools.tsx:789-865）。
 *
 * 【加密】mode==='encrypt' 分支只弹错误提示，不产出任何文件
 *   → 明确未实现（代码注释自陈「禁止伪装成『已加密』」，态度诚实）
 *     但它指引用户「请使用 qpdf」—— 而 qpdf 在本项目既未接线、主程序也已缺失。
 *
 * 【解密】mode==='decrypt' 分支：
 *   const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
 *   const out = await savePdf(doc, ...)
 *   疑点一：userPwd 状态从未被传入，密码输入框是装饰性的。
 *   疑点二：pdf-lib 的 ignoreEncryption 只是「不因加密而抛错」，
 *           它并未实现 RC4/AES 解密。对真加密 PDF，内容流仍是密文，
 *           重新保存后得到的是「声明未加密、内容仍为密文」的坏文件。
 *
 * 本脚本用真加密 PDF 验证疑点二。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'

const execFileP = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, 'work', 'crypto')
await rm(WORK, { recursive: true, force: true })
await mkdir(WORK, { recursive: true })
const SOFFICE = join(process.cwd(), 'resources', 'tools', 'soffice', 'program', 'soffice.com')

// 关键：必须清掉 PYTHONPATH/PYTHONHOME，否则会破坏 LibreOffice 内置 Python
const CLEAN_ENV = { ...process.env }
delete CLEAN_ENV.PYTHONPATH
delete CLEAN_ENV.PYTHONHOME

async function soffice(args, tag) {
  const profile = join(WORK, 'prof-' + tag).replace(/\\/g, '/')
  try {
    await execFileP(SOFFICE, ['-env:UserInstallation=file:///' + profile, ...args], {
      timeout: 180000,
      windowsHide: true,
      env: CLEAN_ENV
    })
    return ''
  } catch (e) {
    return String(e.stderr || e.message).slice(0, 400)
  }
}

/* ---------- 1. 源：复用已生成的 xlsx ---------- */
const srcXlsx = join(HERE, 'work', 'src', 'sheet.xlsx')
console.log('='.repeat(74))
console.log('PDF 加密 / 解密（CryptoPanel）审计')
console.log('='.repeat(74))
console.log('\n[素材] 源工作簿: ' + (existsSync(srcXlsx) ? '✅' : '❌ 缺失（请先跑 audit-excel-orientation.mjs）'))
if (!existsSync(srcXlsx)) process.exit(1)

const PASSWORD = 'LingmoAuditPass123'

/* ---------- 2. 明文 PDF ---------- */
const plainDir = join(WORK, 'plain')
await mkdir(plainDir, { recursive: true })
const e1 = await soffice(['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', plainDir, srcXlsx], 'plain')
const plainPath = join(plainDir, 'sheet.pdf')
if (e1.trim()) console.log('    明文转换 stderr: ' + e1.trim().slice(0, 200))

/* ---------- 3. 真加密 PDF ---------- */
const encDir = join(WORK, 'enc')
await mkdir(encDir, { recursive: true })
const encFilter =
  'pdf:calc_pdf_Export:' +
  JSON.stringify({
    EncryptFile: { type: 'boolean', value: 'true' },
    DocumentOpenPassword: { type: 'string', value: PASSWORD },
    RestrictPermissions: { type: 'boolean', value: 'true' },
    PermissionPassword: { type: 'string', value: 'ownerpass' }
  })
const e2 = await soffice(['--headless', '--norestore', '--convert-to', encFilter, '--outdir', encDir, srcXlsx], 'enc')
const encPath = join(encDir, 'sheet.pdf')
if (e2.trim()) console.log('    加密转换 stderr: ' + e2.trim().slice(0, 200))

console.log('\n[素材产出]')
console.log('  明文 PDF : ' + (existsSync(plainPath) ? '✅ ' + (await readFile(plainPath)).length + 'B' : '❌ 失败'))
console.log('  加密 PDF : ' + (existsSync(encPath) ? '✅ ' + (await readFile(encPath)).length + 'B' : '❌ 失败'))
if (!existsSync(encPath) || !existsSync(plainPath)) process.exit(1)

const encBytes = await readFile(encPath)
const encRaw = encBytes.toString('latin1')

/* ---------- 4. 确认加密特征 ---------- */
console.log('\n[1] 加密 PDF 是否真的被加密')
console.log('    含 /Encrypt 字典    : ' + (/\/Encrypt\b/.test(encRaw) ? '✅ 是' : '❌ 否'))
console.log('    含 /Crypt 加密过滤器: ' + (/\/Crypt\b/.test(encRaw) ? '✅ 是' : '❌ 否'))
const sf = [...encRaw.matchAll(/\/Filter\s*\/(\w+)/g)].map((m) => m[1])
console.log('    出现的关键字        : ' + JSON.stringify([...new Set(sf)]))
const std = [...encRaw.matchAll(/\/StdCF|\/V\s*(\d)|\/R\s*(\d)/g)].slice(0, 6).map((m) => m[0])
console.log('    加密算法标记        : ' + JSON.stringify(std))

/* ---------- 5. 复刻「解密」逻辑 ---------- */
console.log('\n[2] 复刻 CryptoPanel 的 decrypt 分支')
console.log('    PDFDocument.load(bytes, { ignoreEncryption: true })')
let decrypted = null
let loadErr = ''
try {
  const doc = await PDFDocument.load(encBytes, { ignoreEncryption: true })
  console.log('      ✓ load 成功，页数 = ' + doc.getPageCount())
  decrypted = Buffer.from(await doc.save())
  await writeFile(join(WORK, 'pdf-lib-output.pdf'), decrypted)
  console.log('      ✓ save 成功，产出 ' + decrypted.length + ' 字节')
} catch (e) {
  loadErr = String(e.message)
  console.log('      ❌ 抛出: ' + loadErr)
}

/* ---------- 6. 对照：基线「明文 load」是否成功 ---------- */
console.log('\n[3] 基线对照')
console.log('    对照点：以 ignoreEncryption 加载【明文】PDF 应完全正常')
try {
  const d = await PDFDocument.load(await readFile(plainPath), { ignoreEncryption: true })
  console.log('      ✓ 明文 load 成功，页数 = ' + d.getPageCount())
} catch (e) {
  console.log('      ❌ ' + e.message)
}
console.log('    对照点：以【不忽略加密】加载加密 PDF')
try {
  await PDFDocument.load(encBytes)
  console.log('      ⚠ 竟然成功（说明该 PDF 实际未加密）')
} catch (e) {
  console.log('      ✓ 抛出 EncryptedPDFError → 证实该 PDF 确为加密（' + String(e.message).slice(0, 60) + '）')
}

/* ---------- 7. 内容流可读性判定 ---------- */
function probe(bytes, label) {
  const raw = Buffer.from(bytes).toString('latin1')
  const out = []
  const re = /\bstream\r?\n/g
  let m
  while ((m = re.exec(raw)) !== null) {
    const s = m.index + m[0].length
    const e = raw.indexOf('endstream', s)
    if (e < 0) break
    const body = Buffer.from(raw.slice(s, e), 'latin1')
    const ds = raw.lastIndexOf('<<', m.index)
    const dict = ds >= 0 ? raw.slice(ds, m.index).replace(/\s+/g, ' ') : ''
    let data = body
    if (/FlateDecode/.test(dict)) {
      try {
        data = inflateSync(body)
      } catch {
        data = null
      }
    }
    if (data && data.length > 50) {
      const t = data.toString('latin1')
      const hasBT = /BT[\s\S]{0,800}ET/.test(t)
      const tjCount = (t.match(/\bT[jJ]\b/g) || []).length
      out.push({ len: data.length, hasBT, tjCount, head: t.slice(0, 50).replace(/[^\x20-\x7e]/g, '.') })
    }
    re.lastIndex = e
  }
  console.log('\n    --- ' + label + ' ---')
  out.slice(0, 5).forEach((s, i) =>
    console.log('      [' + i + '] ' + s.len + 'B  文本块=' + (s.hasBT ? '有' : '无') + '  Tj/TJ 数=' + s.tjCount)
  )
  return out
}

console.log('\n[4] 内容流可读性（有 Tj/TJ 与 BT..ET 即内容可正常解析）')
const pPlain = probe(await readFile(plainPath), '明文 PDF（基线）')
const pEnc = probe(encBytes, '加密 PDF（原始）')
const pOut = decrypted ? probe(decrypted, 'pdf-lib 产出（解密后）') : []

const plainOk = pPlain.some((s) => s.hasBT && s.tjCount > 0)
const outOk = pOut.some((s) => s.hasBT && s.tjCount > 0)

console.log('\n' + '='.repeat(74))
console.log('判定')
console.log('='.repeat(74))
console.log('  明文 PDF 内容可解析       : ' + (plainOk ? '✅ 是' : '❌ 否'))
console.log('  加密 PDF 内容可解析       : ' + (pEnc.some((s) => s.hasBT && s.tjCount > 0) ? '是' : '❌ 否（密文，符合预期）'))
console.log('  pdf-lib 产出内容可解析    : ' + (outOk ? '✅ 是 → 解密成功' : '❌ 否 → 解密失败，产出为坏文件'))
console.log('  pdf-lib 产出仍含 /Encrypt : ' + (/\/Encrypt\b/.test(decrypted ? decrypted.toString('latin1') : '') ? '是' : '否'))
if (outOk) {
  console.log('\n  ⇒ 解密功能可用。')
} else {
  console.log('\n  ⇒ pdf-lib 的 ignoreEncryption 只跳过报错，并未解密内容流。')
  console.log('    用户拿到的是「扩展名 .pdf、无加密标记、但内容仍是密文」的文件，')
  console.log('    用任何阅读器打开都会是空白或报错。')
}
