/**
 * PDF 加解密无头单测（加固版）。
 *
 * 运行（必须带项目 loader，它负责把相对无扩展名导入补成 .ts）：
 *   NODE_OPTIONS="" "<node>" --experimental-loader=./tests/loader.mjs \
 *     --experimental-strip-types tests/pdf-audit/test-pdf-security.mjs
 *   等价于  npm run test:pdf-security
 *
 * 判定原则（吸收 QA 评审意见）：
 *   「内容正确」是唯一硬指标。凡「自家代码读自家产出」的断言一律标注
 *   [自洽]（仅证明内部一致，非规范符合性证据）；凡由第三方实现
 *   （pdf.js，生产依赖）或独立语义基准判定的，标注 [独立]。
 *
 * 覆盖：
 *   A. 对象层：固定输入 → 固定序列化（golden）+ AST 字段校验 + 流内容
 *   B. 解密矩阵（RC4-40/128、AES-128）：pdf.js 文本逐字符一致 [独立]
 *   C. AES-256 明确报不支持
 *   D. 加密（AES-128 / V4 R4）：pdf.js 带口令文本一致、无口令抛异常 [独立]
 *   E. 非加密文件 → NOT_ENCRYPTED
 *   F. QA 新场景（只读消费 qa-fixtures）：空用户口令 / 经典 xref / 增量 /Prev /
 *      真实大文件 / 40 字超长口令，均以 pdf.js 文本判定 [独立]
 *   G. 损坏文件：截断 / 非 PDF → MALFORMED（不得误报 NOT_ENCRYPTED）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  decryptPdf,
  encryptPdf,
  isPdfEncrypted,
  describePdfSecurity,
  PdfSecurityError
} from '../../src/renderer/src/utils/pdfSecurity.ts'
import {
  parseValueAt,
  parseIndirectObject,
  serializeValue,
  latin1FromBytes,
  asName,
  asNumber,
  asArray,
  asDict
} from '../../src/renderer/src/utils/pdfObjects.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENC_DIR = join(HERE, 'fixtures', 'encrypted')
const SRC = join(HERE, 'fixtures', 'enhance-source.pdf')
const QA_FIX = join(HERE, 'qa-fixtures') // QA 独立素材，只读消费
const WORK = join(HERE, 'work')
mkdirSync(WORK, { recursive: true })

const PDFJS_ROOT = join(HERE, '..', '..', 'node_modules', 'pdfjs-dist')
const STD_FONTS = join(PDFJS_ROOT, 'standard_fonts') + '/'
const CMAPS = join(PDFJS_ROOT, 'cmaps') + '/'

const USER_PWD = 'LingmoAuditPass123'
const OWNER_PWD = 'OwnerPass456'

let passed = 0
let failed = 0
const failures = []

function check(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ❌ ${name}${detail ? '  —— ' + detail : ''}`)
  }
}
const section = (t) => console.log('\n' + '─'.repeat(74) + '\n■ ' + t)

/* ---------- 第三方实现：pdf.js 文本提取 [独立判定能力] ---------- */
const PDFJS_BASE = {
  isEvalSupported: false,
  disableFontFace: true,
  standardFontDataUrl: STD_FONTS,
  cMapUrl: CMAPS,
  cMapPacked: true
}
async function pdfjsText(bytes, password) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), password, ...PDFJS_BASE })
  const doc = await task.promise
  const pages = doc.numPages
  let text = ''
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i)
    const c = await page.getTextContent()
    text += c.items.map((it) => ('str' in it ? it.str : '')).join('')
  }
  await task.destroy()
  return { text, pages }
}

const errCode = (e) => (e instanceof PdfSecurityError ? e.code : 'NON_SECURITY_ERROR(' + (e && e.name) + ')')

/* 参照文本（第三方提取） */
const srcBytes = readFileSync(SRC)
const srcRef = await pdfjsText(srcBytes)
const realPlainPath = join(QA_FIX, 'real-large-plain.pdf')
const realRef = existsSync(realPlainPath) ? await pdfjsText(readFileSync(realPlainPath)) : null

/* ==================== A. 对象层 ==================== */

section('A. 对象层：固定输入 → 固定序列化（golden）/ AST / 流内容')

const GOLDEN = [
  [
    '<< /Type /Catalog /Pages 2 0 R /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Catalog /Pages 2 0 R /Kids [3 0 R 4 0 R] /Count 2 >>'
  ],
  ['<< /A << /B << /C 1 >> >> /Arr [1 2 [3 4] (x)] >>', '<< /A << /B << /C 1 >> >> /Arr [1 2 [3 4] (x)] >>'],
  ['(hello)', '(hello)'],
  ['<CAFE>', '<cafe>'], // 十六进制统一小写（规范化）
  ['<48656C6C6F>', '(Hello)'], // 可打印 → 字面量
  ['42', '42'],
  ['-0.5', '-0.5'],
  ['3 0 R', '3 0 R'],
  ['/Name', '/Name'],
  ['/A#20B', '/A#20B'] // 名称里的空格用 #20 转义
]
for (const [input, expect] of GOLDEN) {
  const out = serializeValue(parseValueAt(input, 0).value)
  check(`golden: ${JSON.stringify(input).slice(0, 44)}`, out === expect, `\n      期望 ${JSON.stringify(expect)}\n      实际 ${JSON.stringify(out)}`)
}

// AST 字段校验（独立于序列化器的语义基准）
{
  const ast = parseValueAt('<< /Type /Catalog /Pages 2 0 R /Kids [3 0 R] /Count 1 >>', 0).value
  check('AST 顶层为 dict', ast.kind === 'dict')
  check('AST /Type = /Catalog', ast.kind === 'dict' && asName(ast.map.get('Type')) === 'Catalog')
  check('AST /Pages = 2 0 R', ast.kind === 'dict' && ast.map.get('Pages')?.kind === 'ref' && ast.map.get('Pages').num === 2 && ast.map.get('Pages').gen === 0)
  const kids = ast.kind === 'dict' ? asArray(ast.map.get('Kids')) : null
  check('AST /Kids[0] = 3 0 R', !!kids && kids.items[0]?.kind === 'ref' && kids.items[0].num === 3)
  check('AST /Count = 1', ast.kind === 'dict' && asNumber(ast.map.get('Count')) === 1)
}

// 流对象：内容与 /Length 必须都对
{
  const ind = parseIndirectObject(`5 0 obj\n<< /Length 3 >>\nstream\nabc\nendstream\nendobj`, 0)
  check('流解析：raw 恰为 "abc"', ind.value.kind === 'stream' && latin1FromBytes(ind.value.raw) === 'abc')
  const out = serializeValue(ind.value)
  check('流序列化：/Length 与实际一致', /\/Length 3 /.test(out) && out.includes('stream\nabc\nendstream'))
}

// 幂等（[自洽]：稳定不等于正确，正确性由上面的 golden / AST 基准保证）
{
  const s = '<< /A << /B 1 >> /C [1 2 (x)] >>'
  const once = serializeValue(parseValueAt(s, 0).value)
  const twice = serializeValue(parseValueAt(once, 0).value)
  check('[自洽] 序列化幂等', once === twice)
}

/* ==================== B. 解密矩阵 ==================== */

const MATRIX = [
  { file: 'rc4-40-r2.pdf', alg: 'RC4 40-bit' },
  { file: 'rc4-128-r3.pdf', alg: 'RC4 128-bit' },
  { file: 'rc4-128-r4.pdf', alg: 'RC4 128-bit' },
  { file: 'aes128-r4.pdf', alg: 'AES-128' },
  { file: 'aes128-r4-nometa.pdf', alg: 'AES-128' }
]

for (const { file, alg } of MATRIX) {
  section('B. 解密 ' + file + '（期望 ' + alg + '）')
  const bytes = readFileSync(join(ENC_DIR, file))

  check('[独立] isPdfEncrypted = true', (await isPdfEncrypted(bytes)) === true)
  const info = await describePdfSecurity(bytes)
  check(`[独立] 算法识别为 ${alg}`, info.algorithm === alg, `实际 ${info.algorithm}`)
  check('算法标记 supported', info.supported === true, info.reason ?? '')

  const userOut = await decryptPdf(bytes, USER_PWD)

  // ⭐ 硬指标：第三方 pdf.js 提取文本必须与原文件逐字符一致
  const dec = await pdfjsText(userOut)
  check(
    '[独立] pdf.js 文本与原文逐字符一致',
    dec.text === srcRef.text && dec.pages === srcRef.pages,
    `原文 ${srcRef.pages}页/${srcRef.text.length}字, 产出 ${dec.pages}页/${dec.text.length}字`
  )

  const text = latin1FromBytes(userOut)
  check('产出不含 /Encrypt', !/\/Encrypt\b/.test(text))
  check('[独立] pdf-lib 可解析产出（xref 偏移有效）', await (async () => {
    try {
      await PDFDocument.load(userOut)
      return true
    } catch {
      return false
    }
  })())

  // [自洽] 所有者口令路径：两侧同源，只证内部一致
  const ownerOut = await decryptPdf(bytes, OWNER_PWD)
  check('[自洽] 所有者口令 == 用户口令（逐字节）', Buffer.compare(Buffer.from(userOut), Buffer.from(ownerOut)) === 0)

  let wrongCode = ''
  try {
    await decryptPdf(bytes, 'definitely-wrong-password')
  } catch (e) {
    wrongCode = errCode(e)
  }
  check('错误口令 → PASSWORD_INCORRECT', wrongCode === 'PASSWORD_INCORRECT', `实际 ${wrongCode}`)

  writeFileSync(join(WORK, 'decrypted-' + file), Buffer.from(userOut))
}

/* ==================== C. AES-256 ==================== */

section('C. AES-256（aes256-r6.pdf）→ 明确报不支持')
{
  const bytes = readFileSync(join(ENC_DIR, 'aes256-r6.pdf'))
  const info = await describePdfSecurity(bytes)
  check('识别为 AES-256 且 supported=false', info.algorithm === 'AES-256' && !info.supported)
  let code = ''
  let msg = ''
  try {
    await decryptPdf(bytes, USER_PWD)
  } catch (e) {
    code = errCode(e)
    msg = e && e.message ? e.message : ''
  }
  check('抛 UNSUPPORTED_CRYPTO', code === 'UNSUPPORTED_CRYPTO', `实际 ${code}`)
  check('错误文案含「AES-256」', msg.includes('AES-256'), msg)
}

/* ==================== D. 加密 ==================== */

section('D. 加密 AES-128（V4 R4）')
{
  const enc = await encryptPdf(srcBytes, { userPassword: USER_PWD, ownerPassword: OWNER_PWD })
  const text = latin1FromBytes(enc)

  check('产出含 /Encrypt', /\/Encrypt\b/.test(text))
  check('产出含 /V 4', /\/V 4\b/.test(text))
  check('产出含 /R 4', /\/R 4\b/.test(text))
  check('产出含 /CFM /AESV2', /\/CFM\s*\/AESV2/.test(text))
  check('产出含 /ID', /\/ID\s*\[/.test(text))
  const info = await describePdfSecurity(enc)
  check('describe → encrypted / AES-128 / supported', info.encrypted && info.algorithm === 'AES-128' && info.supported)

  // ⭐ [独立] 第三方 pdf.js：带口令文本逐字符一致；无口令抛 PasswordException
  const withPwd = await pdfjsText(enc, USER_PWD)
  check(
    '[独立] pdf.js 带口令文本与原文一致',
    withPwd.text === srcRef.text && withPwd.pages === srcRef.pages,
    `${withPwd.pages}页/${withPwd.text.length}字`
  )
  let noPwdName = ''
  try {
    await pdfjsText(enc)
  } catch (e) {
    noPwdName = e && e.name
  }
  check('[独立] pdf.js 无口令抛 PasswordException', noPwdName === 'PasswordException', `实际 ${noPwdName}`)

  // [独立] pdf-lib 默认拒绝打开（识别为加密）
  let libThrew = false
  try {
    await PDFDocument.load(enc)
  } catch {
    libThrew = true
  }
  check('[独立] pdf-lib 默认拒绝打开密文', libThrew)

  // [自洽] 自家往返
  const round = await decryptPdf(enc, USER_PWD)
  const dec = await pdfjsText(round)
  check('[独立] 加密产物被本工具解回后 pdf.js 文本仍一致', dec.text === srcRef.text && dec.pages === srcRef.pages)

  let wrongCode = ''
  try {
    await decryptPdf(enc, 'nope-nope-nope')
  } catch (e) {
    wrongCode = errCode(e)
  }
  check('自产密文错误口令 → PASSWORD_INCORRECT', wrongCode === 'PASSWORD_INCORRECT', `实际 ${wrongCode}`)

  writeFileSync(join(WORK, 'encrypted-aes128.pdf'), Buffer.from(enc))
  writeFileSync(join(WORK, 'roundtrip-decrypted.pdf'), Buffer.from(round))
}

/* ==================== E. 非加密文件 ==================== */

section('E. 非加密文件')
{
  check('isPdfEncrypted(source) = false', (await isPdfEncrypted(srcBytes)) === false)
  let code = ''
  try {
    await decryptPdf(srcBytes, 'whatever')
  } catch (e) {
    code = errCode(e)
  }
  check('对未加密文件解密 → NOT_ENCRYPTED', code === 'NOT_ENCRYPTED', `实际 ${code}`)
  if (realRef) {
    let code2 = ''
    try {
      await decryptPdf(readFileSync(realPlainPath), 'whatever')
    } catch (e) {
      code2 = errCode(e)
    }
    check('真实大文件（未加密）→ NOT_ENCRYPTED', code2 === 'NOT_ENCRYPTED', `实际 ${code2}`)
  }
}

/* ==================== F. QA 新场景（只读消费 qa-fixtures） ==================== */

section('F. QA 新场景（qa-fixtures，独立素材 + pdf.js 判定）')
{
  const SCEN = [
    { file: 'owner-only-r4.pdf', pwd: '', ref: 'src', note: '空用户口令 / 仅所有者口令' },
    { file: 'classic-xref-aes128.pdf', pwd: USER_PWD, ref: 'src', note: '经典 xref 表 AES-128' },
    { file: 'classic-xref-rc4.pdf', pwd: USER_PWD, ref: 'src', note: '经典 xref 表 RC4-128' },
    { file: 'incremental-aes128.pdf', pwd: USER_PWD, ref: 'src', note: '增量更新 /Prev 链' },
    { file: 'real-large-aes128.pdf', pwd: USER_PWD, ref: 'real', note: '真实大文件 AES-128' },
    { file: 'real-large-rc4.pdf', pwd: USER_PWD, ref: 'real', note: '真实大文件 RC4-128' },
    { file: 'long-pwd-aes128.pdf', pwd: 'A'.repeat(40), ref: 'src', note: '40 字超长口令' }
  ]
  for (const s of SCEN) {
    const p = join(QA_FIX, s.file)
    if (!existsSync(p)) {
      check(`素材存在: ${s.file}`, false, '缺失（无法验证）')
      continue
    }
    const ref = s.ref === 'real' ? realRef : srcRef
    if (!ref) {
      check(`参照文本可用: ${s.file}`, false, 'real-large-plain.pdf 缺失')
      continue
    }
    const bytes = readFileSync(p)
    let out
    try {
      out = await decryptPdf(bytes, s.pwd)
    } catch (e) {
      check(`解密 ${s.file}（${s.note}）`, false, `抛错 ${errCode(e)}: ${e && e.message}`)
      continue
    }
    const dec = await pdfjsText(out)
    check(
      `${s.file} (${s.note}) → 文本一致`,
      dec.text === ref.text && dec.pages === ref.pages,
      `期望 ${ref.pages}页/${ref.text.length}字, 实际 ${dec.pages}页/${dec.text.length}字`
    )
    // 空口令场景额外确认：非空错口令应被拒
    let wc = ''
    try {
      await decryptPdf(bytes, 'definitely-wrong')
    } catch (e) {
      wc = errCode(e)
    }
    check(`${s.file} 错误口令 → PASSWORD_INCORRECT`, wc === 'PASSWORD_INCORRECT', `实际 ${wc}`)
    writeFileSync(join(WORK, 'qa-dec-' + s.file), Buffer.from(out))
  }
}

/* ==================== G. 损坏文件 → MALFORMED ==================== */

section('G. 损坏文件必须区分 MALFORMED / NOT_ENCRYPTED')
{
  // 非 PDF 内容
  let g1 = ''
  try {
    await decryptPdf(new Uint8Array(Buffer.from('this is not a pdf')), USER_PWD)
  } catch (e) {
    g1 = errCode(e)
  }
  check('非 PDF 垃圾 → MALFORMED', g1 === 'MALFORMED', `实际 ${g1}`)

  // 截断（应 MALFORMED，绝不能误报 NOT_ENCRYPTED）
  const trunc = [
    ['classic-xref-aes128.pdf', 0.5],
    ['classic-xref-aes128.pdf', 0.85],
    ['incremental-aes128.pdf', 0.4],
    ['real-large-aes128.pdf', 0.6],
    ['classic-xref-aes128.pdf', 0.98]
  ]
  for (const [file, frac] of trunc) {
    const full = readFileSync(join(QA_FIX, file))
    const cut = full.subarray(0, Math.max(1, Math.floor(full.length * frac)))
    let code = ''
    try {
      await decryptPdf(cut, USER_PWD)
      code = 'SUCCESS(BUG)'
    } catch (e) {
      code = errCode(e)
    }
    check(`截断 ${Math.round(frac * 100)}% ${file} → MALFORMED`, code === 'MALFORMED', `实际 ${code}`)
  }
}

/* ==================== 汇总 ==================== */

console.log('\n' + '═'.repeat(74))
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed) console.log('失败项：\n  - ' + failures.join('\n  - '))
console.log('═'.repeat(74))
process.exit(failed ? 1 : 0)
