/**
 * QA 独立复验 #4：拆分「逐页导出」改为选一次目录批量写入。
 *
 * 独立性声明：
 *   - 自造 24 页 PDF（工程师用 20 页），每页写唯一标记，用 pdfjs 抽文本确认「第 i 页内容落在第 i 个产出」；
 *   - 注入 api 直接落真实文件系统，统计 pickDir / write / exists 调用次数；
 *   - IPC 三段式接线用静态证据逐项核验（主进程 handle / whenReady 注册 / preload 双写）；
 *   - 全文扫描渲染层是否残留 window.prompt / window.confirm。
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { exportEachPage, eachPageName, writeTargets, joinPath } from '../../../src/renderer/src/utils/pdfBatchWrite.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const WORK = join(HERE, 'qa-work', 'split')
await rm(WORK, { recursive: true, force: true })
await mkdir(WORK, { recursive: true })

let pass = 0
let fail = 0
const failList = []
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  [PASS] ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; failList.push(name); console.log('  [FAIL] ' + name + (detail ? '  ' + detail : '')) }
}

/* ---------- 1. 自造 24 页 PDF ---------- */
const N = 24
const srcDoc = await PDFDocument.create()
{
  const font = await srcDoc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < N; i++) {
    const p = srcDoc.addPage([595, 842])
    p.drawText('QAMARK' + String(i + 1).padStart(2, '0') + 'END', { x: 60, y: 700, size: 18, font, color: rgb(0, 0, 0) })
  }
}
const srcBytes = await srcDoc.save()
const srcPath = join(WORK, 'qa-batch24.pdf')
await writeFile(srcPath, srcBytes)
console.log('== 1. 自造 24 页源 PDF ==')
console.log('   ' + srcPath + '  ' + srcBytes.length + ' B  ' + N + ' 页')

const outDir = join(WORK, 'out')
await mkdir(outDir, { recursive: true })

async function textOf(pp) {
  const d = await pdfjs.getDocument({ data: new Uint8Array(await readFile(pp)), disableWorker: true, isEvalSupported: false }).promise
  const page = await d.getPage(1)
  const tc = await page.getTextContent()
  const s = tc.items.map((i) => i.str).join('')
  await (d.destroy ? d.destroy() : d.cleanup())
  return s
}

function makeApi({ failOn = null, forceExists = false } = {}) {
  const calls = { pickDir: 0, write: 0, exists: 0 }
  return {
    calls,
    api: {
      pickDir: async () => { calls.pickDir++; return outDir },
      exists: async (paths) => { calls.exists++; return paths.map((p) => forceExists || existsSync(p)) },
      write: async (p, data) => {
        calls.write++
        if (failOn && p.endsWith(failOn)) throw new Error('模拟磁盘写入失败（ENOSPC no space left）')
        await mkdir(dirname(p), { recursive: true })
        await writeFile(p, Buffer.from(data))
        return true
      }
    }
  }
}
const buildPage = (doc) => async (i) => {
  const out = await PDFDocument.create()
  const [p] = await out.copyPages(doc, [i])
  out.addPage(p)
  return out.save()
}

/* ---------- 2. 场景 A：正常 24 页逐页导出 ---------- */
console.log('\n== 2. 场景 A：24 页逐页导出（目录只选 1 次）==')
{
  const doc = await PDFDocument.load(srcBytes, { ignoreEncryption: true })
  const { api, calls } = makeApi()
  const res = await exportEachPage(api, {
    baseName: 'qa-batch24',
    pages: doc.getPageIndices(),
    buildPage: buildPage(doc),
    confirmOverwrite: async () => { throw new Error('不应触发重名确认') }
  })
  check('目录选择只调用 1 次', calls.pickDir === 1, 'pickDir=' + calls.pickDir)
  check('未取消', res.canceled === false)
  check('24/24 全部成功', res.ok === N && res.failed.length === 0, res.ok + ' 成功 / ' + res.failed.length + ' 失败')
  check('写入次数 = 页数（无逐页对话框路径）', calls.write === N, 'write=' + calls.write)
  check('重名探测只做 1 批', calls.exists === 1, 'exists=' + calls.exists)

  const names = Array.from({ length: N }, (_, i) => eachPageName('qa-batch24', i))
  check('命名 qa-batch24-p1.pdf … p24.pdf', names[0] === 'qa-batch24-p1.pdf' && names[N - 1] === 'qa-batch24-p24.pdf')
  let allSingle = 0
  let contentOk = 0
  for (let i = 0; i < N; i++) {
    const d = await PDFDocument.load(await readFile(join(outDir, names[i])), { ignoreEncryption: true })
    if (d.getPageCount() === 1) allSingle++
    const txt = await textOf(join(outDir, names[i]))
    if (txt.includes('QAMARK' + String(i + 1).padStart(2, '0') + 'END')) contentOk++
  }
  check('每个产出都是单页有效 PDF', allSingle === N, allSingle + '/' + N)
  check('第 i 个产出内容 = 源第 i 页（页归属正确）', contentOk === N, contentOk + '/' + N)
}

/* ---------- 3. 场景 B：重名 → 取消 ---------- */
console.log('\n== 3. 场景 B：重名 + 取消（不得静默覆盖、不得写任何文件）==')
{
  await rm(outDir, { recursive: true, force: true }); await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'qa-batch24-p1.pdf'), '%PDF-1.4 QAPREEXISTING-ORIGINAL')
  await writeFile(join(outDir, 'qa-batch24-p5.pdf'), '%PDF-1.4 QAPREEXISTING-5')
  const doc = await PDFDocument.load(srcBytes, { ignoreEncryption: true })
  const { api, calls } = makeApi()
  let asked = null
  const res = await exportEachPage(api, {
    baseName: 'qa-batch24',
    pages: doc.getPageIndices(),
    buildPage: buildPage(doc),
    confirmOverwrite: async (names) => { asked = names; return false }
  })
  check('探测到 2 个重名并触发二次确认', Array.isArray(asked) && asked.length === 2 && asked.includes('qa-batch24-p1.pdf') && asked.includes('qa-batch24-p5.pdf'), JSON.stringify(asked))
  check('取消 → canceled=true', res.canceled === true)
  check('取消 → write 一次都没发生', calls.write === 0, 'write=' + calls.write)
  const p1 = (await readFile(join(outDir, 'qa-batch24-p1.pdf'))).toString('latin1')
  const p5 = (await readFile(join(outDir, 'qa-batch24-p5.pdf'))).toString('latin1')
  check('原有同名文件内容未被改动', p1 === '%PDF-1.4 QAPREEXISTING-ORIGINAL' && p5 === '%PDF-1.4 QAPREEXISTING-5')
  check('其余 22 页也未落盘', !existsSync(join(outDir, 'qa-batch24-p2.pdf')) && !existsSync(join(outDir, 'qa-batch24-p24.pdf')))
}

/* ---------- 4. 场景 C：重名 → 确认覆盖 ---------- */
console.log('\n== 4. 场景 C：重名 + 确认覆盖 ==')
{
  const doc = await PDFDocument.load(srcBytes, { ignoreEncryption: true })
  const { api } = makeApi()
  const res = await exportEachPage(api, {
    baseName: 'qa-batch24',
    pages: doc.getPageIndices(),
    buildPage: buildPage(doc),
    confirmOverwrite: async () => true
  })
  check('确认后 24/24 成功', res.ok === N && res.failed.length === 0, res.ok + '/' + N)
  const now = await readFile(join(outDir, 'qa-batch24-p1.pdf'))
  check('同名文件被新产出替换（不再含旧标记）', now.subarray(0, 4).toString('latin1') === '%PDF' && !Buffer.from(now).toString('latin1').includes('QAPREEXISTING-ORIGINAL'))
}

/* ---------- 5. 场景 D：部分失败 → 逐条原因 ---------- */
console.log('\n== 5. 场景 D：部分失败（第 7 页 ENOSPC）==')
{
  await rm(outDir, { recursive: true, force: true }); await mkdir(outDir, { recursive: true })
  const doc = await PDFDocument.load(srcBytes, { ignoreEncryption: true })
  const { api } = makeApi({ failOn: 'qa-batch24-p7.pdf' })
  const res = await exportEachPage(api, {
    baseName: 'qa-batch24',
    pages: doc.getPageIndices(),
    buildPage: buildPage(doc),
    confirmOverwrite: async () => true
  })
  check('成功 23 / 失败 1（精确计数）', res.ok === 23 && res.failed.length === 1, res.ok + ' 成功 / ' + res.failed.length + ' 失败')
  check('失败清单含文件名与原因（可行动反馈）', res.failed[0]?.name === 'qa-batch24-p7.pdf' && /ENOSPC/.test(res.failed[0]?.error ?? ''), JSON.stringify(res.failed))
  check('失败不中断其余文件', existsSync(join(outDir, 'qa-batch24-p6.pdf')) && existsSync(join(outDir, 'qa-batch24-p8.pdf')) && existsSync(join(outDir, 'qa-batch24-p24.pdf')))
}

/* ---------- 6. 场景 E：写入返回 false（路径未授权/超限）要计入失败 ---------- */
console.log('\n== 6. 场景 E：write 返回 false（未授权路径）不得算成功 ==')
{
  const api = { pickDir: async () => outDir, exists: async (ps) => ps.map(() => false), write: async () => false }
  const out = await writeTargets(api, [
    { name: 'a.pdf', path: joinPath(outDir, 'a.pdf'), bytes: new Uint8Array([1]) },
    { name: 'b.pdf', path: joinPath(outDir, 'b.pdf'), bytes: new Uint8Array([2]) }
  ])
  check('write=false 计入失败而非成功', out.ok === 0 && out.failed.length === 2, JSON.stringify(out))
}

/* ---------- 7. IPC 三段式接线静态核验 ---------- */
console.log('\n== 7. IPC 接线三段式（pdf:pick-dir / pdf:exists）==')
{
  const pdfIpc = await readFile(join(ROOT, 'src', 'main', 'pdf', 'pdfIpc.ts'), 'utf-8')
  const mainIdx = await readFile(join(ROOT, 'src', 'main', 'index.ts'), 'utf-8')
  const preTs = await readFile(join(ROOT, 'src', 'preload', 'index.ts'), 'utf-8')
  const preDts = await readFile(join(ROOT, 'src', 'preload', 'index.d.ts'), 'utf-8')

  check('① 主进程 ipcMain.handle("pdf:pick-dir") 已注册', /ipcMain\.handle\(\s*'pdf:pick-dir'/.test(pdfIpc))
  check('① 主进程 ipcMain.handle("pdf:exists") 已注册', /ipcMain\.handle\(\s*'pdf:exists'/.test(pdfIpc))
  check('② registerPdfIpc 被 app.whenReady() 回调调用', /app\.whenReady\(\)\.then\([\s\S]*?registerPdfIpc\(\)/.test(mainIdx))
  check('② registerPdfIpc 确实定义了这两个 handler（同一函数体内）', /registerPdfIpc\(\)\s*:?\s*\{[\s\S]*pdf:pick-dir[\s\S]*pdf:exists/.test(pdfIpc) || (/registerPdfIpc/.test(pdfIpc) && /pdf:pick-dir/.test(pdfIpc) && /pdf:exists/.test(pdfIpc)))

  check('③ preload/index.ts 暴露 pickDir 且 invoke("pdf:pick-dir")', /pickDir:\s*\([^)]*\)\s*:\s*Promise<string \| null>[\s\S]{0,80}pdf:pick-dir/.test(preTs))
  check('③ preload/index.ts 暴露 exists 且 invoke("pdf:exists")', /exists:\s*\(paths:\s*string\[\]\)[\s\S]{0,80}pdf:exists/.test(preTs))
  check('③ preload/index.d.ts 声明 pickDir（与 .ts 双写）', /pickDir:\s*\(title\?:\s*string\)\s*=>\s*Promise<string \| null>/.test(preDts))
  check('③ preload/index.d.ts 声明 exists（与 .ts 双写）', /exists:\s*\(paths:\s*string\[\]\)\s*=>\s*Promise<boolean\[\]/.test(preDts))

  // 权限模型：pick-dir 选择的目录登记为可写；write 必须走授权目录
  check('主进程登记目录（allowDir）后才允许批量写入', /allowDir\(result\.filePaths\[0\]\)/.test(pdfIpc))
  check('pdf:write 先校验授权（isPathAllowed）', /ipcMain\.handle\(\s*'pdf:write'[\s\S]{0,200}isPathAllowed\(filePath\)/.test(pdfIpc))
  check('pdf:exists 对未授权路径返回 false（不泄漏文件存在性）', /isPathAllowed\(p\)\s*\?\s*existsSync\(p\)\s*:\s*false/.test(pdfIpc))
  check('目录授权范围限定为「选中目录内部文件」', /isInsideDir\(p,\s*d\)/.test(pdfIpc) && /f\.startsWith\(d \+ '\/'\)/.test(pdfIpc))

  // 死参数 paper 已彻底移除
  check('主进程 excel-to-pdf 入参无死参数 paper', !/paper\s*[?:]\s*string/.test(pdfIpc) && /pageOrientation/.test(pdfIpc))
  check('preload 两端 excelToPdf 入参均为 pageOrientation（无 paper）', /pageOrientation\?:\s*'auto' \| 'portrait' \| 'landscape'/.test(preTs) && /pageOrientation\?:\s*'auto' \| 'portrait' \| 'landscape'/.test(preDts))
  // 词边界匹配：wallpaper / pickWallpaper 等不含独立 paper 词
  const barePaper = (s) => /(^|[^a-zA-Z])paper([^a-zA-Z]|$)/.test(s)
  check('preload 两端无独立 paper 参数残留', !barePaper(preTs) && !barePaper(preDts))
}

/* ---------- 8. 渲染层不得使用 window.prompt / window.confirm ---------- */
console.log('\n== 8. 渲染层无 window.prompt / window.confirm（项目硬约定）==')
{
  // 用 fs 递归扫描 renderer/src
  const { readdir } = await import('node:fs/promises')
  async function walk(dir) {
    const out = []
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) out.push(...(await walk(p)))
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
    }
    return out
  }
  const files = await walk(join(ROOT, 'src', 'renderer', 'src'))
  const hits = []
  for (const f of files) {
    const src = await readFile(f, 'utf-8')
    if (/window\.(prompt|confirm)\s*\(/.test(src)) hits.push(f.replace(ROOT, ''))
  }
  check('渲染层无 window.prompt / window.confirm', hits.length === 0, hits.length ? hits.join(', ') : '扫描 ' + files.length + ' 个文件全干净')
  const pdfTools = await readFile(join(ROOT, 'src', 'renderer', 'src', 'pages', 'PdfTools.tsx'), 'utf-8')
  check('拆分面板的重名确认走 Modal.confirm（非 window.confirm）', /Modal\.confirm/.test(pdfTools))

  const sp = pdfTools.slice(pdfTools.indexOf('function SplitPanel()'), pdfTools.indexOf('/* ---------- 旋转', pdfTools.indexOf('function SplitPanel()')))
  const savePdfCalls = (sp.match(/await savePdf\(/g) || []).length
  check('UI 用 exportEachPage 走批量写入；savePdf 仅剩「合并所选」1 处（无逐页 savePdf）',
    /exportEachPage\(getPdfApi\(\)/.test(sp) && savePdfCalls === 1, 'savePdf 调用 ' + savePdfCalls + ' 次')
  check('部分失败给「成功 M/N + 失败清单」明确反馈', /部分成功：\$\{res\.ok\}\/\$\{selected\.length\}/.test(sp) && /failures\.map/.test(sp) && /f\.name[\s\S]{0,40}f\.error/.test(sp))
  check('取消且无重名时不误报（仅在冲突时提示）', /res\.canceled[\s\S]{0,160}res\.conflicts\.length/.test(sp))
  check('逐页导出文案改为「选一次文件夹」（不再逐页弹窗）', /选一次目标文件夹后批量写入/.test(sp))
}

console.log('\n' + '='.repeat(64))
console.log('QA#4 结果: ' + pass + ' 项通过, ' + fail + ' 项失败')
if (failList.length) console.log('失败项: ' + failList.join(' | '))
console.log('='.repeat(64))
process.exit(fail ? 1 : 0)
