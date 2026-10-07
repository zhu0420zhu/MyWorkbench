/* QA 探针（Electron 主进程）。
 *
 * 与生产 app 的关系：
 *   - 主进程侧：注册的是**生产** registerPdfIpc()（含真实 pathAcl 校验），
 *     只把两个原生对话框打桩成确定性返回（无头环境点不了真对话框）；
 *   - preload 侧：直接用**生产构建产物** out/preload/index.js，不做任何替换，
 *     这样窗口里拿到的 window.api.pdf.* 就是用户点按钮时走的那一条链路。
 */
const { app, BrowserWindow, dialog } = require('electron')
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { join, dirname } = require('node:path')

const { registerPdfIpc } = require('./dist/pdf-ipc.cjs')

const PLAN = JSON.parse(readFileSync(process.env.PROBE_PLAN, 'utf-8'))
const OUT = process.env.PROBE_OUT
const PRELOAD = PLAN.preloadPath
const PAGE = PLAN.pagePath

const dialogCalls = []
/** 依次消费 PLAN.openDialogs / PLAN.saveDialogs，无剩余时返回取消 */
let openIdx = 0
let saveIdx = 0
dialog.showOpenDialog = async (...args) => {
  dialogCalls.push({ kind: 'open', options: args[args.length - 1] })
  const next = PLAN.openDialogs[openIdx++]
  return next ? { canceled: false, filePaths: next } : { canceled: true, filePaths: [] }
}
dialog.showSaveDialog = async (...args) => {
  dialogCalls.push({ kind: 'save', options: args[args.length - 1] })
  const next = PLAN.saveDialogs[saveIdx++]
  return next ? { canceled: false, filePath: next } : { canceled: true, filePath: undefined }
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
  registerPdfIpc()
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
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
    await win.loadFile(PAGE)
    // 模块脚本是异步执行的，必须等到探针入口挂到 window 上再调用
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
