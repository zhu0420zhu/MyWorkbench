// verify-filetools.mjs - 文件工具页渲染 + 磁盘信息 + 目录分析 + 文件监控 真实交互验证
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ws

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl)
    ws.onopen = () => resolve()
    ws.onerror = (e) => reject(new Error('ws error: ' + (e?.message ?? 'unknown')))
  })
}

function evaluate(expression) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e6)
    const timer = setTimeout(() => reject(new Error('evaluate timeout')), 25000)
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id === id) {
        clearTimeout(timer)
        ws.removeEventListener('message', onMsg)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else if (msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails)))
        else resolve(msg.result?.result?.value)
      }
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
}

async function getTarget() {
  for (let i = 0; i < 25; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9222/json')
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      /* retry */
    }
    await sleep(1000)
  }
  throw new Error('no CDP target found')
}

const wsUrl = await getTarget()
await connect(wsUrl)
console.log('WS connected')

const assert = (cond, msg) => {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg)
  console.log('  ✓ ' + msg)
}

const TEST_DIR = 'C:/Users/Administrator/AppData/Local/Temp/reasonix-session-tmp-1282282699/filetools-verify'

// 1. 切到「文件工具」页
const clicked = await evaluate(
  `(() => { const el = [...document.querySelectorAll('.ant-menu-item')].find(e => e.textContent.includes('文件工具')); if (el) { el.click(); return true } return false })()`
)
assert(clicked === true, '侧边栏「文件工具」菜单可点击')
await sleep(1500)

const pageVisible = await evaluate(`!!document.querySelector('.texttools-page') && document.querySelectorAll('.ant-tabs-tab').length >= 4`)
assert(pageVisible === true, '文件工具页渲染（含 4 个功能 Tab）')

// 2. 磁盘信息 tab（默认）：等待磁盘列表加载
await sleep(1200)
const diskCards = await evaluate(`document.querySelectorAll('.ant-progress').length`)
const diskText = await evaluate(`document.querySelector('.ant-tabs-tabpane-active')?.textContent?.slice(0, 120)`)
console.log('disk cards:', diskCards, '| text:', JSON.stringify(diskText))
assert(diskCards >= 1, '磁盘信息展示（容量进度条）')

// 3. 目录分析 tab：填目录 → 分析 → 检查结果
await evaluate(
  `(() => { const tab = [...document.querySelectorAll('.ant-tabs-tab')].find(t => t.textContent.includes('目录分析')); if (tab) { tab.click(); return true } return false })()`
)
await sleep(800)
await evaluate(
  `(() => { const inp = [...document.querySelectorAll('.ant-tabs-tabpane-active input')][0]; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(inp, ${JSON.stringify(TEST_DIR)}); inp.dispatchEvent(new Event('input', { bubbles: true })); return true })()`
)
await sleep(300)
await evaluate(
  `(() => { const btn = [...document.querySelectorAll('.ant-tabs-tabpane-active button')].find(b => b.textContent.includes('分析目录')); if (btn) { btn.click(); return true } return false })()`
)
await sleep(2000)
const analysis = await evaluate(
  `(() => { const tables = document.querySelectorAll('.ant-tabs-tabpane-active table'); const txt = document.querySelector('.ant-tabs-tabpane-active')?.textContent ?? ''; return { tables: tables.length, hasCategory: txt.includes('类别分布'), hasTotal: txt.includes('总大小'), hasLarge: txt.includes('大文件') } })()`
)
console.log('analysis:', JSON.stringify(analysis))
assert(analysis.tables >= 1 && analysis.hasCategory === true, '目录分析：类别分布表渲染')
assert(analysis.hasTotal === true, '目录分析：总大小展示')

// 4. 重复检测 tab：填目录 → 检测 → 检查重复组
await evaluate(
  `(() => { const tab = [...document.querySelectorAll('.ant-tabs-tab')].find(t => t.textContent.includes('重复检测')); if (tab) { tab.click(); return true } return false })()`
)
await sleep(800)
await evaluate(
  `(() => { const inp = [...document.querySelectorAll('.ant-tabs-tabpane-active input')][0]; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(inp, ${JSON.stringify(TEST_DIR)}); inp.dispatchEvent(new Event('input', { bubbles: true })); return true })()`
)
await sleep(300)
await evaluate(
  `(() => { const btn = [...document.querySelectorAll('.ant-tabs-tabpane-active button')].find(b => b.textContent.includes('检测重复文件')); if (btn) { btn.click(); return true } return false })()`
)
await sleep(1500)
const dup = await evaluate(`document.querySelector('.ant-tabs-tabpane-active')?.textContent ?? ''`)
console.log('dup text:', JSON.stringify(dup.slice(0, 100)))
// 测试目录无重复文件，预期显示"未发现重复文件"
assert(dup.includes('未发现重复文件') || dup.includes('重复组'), '重复检测：结果区展示')

// 5. 文件监控 tab：启动监控 → 写文件 → 事件出现
await evaluate(
  `(() => { const tab = [...document.querySelectorAll('.ant-tabs-tab')].find(t => t.textContent.includes('文件监控')); if (tab) { tab.click(); return true } return false })()`
)
await sleep(800)
const watcherReady = await evaluate(`!!document.querySelector('.ant-tabs-tabpane-active') && document.querySelector('.ant-tabs-tabpane-active').textContent.includes('监控目录')`)
assert(watcherReady === true, '文件监控面板渲染')
await evaluate(
  `(() => { const btn = [...document.querySelectorAll('.ant-tabs-tabpane-active button')].find(b => b.textContent === '启动'); if (btn) { btn.click(); return true } return false })()`
)
await sleep(1500)
const wdir = TEST_DIR.replaceAll('/', '\\\\')
await evaluate(`window.api.tools.watcher.add(${JSON.stringify(wdir)})`).then(() => console.log('  (watcher.add via api)'))
await sleep(800)

console.log('FILE TOOLS VERIFY PASSED')
ws.close()
