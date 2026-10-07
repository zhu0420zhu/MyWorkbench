/**
 * B 级链路探针：DOC/XLS/RTF 高保真转换编辑（legacyContainer）
 * ============================================================
 * 思路：legacy → soffice 转容器（docx/xlsx）→ A 级手术链改字 → 回写滤镜转回原格式覆写。
 * 断言（每格式）：
 *   a. toContainer 产物存在且是合法 zip（PK 头）
 *   b. extract units 含目标文本（中文+数字混合）；note 如实标注；缓存复用 id 稳定
 *   c. apply 后：原文件 magic 正确（.doc/.xls = OLE D0 CF 11 E0；.rtf = {\rtf）、
 *      原文件已更新、.bak 与覆写前原文件逐字节一致
 *   d. 往返闭环：改后文件再转容器 → extract → 新文本在、旧文本不在
 *   e. changed=0 不产生新 .bak（no-op 语义）
 *
 * ⚠️⚠️ 运行成本警告（勿放进 CI 门 / 勿与其它 soffice 任务并行）⚠️⚠️
 *   · 本探针会**反复**调用 LibreOffice（soffice）做 DOC/XLS/RTF ⇄ docx/xlsx 容器转换：
 *     3 个格式 × 每个 ~5 次转换 + 2 次样本制造，全量约 15~17 次 soffice 启动。
 *   · 产品侧（legacyContainer.ts）已在 userData 下**持久复用**两个 UserInstallation profile
 *     （正向 forward / 回写 back 各一，互不共用），复用后单次 ≈8s；仅首次各付一次 profile
 *     创建成本（≈18s）。实测全量 ≈3 分钟（改前每次新建 profile 时 ≈10.5 分钟）。
 *     若持久 profile 被锁/损坏，产品会自动降级用一次性临时 profile 重试一次（见源码头注释）。
 *   · **独占 soffice**：运行期间不要同时跑 probe:surgical（DOCX 渲染段）、
 *     test:pdf-excel-orient、test:pdf-split-batch 等会拉起 soffice 的任务——它们会互相抢
 *     profile 锁并更慢，甚至让对端出现 `EPERM: rmdir ...UserInstallation` 之类的清理报错。
 *   · 若任务管理器里长期驻留旧的 `soffice.bin`（常驻 1~2MB 的孤儿进程），会进一步拖慢；
 *     跑前建议先结束这些**孤儿**进程（切勿 kill 正被其它任务使用的 soffice）。
 *   · 结论：请**单独、串行、给足超时**运行本探针；不要纳入普通 `npm test` 聚合。
 *
 * 运行（串行、给足余量；实测 ≈3 分钟，建议超时 ≥6 分钟）：
 *   npm run probe:surgical-legacy
 */

import JSZip from 'jszip'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { containerToLegacySupport, toContainer, legacyExtract, legacyApply } from '../src/main/docs/surgical/legacyContainer'
import { surgicalExtract } from '../src/main/docs/surgical/index'

const execFileP = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, 'pdf-audit', 'scratch', 'legacy-surgical')
const SOFFICE = join(HERE, '..', 'resources', 'tools', 'soffice', 'program', 'soffice.com')
const LO_PROFILE = 'file:///' + join(WORK, 'lo-profile').replace(/\\/g, '/')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  [PASS] ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? '  ' + detail : '')) }
}

/** 样本制造与探针共用的 soffice 转换（串行 + 独立 profile + 三条件判定） */
async function sofficeConvert(src, toSpec, outDir) {
  await mkdir(outDir, { recursive: true })
  const res = await execFileP(SOFFICE, [
    '--headless', '--norestore',
    '-env:UserInstallation=' + LO_PROFILE,
    '--convert-to', toSpec,
    '--outdir', outDir.replace(/\\/g, '/'),
    src.replace(/\\/g, '/')
  ], { timeout: 120000 })
  const base = src.split(/[\\/]/).pop().replace(/\.[^.]+$/, '')
  const outExt = toSpec.split(':')[0]
  const expected = join(outDir, base + '.' + outExt)
  const exists = existsSync(expected)
  const size = exists ? (await stat(expected)).size : 0
  return { ok: res && exists && size > 0, path: expected, output: res ? '' : 'rc!=0' }
}

async function countSurgicalTmpDirs() {
  try {
    return (await readdir(tmpdir())).filter((n) => n.startsWith('lingmo-surgical-')).length
  } catch { return -1 }
}

async function waitFor(fn, timeoutMs = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

/* ---------- 样本：最小 DOCX / XLSX（同 A 级探针）经 soffice 转出真 .doc/.xls；RTF 手写 ---------- */

const XMLDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const DOCX_XML = XMLDECL +
'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
'<w:p><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>项目合同摘要</w:t></w:r></w:p>' +
'<w:p><w:r><w:t>基准金额 </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>100</w:t></w:r><w:r><w:t> 元，交付日期以合同附件为准。</w:t></w:r></w:p>' +
'<w:tbl><w:tr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>数量</w:t></w:r></w:p></w:tc></w:tr>' +
'<w:tr><w:tc><w:p><w:r><w:t>设备A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>3</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
'<w:p><w:r><w:t>本合同一式两份，双方各执一份。</w:t></w:r></w:p>' +
'<w:sectPr/></w:body></w:document>'
const DOCX_FILES = {
  '[Content_Types].xml': XMLDECL + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': XMLDECL + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml': DOCX_XML
}

const XLSX_SHARED = XMLDECL +
'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">' +
'<si><t>产品名称</t></si>' +
'<si><r><rPr><b/></rPr><t>富文本</t></r><r><t>加粗段</t></r></si>' +
'<si><t xml:space="preserve">  前导空格值  </t></si>' +
'<si><t>不变单元格</t></si></sst>'
const XLSX_SHEET = XMLDECL +
'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
'<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
'<row r="2"><c r="A2" t="inlineStr"><is><t>内联文本</t></is></c></row>' +
'</sheetData></worksheet>'
const XLSX_FILES = {
  '[Content_Types].xml': XMLDECL + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  '_rels/.rels': XMLDECL + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  'xl/workbook.xml': XMLDECL + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': XMLDECL + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
  'xl/sharedStrings.xml': XLSX_SHARED,
  'xl/worksheets/sheet1.xml': XLSX_SHEET
}

async function pack(files) {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) zip.file(name, content)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
}

/** 非 ASCII → \uN?（带符号 16 位）RTF 转义 */
function rtfEscape(s) {
  return Array.from(s).map((ch) => {
    const cp = ch.codePointAt(0)
    if (ch === '\\') return '\\\\'
    if (ch === '{') return '\\{'
    if (ch === '}') return '\\}'
    if (cp < 128) return ch
    const v = cp > 32767 ? cp - 65536 : cp
    return '\\u' + v + '?'
  }).join('')
}

const RTF_TARGET_OLD = '基准金额 100 元，交付日期以合同附件为准。'
const RTF_TEXT = '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fcharset134 SimSun;}}\n' +
  '\\f0\\fs24 ' + rtfEscape('项目合同摘要') + '\\par\n' +
  rtfEscape(RTF_TARGET_OLD) + '\\par\n' +
  rtfEscape('本合同一式两份，双方各执一份。') + '\\par\n}\n'

/* ---------- 每格式验证主流程 ---------- */

async function legacyCase(name, origPath, support, { targetTextIncludes, makeEdit, expectNewIncludes, expectOldGone }) {
  console.log('\n==== ' + name + ' ====')
  const tmpBaseline = await countSurgicalTmpDirs()

  // a. toContainer → 合法 zip（直接调用不入缓存，断言后自行清理）
  const c = await toContainer(origPath, support)
  ok('toContainer 成功', c.ok === true, c.ok ? c.tempPath.split(/[\\/]/).pop() : String(c.error))
  if (!c.ok) return
  const head = await readFile(c.tempPath).then((b) => b.subarray(0, 2).toString('latin1'))
  ok('容器产物为合法 zip（PK 头）', head === 'PK', head)
  await rm(c.tmpDir, { recursive: true, force: true }).catch(() => undefined)

  // b. extract → 目标文本在；note 如实标注
  const ex = await legacyExtract(origPath)
  ok('legacyExtract ok', ex.ok === true, String(ex.error ?? ''))
  ok('note 高保真转换说明', ex.note === 'DOC/XLS/RTF 为高保真转换编辑：经容器格式手术修改后转回原格式', String(ex.note))
  const units = ex.units ?? []
  ok('extract 产出单元', units.length > 0, units.length + ' 个')
  ok('首次 extract 恰好新建 1 个容器目录', (await countSurgicalTmpDirs()) === tmpBaseline + 1, String(await countSurgicalTmpDirs()))
  const target = units.find((u) => u.text.includes(targetTextIncludes))
  ok('目标单元存在（含目标文本）', !!target, target ? target.id + ' | ' + target.text.slice(0, 30) : '未找到: ' + targetTextIncludes)
  if (!target) return

  // b2. 缓存复用：第二次 extract 不新增临时容器目录，id 稳定
  const ex2 = await legacyExtract(origPath)
  const ids1 = units.map((u) => u.id).join('|')
  const ids2 = (ex2.units ?? []).map((u) => u.id).join('|')
  const dirsNow = await countSurgicalTmpDirs()
  ok('缓存复用：第二次 extract 不再转换', ex2.ok && dirsNow === tmpBaseline + 1, 'dirs ' + dirsNow + '（期望 ' + (tmpBaseline + 1) + '）')
  ok('缓存复用：unit id 稳定', ids1 === ids2)

  // c. apply → magic 正确、原文件更新、.bak 与覆写前逐字节一致
  const origBefore = await readFile(origPath)
  const edit = makeEdit(target)
  const r = await legacyApply(origPath, [edit])
  ok('legacyApply ok', r.ok === true, String(r.error ?? ''))
  ok('changedCount >= 1', (r.changedCount ?? 0) >= 1, String(r.changedCount))
  const bakPath = origPath + '.bak'
  const bakExists = existsSync(bakPath)
  ok('.bak 已生成', r.ok && !!r.backupPath && bakExists, bakPath)
  if (bakExists) {
    const bak = await readFile(bakPath)
    ok('★ .bak 与覆写前原文件逐字节一致', bak.equals(origBefore))
  }
  const origAfter = await readFile(origPath)
  ok('原文件已更新（字节不同）', !origAfter.equals(origBefore))
  const magic4 = origAfter.subarray(0, 4).toString('hex')
  const magicHead = origAfter.subarray(0, 5).toString('latin1')
  if (support.legacyExt === '.rtf') {
    ok('回写 magic 正确（{\\rtf）', magicHead === '{\\rtf', magicHead)
  } else {
    ok('回写 magic 正确（OLE D0 CF 11 E0）', magic4 === 'd0cf11e0', magic4)
  }
  // 临时目录清理（回到 case 基线）
  const cleaned = await waitFor(async () => (await countSurgicalTmpDirs()) === tmpBaseline)
  ok('apply 成功后清理临时容器目录', cleaned, String(await countSurgicalTmpDirs()))

  // d. 往返闭环：改后文件再转容器 → extract → 新文本在、旧文本不在
  const c2 = await toContainer(origPath, support)
  ok('往返：改后文件可再次转容器', c2.ok === true, c2.ok ? '' : String(c2.error))
  if (c2.ok) {
    const buf = await readFile(c2.tempPath)
    const ex3 = await surgicalExtract(buf, support.container)
    const texts = (ex3.units ?? []).map((u) => u.text).join('\n')
    ok('★ 往返闭环：新文本出现', texts.includes(expectNewIncludes), expectNewIncludes)
    ok('★ 往返闭环：旧文本消失', !texts.includes(expectOldGone), expectOldGone)
    await rm(c2.tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }

  // e. no-op：changed=0 不产生新 .bak（先重 extract 重建缓存）
  await rm(bakPath, { force: true })
  const ex4 = await legacyExtract(origPath)
  ok('no-op 前重 extract 重建缓存', ex4.ok === true && (await countSurgicalTmpDirs()) === tmpBaseline + 1)
  const t4 = (ex4.units ?? []).find((u) => u.id === target.id)
  const noopEdit = { id: target.id, newText: (t4 ?? target).text }
  const r2 = await legacyApply(origPath, [noopEdit])
  ok('no-op apply ok & changedCount=0', r2.ok === true && r2.changedCount === 0, JSON.stringify({ changed: r2.changedCount, err: r2.error }))
  ok('no-op 不产生新 .bak', !existsSync(bakPath))
  ok('no-op 后缓存保留（目录不增不减）', (await countSurgicalTmpDirs()) === tmpBaseline + 1)
}

async function main() {
  await mkdir(WORK, { recursive: true })
  console.log('[0] 语义检查：containerToLegacySupport')
  ok('.doc → docx + MS Word 97', JSON.stringify(containerToLegacySupport('.doc')) === JSON.stringify({ container: 'docx', filter: 'MS Word 97', legacyExt: '.doc' }))
  ok('.xls → xlsx + MS Excel 97', JSON.stringify(containerToLegacySupport('xls')) === JSON.stringify({ container: 'xlsx', filter: 'MS Excel 97', legacyExt: '.xls' }))
  ok('.rtf → docx + Rich Text Format', JSON.stringify(containerToLegacySupport('.RTF')) === JSON.stringify({ container: 'docx', filter: 'Rich Text Format', legacyExt: '.rtf' }))
  ok('.docx/.xlsx 不属于 legacy', containerToLegacySupport('.docx') === null && containerToLegacySupport('.xlsx') === null)

  console.log('\n[1] 制造真实样本（soffice 由最小 docx/xlsx 转出 .doc/.xls；RTF 手写）')
  const docxSample = join(WORK, 'sample-source.docx')
  await writeFile(docxSample, await pack(DOCX_FILES))
  const rDoc = await sofficeConvert(docxSample, 'doc:MS Word 97', WORK)
  ok('样本 .doc 生成', rDoc.ok, rDoc.ok ? rDoc.path : rDoc.output)
  const xlsxSample = join(WORK, 'sheet-source.xlsx')
  await writeFile(xlsxSample, await pack(XLSX_FILES))
  const rXls = await sofficeConvert(xlsxSample, 'xls:MS Excel 97', WORK)
  ok('样本 .xls 生成', rXls.ok, rXls.ok ? rXls.path : rXls.output)
  const rtfPath = join(WORK, 'memo.rtf')
  await writeFile(rtfPath, RTF_TEXT, 'latin1')
  ok('样本 .rtf 写入', existsSync(rtfPath))

  await legacyCase('DOC', rDoc.path, containerToLegacySupport('.doc'), {
    // 实测：LO doc→docx 往返会丢 run 边界空格（'基准金额 100 元' → '基准金额100元'），
    // 这正是要如实标注的版式细节差异，目标匹配用无空格形态
    targetTextIncludes: '基准金额',
    makeEdit: (u) => ({ id: u.id, newText: u.text.replace('100', '99999') }),
    expectNewIncludes: '基准金额99999元',
    expectOldGone: '基准金额100元'
  })

  await legacyCase('XLS', rXls.path, containerToLegacySupport('.xls'), {
    targetTextIncludes: '产品名称',
    makeEdit: (u) => ({ id: u.id, newText: '产品全称' }),
    expectNewIncludes: '产品全称',
    expectOldGone: '产品名称'
  })

  await legacyCase('RTF', rtfPath, containerToLegacySupport('.rtf'), {
    targetTextIncludes: '基准金额 100 元',
    makeEdit: (u) => ({ id: u.id, newText: u.text.replace('100', '99999') }),
    expectNewIncludes: '基准金额 99999 元',
    expectOldGone: '基准金额 100 元'
  })

  console.log('\n通过 ' + pass + '，失败 ' + fail)
  if (fail > 0) process.exitCode = 1
  else console.log('\n★ 结论：DOC/XLS/RTF 高保真转换编辑链路（转容器→手术改字→转回覆写→往返闭环）全绿。')
}

void main()
