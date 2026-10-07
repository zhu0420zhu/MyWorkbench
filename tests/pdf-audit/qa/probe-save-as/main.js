/* QA 探针（Electron 主进程）——「另存为多格式」运行期验证。
 *
 * 主进程注册的是**生产** registerDocsIpc()（esbuild 打包，electron 外置），
 * 窗口 preload 直接用**生产构建产物** out/preload/index.js；
 * 唯一替身是两个原生对话框：无头环境点不了，改由 PLAN 给出的确定性队列驱动。
 *
 * 队列被耗尽后**抛错**而不是返回取消 —— 这样"本该在弹框之前就失败"的空内容守卫
 * 一旦失效，错误信息会立刻变成 UNEXPECTED_DIALOG，断言不会静默通过。
 */
const { app, BrowserWindow, dialog } = require('electron')
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { join, dirname } = require('node:path')

const { registerDocsIpc } = require('./dist/docs-ipc.cjs')

const PLAN = JSON.parse(readFileSync(process.env.PROBE_PLAN, 'utf-8'))
const OUT = process.env.PROBE_OUT

const dialogCalls = []
let openIdx = 0
let saveIdx = 0
dialog.showOpenDialog = async (...args) => {
  dialogCalls.push({ kind: 'open', options: args[args.length - 1] })
  const next = PLAN.openDialogs[openIdx++]
  if (next === undefined) throw new Error('UNEXPECTED_DIALOG(open)')
  return next === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [next] }
}
dialog.showSaveDialog = async (...args) => {
  dialogCalls.push({ kind: 'save', options: args[args.length - 1] })
  const next = PLAN.saveDialogs[saveIdx++]
  if (next === undefined) throw new Error('UNEXPECTED_DIALOG(save)')
  return next === null ? { canceled: true, filePath: undefined } : { canceled: false, filePath: next }
}

const report = (payload) => {
  try {
    mkdirSync(dirname(OUT), { recursive: true })
    writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf-8')
  } catch (e) {
    console.error('[probe] 写报告失败', e)
  }
}

app.whenReady().then(async () => {
  registerDocsIpc()
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: { preload: PLAN.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false }
  })
  win.webContents.on('render-process-gone', (_e, d) => {
    report({ fatal: 'render-process-gone: ' + JSON.stringify(d), dialogCalls })
    app.quit()
  })
  win.webContents.on('console-message', (...a) => {
    const d = a[1]
    if (d && typeof d === 'object' && 'message' in d) console.log('[renderer]', d.level, d.message)
    else console.log('[renderer]', a[1], a[2])
  })
  try {
    await win.loadFile(PLAN.pagePath)
    let ready = false
    for (let i = 0; i < 200 && !ready; i++) {
      ready = await win.webContents.executeJavaScript("typeof window.__probeRun === 'function'", true)
      if (!ready) await new Promise((res) => setTimeout(res, 50))
    }
    if (!ready) throw new Error('window.__probeRun 未在 10s 内就绪')
    const result = await win.webContents.executeJavaScript('window.__probeRun()', true)
    report({ result, dialogCalls })
  } catch (e) {
    report({ fatal: 'main: ' + (e && e.stack ? e.stack : String(e)), dialogCalls })
  }
  app.quit()
})

app.on('window-all-closed', () => app.quit())
