/* QA 探针（Electron 主进程）——图片编辑 UI 的真实渲染进程 e2e。
 *
 * 主进程注册的是**生产** registerPdfIpc()（含真实 pathAcl），窗口 preload 用的是
 * **生产构建产物** out/preload/index.js —— 也就是说渲染进程里的 window.api.pdf.*
 * 就是用户点按钮时走的那条链路。
 *
 * 唯一替身：
 *   1. 原生打开/保存对话框（无头点不了）→ 由 PLAN 的确定性队列驱动；
 *   2. 渲染进程里 <input type=file> 的原生文件选择框 → 由页面自己的 patch 拦掉
 *      （探针直接给 input.files 塞 File 再派发 change，等价于用户选了文件）。
 */
const { app, BrowserWindow, dialog } = require('electron')
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { join, dirname } = require('node:path')

const { registerPdfIpc } = require('./dist/pdf-ipc.cjs')

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

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  registerPdfIpc()
  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 1000,
    webPreferences: {
      preload: PLAN.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // file:// 页面下加载 pdf.js 的 module worker 需要放开 webSecurity（与 probe-ocr 同一处理）
      webSecurity: false
    }
  })
  win.webContents.on('render-process-gone', (_e, d) => {
    report({ fatal: 'render-process-gone: ' + JSON.stringify(d), dialogCalls })
    app.quit()
  })
  win.webContents.on('console-message', (...a) => {
    const d = a[1]
    if (d && typeof d === 'object' && 'message' in d) {
      if (d.level !== 'info' || /error|Error|failed|Failed/.test(String(d.message))) console.log('[renderer]', d.level, d.message)
    } else console.log('[renderer]', a[1], a[2])
  })

  try {
    await win.loadFile(PLAN.pagePath)
    let ready = false
    for (let i = 0; i < 400 && !ready; i++) {
      ready = await win.webContents.executeJavaScript("typeof window.__probeRun === 'function'", true)
      if (!ready) await new Promise((res) => setTimeout(res, 50))
    }
    if (!ready) throw new Error('window.__probeRun 未在 20s 内就绪')
    const result = await win.webContents.executeJavaScript('window.__probeRun()', true)
    report({ result, dialogCalls })
  } catch (e) {
    report({ fatal: 'main: ' + (e && e.stack ? e.stack : String(e)), dialogCalls })
  }
  app.quit()
})

app.on('window-all-closed', () => app.quit())
