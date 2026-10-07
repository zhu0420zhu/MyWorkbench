/**
 * Phase 4 独立验收抽查 · phase4-verify（未预告断言组合，不复用实现者自报数据）
 * =====================================================================
 * 自造含 3-run 拆分段落的最小 DOCX，直接调主进程函数链
 * （surgicalExtract / surgicalApply，参考 tests/faithful-wiring-probe.mjs 写法），
 * 一次 apply 改两处：
 *   段1（部分替换）："基准金额 100 元，交付日期以合同附件为准。"
 *                    → "基准金额 99 元整，交付日期以合同附件为准。"（100→99 元整）
 *   段2（纯尾部追加）："结尾段落。" → "结尾段落。以上条款经双方确认生效。"
 * 断言：
 *   1. extract ok，3 个非空单元，3-run 段合并文本正确；
 *   2. apply ok、changedCount=2、无 skipped；
 *   3. 落盘语义（.bak 先备份再写回）后备份与原文件逐字节一致；
 *   4. zip 条目集合一致，除 word/document.xml 外全部条目逐字节一致；
 *   5. document.xml 与手算期望全等：段0/sectPr/壳一字不动，斜体 rPr 完整保留，
 *      段1 首个 run（"基准金额 "）一字不动，变化只落在斜体 run 与第三 run 的文本内；
 *   6. 旧文字串在新 document.xml 中不存在，新文字串存在；
 *   7. 往返 extract：两个目标单元文本 = 各自 newText，未动单元文本不变，单元数仍为 3。
 *
 * 运行：
 *   NODE_OPTIONS="" node --experimental-loader=./tests/loader.mjs --experimental-strip-types tests/phase4-verify-probe.mjs
 */
import JSZip from 'jszip'
import { mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { surgicalExtract, surgicalApply } from '../src/main/docs/surgical/index'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, 'pdf-audit', 'scratch', 'phase4-verify')
await rm(WORK, { recursive: true, force: true })
await mkdir(WORK, { recursive: true })

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  [PASS] ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? '  ' + detail : '')) }
}

/* ---- 1. 自造最小 DOCX（段1 为 3-run 拆分：普通 + 斜体 + 普通） ---- */
const XMLDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const P0 = '<w:p><w:r><w:t>合同编号 HX-2026-001</w:t></w:r></w:p>'
const P1 =
  '<w:p><w:r><w:t>基准金额 </w:t></w:r>' +
  '<w:r><w:rPr><w:i/></w:rPr><w:t>100</w:t></w:r>' +
  '<w:r><w:t> 元，交付日期以合同附件为准。</w:t></w:r></w:p>'
const P2 = '<w:p><w:r><w:t>结尾段落。</w:t></w:r></w:p>'
const DOC_XML = XMLDECL +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
  P0 + P1 + P2 + '<w:sectPr/></w:body></w:document>'
const FILES = {
  '[Content_Types].xml': XMLDECL + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': XMLDECL + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml': DOC_XML
}
const zip = new JSZip()
for (const [n, c] of Object.entries(FILES)) zip.file(n, c)
const original = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })

const docxPath = join(WORK, 'phase4-sample.docx')
await writeFile(docxPath, original)
console.log('样本 DOCX: ' + docxPath + ' (' + original.length + 'B)')

/* ---- 2. extract ---- */
const ex = await surgicalExtract(original, '.docx')
ok('extract ok & format=docx', ex.ok === true && ex.format === 'docx', 'err=' + String(ex.error))
const units = ex.units ?? []
ok('extract 产出 3 个非空单元', units.length === 3, units.length + ' 个')
const u0 = units.find((u) => u.text.includes('合同编号'))
const u1 = units.find((u) => u.text.startsWith('基准金额'))
const u2 = units.find((u) => u.text.startsWith('结尾段落'))
ok('3-run 拆分段合并为完整文本', !!u1 && u1.text === '基准金额 100 元，交付日期以合同附件为准。', JSON.stringify(u1?.text))
ok('单元 id 指向 document.xml 段落序号', !!u0 && !!u1 && !!u2 && u0.id === 'word/document.xml#0' && u1.id === 'word/document.xml#1' && u2.id === 'word/document.xml#2', `${u0?.id} ${u1?.id} ${u2?.id}`)

/* ---- 3. 一次 apply 改两处：部分替换 + 纯尾部追加 ---- */
const NEW1 = '基准金额 99 元整，交付日期以合同附件为准。'
const NEW2 = '结尾段落。以上条款经双方确认生效。'
const edits = [
  { id: u1.id, newText: NEW1 },
  { id: u2.id, newText: NEW2 }
]
const r = await surgicalApply(original, '.docx', edits)
ok('apply ok', r.ok === true, String(r.error ?? ''))
ok('changedCount=2', r.changedCount === 2, 'actual=' + String(r.changedCount))
ok('无 skipped', (r.skipped ?? []).length === 0, JSON.stringify(r.skipped))
ok('返回写回字节', r.bytes instanceof Uint8Array && r.bytes.length > 0)

/* ---- 4. surgicalIpc 同款落盘语义：先 .bak 备份再原子写回 ---- */
const backupPath = docxPath + '.bak'
await copyFile(docxPath, backupPath)
await writeFile(docxPath, Buffer.from(r.bytes))
const bakBuf = await readFile(backupPath)
ok('★ 备份与原文件逐字节一致', bakBuf.equals(original))

/* ---- 5. 结构级：除 document.xml 外逐字节一致 ---- */
const zb = await JSZip.loadAsync(original)
const za = await JSZip.loadAsync(await readFile(docxPath))
const names = Object.keys(zb.files).sort()
ok('zip 条目集合一致', JSON.stringify(names) === JSON.stringify(Object.keys(za.files).sort()))
const diff = []
for (const n of names) {
  if (n === 'word/document.xml') continue
  const b = await zb.files[n].async('nodebuffer')
  const a = await za.files[n].async('nodebuffer')
  if (!b.equals(a)) diff.push(n)
}
ok('★ 除 word/document.xml 外全部条目逐字节一致', diff.length === 0, diff.length ? '差异: ' + diff.join(', ') : '')

/* ---- 6. document.xml 手算期望全等 ----
 * replaceChunkText 对段1（chunks: "基准金额 " | "100" | " 元，交付日期以合同附件为准。"）：
 *   prefix=5（"基准金额 "），suffix=13（"，交付日期以合同附件为准。"），
 *   变化区间 [5,10)，newMiddle="99 元整" 写入首个受影响块（斜体 run，继承 <w:i/>），
 *   第三块保留后缀 "，交付日期以合同附件为准。"，首块一字不动。
 * 段2：纯尾部追加 → appendMode，新中段 "以上条款经双方确认生效。" 挂到唯一 run 尾部。
 */
const P1_EXPECT =
  '<w:p><w:r><w:t>基准金额 </w:t></w:r>' +
  '<w:r><w:rPr><w:i/></w:rPr><w:t>99 元整</w:t></w:r>' +
  '<w:r><w:t>，交付日期以合同附件为准。</w:t></w:r></w:p>'
const P2_EXPECT = '<w:p><w:r><w:t>结尾段落。以上条款经双方确认生效。</w:t></w:r></w:p>'
const DOC_XML_EXPECT = XMLDECL +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
  P0 + P1_EXPECT + P2_EXPECT + '<w:sectPr/></w:body></w:document>'
const actualXml = await za.files['word/document.xml'].async('string')
ok('★ document.xml 与手算期望全等（段0/sectPr/壳一字不动，斜体 rPr 保留，首 run 原样）', actualXml === DOC_XML_EXPECT,
  actualXml === DOC_XML_EXPECT ? '' : '\n    expect: ' + DOC_XML_EXPECT.slice(200, 420) + '\n    actual: ' + actualXml.slice(200, 420))

/* ---- 7. 旧文字不残留 / 新文字存在 ---- */
ok('旧文字串 "基准金额 100" 已消失', !actualXml.includes('基准金额 100'))
ok('新文字串 "99 元整" 已写入斜体 run', actualXml.includes('<w:i/></w:rPr><w:t>99 元整</w:t>'))
ok('追加文字串已写入段2', actualXml.includes('结尾段落。以上条款经双方确认生效。'))

/* ---- 8. 往返 extract ---- */
const ex2 = await surgicalExtract(await readFile(docxPath), '.docx')
const map2 = new Map((ex2.units ?? []).map((u) => [u.id, u.text]))
ok('往返：单元数仍为 3', (ex2.units ?? []).length === 3)
ok('往返：段1 文本 = newText', map2.get('word/document.xml#1') === NEW1, JSON.stringify(map2.get('word/document.xml#1')))
ok('往返：段2 文本 = newText', map2.get('word/document.xml#2') === NEW2, JSON.stringify(map2.get('word/document.xml#2')))
ok('往返：未动单元 #0 文本不变', map2.get('word/document.xml#0') === u0?.text, JSON.stringify(map2.get('word/document.xml#0')))

console.log('\nRESULT: ' + (fail === 0 ? `ALL PASS (${pass})` : `FAIL (${fail}/${pass + fail})`))
process.exit(fail === 0 ? 0 : 1)
