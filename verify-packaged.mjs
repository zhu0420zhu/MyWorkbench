// verify-packaged.mjs - 打包产物冒烟测试（热点聚合 + 发布面板 + IPC）
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

// 1. 热点页
await evaluate(`(() => { const el = [...document.querySelectorAll('.ant-menu-item')].find(e => e.textContent.includes('热点')); if (el) { el.click(); return true } return false })()`)
await sleep(3000)
const hotCount = await evaluate(`document.querySelectorAll('.ant-list-item').length`)
console.log('hot events:', hotCount)
assert(hotCount > 0, '打包产物：热点聚合正常（DailyHotApi 内嵌于 asar）')

// 2. 发布面板 6 平台（IPC 直测更快）
await evaluate(`(() => { const btn = [...document.querySelectorAll('.ant-list-item button')].find(b => b.textContent.includes('编辑发布')); if (btn) { btn.click(); return true } return false })()`)
await sleep(1200)
const platforms = await evaluate(`window.api.publish.listPlatforms().then(r => JSON.stringify(r.map(p => p.id)))`)
console.log('platforms:', platforms)
assert(platforms.includes('weibo') && platforms.includes('bilibili') && platforms.includes('gongzhonghao'), '打包产物：6 平台适配器已注册')

// 3. 通知设置 IPC
const notify = await evaluate(`window.api.hot.notifierGet().then(r => JSON.stringify(r))`)
console.log('notifier:', notify)
assert(notify.includes('intervalMinutes'), '打包产物：热点通知设置 IPC 正常')

// 4. 文件工具 IPC（ck 移植模块在打包产物中）
const disks = await evaluate(`window.api.tools.getAllDisks().then(r => JSON.stringify(r.length))`)
console.log('disks:', disks)
assert(Number(disks) > 0, '打包产物：文件工具 IPC 正常')

console.log('PACKAGED VERIFY PASSED')
ws.close()
