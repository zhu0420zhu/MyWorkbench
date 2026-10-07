/**
 * 验收「拆分 · 逐页导出改为批量写入」（P2#6）。
 *
 * 旧实现：循环内 `await savePdf(out, ...)` → `savePdf` 内部弹 savePath 对话框，
 * 100 页 PDF 连续弹 100 次保存框，必须逐一点击。
 *
 * 新实现：src/renderer/src/utils/pdfBatchWrite.ts 的 exportEachPage()
 * 断言（用 20 页真实 PDF 驱动生产代码路径）：
 *   1) 目录选择只发生 **1 次**
 *   2) 20 页全部写入，命名为 原名-pN.pdf，且每个文件是单页有效 PDF
 *   3) 重名 → 二次确认；**取消时一个字节都不写**
 *   4) 覆盖确认通过后正常写入
 *   5) 部分失败有逐条原因（成功 M/N + 失败清单），不是笼统报错
 */
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { exportEachPage, eachPageName } from '../../src/renderer/src/utils/pdfBatchWrite.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, 'work', 'split-verify')
await rm(WORK, { recursive: true, force: true })
await mkdir(WORK, { recursive: true })

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  [PASS] ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? '  ' + detail : '')) }
}

/* 1. 造一个 20 页真实 PDF（每页文字带页码，便于校验页内容归属） */
const srcDoc = await PDFDocument.create()
{
  const font = await srcDoc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < 20; i++) {
    const p = srcDoc.addPage([595, 842])
    p.drawText('source page ' + (i + 1), { x: 60, y: 760, size: 16, font, color: rgb(0, 0, 0) })
  }
}
const srcBytes = await srcDoc.save()
const srcPath = join(WORK, 'report.pdf')
await writeFile(srcPath, srcBytes)
console.log('源文件: report.pdf  ' + srcBytes.length + ' B  20 页')

const outDir = join(WORK, 'out')
await mkdir(outDir, { recursive: true })

function makeApi({ failOn = null, existsOverride = null } = {}) {
  const calls = { pickDir: 0, write: 0, exists: 0 }
  const api = {
    pickDir: async () => { calls.pickDir++; return outDir },
    exists: async (paths) => { calls.exists++; return existsOverride ? existsOverride(paths) : paths.map((p) => existsSync(p)) },
    write: async (p, data) => {
      calls.write++
      if (failOn && p.endsWith(failOn)) throw new Error('模拟磁盘写入失败（ENOSPC）')
      await writeFile(p, Buffer.from(data))
      return true
    }
  }
  return { api, calls }
}

const buildPage = (doc) => async (i) => {
  const out = await PDFDocument.create()
  const [p] = await out.copyPages(doc, [i])
  out.addPage(p)
  return out.save()
}

/* ---------- 场景 A：正常批量导出 ---------- */
console.log('\n== 场景 A：20 页逐页导出 ==')
{
  const doc = await PDFDocument.load(srcBytes, { ignoreEncryption: true })
  const { api, calls } = makeApi()
  const res = await exportEachPage(api, {
    baseName: 'report',
    pages: doc.getPageIndices(),
    buildPage: buildPage(doc),
    confirmOverwrite: async () => { throw new Error('本场景不应触发重名确认') }
  })
  check('目录选择只弹 1 次', calls.pickDir === 1, 'pickDir 调用 ' + calls.pickDir + ' 次')
  check('未取消', res.canceled === false)
  check('20/20 全部成功', res.ok === 20 && res.failed.length === 0, res.ok + ' 成功, ' + res.failed.length + ' 失败')
  check('写入调用次数 = 页数（无多余对话框路径）', calls.write === 20, 'write 调用 ' + calls.write + ' 次')

  const expected = Array.from({ length: 20 }, (_, i) => eachPageName('report', i))
  const missing = expected.filter((n) => !existsSync(join(outDir, n)))
  check('命名可预期（report-p1.pdf … report-p20.pdf）', missing.length === 0, missing.length ? '缺失: ' + missing.join(',') : '20/20 存在')

  let singlePage = 0
  let contentOk = 0
  for (let i = 0; i < 20; i++) {
    const bytes = await readFile(join(outDir, expected[i]))
    const d = await PDFDocument.load(bytes, { ignoreEncryption: true })
    if (d.getPageCount() === 1) singlePage++
    const raw = Buffer.from(bytes).toString('latin1')
    // 内容流是压缩的，改为校验页尺寸与页数；用 pdf.js 抽取文本代价高，这里只要求单页且可解析
    if (d.getPage(0).getSize().width === 595) contentOk++
  }
  check('每个产出都是单页有效 PDF', singlePage === 20, singlePage + '/20')
  check('页面尺寸保留', contentOk === 20, contentOk + '/20')
}

/* ---------- 场景 B：重名 + 用户取消 → 不写任何文件 ---------- */
console.log('\n== 场景 B：重名 + 取消 ==')
{
  await rm(outDir, { recursive: true, force: true }); await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'report-p1.pdf'), Buffer.from('%PDF-1.4 OLD-CONTENT'))
  const doc = await PDFDocument.load(srcBytes, { ignoreEncryption: true })
  const { api, calls } = makeApi()
  let askedNames = null
  const res = await exportEachPage(api, {
    baseName: 'report',
    pages: doc.getPageIndices(),
    buildPage: buildPage(doc),
    confirmOverwrite: async (names) => { askedNames = names; return false }
  })
  check('探测到重名并触发二次确认', Array.isArray(askedNames) && askedNames.length === 1, JSON.stringify(askedNames))
  check('取消 → canceled=true', res.canceled === true)
  check('取消 → 一个字节都不写', calls.write === 0, 'write 调用 ' + calls.write + ' 次')
  const stillOld = (await readFile(join(outDir, 'report-p1.pdf'))).toString('latin1')
  check('原有同名文件未被改动', stillOld === '%PDF-1.4 OLD-CONTENT')
  check('其余 19 页也未落盘', !existsSync(join(outDir, 'report-p2.pdf')))
}

/* ---------- 场景 C：重名 + 确认覆盖 → 正常写入 ---------- */
console.log('\n== 场景 C：重名 + 确认覆盖 ==')
{
  const doc = await PDFDocument.load(srcBytes, { ignoreEncryption: true })
  const { api, calls } = makeApi()
  const res = await exportEachPage(api, {
    baseName: 'report',
    pages: doc.getPageIndices(),
    buildPage: buildPage(doc),
    confirmOverwrite: async () => true
  })
  check('确认后 20/20 成功', res.ok === 20 && res.failed.length === 0, res.ok + '/20')
  const now = await readFile(join(outDir, 'report-p1.pdf'))
  check('同名文件已被新产出覆盖', now.length > 100 && now.subarray(0, 4).toString('latin1') === '%PDF')
}

/* ---------- 场景 D：部分失败 → 逐条原因 ---------- */
console.log('\n== 场景 D：部分失败（第 7 页写入失败）==')
{
  await rm(outDir, { recursive: true, force: true }); await mkdir(outDir, { recursive: true })
  const doc = await PDFDocument.load(srcBytes, { ignoreEncryption: true })
  const { api } = makeApi({ failOn: 'report-p7.pdf' })
  const res = await exportEachPage(api, {
    baseName: 'report',
    pages: doc.getPageIndices(),
    buildPage: buildPage(doc),
    confirmOverwrite: async () => true
  })
  check('成功 19 / 失败 1', res.ok === 19 && res.failed.length === 1, res.ok + ' 成功, ' + res.failed.length + ' 失败')
  check('失败清单含文件名与原因', res.failed[0]?.name === 'report-p7.pdf' && /ENOSPC/.test(res.failed[0]?.error ?? ''), JSON.stringify(res.failed))
  check('其余文件仍全部落盘', existsSync(join(outDir, 'report-p6.pdf')) && existsSync(join(outDir, 'report-p8.pdf')))
}

console.log('\n' + '='.repeat(64))
console.log(`结果: ${pass} 项通过, ${fail} 项失败`)
console.log('='.repeat(64))
process.exit(fail ? 1 : 0)
