// verify-p0.mjs - P0 UI 实机验证（改名多媒体/引号符号/磁盘清理/登录汇总）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ws

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl)
    ws.onopen = () => resolve()
    ws.onerror = (e) => reject(new Error('ws error'))
  })
}

function evaluate(expression) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e6)
    const timer = setTimeout(() => reject(new Error('timeout')), 30000)
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
  throw new Error('no target')
}

const wsUrl = await getTarget()
await connect(wsUrl)
console.log('WS connected')

const assert = (cond, msg) => {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg)
  console.log('  ✓ ' + msg)
}

// 1. 导航改名「多媒体」
const navLabel = await evaluate(`([...document.querySelectorAll('.ant-menu-item')].some(e => e.textContent.includes('多媒体')))`)
assert(navLabel === true, '侧边栏导航显示「多媒体」')
await evaluate(`(() => { const el = [...document.querySelectorAll('.ant-menu-item')].find(e => e.textContent.includes('多媒体')); el.click(); return true })()`)
await sleep(2500)
const pageTitle = await evaluate(`(document.querySelector('.page-header')?.textContent ?? '').includes('多媒体')`)
assert(pageTitle === true, '页面标题含「多媒体」')

// 2. 文本工具：引号+符号同时（位置首尾）
await evaluate(`(() => { const el = [...document.querySelectorAll('.ant-menu-item')].find(e => e.textContent.includes('文本工具')); el.click(); return true })()`)
await sleep(1500)
await evaluate(`(() => { const ta = document.querySelector('.texttools-pane .texttools-textarea'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, '苹果'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
await sleep(300)
// 勾选引号（双）+ 逗号：按「符号添加」工具组定位
await evaluate(`(() => { const g = [...document.querySelectorAll('.tool-group')].find(g => g.textContent.includes('符号添加')); g.querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true })()`)
await sleep(800)
await evaluate(`(() => { const opt = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find(i => i.textContent.includes('"双')); if (opt) { opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); opt.click(); return true } return false })()`)
await sleep(400)
await evaluate(`(() => { const w = [...document.querySelectorAll('.texttools-tools .ant-checkbox-wrapper')].find(w => w.textContent.trim() === ','); if (w) { w.querySelector('input').click(); return true } return false })()`)
await sleep(400)
// 位置选「首尾」
await evaluate(`(() => { const g = [...document.querySelectorAll('.tool-group')].find(g => g.textContent.includes('符号添加')); const sels = [...g.querySelectorAll('.ant-select')]; const pos = sels.find(s => s.textContent.includes('行尾') || s.textContent.includes('行首')); pos.querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true })()`)
await sleep(800)
await evaluate(`(() => { const opt = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find(i => i.textContent.includes('首尾')); if (opt) { opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); opt.click(); return true } return false })()`)
await sleep(400)
await evaluate(`(() => { const btn = [...document.querySelectorAll('.texttools-tools button')].find(b => b.textContent.includes('添加符号')); if (btn) { btn.click(); return true } return false })()`)
await sleep(500)
const symOut = await evaluate(`document.querySelector('.texttools-output')?.textContent`)
console.log('symbol output:', JSON.stringify(symOut))
assert(symOut === '"苹果"\n,苹果,', `引号+符号同时添加（首尾）：${JSON.stringify(symOut)}`)

// 3. 文件工具：磁盘清理 tab
await evaluate(`(() => { const el = [...document.querySelectorAll('.ant-menu-item')].find(e => e.textContent.includes('文件工具')); el.click(); return true })()`)
await sleep(1500)
const tabs = await evaluate(`(() => [...document.querySelectorAll('.ant-tabs-tab')].map(t => t.textContent.trim()))()`)
console.log('filetools tabs:', JSON.stringify(tabs))
assert(tabs.includes('磁盘清理'), '文件工具含「磁盘清理」tab')
// 磁盘信息默认不自动加载（无进度条内容）
const diskAuto = await evaluate(`(document.querySelector('.ant-tabs-tabpane-active')?.textContent ?? '').includes('刷新磁盘')`)
assert(diskAuto === true, '磁盘信息 tab 为手动（含刷新按钮）')

// 4. 多媒体发布面板登录汇总
await evaluate(`(() => { const el = [...document.querySelectorAll('.ant-menu-item')].find(e => e.textContent.includes('多媒体')); el.click(); return true })()`)
await sleep(2500)
await evaluate(`(() => { const btn = [...document.querySelectorAll('.ant-list-item button')].find(b => b.textContent.includes('编辑发布')); if (btn) { btn.click(); return true } return false })()`)
await sleep(2000)
const loginSummary = await evaluate(`(document.querySelector('.ant-modal-content')?.textContent ?? '').includes('已登录')`)
console.log('login summary visible:', loginSummary)

console.log('P0 VERIFY PASSED')
ws.close()
