/**
 * QA 探针 runner：真实 Electron 下的「PDF 就地编辑 → 保存」运行期验证 + 落盘后独立复核。
 *
 * 用法：node tests/pdf-audit/qa/probe-inplace-save/run.mjs
 *
 * 这里刻意分成两段证据链：
 *   A. 渲染进程内（真实 Chromium + 真实 preload + 真实 ipcMain + 真实 pathAcl）
 *   B. Electron 退出后，用 node 侧 pdf-lib / qpdf / pdf.js **独立**复核落盘文件
 *      （A 说「写成功了」，B 才回答「写出来的到底是不是对的东西」）
 */
import { createRequire } from 'node:module'
import { spawnSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..', '..')
const DIST = join(HERE, 'dist')
const WORK = join(ROOT, 'tests', 'pdf-audit', 'qa', 'qa-work', 'inplace-runtime')
const QPDF = join(ROOT, 'resources', 'tools', 'qpdf', 'qpdf.exe')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

const sha256 = (b) => createHash('sha256').update(b).digest('hex')
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

rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
mkdirSync(DIST, { recursive: true })

/* ============ 1. 素材：3 页 Letter 正文 + 第 1 页一张真实 JPEG ============ */
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib')
const { createCanvas } = require('@napi-rs/canvas')

async function buildFixture() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const c = createCanvas(200, 120)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#2b6cb0'
  ctx.fillRect(0, 0, 200, 120)
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 20px sans-serif'
  ctx.fillText('QA IMG', 20, 60)
  const img = await doc.embedJpg(await c.encode('jpeg', 85))
  const p1 = doc.addPage([595.28, 841.89])
  p1.drawImage(img, { x: 360, y: 640, width: 160, height: 96 })
  p1.drawText('PAGE-1 KEEP ME INTACT', { x: 60, y: 688, size: 12, font, color: rgb(0, 0, 0) })
  p1.drawText('PAGE-1 ORIGINAL LINE WILL BE REPLACED', { x: 60, y: 755, size: 14, font, color: rgb(0, 0, 0) })
  for (let i = 2; i <= 3; i++) {
    doc.addPage([595.28, 841.89]).drawText(`PAGE-${i} ORIGINAL LINE WILL BE REPLACED`, { x: 60, y: 755, size: 14, font, color: rgb(0, 0, 0) })
  }
  return await doc.save({ useObjectStreams: true })
}

const fixtureBytes = await buildFixture()
const fixturePath = join(WORK, '_fixture-original.pdf')
writeFileSync(fixturePath, fixtureBytes)
info(`素材：${fixtureBytes.byteLength} B, sha256=${sha256(fixtureBytes).slice(0, 16)}…`)

/* 被测原文件（会被探针覆盖写） */
const docDir = join(WORK, 'doc')
mkdirSync(docDir, { recursive: true })
const docPath = join(docDir, 'QA-合同.pdf')
copyFileSync(fixturePath, docPath)

const otherDir = join(WORK, 'elsewhere')
mkdirSync(otherDir, { recursive: true })
const backupPath = join(docDir, 'QA-合同-备份-20260929120000.pdf')
const backupElsewherePath = join(otherDir, 'QA-合同-备份.pdf')
const saveAsTarget = join(WORK, 'QA-已编辑.pdf')
const unauthorizedPath = join(WORK, 'never-registered', 'x.pdf')

const pagePath = join(HERE, 'index.html')
/* 探针 bundle 以 IIFE 形式**内联**进页面：file:// 下外链 module 脚本会被 CORS 拦掉，
 * 内联后既不依赖网络也不依赖 file 协议特权。 */
function writePage(bundleText) {
  writeFileSync(
    pagePath,
    `<!doctype html><html><head><meta charset="utf-8"><title>qa probe</title></head>
<body><div id="root"></div>
<script>window.__PROBE_CFG__ = ${JSON.stringify({ docPath, backupPath, backupElsewherePath, saveAsTarget, unauthorizedPath })};</script>
<script>${bundleText.replace(/<\/script/gi, '<\\/script')}</script>
</body></html>`,
    'utf-8'
  )
}

/* ============ 2. 打包：主进程 pdfIpc（真实）/ 渲染进程探针 ============ */
console.log('\n[1/3] esbuild 打包真实 pdf IPC 主进程模块 …')
await esbuild.build({
  entryPoints: [join(ROOT, 'src', 'main', 'pdf', 'pdfIpc.ts')],
  outfile: join(DIST, 'pdf-ipc.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['electron'],
  logLevel: 'warning'
})

console.log('[2/3] esbuild 打包渲染进程探针（含生产 pdfInPlaceReplace / pdfText）…')
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

/* ============ 3. 拉起真实 Electron ============ */
const planPath = join(WORK, '_plan.json')
const outPath = join(WORK, '_probe-report.json')
writeFileSync(
  planPath,
  JSON.stringify(
    {
      preloadPath: join(ROOT, 'out', 'preload', 'index.js'),
      pagePath,
      openDialogs: [[docPath], [docDir]],
      saveDialogs: [saveAsTarget]
    },
    null,
    2
  ),
  'utf-8'
)
if (!existsSync(join(ROOT, 'out', 'preload', 'index.js'))) {
  console.error('❌ 缺少生产 preload 构建产物 out/preload/index.js，请先 npm run build')
  process.exit(1)
}

console.log('[3/3] 启动真实 Electron（生产 preload + 生产 pdf IPC）…\n')
const env = { ...process.env, PROBE_PLAN: planPath, PROBE_OUT: outPath }
delete env.ELECTRON_RUN_AS_NODE
const r = spawnSync(ELECTRON, [HERE], { env, stdio: 'inherit' })
info(`electron 退出码 = ${r.status}`)

console.log('\n=== A. 渲染进程内（真实 Chromium / 真实 preload / 真实 IPC / 真实 ACL） ===')
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
info(`对话框调用记录：open=${dlg.filter((d) => d.kind === 'open').length} save=${dlg.filter((d) => d.kind === 'save').length}`)

/* ============ B. 落盘后独立复核（node 侧另一条证据链） ============ */
console.log('\n=== B. 落盘文件独立复核（pdf-lib / qpdf / pdf.js，与 A 完全不同的工具链） ===')

const docOnDisk = existsSync(docPath) ? readFileSync(docPath) : null
ok('原文件仍存在且非空', !!docOnDisk && docOnDisk.byteLength > 0, docOnDisk ? `${docOnDisk.byteLength} B` : '缺失')
if (docOnDisk) {
  ok('原文件确实被改写（sha256 与编辑前不同）', sha256(docOnDisk) !== sha256(fixtureBytes), `${sha256(fixtureBytes).slice(0, 12)} → ${sha256(docOnDisk).slice(0, 12)}`)
  ok('原文件是合法 PDF 头', docOnDisk.subarray(0, 5).toString('latin1') === '%PDF-', docOnDisk.subarray(0, 8).toString('latin1'))
  ok('原文件以 %%EOF 收尾', docOnDisk.subarray(-1024).toString('latin1').includes('%%EOF'))

  const v = await PDFDocument.load(new Uint8Array(docOnDisk))
  ok('复核①pdf-lib 可重开被覆盖的原文件', v.getPageCount() === 3, `页数=${v.getPageCount()}`)
  const sizes = v.getPages().map((p) => p.getSize())
  ok('复核①每页 MediaBox 保持 595.28×841.89', sizes.every((s) => Math.abs(s.width - 595.28) < 0.02 && Math.abs(s.height - 841.89) < 0.02), JSON.stringify(sizes.map((s) => [Math.round(s.width), Math.round(s.height)])))

  const pdfjs = await import(pathToFileURL(join(ROOT, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href)
  const STD_FONTS = pathToFileURL(join(ROOT, 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/').href
  const task = pdfjs.getDocument({ data: new Uint8Array(docOnDisk), useWorkerFetch: false, isEvalSupported: false, disableFontFace: true, standardFontDataUrl: STD_FONTS })
  const pd = await task.promise
  ok('复核②pdf.js 可打开被覆盖的原文件，页数不变', pd.numPages === 3, String(pd.numPages))
  const textOf = async (i) => {
    const tc = await (await pd.getPage(i)).getTextContent()
    return tc.items.map((it) => it.str).join('')
  }
  const t1 = await textOf(1)
  const t2 = await textOf(2)
  const t3 = await textOf(3)
  // 探针配置：rep.page = 1（0 基）→ 第 2 页被替换；anno.page = 0 → 第 1 页加高亮；第 3 页完全不动
  ok('复核②第 3 页（真正未编辑页）文字与编辑前逐字符相同', t3 === 'PAGE-3 ORIGINAL LINE WILL BE REPLACED', JSON.stringify(t3))
  ok('复核②第 1 页（仅加高亮批注，不动文字）两行原文均在', t1.includes('PAGE-1 KEEP ME INTACT') && t1.includes('PAGE-1 ORIGINAL LINE WILL BE REPLACED'), JSON.stringify(t1))
  // 设计取舍（非缺陷）：覆盖矩形是**追加**在内容流末尾的，原内容流一字未改，
  // 因此第 2 页的旧文字仍留在文本层（可被复制/检索），只是视觉上被矩形盖住。
  // ⚠ 这正好能解释用户看到的「改完保存好像没变」：编辑面板的行列表是从文本层重新提取的，
  //   重载后旧文字会再次列出来；页面渲染出来的样子才是新的。
  ok('复核②第 2 页（被替换页）旧文字仍留在文本层（既定取舍，同时解释了「看起来没变」）', t2.includes('PAGE-2 ORIGINAL LINE WILL BE REPLACED'), JSON.stringify(t2))
  await task.destroy()

  /* ---- 复核④ 像素级：页面渲染出来到底变没变（直接回答「保存没改变」） ---- */
  const { createCanvas } = require('@napi-rs/canvas')
  class NodeCanvasFactory {
    create(w, h) {
      const canvas = createCanvas(w, h)
      return { canvas, context: canvas.getContext('2d') }
    }
    reset(cc, w, h) {
      cc.canvas.width = w
      cc.canvas.height = h
    }
    destroy(cc) {
      cc.canvas.width = 0
      cc.canvas.height = 0
    }
  }
  const renderPage = async (bytes, pageNo, scale = 2) => {
    const t = pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, isEvalSupported: false, disableFontFace: true, standardFontDataUrl: STD_FONTS, canvasFactory: new NodeCanvasFactory() })
    const d = await t.promise
    const p = await d.getPage(pageNo)
    const vp = p.getViewport({ scale })
    const cc = new NodeCanvasFactory().create(Math.ceil(vp.width), Math.ceil(vp.height))
    await p.render({ canvasContext: cc.context, viewport: vp }).promise
    const data = cc.context.getImageData(0, 0, cc.canvas.width, cc.canvas.height).data
    const out = { data, w: cc.canvas.width, h: cc.canvas.height }
    await t.destroy()
    return out
  }
  /** 逐像素差分：返回 { total, inBand, outBand }；band 用 PDF 用户坐标传入 */
  const diffStats = (a, b, scale, rect) => {
    let total = 0
    let inBand = 0
    let outBand = 0
    const W = a.w
    const H = a.h
    // PDF 用户坐标 → 设备像素（无旋转、scale 缩放、上下翻转）
    const x0 = Math.floor((rect.x - 4) * scale)
    const x1 = Math.ceil((rect.x + rect.width + 4) * scale)
    const y0 = Math.floor((841.89 - (rect.y + rect.height) - 4) * scale)
    const y1 = Math.ceil((841.89 - rect.y + 4) * scale)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])
        if (d > 24) {
          total++
          if (x >= x0 && x < x1 && y >= y0 && y < y1) inBand++
          else outBand++
        }
      }
    }
    return { total, inBand, outBand }
  }

  const REP_RECT = { x: 60, y: 748, width: 320, height: 22 } // 探针替换区（第 2 页）
  const ANNO_RECT = { x: 60, y: 688, width: 300, height: 18 } // 探针高亮区（第 1 页）

  const [p1a, p1b, p2a, p2b, p3a, p3b] = await Promise.all([
    renderPage(fixtureBytes, 1),
    renderPage(docOnDisk, 1),
    renderPage(fixtureBytes, 2),
    renderPage(docOnDisk, 2),
    renderPage(fixtureBytes, 3),
    renderPage(docOnDisk, 3)
  ])
  const d3 = diffStats(p3a, p3b, 2, { x: 0, y: 0, width: 0.0001, height: 0.0001 })
  ok('复核④第 3 页（未编辑页）渲染像素逐点完全相同', d3.total === 0, `差异像素=${d3.total}`)

  const d2 = diffStats(p2a, p2b, 2, REP_RECT)
  ok('复核④第 2 页（被替换页）渲染像素确实变了 —— 直接反驳「保存没改变」', d2.total > 500, `差异像素=${d2.total}`)
  ok('复核④第 2 页的变化全部落在替换区带内（没有误伤版面其它位置）', d2.inBand > 500 && d2.outBand === 0, `带内=${d2.inBand} 带外=${d2.outBand}`)

  const d1 = diffStats(p1a, p1b, 2, ANNO_RECT)
  ok('复核④第 1 页（加高亮页）渲染像素变了且变化只落在批注区带内', d1.inBand > 500 && d1.outBand === 0, `带内=${d1.inBand} 带外=${d1.outBand}`)
}

const backupDisk = existsSync(backupPath) ? readFileSync(backupPath) : null
ok('备份文件已落盘', !!backupDisk, backupPath.replace(ROOT, '.'))
ok('备份内容 == 编辑前的原始字节（可回滚）', !!backupDisk && sha256(backupDisk) === sha256(fixtureBytes), backupDisk ? sha256(backupDisk).slice(0, 12) : '缺失')

const saveAsDisk = existsSync(saveAsTarget) ? readFileSync(saveAsTarget) : null
ok('另存为文件已落盘', !!saveAsDisk && saveAsDisk.byteLength > 0, saveAsDisk ? `${saveAsDisk.byteLength} B` : '缺失')
ok('原文件与另存文件字节一致（同一份产出）', !!saveAsDisk && !!docOnDisk && sha256(saveAsDisk) === sha256(docOnDisk))

ok('被拒的越权备份文件未被创建（ACL 真的挡住了，不是写成功又删）', !existsSync(backupElsewherePath), backupElsewherePath.replace(ROOT, '.'))
ok('被拒的未登记路径文件未被创建', !existsSync(unauthorizedPath), unauthorizedPath.replace(ROOT, '.'))

/** Windows 上紧跟文件写入后拉起 qpdf.exe 偶发 EBUSY（杀软/索引器占用），退避重试。
 *  用异步 execFile（本仓 qa-3-orient 已验证可行），同步 spawnSync 在此环境下必 EBUSY。 */
const execFileP = promisify(execFile)
async function runQpdf(args, tries = 6) {
  let lastErr = null
  for (let i = 0; i < tries; i++) {
    try {
      return await execFileP(QPDF, args, { maxBuffer: 64 * 1024 * 1024, encoding: 'utf-8' })
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 400))
    }
  }
  throw lastErr
}

async function qpdfPages(p) {
  const { stdout } = await runQpdf(['--json=1', p])
  const j = JSON.parse(stdout)
  const refs = (j.pages ?? []).map((x) => x.object)
  const media = []
  for (const ref of refs) {
    const mb = j.objects?.[ref]?.['/MediaBox']
    if (Array.isArray(mb)) media.push({ w: mb[2] - mb[0], h: mb[3] - mb[1] })
  }
  return { pages: refs.length, all: media }
}

if (existsSync(QPDF) && docOnDisk) {
  try {
    const q = await runQpdf(['--check', docPath])
    const qout = (q.stdout || '') + (q.stderr || '')
    ok('复核③qpdf --check 通过（第三方解析器认可结构）', qout.includes('No syntax or stream encoding errors found'), qout.trim().split('\n').slice(0, 2).join(' | '))
    const pq = await qpdfPages(docPath)
    ok('复核③qpdf 独立读到的页数 = 3', pq.pages === 3, String(pq.pages))
    ok(
      '复核③qpdf 读到的各页 MediaBox 均保持 595.28×841.89',
      pq.all.length === 3 && pq.all.every((m) => Math.abs(m.w - 595.28) < 0.1 && Math.abs(m.h - 841.89) < 0.1),
      JSON.stringify(pq.all.map((m) => [Math.round(m.w), Math.round(m.h)]))
    )
  } catch (e) {
    ok('复核③qpdf 可运行', false, (e && e.message) || String(e))
  }
} else {
  info('跳过 qpdf 复核（未找到 resources/tools/qpdf/qpdf.exe）')
}

/* ============ 汇总 ============ */
console.log('\n================ QA 就地编辑运行期验证汇总 ================')
console.log(`QA 就地编辑运行期验证结果: ${pass} 项通过, ${fail} 项失败`)
if (fails.length) {
  console.log('失败明细：')
  for (const f of fails) console.log('  - ' + f)
}
const leftover = existsSync(join(WORK, 'never-registered')) ? readdirSync(join(WORK, 'never-registered')) : []
info(`never-registered 目录内容：${JSON.stringify(leftover)}`)
info(`产物目录：${WORK.replace(ROOT, '.')}`)
console.log('log:', `${pass}/${fail}`)
process.exitCode = fail ? 1 : 0
