/**
 * 验收「PDF 压缩档位三档真实分化」（P1#4）。
 *
 * 旧实现：三档只切 `useObjectStreams`
 *   - 低档 useObjectStreams:false → 产出比原文件大（实测 +60.9%）
 *   - 中/高走同一分支 → 产出逐字节相同
 *
 * 新实现：三档各自走不同管线（src/renderer/src/utils/pdfCompress.ts）
 *   低 = 重建页面（保留元数据） / 中 = 低 + 清元数据 / 高 = 中 + 去链接热区 + 剪枝
 * 断言：
 *   1) 三档产出字节数严格递减（压缩强度递增）且互不相同
 *   2) 任何档位都不输出比原文件更大的结果（无收益时保留原文件）
 *   3) 页面可见内容不因子档位处理而改变：页数 / 页尺寸 / 旋转 / 裁剪框 / 内容流字节
 */
import { readFile } from 'node:fs/promises'
import { PDFDocument, PDFArray, PDFName, PDFRawStream, PDFRef, StandardFonts, rgb } from 'pdf-lib'
import { structureCompressPdf } from '../../src/renderer/src/utils/pdfCompress.ts'

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  [PASS] ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? '  ' + detail : '')) }
}

async function mkTextPdf(n) {
  const d = await PDFDocument.create()
  d.setTitle('季度报表'); d.setAuthor('灵墨'); d.setSubject('测试文档'); d.setKeywords(['报表', '测试'])
  const f = await d.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < n; i++) {
    const p = d.addPage([595, 842])
    p.drawText('Quarterly report page ' + (i + 1), { x: 60, y: 760, size: 14, font: f, color: rgb(0, 0, 0) })
  }
  return await d.save()
}

/** 收集一页的内容流字节（归一化 Contents：单流或数组） */
function pageContentBytes(doc, page) {
  const ctx = doc.context
  const contents = page.node.get(PDFName.of('Contents'))
  const parts = []
  const one = (o) => {
    const stream = o instanceof PDFRef ? ctx.lookup(o) : o
    if (stream instanceof PDFRawStream) parts.push(Buffer.from(stream.contents))
  }
  if (contents instanceof PDFArray) contents.asArray().forEach(one)
  else if (contents) one(contents)
  return Buffer.concat(parts)
}

function pageFingerprint(doc) {
  return doc.getPages().map((p) => {
    const s = p.getSize()
    const crop = p.getCropBox()
    return {
      w: Math.round(s.width * 100) / 100,
      h: Math.round(s.height * 100) / 100,
      rot: ((p.getRotation().angle % 360) + 360) % 360,
      cropW: Math.round((crop.width) * 100) / 100,
      cropH: Math.round((crop.height) * 100) / 100,
      content: pageContentBytes(doc, p).toString('latin1')
    }
  })
}

const samples = [
  ['real-large-plain.pdf（34页·带无障碍标签与链接）', await readFile('tests/pdf-audit/qa-fixtures/real-large-plain.pdf')],
  ['enhance-source.pdf（3页）', await readFile('tests/pdf-audit/fixtures/enhance-source.pdf')],
  ['text-20p-meta.pdf（20页·带元数据，现造）', await mkTextPdf(20)]
]

const levels = ['low', 'medium', 'high']
const CN = { low: '低', medium: '中', high: '高' }

for (const [name, orig] of samples) {
  console.log('\n' + '='.repeat(72))
  console.log('样本: ' + name + '   原文件 ' + orig.length + ' B')
  console.log('='.repeat(72))
  const srcDoc = await PDFDocument.load(orig, { ignoreEncryption: true })
  const srcFp = pageFingerprint(srcDoc)

  const sizes = {}
  for (const lv of levels) {
    const res = await structureCompressPdf(orig, lv)
    sizes[lv] = res.bytes.byteLength
    const t = res.bytes.byteLength < orig.length ? '✅ 缩小' : '⚠ 无收益→保留原文件'
    console.log(
      '  ' + CN[lv] + '档  ' + String(res.bytes.byteLength).padStart(8) + ' B  (' +
      (res.bytes.byteLength - orig.length >= 0 ? '+' : '') + (res.bytes.byteLength - orig.length) +
      ')  ' + t +
      '  清元数据=' + res.stats.metadataCleared +
      ' 去链接=' + res.stats.droppedLinkAnnots +
      ' 剪枝=' + res.stats.prunedObjects
    )
    // 2) 永不输出更大的文件
    check(CN[lv] + '档不劣于原文件', res.bytes.byteLength <= orig.length, res.bytes.byteLength + ' ≤ ' + orig.length)

    // 3) 内容保真：页数 + 页指纹
    const outDoc = await PDFDocument.load(res.bytes, { ignoreEncryption: true })
    check(CN[lv] + '档页数一致', outDoc.getPageCount() === srcDoc.getPageCount(), outDoc.getPageCount() + ' = ' + srcDoc.getPageCount())
    const outFp = pageFingerprint(outDoc)
    const same = JSON.stringify(outFp) === JSON.stringify(srcFp)
    check(CN[lv] + '档页面可见内容/尺寸/旋转/裁剪框未变', same, same ? '' : '存在差异')
  }

  // 1) 三档严格递减（低 > 中 > 高）且互不相同
  check('三档字节数互不相同', new Set(levels.map((l) => sizes[l])).size === 3, JSON.stringify(sizes))
  check('压缩强度顺序正确（低 > 中 > 高）', sizes.low > sizes.medium && sizes.medium > sizes.high, sizes.low + ' > ' + sizes.medium + ' > ' + sizes.high)
}

console.log('\n' + '='.repeat(72))
console.log(`结果: ${pass} 项通过, ${fail} 项失败`)
console.log('='.repeat(72))
process.exit(fail ? 1 : 0)
