/* Electron 探针主进程（textRuns）：起本地 127.0.0.1 静态服务（避免 file:// 对 ESM/模块 Worker 的限制），
 * 隐藏窗口加载探针页，注入 PDF base64，调用页面里的 window.__runTextRuns
 * （= 真实 src/renderer/src/utils/pdfTextBlocks.ts 的 pdfBytesToTextRuns）。 */
const { app, BrowserWindow } = require('electron')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')

const DIR = __dirname
const ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const WORKER = path.join(ROOT, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs')

const CASES = [
  {
    name: '中文 PDF（soffice 生成，含标题/正文/列表）',
    file: path.join(DIR, 'out', 'src-zh.pdf'),
    maxPages: 2
  },
  {
    name: '同一份中文 PDF 的 /Rotate=90 副本（用 pdf-lib 改旋转）',
    file: path.join(DIR, 'out', 'src-zh-rot90.pdf'),
    maxPages: 1
  },
  {
    name: '既有 fixture（enhance-source.pdf，低对比扫描样本）',
    file: path.join(ROOT, 'tests', 'pdf-audit', 'fixtures', 'enhance-source.pdf'),
    maxPages: 1
  },
  {
    name: '图片型 PDF（无文本层，应产出 0 个 run 且不整页渲染）',
    file: path.join(ROOT, 'tests', 'pdf-audit', 'scratch', 'image-only.pdf'),
    maxPages: 3
  }
]

app.disableHardwareAcceleration()

function startServer() {
  const routes = {
    '/': path.join(DIR, 'index-textruns.html'),
    '/index-textruns.html': path.join(DIR, 'index-textruns.html'),
    '/bundle-textruns.js': path.join(DIR, 'bundle-textruns.js'),
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
      res.setHeader(
        'Content-Type',
        u.endsWith('.mjs') || u.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8'
      )
      res.end(fs.readFileSync(f))
    })
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => resolve(srv))
  })
}

async function waitForRun(win) {
  for (let i = 0; i < 100; i++) {
    const ok = await win.webContents.executeJavaScript('typeof window.__runTextRuns === "function"')
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
    console.log('探针 bundle 未加载成功（window.__runTextRuns 未定义）')
    app.exit(1)
    return
  }
  console.log('Chromium = ' + process.versions.chrome + ' / Electron = ' + process.versions.electron)
  console.log('探针页   = http://127.0.0.1:' + port + '/')

  for (const c of CASES) {
    console.log('\n' + '='.repeat(78))
    console.log('用例: ' + c.name)
    console.log('文件: ' + c.file)
    if (!fs.existsSync(c.file)) {
      console.log('  跳过（文件不存在）')
      continue
    }
    const b64 = fs.readFileSync(c.file).toString('base64')
    const res = await win.webContents.executeJavaScript(
      `window.__runTextRuns(${JSON.stringify(b64)}, ${c.maxPages})`
    )
    console.log('  pdfjs 版本 : ' + res.pdfjsVersion)
    console.log('  workerSrc  : ' + res.workerSrc)
    console.log('  耗时       : ' + res.ms + 'ms')
    if (!res.ok) {
      console.log('  抛异常     : ' + res.error)
      continue
    }
    console.log('  PDF 总页数 : ' + res.totalPages + '（本次处理 ' + res.pageCount + ' 页）')
    console.log('  onProgress : ' + JSON.stringify(res.progressCalls))
    if (res.firstRunExact) {
      console.log('  runs[0] 原始字段（未做四舍五入）: ' + res.firstRunExact)
    }
    for (const p of res.pages) {
      console.log(
        '\n  --- 第 ' + (p.page + 1) + ' 页：' + p.runCount + ' 个 run / 视口 ' + p.width.toFixed(2) + ' × ' + p.height.toFixed(2) + ' pt'
      )
      console.log('      align 分布  : ' + JSON.stringify(p.alignCounts))
      console.log('      字体名集合  : ' + JSON.stringify(p.fontFamilies))
      p.runs.forEach((run, i) => {
        console.log('      [' + i + '] ' + run.id + ' ' + JSON.stringify(run.text))
        console.log(
          '           rect x=' +
            run.rect.x.toFixed(2) +
            ' y=' +
            run.rect.y.toFixed(2) +
            ' w=' +
            run.rect.width.toFixed(2) +
            ' h=' +
            run.rect.height.toFixed(2) +
            ' | baseline=' +
            run.baseline.toFixed(2) +
            ' | fontSize=' +
            run.fontSize.toFixed(2) +
            ' | ' +
            run.align
        )
        console.log(
          '           色 rgb(' +
            Math.round(run.color.r * 255) +
            ',' +
            Math.round(run.color.g * 255) +
            ',' +
            Math.round(run.color.b * 255) +
            ') / 底 rgb(' +
            Math.round(run.bgColor.r * 255) +
            ',' +
            Math.round(run.bgColor.g * 255) +
            ',' +
            Math.round(run.bgColor.b * 255) +
            ') | 字体 ' +
            run.fontFamily
        )
      })
    }
    if (res.fontProbe) {
      console.log('\n  字体名诊断（page.commonObjs 各阶段实测）：')
      console.log('    渲染前（getTextContent 之后）: ' + JSON.stringify(res.fontProbe.beforeRender))
      console.log('    渲染后                        : ' + JSON.stringify(res.fontProbe.afterRender))
      console.log('    回调形式等待                  : ' + JSON.stringify(res.fontProbe.viaCallback))
    }
    if (res.firstRunChecks) {
      console.log('\n  客观核对（把 run 的 rect 换算回设备像素，数的像素）：')
      for (const chk of res.firstRunChecks) {
        const px = chk.pixel
        console.log(
          '    ' +
            chk.id +
            ' 「' +
            chk.text +
            '」' +
            (px
              ? '\n      设备框=[' +
                px.deviceBox.join(',') +
                '] 画布=' +
                px.canvas.join('×') +
                ' 墨色占比=' +
                (px.inkFraction * 100).toFixed(1) +
                '%（深色 ' +
                (px.darkFraction * 100).toFixed(1) +
                '%）| y在视口页内=' +
                px.yInPageRange +
                ' y在未旋转页内=' +
                px.yInUnrotatedPageRange +
                ' 未旋转页=' +
                px.unrotatedPage.map((v) => v.toFixed(2)).join('×') +
                ' x非负=' +
                px.xNonNegative
              : '  像素核对不可用')
        )
      }
    }
  }
  console.log('\n' + '='.repeat(78))
  srv.close()
  app.exit(0)
})
