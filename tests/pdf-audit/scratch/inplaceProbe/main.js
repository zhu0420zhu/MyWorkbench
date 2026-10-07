/* 就地改字 Electron 探针主进程：
 * 起 127.0.0.1 静态服务 → 隐藏窗口加载探针页 → 注入样本 PDF + 替换清单 →
 * 调用页面里真实运行的 replacePdfText（真实 Chromium canvas）→ 落盘产物。
 *
 * 运行（必须去掉 ELECTRON_RUN_AS_NODE，否则 electron.exe 会当 Node 跑）：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe tests/pdf-audit/scratch/inplaceProbe
 */
const { app, BrowserWindow } = require('electron')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')

const DIR = __dirname
const ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const SCRATCH = path.join(ROOT, 'tests', 'pdf-audit', 'scratch')
const SRC = path.join(SCRATCH, 'out', 'zh-edit-src.pdf')
const DST = path.join(SCRATCH, 'out', 'zh-edit-electron.pdf')
const REPS = path.join(SCRATCH, 'out', 'candidate-reps.json')

app.disableHardwareAcceleration()

function startServer() {
  const routes = {
    '/': path.join(DIR, 'index.html'),
    '/index.html': path.join(DIR, 'index.html'),
    '/bundle.js': path.join(DIR, 'bundle.js')
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
      res.setHeader('Content-Type', u.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8')
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

  console.log('Electron = ' + process.versions.electron + ' / Chromium = ' + process.versions.chrome)
  console.log('样本     = ' + SRC)
  const srcBytes = fs.readFileSync(SRC)
  const reps = JSON.parse(fs.readFileSync(REPS, 'utf8'))
  console.log('替换清单 = ' + JSON.stringify(reps))

  const res = await win.webContents.executeJavaScript(
    `window.__run(${JSON.stringify(srcBytes.toString('base64'))}, ${JSON.stringify(reps)})`
  )
  console.log('\ncanvas 可用    : ' + res.canvasAvailable)
  console.log('真实 Chromium 栅格化指标: ' + JSON.stringify(res.raster))
  console.log('耗时           : ' + res.ms + 'ms')
  if (!res.ok) {
    console.log('❌ 抛异常      : ' + res.error)
    srv.close()
    app.exit(1)
    return
  }
  const outBytes = Buffer.from(res.outB64, 'base64')
  fs.writeFileSync(DST, outBytes)
  console.log('输入字节       : ' + res.inBytes)
  console.log('输出字节       : ' + res.outBytes)
  console.log('输出前8字节    : ' + JSON.stringify(res.head))
  console.log('产物           : ' + DST)
  srv.close()
  app.exit(0)
})
