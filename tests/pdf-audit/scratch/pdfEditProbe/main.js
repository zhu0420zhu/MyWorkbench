/* Electron 探针主进程：起本地 127.0.0.1 静态服务（避免 file:// 对 ESM/模块 Worker 的限制），
 * 隐藏窗口加载探针页，注入 PDF base64，调用页面里的 window.__run（= 真实 pdfBytesToHtml）。 */
const { app, BrowserWindow } = require('electron')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')

const DIR = __dirname
const ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const WORKER = path.join(ROOT, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs')

const CASES = [
  { name: '中文 PDF（soffice 生成，含标题/正文/列表）', file: path.join(DIR, 'out', 'src-zh.pdf') },
  { name: '既有 fixture（enhance-source.pdf）', file: path.join(ROOT, 'tests', 'pdf-audit', 'fixtures', 'enhance-source.pdf') },
  { name: '图片型 PDF（make-image-only-pdf 产物，若存在）', file: path.join(ROOT, 'tests', 'pdf-audit', 'scratch', 'image-only.pdf') }
]

app.disableHardwareAcceleration()

function startServer() {
  const routes = {
    '/': path.join(DIR, 'index.html'),
    '/index.html': path.join(DIR, 'index.html'),
    '/bundle.js': path.join(DIR, 'bundle.js'),
    '/pdf.worker.min.mjs': WORKER
  }
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = (req.url || '/').split('?')[0]
      const f = routes[u]
      if (!f || !fs.existsSync(f)) {
        res.statusCode = 404
        res.end('not found: ' + u)
        return
      }
      res.setHeader('Content-Type', u.endsWith('.mjs') || u.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8')
      res.end(fs.readFileSync(f))
    })
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => resolve(srv))
  })
}

async function waitForRun(win) {
  for (let i = 0; i < 100; i++) {
    const ok = await win.webContents.executeJavaScript('typeof window.__run === "function"')
    if (ok) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

app.whenReady().then(async () => {
  const srv = await startServer()
  const port = srv.address().port
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { webSecurity: false, nodeIntegration: false, contextIsolation: false }
  })
  await win.loadURL(`http://127.0.0.1:${port}/`)
  const ready = await waitForRun(win)
  if (!ready) {
    console.log('❌ 探针 bundle 未加载成功（window.__run 未定义）')
    app.exit(1)
    return
  }
  console.log('Chromium = ' + process.versions.chrome + ' / Electron = ' + process.versions.electron)
  console.log('探针页 = http://127.0.0.1:' + port + '/')

  for (const c of CASES) {
    console.log('\n' + '='.repeat(70))
    console.log('用例: ' + c.name)
    console.log('文件: ' + c.file)
    if (!fs.existsSync(c.file)) {
      console.log('  ⏭  跳过（文件不存在）')
      continue
    }
    const b64 = fs.readFileSync(c.file).toString('base64')
    const res = await win.webContents.executeJavaScript(
      `window.__run(${JSON.stringify(b64)})`
    )
    console.log('  pdfjs 版本 : ' + res.pdfjsVersion)
    console.log('  workerSrc  : ' + res.workerSrc)
    console.log('  耗时       : ' + res.ms + 'ms')
    if (!res.ok) {
      console.log('  ❌ 抛异常   : ' + res.error)
      continue
    }
    console.log('  总页数     : ' + res.pages)
    console.log('  非空白字符 : ' + res.chars)
    console.log('  needOcr    : ' + res.needOcr)
    console.log('  note       : ' + JSON.stringify(res.note))
    console.log('  html 长度  : ' + res.htmlLen)
    console.log('  html       : ' + JSON.stringify(res.html))
  }
  console.log('\n' + '='.repeat(70))
  srv.close()
  app.exit(0)
})
