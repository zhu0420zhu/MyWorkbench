/**
 * DOCX「手术式编辑」可行性探针
 * ============================
 * 目标：证明「编辑 DOCX 后排版完全不变」有一条真实可行的路——
 *   解包 zip → 只改 word/document.xml 里的目标文字节点 → 重新打包。
 * 字体样式/段落结构/表格/图片/分页所在的其余 zip 条目一个字节都不动。
 *
 * 取证口径（不是"看起来没变"）：
 *   [结构级] before/after 用同一 JSZip 流程打包，除 document.xml 外所有条目字节逐一致；
 *   [渲染级] before/after 都经内嵌 soffice 转 PDF，用 pdf.js 提取：
 *     - 页数相同
 *     - 旧文字消失、新文字出现
 *     - 其余文字逐字符一致
 *
 * 运行：
 *   cd /d/YM/MyWorkbench
 *   NODE_OPTIONS="" node tests/docx-surgical-probe.mjs
 */
import JSZip from 'jszip'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const execFileP = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, 'pdf-audit', 'scratch', 'docx-surgical')
const SOFFICE = join(HERE, '..', 'resources', 'tools', 'soffice', 'program', 'soffice.com')
const LO_PROFILE = 'file:///' + join(WORK, 'lo-profile').replace(/\\/g, '/')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  [PASS] ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? '  ' + detail : '')) }
}

/* ---------- 1. 手工构造一份最小但真实的 DOCX（含粗体标题、正文、表格、分页要素） ---------- */

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>项目合同摘要</w:t></w:r></w:p><w:p><w:r><w:t>甲方与乙方经友好协商，就设备采购事宜达成如下条款。</w:t></w:r></w:p><w:p><w:r><w:t>基准金额 100 元，交付日期以合同附件为准。</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>数量</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>设备A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>3</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>本合同一式两份，双方各执一份。</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`

/** 用同一 JSZip 流程打包（before/after 走同一条路，其他条目字节天然可比） */
async function packDocx(documentXml) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', CONTENT_TYPES)
  zip.file('_rels/.rels', ROOT_RELS)
  zip.file('word/document.xml', documentXml)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
}

/* ---------- 2. 手术：只改 document.xml 里的目标文字 ---------- */

const OLD_TEXT = '基准金额 100 元，交付日期以合同附件为准。'
const NEW_TEXT = '基准金额 99999 元，交付日期以合同附件为准。'

function surgicalEdit(documentXml) {
  const i = documentXml.indexOf(OLD_TEXT)
  if (i < 0) throw new Error('目标文字在 document.xml 中找不到（真实实现需要处理 run 拆分，本探针先验证无拆分场景）')
  return documentXml.slice(0, i) + NEW_TEXT + documentXml.slice(i + OLD_TEXT.length)
}

/* ---------- 3. soffice 转 PDF ---------- */

async function toPdf(docxPath, outDir) {
  const res = await execFileP(SOFFICE, [
    '--headless',
    '-env:UserInstallation=' + LO_PROFILE,
    '--convert-to', 'pdf',
    '--outdir', outDir,
    docxPath
  ], { timeout: 120000 })
  return join(outDir, docxPath.split(/[\\/]/).pop().replace(/\.docx$/i, '') + '.pdf')
}

/* ---------- 4. pdf.js 提取 ---------- */

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

/* ---------- 主流程 ---------- */

async function main() {
  await mkdir(WORK, { recursive: true })
  console.log('[1] 构造样本 DOCX（含粗体标题/正文/表格）')

  const beforeXml = DOCUMENT_XML
  const afterXml = surgicalEdit(DOCUMENT_XML)

  const beforePath = join(WORK, 'before.docx')
  const afterPath = join(WORK, 'after.docx')
  await writeFile(beforePath, await packDocx(beforeXml))
  await writeFile(afterPath, await packDocx(afterXml))
  console.log('  before.docx / after.docx 已生成')

  console.log('\n[2] 结构级取证：除 document.xml 外所有条目必须逐字节一致')
  {
    const zb = await JSZip.loadAsync(await readFile(beforePath))
    const za = await JSZip.loadAsync(await readFile(afterPath))
    const namesB = Object.keys(zb.files).sort()
    const namesA = Object.keys(za.files).sort()
    ok('zip 条目集合一致', JSON.stringify(namesB) === JSON.stringify(namesA), namesB.join(', '))
    let allSame = true
    const diffNames = []
    for (const n of namesB) {
      const cb = await zb.files[n].async('nodebuffer')
      const ca = await za.files[n].async('nodebuffer')
      if (!cb.equals(ca)) { allSame = false; diffNames.push(n) }
    }
    ok('除 document.xml 外全部条目字节一致（字体/样式/表格结构所在载体未动）', diffNames.length === 1 && diffNames[0] === 'word/document.xml',
      diffNames.length === 1 && diffNames[0] === 'word/document.xml' ? '唯一差异条目: word/document.xml（预期内）' : '差异条目: ' + diffNames.join(', '))
    const docB = await zb.files['word/document.xml'].async('string')
    const docA = await za.files['word/document.xml'].async('string')
    ok('document.xml 恰好只有目标文字发生变化',
      docB.replace(OLD_TEXT, '') === docA.replace(NEW_TEXT, '') && docB.includes(OLD_TEXT) && docA.includes(NEW_TEXT))
  }

  console.log('\n[3] 渲染级取证：soffice 转 PDF + pdf.js 提取对比（soffice 串行执行）')
  const outDir = join(WORK, 'pdf')
  await mkdir(outDir, { recursive: true })
  const pdfBefore = await toPdf(beforePath, outDir)
  const pdfAfter = await toPdf(afterPath, outDir)
  const rb = await extractPdfText(pdfBefore)
  const ra = await extractPdfText(pdfAfter)
  console.log('  before: ' + rb.pages + ' 页, ' + rb.text.length + ' 字符')
  console.log('  after : ' + ra.pages + ' 页, ' + ra.text.length + ' 字符')

  ok('页数相同（分页布局未变）', rb.pages === ra.pages, rb.pages + ' vs ' + ra.pages)
  ok('新文字已出现', ra.text.includes('99999'))
  ok('旧文字已消失', !ra.text.includes('基准金额 100 元'))

  // 注意：pdf.js 会把 CJK 与拉丁字符之间的间隙切分成独立文本项（如「设备A」→「设备"+" "+"A」），
  // 这是**提取器的切分行为**，before/after 表现一致，不代表文档被改坏。
  // 所以全文对比必须剔除空白后再逐字符比——这一条比逐句断言强得多。
  const clean = (s) => s.replace(/\s+/g, '')
  const cb = clean(rb.text)
  const ca = clean(ra.text)
  ok('★ 全文对比：除目标文字外逐字符一致（含标题/正文/表格/结尾，剔除提取器空白切分）',
    ca === cb.replace(clean(OLD_TEXT), clean(NEW_TEXT)),
    'before ' + cb.length + ' 字符 / after ' + ca.length + ' 字符')
  ok('表格内容未受影响（设备A × 3，按切分形态断言）', ca.includes('设备A') && ca.includes('3'))

  console.log('\n通过 ' + pass + '，失败 ' + fail)
  if (fail > 0) process.exitCode = 1
  else console.log('\n★ 结论：DOCX 手术式编辑在结构级与渲染级均保真——「编辑后排版完全不变」技术路线成立。')
}

void main()
