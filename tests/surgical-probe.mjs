/**
 * 手术式文档编辑 · 全格式探针
 * ============================
 * 对 7 种格式（docx/odt/ods/odp/xlsx/pptx/epub）验证「手术式编辑」核心层：
 *   [结构级] apply 后重读 zip：除目标 XML 条目外所有条目解压内容逐字节一致；
 *            目标条目与「手算期望 XML」全等（= 除目标文字外其余内容不变）。
 *   [行为级] run 合并（3-run 拆分段落）、部分替换保格式、XML 转义、skipped 语义、
 *            往返 extract 文本一致。
 *   [渲染级] DOCX：soffice 转 PDF（串行 + 独立 UserInstallation）+ pdf.js 提取，
 *            剔除空白后全文逐字符一致。
 *
 * 运行：
 *   npm run probe:surgical
 *   （= NODE_OPTIONS="" node --experimental-loader=./tests/loader.mjs --experimental-strip-types tests/surgical-probe.mjs）
 */
import JSZip from 'jszip'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

import { surgicalExtract, surgicalApply } from '../src/main/docs/surgical/index'

const execFileP = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, 'pdf-audit', 'scratch', 'surgical')
const SOFFICE = join(HERE, '..', 'resources', 'tools', 'soffice', 'program', 'soffice.com')
const LO_PROFILE = 'file:///' + join(WORK, 'lo-profile').replace(/\\/g, '/')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  [PASS] ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? '  ' + detail : '')) }
}
const clean = (s) => String(s).replace(/\s+/g, '')

async function pack(files) {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) zip.file(name, content)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
}

/**
 * 通用手术案例验证：
 *  - extract 单元抽取与 id 稳定性
 *  - apply：changedCount / skipped / 返回字节
 *  - 结构级：非目标条目逐字节一致 + 目标条目与手算期望全等
 *  - 往返：改后 extract 文本与期望一致
 */
async function surgicalCase(name, { ext, files, edits, expectFormat, changedCount, expectSkipped, expectedTargetEntries, expectedUnitTexts, extraChecks }) {
  console.log('\n==== ' + name + ' ====')
  const before = await pack(files)

  const ex = await surgicalExtract(before, ext)
  ok('extract ok & format 正确', ex.ok === true && ex.format === expectFormat, 'format=' + String(ex.format) + ' err=' + String(ex.error))
  ok('extract 产出单元', (ex.units ?? []).length > 0, String((ex.units ?? []).length) + ' 个')

  const r = await surgicalApply(before, ext, edits)
  ok('apply ok', r.ok === true, String(r.error ?? ''))
  ok('changedCount=' + changedCount, r.changedCount === changedCount, 'actual=' + String(r.changedCount))
  for (const s of expectSkipped) {
    const hit = (r.skipped ?? []).find((x) => x.id === s.id)
    ok('skipped: ' + s.id + '（' + s.reasonPart + '）', !!hit && hit.reason.includes(s.reasonPart), hit ? hit.reason : '未跳过')
  }
  ok('有变更时返回写回字节', r.bytes instanceof Uint8Array && r.bytes.length > 0)

  // ---- 结构级 ----
  const zb = await JSZip.loadAsync(before)
  const za = await JSZip.loadAsync(Buffer.from(r.bytes))
  const names = Object.keys(zb.files).sort()
  ok('zip 条目集合一致', JSON.stringify(names) === JSON.stringify(Object.keys(za.files).sort()))
  const diff = []
  for (const n of names) {
    if (expectedTargetEntries[n] !== undefined) continue
    const cb = await zb.files[n].async('nodebuffer')
    const ca = await za.files[n].async('nodebuffer')
    if (!cb.equals(ca)) diff.push(n)
  }
  ok('★ 除目标条目外全部逐字节一致', diff.length === 0, diff.length ? '差异: ' + diff.join(', ') : '字体/样式/结构载体未动')

  for (const [n, expected] of Object.entries(expectedTargetEntries)) {
    const ca = await za.files[n].async('string')
    const same = ca === expected
    ok('★ 目标条目与手算期望全等: ' + n, same)
    if (!same) {
      console.log('    期望: ' + expected)
      console.log('    实际: ' + ca)
    }
  }

  // ---- 往返 ----
  const ex2 = await surgicalExtract(Buffer.from(r.bytes), ext)
  const map2 = new Map((ex2.units ?? []).map((u) => [u.id, u.text]))
  for (const [id, t] of Object.entries(expectedUnitTexts)) {
    ok('往返 extract 文本: ' + id, map2.get(id) === t, JSON.stringify(map2.get(id)))
  }

  if (extraChecks) extraChecks(await za.files[Object.keys(expectedTargetEntries)[0]].async('string'))
  return { before, after: Buffer.from(r.bytes) }
}

/* ============================================================
 * 样本文件（手工构造最小但真实的结构）
 * ============================================================ */

const XMLDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

// ---------- DOCX：粗体标题 + 正文 + 拆 3 run 的段落 + 表格 ----------
const DOCX_XML = XMLDECL +
'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
'<w:p><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>项目合同摘要</w:t></w:r></w:p>' +
'<w:p><w:r><w:t>甲方与乙方经友好协商，就设备采购事宜达成如下条款。</w:t></w:r></w:p>' +
'<w:p><w:r><w:t>基准金额 </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>100</w:t></w:r><w:r><w:t> 元，交付日期以合同附件为准。</w:t></w:r></w:p>' +
'<w:tbl><w:tr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>数量</w:t></w:r></w:p></w:tc></w:tr>' +
'<w:tr><w:tc><w:p><w:r><w:t>设备A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>3</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
'<w:p><w:r><w:t>本合同一式两份，双方各执一份。</w:t></w:r></w:p>' +
'<w:p><w:r><w:t>转义测试</w:t></w:r></w:p>' +
'<w:sectPr/></w:body></w:document>'

const DOCX_FILES = {
  '[Content_Types].xml': XMLDECL + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': XMLDECL + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml': DOCX_XML
}

const DOCX_EXPECTED = DOCX_XML
  .replace('<w:t>100</w:t>', '<w:t>99999</w:t>')
  .replace('<w:t>设备A</w:t>', '<w:t>设备B</w:t>')
  .replace('<w:t>转义测试</w:t>', '<w:t>转义&lt;&amp;&gt;&quot;&apos;中文完毕</w:t>')

const DOCX_EDITS = [
  // 部分替换：变化只落在中间 run（100→99999），首尾 run 与斜体 rPr 一字不动
  { id: 'word/document.xml#2', newText: '基准金额 99999 元，交付日期以合同附件为准。' },
  { id: 'word/document.xml#5', newText: '设备B' },
  // 整段替换 + XML 特殊字符转义
  { id: 'word/document.xml#8', newText: '转义<&>"\'中文完毕' },
  // 与原文相同 → skipped
  { id: 'word/document.xml#1', newText: '甲方与乙方经友好协商，就设备采购事宜达成如下条款。' },
  // id 失效 → skipped
  { id: 'word/document.xml#99', newText: '不存在的段落' }
]

// ---------- XLSX：sharedStrings（普通 + 富文本 si + 前导空格）+ inlineStr ----------
const XLSX_SHARED = XMLDECL +
'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="5" uniqueCount="4">' +
'<si><t>产品名称</t></si>' +
'<si><r><rPr><b/></rPr><t>富文本</t></r><r><t>加粗段</t></r></si>' +
'<si><t xml:space="preserve">  前导空格值  </t></si>' +
'<si><t>不变单元格</t></si></sst>'

const XLSX_SHEET = XMLDECL +
'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
'<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
'<row r="2"><c r="A2" t="inlineStr"><is><t>内联文本</t></is></c><c r="B2" t="s"><v>2</v></c></row>' +
'<row r="3"><c r="A3" t="s"><v>3</v></c></row>' +
'</sheetData></worksheet>'

const XLSX_FILES = {
  '[Content_Types].xml': XMLDECL + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  '_rels/.rels': XMLDECL + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  'xl/workbook.xml': XMLDECL + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': XMLDECL + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
  'xl/sharedStrings.xml': XLSX_SHARED,
  'xl/worksheets/sheet1.xml': XLSX_SHEET
}

const XLSX_EXPECTED_SHARED = XLSX_SHARED
  .replace('<si><t>产品名称</t></si>', '<si><t>产品全称</t></si>')
  .replace('<r><t>加粗段</t></r>', '<r><t>改写段</t></r>')
  .replace('<t xml:space="preserve">  前导空格值  </t>', '<t xml:space="preserve">  前导空格改  </t>')

const XLSX_EXPECTED_SHEET = XLSX_SHEET.replace('<t>内联文本</t>', '<t>内联新文本</t>')

const XLSX_EDITS = [
  // 普通共享串
  { id: 'xl/sharedStrings.xml#0', newText: '产品全称' },
  // 富文本 si：变化只落在第二个 <r><t>（加粗→改写），第一个 run 与 rPr 原样
  { id: 'xl/sharedStrings.xml#1', newText: '富文本改写段' },
  // 首尾空格保留（xml:space="preserve" 维持）
  { id: 'xl/sharedStrings.xml#2', newText: '  前导空格改  ' },
  // inlineStr
  { id: 'xl/worksheets/sheet1.xml#0', newText: '内联新文本' },
  // 未变化 → skipped
  { id: 'xl/sharedStrings.xml#3', newText: '不变单元格' }
]

// ---------- PPTX：2 页、多文本框 ----------
function slideXml(texts) {
  return XMLDECL +
'<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>' +
texts.map((t) => '<p:sp><p:txBody><a:p><a:r><a:t>' + t + '</a:t></a:r></a:p></p:txBody></p:sp>').join('') +
'</p:spTree></p:cSld></p:sld>'
}

const PPTX_FILES = {
  '[Content_Types].xml': XMLDECL + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
  '_rels/.rels': XMLDECL + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
  'ppt/presentation.xml': XMLDECL + '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>',
  'ppt/slides/slide1.xml': slideXml(['第一页标题', '第一页正文']),
  'ppt/slides/slide2.xml': slideXml(['第二页要点'])
}

const PPTX_EXPECTED_S1 = PPTX_FILES['ppt/slides/slide1.xml']
  .replace('<a:t>第一页标题</a:t>', '<a:t>P1 &lt;标&gt; &amp; &quot;引&quot; &apos;注&apos; 中文</a:t>')
const PPTX_EXPECTED_S2 = PPTX_FILES['ppt/slides/slide2.xml']
  .replace('<a:t>第二页要点</a:t>', '<a:t>第二页·要点已改</a:t>')

const PPTX_EDITS = [
  { id: 'ppt/slides/slide1.xml#0', newText: 'P1 <标> & "引" \'注\' 中文' },
  { id: 'ppt/slides/slide2.xml#0', newText: '第二页·要点已改' },
  { id: 'ppt/slides/slide1.xml#1', newText: '第一页正文' } // 未变化 → skipped
]

// ---------- EPUB：2 个 xhtml 章节 ----------
const EPUB_CH1 = '<?xml version="1.0" encoding="UTF-8"?>\n' +
'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body>' +
'<h1>第一章 起点</h1><p>清晨的<b>雨</b>落在屋檐上。</p></body></html>'
const EPUB_CH2 = '<?xml version="1.0" encoding="UTF-8"?>\n' +
'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head><body>' +
'<h2>第二章 转折</h2><p>他推开门，看见了那封信。</p><ul><li>第一条待办</li><li>第二条待办</li></ul></body></html>'

const EPUB_FILES = {
  'META-INF/container.xml': XMLDECL + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  'content.opf': XMLDECL + '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:test</dc:identifier><dc:title>测试书</dc:title></metadata><manifest><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
  'chapter1.xhtml': EPUB_CH1,
  'chapter2.xhtml': EPUB_CH2
}

const EPUB_EXPECTED_CH1 = EPUB_CH1
  .replace('<h1>第一章 起点</h1>', '<h1>第&lt;一&gt;章 &amp; &quot;题&quot; &apos;注&apos;</h1>')
  .replace('<p>清晨的<b>雨</b>落在屋檐上。</p>', '<p>清晨的<b>雨</b>停在了屋檐上。</p>')
const EPUB_EXPECTED_CH2 = EPUB_CH2.replace('<li>第一条待办</li>', '<li>第一条已完成</li>')

const EPUB_EDITS = [
  // 叶子块内行内标签保留：变化只落在 <b> 之后的字符数据
  { id: 'chapter1.xhtml#1', newText: '清晨的雨停在了屋檐上。' },
  // 整块替换 + 转义
  { id: 'chapter1.xhtml#0', newText: '第<一>章 & "题" \'注\'' },
  { id: 'chapter2.xhtml#2', newText: '第一条已完成' },
  { id: 'chapter2.xhtml#1', newText: '他推开门，看见了那封信。' } // 未变化 → skipped
]

// ---------- ODT：标题 + 段落 + span 行内样式 + tab 占位符 ----------
const ODF_NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"'
const ODT_XML = '<?xml version="1.0" encoding="UTF-8"?>\n' +
'<office:document-content ' + ODF_NS + ' office:version="1.2"><office:body><office:text>' +
'<text:h text:outline-level="1">会议纪要标题</text:h>' +
'<text:p>与会人员：张三、李四。</text:p>' +
'<text:p>进度：<text:span text:style-name="T1">正常</text:span>，风险可控。</text:p>' +
'<text:p>缩进<text:tab/>制表结束</text:p>' +
'<text:p/>' +
'</office:text></office:body></office:document-content>'

const ODT_FILES = {
  'mimetype': 'application/vnd.oasis.opendocument.text',
  'content.xml': ODT_XML
}

const ODT_EXPECTED = ODT_XML
  .replace('<text:h text:outline-level="1">会议纪要标题</text:h>', '<text:h text:outline-level="1">纪要&lt;纪&gt; &amp; &quot;要&quot;</text:h>')
  .replace('<text:p>与会人员：张三、李四。</text:p>', '<text:p>与会人员：张三、李四、王五。</text:p>')
  .replace('<text:span text:style-name="T1">正常</text:span>', '<text:span text:style-name="T1">延迟</text:span>')

const ODT_EDITS = [
  // span 行内标签保留：变化只落在 span 内
  { id: 'content.xml#2', newText: '进度：延迟，风险可控。' },
  // 中部插入（李四 → 李四、王五）：空变化区间收敛
  { id: 'content.xml#1', newText: '与会人员：张三、李四、王五。' },
  // 整段替换 + 转义
  { id: 'content.xml#0', newText: '纪要<纪> & "要"' },
  // 含空白占位符（text:tab）→ skipped
  { id: 'content.xml#3', newText: '缩进制表改' }
]

// ---------- ODS：表格单元格 ----------
const ODS_XML = '<?xml version="1.0" encoding="UTF-8"?>\n' +
'<office:document-content ' + ODF_NS + ' xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="1.2"><office:body><office:spreadsheet>' +
'<table:table table:name="库存"><table:table-column/><table:table-row>' +
'<table:table-cell office:value-type="string"><text:p>库存量</text:p></table:table-cell>' +
'<table:table-cell office:value-type="string"><text:p>120</text:p></table:table-cell>' +
'</table:table-row></table:table>' +
'</office:spreadsheet></office:body></office:document-content>'

const ODS_FILES = { 'content.xml': ODS_XML }
const ODS_EXPECTED = ODS_XML.replace('<text:p>120</text:p>', '<text:p>135</text:p>')
const ODS_EDITS = [
  { id: 'content.xml#1', newText: '135' },
  { id: 'content.xml#0', newText: '库存量' } // 未变化 → skipped
]

// ---------- ODP：页面文本框 ----------
const ODP_XML = '<?xml version="1.0" encoding="UTF-8"?>\n' +
'<office:document-content ' + ODF_NS + ' xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" office:version="1.2"><office:body><office:presentation>' +
'<draw:page draw:name="page1"><draw:frame><draw:text-box>' +
'<text:p>开场白</text:p><text:p>第二行要点</text:p>' +
'</draw:text-box></draw:frame></draw:page>' +
'</office:presentation></office:body></office:document-content>'

const ODP_FILES = { 'content.xml': ODP_XML }
const ODP_EXPECTED = ODP_XML.replace('<text:p>开场白</text:p>', '<text:p>开场·白</text:p>')
const ODP_EDITS = [
  { id: 'content.xml#0', newText: '开场·白' },
  { id: 'content.xml#1', newText: '第二行要点' } // 未变化 → skipped
]

/* ============================================================
 * 渲染级：DOCX soffice → PDF → pdf.js 全文对比
 * ============================================================ */

async function toPdf(docxPath, outDir) {
  const res = await execFileP(SOFFICE, [
    '--headless',
    '-env:UserInstallation=' + LO_PROFILE,
    '--convert-to', 'pdf',
    '--outdir', outDir,
    docxPath
  ], { timeout: 120000 })
  const out = join(outDir, docxPath.split(/[\\/]/).pop().replace(/\.docx$/i, '') + '.pdf')
  return { out, res }
}

async function extractPdfText(pdfPath) {
  const data = await readFile(pdfPath)
  const task = pdfjs.getDocument({ data: new Uint8Array(data), verbosity: 0 })
  const pdf = await task.promise
  let text = ''
  const pages = pdf.numPages
  for (let i = 1; i <= pages; i++) {
    const p = await pdf.getPage(i)
    const tc = await p.getTextContent()
    text += tc.items.map((it) => String(it.str ?? '')).join('')
  }
  await task.destroy()
  return { pages, text }
}

async function docxRenderCheck(before, after) {
  console.log('\n==== DOCX 渲染级（soffice → PDF → pdf.js） ====')
  const outDir = join(WORK, 'pdf')
  await mkdir(outDir, { recursive: true })
  const beforePath = join(outDir, 'surgical-before.docx')
  const afterPath = join(outDir, 'surgical-after.docx')
  await writeFile(beforePath, before)
  await writeFile(afterPath, after)

  // soffice 串行执行
  const rb0 = await toPdf(beforePath, outDir)
  if (!rb0.res) throw new Error('soffice before 失败')
  const ra0 = await toPdf(afterPath, outDir)
  // rc=0 但产物不存在 = 失败
  const fsOk = async (p) => { try { await readFile(p); return true } catch { return false } }
  ok('soffice 产物存在（before/after）', (await fsOk(rb0.out)) && (await fsOk(ra0.out)))

  const rb = await extractPdfText(rb0.out)
  const ra = await extractPdfText(ra0.out)
  console.log('  before: ' + rb.pages + ' 页 / after: ' + ra.pages + ' 页')
  ok('页数相同（分页布局未变）', rb.pages === ra.pages)

  const OLD1 = '基准金额 100 元，交付日期以合同附件为准。'
  const NEW1 = '基准金额 99999 元，交付日期以合同附件为准。'
  ok('新文字已出现', clean(ra.text).includes(clean(NEW1)))
  ok('旧文字已消失', !clean(ra.text).includes(clean(OLD1)))

  // pdf.js 会把 CJK 与拉丁间隙拆成独立文本项 → 必须剔除空白后全文逐字符比
  const expectAfter = clean(rb.text)
    .replace(clean(OLD1), clean(NEW1))
    .replace(clean('设备A'), clean('设备B'))
    .replace(clean('转义测试'), clean('转义<&>"\'中文完毕'))
  ok('★ 全文对比：除目标文字外逐字符一致（剔除提取器空白切分）', clean(ra.text) === expectAfter,
    'before ' + clean(rb.text).length + ' 字符 / after ' + clean(ra.text).length + ' 字符')
  ok('表格内容未受影响', clean(ra.text).includes(clean('设备B')) && clean(ra.text).includes('3') && clean(ra.text).includes(clean('项目合同摘要')))
}

/* ============================================================
 * 主流程
 * ============================================================ */

async function main() {
  await mkdir(WORK, { recursive: true })

  // ---- DOCX ----
  const docx = await surgicalCase('DOCX', {
    ext: 'docx',
    files: DOCX_FILES,
    edits: DOCX_EDITS,
    expectFormat: 'docx',
    changedCount: 3,
    expectSkipped: [
      { id: 'word/document.xml#1', reasonPart: '文本未变化' },
      { id: 'word/document.xml#99', reasonPart: '段落不存在' }
    ],
    expectedTargetEntries: { 'word/document.xml': DOCX_EXPECTED },
    expectedUnitTexts: {
      'word/document.xml#0': '项目合同摘要',
      'word/document.xml#2': '基准金额 99999 元，交付日期以合同附件为准。',
      'word/document.xml#5': '设备B',
      'word/document.xml#8': '转义<&>"\'中文完毕'
    },
    extraChecks: (xml) => {
      ok('[DOCX] 3-run 段落：中间 run 替换、斜体 rPr 保留', xml.includes('<w:r><w:rPr><w:i/></w:rPr><w:t>99999</w:t></w:r>'))
      ok('[DOCX] 3-run 段落：首尾 run 字节原样', xml.includes('<w:r><w:t>基准金额 </w:t></w:r>') && xml.includes('<w:r><w:t> 元，交付日期以合同附件为准。</w:t></w:r>'))
      ok('[DOCX] XML 转义落地', xml.includes('转义&lt;&amp;&gt;&quot;&apos;中文完毕'))
    }
  })

  // ---- XLSX ----
  await surgicalCase('XLSX', {
    ext: 'xlsx',
    files: XLSX_FILES,
    edits: XLSX_EDITS,
    expectFormat: 'xlsx',
    changedCount: 4,
    expectSkipped: [{ id: 'xl/sharedStrings.xml#3', reasonPart: '文本未变化' }],
    expectedTargetEntries: {
      'xl/sharedStrings.xml': XLSX_EXPECTED_SHARED,
      'xl/worksheets/sheet1.xml': XLSX_EXPECTED_SHEET
    },
    expectedUnitTexts: {
      'xl/sharedStrings.xml#0': '产品全称',
      'xl/sharedStrings.xml#1': '富文本改写段',
      'xl/sharedStrings.xml#2': '  前导空格改  ',
      'xl/worksheets/sheet1.xml#0': '内联新文本'
    }
  })

  // ---- PPTX ----
  await surgicalCase('PPTX', {
    ext: 'pptx',
    files: PPTX_FILES,
    edits: PPTX_EDITS,
    expectFormat: 'pptx',
    changedCount: 2,
    expectSkipped: [{ id: 'ppt/slides/slide1.xml#1', reasonPart: '文本未变化' }],
    expectedTargetEntries: {
      'ppt/slides/slide1.xml': PPTX_EXPECTED_S1,
      'ppt/slides/slide2.xml': PPTX_EXPECTED_S2
    },
    expectedUnitTexts: {
      'ppt/slides/slide1.xml#0': 'P1 <标> & "引" \'注\' 中文',
      'ppt/slides/slide2.xml#0': '第二页·要点已改'
    }
  })

  // ---- EPUB ----
  await surgicalCase('EPUB', {
    ext: 'epub',
    files: EPUB_FILES,
    edits: EPUB_EDITS,
    expectFormat: 'epub',
    changedCount: 3,
    expectSkipped: [{ id: 'chapter2.xhtml#1', reasonPart: '文本未变化' }],
    expectedTargetEntries: {
      'chapter1.xhtml': EPUB_EXPECTED_CH1,
      'chapter2.xhtml': EPUB_EXPECTED_CH2
    },
    expectedUnitTexts: {
      'chapter1.xhtml#1': '清晨的雨停在了屋檐上。',
      'chapter1.xhtml#0': '第<一>章 & "题" \'注\'',
      'chapter2.xhtml#2': '第一条已完成'
    },
    extraChecks: (xml) => {
      ok('[EPUB] 行内标签 <b> 原样保留', xml.includes('<p>清晨的<b>雨</b>停在了屋檐上。</p>'))
    }
  })

  // ---- ODT ----
  await surgicalCase('ODT', {
    ext: 'odt',
    files: ODT_FILES,
    edits: ODT_EDITS,
    expectFormat: 'odt',
    changedCount: 3,
    expectSkipped: [{ id: 'content.xml#3', reasonPart: '空白占位符' }],
    expectedTargetEntries: { 'content.xml': ODT_EXPECTED },
    expectedUnitTexts: {
      'content.xml#2': '进度：延迟，风险可控。',
      'content.xml#1': '与会人员：张三、李四、王五。',
      'content.xml#0': '纪要<纪> & "要"'
    },
    extraChecks: (xml) => {
      ok('[ODT] span 行内样式原样保留', xml.includes('<text:span text:style-name="T1">延迟</text:span>'))
      ok('[ODT] text:tab 占位符段落未被触碰', xml.includes('<text:p>缩进<text:tab/>制表结束</text:p>'))
    }
  })

  // ---- ODS ----
  await surgicalCase('ODS', {
    ext: 'ods',
    files: ODS_FILES,
    edits: ODS_EDITS,
    expectFormat: 'ods',
    changedCount: 1,
    expectSkipped: [{ id: 'content.xml#0', reasonPart: '文本未变化' }],
    expectedTargetEntries: { 'content.xml': ODS_EXPECTED },
    expectedUnitTexts: { 'content.xml#1': '135', 'content.xml#0': '库存量' }
  })

  // ---- ODP ----
  await surgicalCase('ODP', {
    ext: 'odp',
    files: ODP_FILES,
    edits: ODP_EDITS,
    expectFormat: 'odp',
    changedCount: 1,
    expectSkipped: [{ id: 'content.xml#1', reasonPart: '文本未变化' }],
    expectedTargetEntries: { 'content.xml': ODP_EXPECTED },
    expectedUnitTexts: { 'content.xml#0': '开场·白', 'content.xml#1': '第二行要点' }
  })

  // ---- 渲染级（DOCX）----
  await docxRenderCheck(docx.before, docx.after)

  console.log('\n通过 ' + pass + '，失败 ' + fail)
  if (fail > 0) {
    process.exitCode = 1
  } else {
    console.log('\n★ 结论：7 格式手术式编辑在结构级全绿、DOCX 渲染级全绿——「编辑后原格式排版完全不变」核心层成立。')
  }
}

void main()
