/**
 * QA 探针 runner：「另存为多格式」空内容守卫（#50）+ 落盘扩展名对齐（#51）独立复核。
 *
 * 用法：node tests/pdf-audit/qa/probe-save-as/run.mjs
 *
 * 两段证据链：
 *   A. 真实 Electron（真实 Chromium + 生产 preload + 生产 docs IPC + 生产 pathAcl）
 *   B. Electron 退出后 node 侧独立复核落盘文件（fs / pdf.js / qpdf）
 */
import { createRequire } from 'node:module'
import { spawnSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..', '..')
const DIST = join(HERE, 'dist')
const WORK = join(ROOT, 'tests', 'pdf-audit', 'qa', 'qa-work', 'save-as')
const QPDF = join(ROOT, 'resources', 'tools', 'qpdf', 'qpdf.exe')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

let pass = 0
let fail = 0
const fails = []
function ok(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`)
  } else {
    fail++
    fails.push(name + (detail ? ' :: ' + detail : ''))
    console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`)
  }
}
const info = (m) => console.log('  · ' + m)
const W = (p) => join(WORK, p).replace(/\\/g, '/')

rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
mkdirSync(DIST, { recursive: true })

/* ============ 1. 页面 + 对话框脚本 ============
 * saveDialogs 顺序必须与 renderer-entry.ts 里的调用顺序严格一致：
 *   1..3  空内容守卫的三条"看着像空但非空"反例（html 源）
 *   4..8  扩展名对齐 5 例
 *   9     text→txt 纯空白观察项
 *   10    用户取消
 *   11    PDF 导出（用户把名字写成 .doc）
 */
const pagePath = join(HERE, 'index.html')
function writePage(bundleText) {
  writeFileSync(
    pagePath,
    `<!doctype html><html><head><meta charset="utf-8"><title>qa probe save-as</title></head>
<body><div id="root"></div>
<script>window.__PROBE_CFG__ = ${JSON.stringify({ workDir: WORK })};</script>
<script>${bundleText.replace(/<\/script/gi, '<\\/script')}</script>
</body></html>`,
    'utf-8'
  )
}

const saveDialogs = [
  W('反例1.html'), //     1 已是目标扩展名
  W('反例2'), //          2 无扩展名 → 追加 .html
  W('反例3.htm'), //      3 别的扩展名 → 替换 .html
  W('对齐测试.doc'), //   4 选了 txt → 改成 .txt
  W('网页.pdf'), //       5 选了 html → 改成 .html
  W('无扩展名'), //       6 选了 md → 追加 .md
  W('已经是.txt'), //     7 原样
  W('大小写.TXT'), //     8 大小写不同 → 原样保留 .TXT
  W('纯空白文本观察.txt'), // 9 观察项：text→txt 无守卫分支
  null, //                10 用户取消
  W('导出未对齐名.doc') // 11 选了 pdf → 改成 .pdf
]

/* 生产 sofficePath 用 app.getAppPath() 定位内置 LibreOffice，而探针的 app 目录是 HERE。
 * 因此这里在探针目录挂一个指向仓库 resources 的目录联接，让内置 LibreOffice 真能被找到；
 * 跑完即删，避免污染仓库。 */
const RES_LINK = join(HERE, 'resources')
if (!existsSync(RES_LINK)) {
  try {
    symlinkSync(join(ROOT, 'resources'), RES_LINK, 'junction')
  } catch (e) {
    console.warn('[warn] 创建 resources 联接失败（PDF 用例会因找不到 soffice 而失败）:', e.message)
  }
}
process.on('exit', () => {
  // 只用 rmdirSync（非递归）：目录联接会被移除；万一它不是联接而是真目录，
  // 这里会抛错而不是递归删掉仓库 resources/ —— 宁可留垃圾，不可误删。
  try {
    rmdirSync(RES_LINK)
  } catch {
    /* ignore */
  }
})

/* ============ 2. 打包 ============ */
console.log('\n[1/3] esbuild 打包真实 docs IPC 主进程模块 …')
await esbuild.build({
  entryPoints: [join(ROOT, 'src', 'main', 'docsIpc.ts')],
  outfile: join(DIST, 'docs-ipc.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['electron'],
  logLevel: 'warning'
})
rmSync(join(HERE, '_tmp-docs.cjs'), { force: true })

console.log('[2/3] esbuild 打包渲染进程探针 …')
const rendererOut = join(DIST, 'probe-bundle.js')
await esbuild.build({
  entryPoints: [join(HERE, 'renderer-entry.ts')],
  outfile: rendererOut,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  logLevel: 'warning'
})
writePage(readFileSync(rendererOut, 'utf-8'))

const planPath = join(WORK, '_plan.json')
const outPath = join(WORK, '_probe-report.json')
writeFileSync(
  planPath,
  JSON.stringify({ preloadPath: join(ROOT, 'out', 'preload', 'index.js'), pagePath, openDialogs: [], saveDialogs }, null, 2),
  'utf-8'
)
if (!existsSync(join(ROOT, 'out', 'preload', 'index.js'))) {
  console.error('❌ 缺少生产 preload 构建产物 out/preload/index.js，请先 npm run build')
  process.exit(1)
}

/* ============ 3. 拉起真实 Electron ============ */
console.log('[3/3] 启动真实 Electron（生产 preload + 生产 docs IPC）…\n')
const env = { ...process.env, PROBE_PLAN: planPath, PROBE_OUT: outPath }
delete env.ELECTRON_RUN_AS_NODE
const r = spawnSync(ELECTRON, [HERE], { env, stdio: 'inherit' })
info(`electron 退出码 = ${r.status}`)

console.log('\n=== A. 渲染进程内（真实 Chromium / 真实 preload / 真实 docs IPC） ===')
if (!existsSync(outPath)) {
  ok('探针产出报告', false, '未生成 _probe-report.json')
  process.exit(1)
}
const report = JSON.parse(readFileSync(outPath, 'utf-8'))
if (report.fatal) {
  ok('探针未致命失败', false, report.fatal)
} else {
  for (const row of report.result.rows) {
    if (row.name.startsWith('· ')) info(row.name.slice(2))
    else ok(row.name, row.pass, row.detail)
  }
}
const dlg = report.dialogCalls || []
const saveCalls = dlg.filter((d) => d.kind === 'save')
info(`保存对话框实际被调用 ${saveCalls.length} 次（预期 ${saveDialogs.length}）`)
ok('保存对话框调用次数与预期完全一致（守卫用例一次都没弹框）', saveCalls.length === saveDialogs.length, `${saveCalls.length} vs ${saveDialogs.length}`)
const unexpected = saveCalls.filter((d) => String(d.options?.title) === '').length
void unexpected

/* ============ B. 落盘文件独立复核 ============ */
console.log('\n=== B. 落盘文件独立复核（node fs / pdf.js / qpdf） ===')
const exists = (p) => existsSync(join(WORK, p))

const expectFiles = [
  ['反例1.html', '含单个可见字符'],
  ['反例2.html', 'css 里藏着文本（无扩展名被补成 .html）'],
  ['反例3.html', '实体解出的可见字符（.htm 被改成 .html）'],
  ['对齐测试.txt', '选了 txt → .doc 被改成 .txt'],
  ['网页.html', '选了 html → .pdf 被改成 .html'],
  ['无扩展名.md', '选了 md → 追加 .md'],
  ['已经是.txt', '本来就是 .txt → 原样'],
  ['大小写.TXT', '大小写不同 → 原样保留 .TXT']
]
for (const [f, why] of expectFiles) ok(`落盘存在 ${f}（${why}）`, exists(f), W(f))

ok('落盘【不存在】对齐测试.doc（旧扩展名没有残留双份文件）', !exists('对齐测试.doc'), W('对齐测试.doc'))
ok('落盘【不存在】网页.pdf（旧扩展名没有残留双份文件）', !exists('网页.pdf'), W('网页.pdf'))
ok('落盘【不存在】导出未对齐名.doc（旧扩展名没有残留双份文件）', !exists('导出未对齐名.doc'), W('导出未对齐名.doc'))
ok('用户取消 → 取消用例.txt 未被创建', !exists('取消用例.txt'), W('取消用例.txt'))

const contentOf = (f) => (exists(f) ? readFileSync(join(WORK, f)) : null)
/* 观察项取证：text 源直写分支没有空内容守卫，纯空白会真的写出一份 0 字节 .txt */
const blankTxt = contentOf('纯空白文本观察.txt')
if (blankTxt) info(`观察取证：纯空白文本观察.txt 已落盘，大小 ${blankTxt.byteLength} B（该分支无空内容守卫）`)

ok('对齐测试.txt 内容与提交内容一致', (contentOf('对齐测试.txt') || Buffer.alloc(0)).toString('utf-8') === '对齐测试正文 ALIGN-1', JSON.stringify((contentOf('对齐测试.txt') || Buffer.alloc(0)).toString('utf-8')))
ok('无扩展名.md 内容与提交内容一致', (contentOf('无扩展名.md') || Buffer.alloc(0)).toString('utf-8') === '# 无扩展名 ALIGN-3', JSON.stringify((contentOf('无扩展名.md') || Buffer.alloc(0)).toString('utf-8')))
const html = (contentOf('网页.html') || Buffer.alloc(0)).toString('utf-8')
ok('网页.html 是完整 HTML 文档且含提交内容', html.startsWith('<!DOCTYPE html>') && html.includes('网页对齐 ALIGN-2'), html.slice(0, 60))
ok('反例1.html 里的单字符可见内容被保留', ((contentOf('反例1.html') || Buffer.alloc(0)).toString('utf-8')).includes('x'))

/* ---- PDF 产物：非空白、可打开、文字层含提交内容 ---- */
const pdfBuf = contentOf('导出未对齐名.pdf')
ok('PDF 已落盘且非空', !!pdfBuf && pdfBuf.byteLength > 1000, pdfBuf ? `${pdfBuf.byteLength} B` : '缺失')
if (pdfBuf) {
  ok('PDF 头合法', pdfBuf.subarray(0, 5).toString('latin1') === '%PDF-', pdfBuf.subarray(0, 8).toString('latin1'))
  ok('PDF 以 %%EOF 收尾', pdfBuf.subarray(-2048).toString('latin1').includes('%%EOF'))
  const pdfjs = await import(pathToFileURL(join(ROOT, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href)
  const STD_FONTS = pathToFileURL(join(ROOT, 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/').href
  const task = pdfjs.getDocument({ data: new Uint8Array(pdfBuf), useWorkerFetch: false, isEvalSupported: false, disableFontFace: true, standardFontDataUrl: STD_FONTS })
  const pd = await task.promise
  ok('PDF 页数 ≥ 1', pd.numPages >= 1, String(pd.numPages))
  let text = ''
  for (let i = 1; i <= pd.numPages; i++) text += (await (await pd.getPage(i)).getTextContent()).items.map((it) => it.str).join('')
  ok('PDF 非空白（提取文字长度 > 0）—— 直接回答「另存为是不是空白」', text.length > 0, `长度=${text.length}`)
  ok('PDF 文字层含 ASCII 标记 PROBE-ASCII-9', text.includes('PROBE-ASCII-9'), JSON.stringify(text.slice(0, 120)))
  ok('PDF 文字层含中文「另存为 PDF 不会产出空白文件」', text.includes('不会产出空白文件'), text.includes('不会产出空白文件') ? '命中' : JSON.stringify(text.slice(0, 160)))
  await task.destroy()

  const execFileP = promisify(execFile)
  try {
    const { stdout } = await execFileP(QPDF, ['--check', join(WORK, '导出未对齐名.pdf')], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
    ok('qpdf --check 通过', stdout.includes('No syntax or stream encoding errors found'), stdout.trim().split('\n').slice(0, 2).join(' | '))
  } catch (e) {
    ok('qpdf 可运行', false, (e && e.message) || String(e))
  }
}

info(`产物目录内容：${JSON.stringify(readdirSync(WORK).filter((f) => !f.startsWith('_'))) }`)

console.log('\n================ QA 另存为守卫/扩展名 运行期验证汇总 ================')
console.log(`QA 另存为运行期验证结果: ${pass} 项通过, ${fail} 项失败`)
if (fails.length) {
  console.log('失败明细：')
  for (const f of fails) console.log('  - ' + f)
}
info(`产物目录：${WORK.replace(ROOT, '.')}`)
process.exitCode = fail ? 1 : 0
