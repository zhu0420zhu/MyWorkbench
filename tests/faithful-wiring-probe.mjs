/**
 * Phase 3 接线验证 · 保真编辑渲染层链路的最小端到端探针
 * ============================================================
 * 复刻 DocsViewer 'faithful' 模式的数据链路（不进 Electron，直接调主进程函数）：
 *   造真实最小 DOCX（含 3-run 拆分段落）→ surgicalExtract → 模拟一次 newText 修改
 *   → surgicalApply → 按 surgicalIpc 同款语义落盘（先 copy .bak 再原子写回）
 * 断言：
 *   1. extract ok 且单元包含 3-run 段落合并后的完整文本；
 *   2. apply ok、changedCount=1、无 skipped；
 *   3. 备份 .bak 存在且与原文件逐字节一致；
 *   4. 写回后 zip 条目集合一致，除 word/document.xml 外所有条目逐字节一致；
 *   5. document.xml 与手算期望全等（只有目标 run 的 100→99999，斜体 rPr 与其余 run 一字不动）；
 *   6. 往返 extract 文本一致；
 *   7. 无修改（newText===原文）时 changedCount=0、不产出写回字节（不落盘语义）。
 *
 * 运行：
 *   NODE_OPTIONS="" node --experimental-loader=./tests/loader.mjs --experimental-strip-types tests/faithful-wiring-probe.mjs
 */
import JSZip from 'jszip'
import { mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { surgicalExtract, surgicalApply } from '../src/main/docs/surgical/index'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, 'pdf-audit', 'scratch', 'faithful-wiring')
await rm(WORK, { recursive: true, force: true })
await mkdir(WORK, { recursive: true })

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  [PASS] ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? '  ' + detail : '')) }
}

/* ---- 1. 造真实最小 DOCX（JSZip，含 3-run 段落） ---- */
const XMLDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const DOCX_XML = XMLDECL +
'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
'<w:p><w:r><w:t>标题段落</w:t></w:r></w:p>' +
'<w:p><w:r><w:t>基准金额 </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>100</w:t></w:r><w:r><w:t> 元，交付日期以合同附件为准。</w:t></w:r></w:p>' +
'<w:p><w:r><w:t>结尾段落</w:t></w:r></w:p>' +
'<w:sectPr/></w:body></w:document>'
const FILES = {
  '[Content_Types].xml': XMLDECL + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': XMLDECL + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml': DOCX_XML
}
const zip = new JSZip()
for (const [n, c] of Object.entries(FILES)) zip.file(n, c)
const original = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })

const docxPath = join(WORK, 'sample.docx')
await writeFile(docxPath, original)
console.log('样本 DOCX: ' + docxPath + ' (' + original.length + 'B)')

/* ---- 2. surgicalExtract ---- */
const buf0 = await readFile(docxPath)
const ex = await surgicalExtract(buf0, '.docx')
ok('extract ok & format=docx', ex.ok === true && ex.format === 'docx', 'err=' + String(ex.error))
const units = ex.units ?? []
ok('extract 产出单元', units.length >= 3, units.length + ' 个')
const target = units.find((u) => u.text.startsWith('基准金额'))
ok('3-run 段落合并为完整文本', !!target && target.text === '基准金额 100 元，交付日期以合同附件为准。', JSON.stringify(target?.text))
ok('单元 id 稳定指向 document.xml', !!target && target.id.startsWith('word/document.xml#'), target?.id)

/* ---- 3. 模拟 DocsViewer 的一次 newText 修改 ---- */
const edits = [{ id: target.id, newText: '基准金额 99999 元，交付日期以合同附件为准。' }]
const r = await surgicalApply(buf0, '.docx', edits)
ok('apply ok', r.ok === true, String(r.error ?? ''))
ok('changedCount=1', r.changedCount === 1, 'actual=' + String(r.changedCount))
ok('无 skipped', (r.skipped ?? []).length === 0)
ok('返回写回字节', r.bytes instanceof Uint8Array && r.bytes.length > 0)

/* ---- 4. 按 surgicalIpc 同款语义落盘：先备份 .bak 再写回 ---- */
const backupPath = docxPath + '.bak'
await copyFile(docxPath, backupPath)
await writeFile(docxPath, Buffer.from(r.bytes))
const bakBuf = await readFile(backupPath)
ok('备份 .bak 存在', bakBuf.length > 0)
ok('★ 备份与原文件逐字节一致', bakBuf.equals(original))

/* ---- 5. 结构级断言 ---- */
const zb = await JSZip.loadAsync(original)
const za = await JSZip.loadAsync(await readFile(docxPath))
const names = Object.keys(zb.files).sort()
ok('zip 条目集合一致', JSON.stringify(names) === JSON.stringify(Object.keys(za.files).sort()))
const diff = []
for (const n of names) {
  if (n === 'word/document.xml') continue
  if (!zb.files[n].async || !(await (await zb.files[n].async('nodebuffer')).equals(await za.files[n].async('nodebuffer')))) diff.push(n)
}
ok('★ 除 word/document.xml 外全部条目逐字节一致', diff.length === 0, diff.length ? '差异: ' + diff.join(', ') : '')

const expectedXml = DOCX_XML.replace('<w:t>100</w:t>', '<w:t>99999</w:t>')
const actualXml = await za.files['word/document.xml'].async('string')
ok('★ document.xml 与手算期望全等（只有目标 run 文字变化，斜体 rPr 与其余 run 不动）', actualXml === expectedXml)

/* ---- 6. 往返 ---- */
const ex2 = await surgicalExtract(await readFile(docxPath), '.docx')
const map2 = new Map((ex2.units ?? []).map((u) => [u.id, u.text]))
ok('往返 extract 文本一致', map2.get(target.id) === '基准金额 99999 元，交付日期以合同附件为准。', JSON.stringify(map2.get(target.id)))

/* ---- 7. 无修改语义：changed=0 不落盘 ---- */
const r0 = await surgicalApply(await readFile(docxPath), '.docx', [{ id: target.id, newText: '基准金额 99999 元，交付日期以合同附件为准。' }])
ok('无修改时 changedCount=0', r0.ok === true && r0.changedCount === 0)
ok('无修改时不产出写回字节（不落盘语义）', r0.bytes == null)

console.log('\nRESULT: ' + (fail === 0 ? `ALL PASS (${pass})` : `FAIL (${fail}/${pass + fail})`))
process.exit(fail === 0 ? 0 : 1)
