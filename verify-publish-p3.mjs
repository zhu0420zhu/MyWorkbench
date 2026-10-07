// verify-publish-p3.mjs - 适配器完善 + 热点推送 UI 实机验证
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
    const timer = setTimeout(() => reject(new Error('evaluate timeout')), 30000)
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

// 1. 热点页
await evaluate(`(() => { const el = [...document.querySelectorAll('.ant-menu-item')].find(e => e.textContent.includes('热点')); if (el) { el.click(); return true } return false })()`)
await sleep(3000)

// 2. 热点推送设置区渲染
const notifyArea = await evaluate(`(document.querySelector('.dashboard-page')?.textContent ?? '').includes('热点推送')`)
assert(notifyArea === true, '热点推送设置区渲染')
const notifyBtn = await evaluate(`([...document.querySelectorAll('.dashboard-page button')].some(b => b.textContent.includes('立即检查')))`)
assert(notifyBtn === true, '「立即检查」按钮存在')

// 3. IPC 直测：通知设置读写 + 状态 + 立即检查
const nGet = await evaluate(`window.api.hot.notifierGet().then(r => JSON.stringify(r))`)
console.log('notifier settings:', nGet)
assert(nGet.includes('intervalMinutes'), 'notifierGet 返回设置')
const nCheck = await evaluate(`window.api.hot.notifierCheck().then(r => JSON.stringify(r))`)
console.log('notifier check:', nCheck)
assert(nCheck.includes('"total"'), 'notifierCheck 执行成功（拉取热点对比）')
const nSet = await evaluate(`window.api.hot.notifierSet({ enabled: true, intervalMinutes: 5, topCount: 10 }).then(r => JSON.stringify(r))`)
console.log('notifier set:', nSet)
assert(nSet.includes('"enabled":true'), 'notifierSet 开启推送')
const nStatus = await evaluate(`window.api.hot.notifierStatus().then(r => JSON.stringify(r))`)
console.log('notifier status:', nStatus)
assert(nStatus.includes('"running":true'), 'notifierStatus running=true（定时器已启动）')
// 关闭，避免持续弹通知
await evaluate(`window.api.hot.notifierSet({ enabled: false, intervalMinutes: 5, topCount: 10 })`)

// 4. 发布面板：6 平台（微博/知乎/B站/掘金/公众号/CSDN）
let modalOpened = false
for (let i = 0; i < 6 && !modalOpened; i++) {
  modalOpened = await evaluate(`(() => { const btn = [...document.querySelectorAll('.ant-list-item button')].find(b => b.textContent.includes('编辑发布')); if (btn) { btn.click(); return true } return false })()`)
  await sleep(1200)
}
let platformRows = []
for (let i = 0; i < 30; i++) {
  await sleep(1000)
  platformRows = await evaluate(`(() => [...document.querySelectorAll('.ant-modal-content div')].filter(d => d.textContent.includes('可发布') || d.textContent.includes('待适配')).map(r => r.textContent.trim().slice(0, 50)))()`)
  if (platformRows.length >= 6) break
}
console.log('platform rows:', JSON.stringify(platformRows))
assert(platformRows.length >= 6, `发布面板渲染 ≥6 平台（实际 ${platformRows.length}）`)
assert(platformRows.some((t) => t.includes('B站') && t.includes('可发布')), 'B站 可发布（wbi 签名适配器）')
assert(platformRows.some((t) => t.includes('掘金') && t.includes('可发布')), '掘金 可发布（草稿适配器）')
assert(platformRows.some((t) => t.includes('公众号') && t.includes('可发布')), '公众号 可发布（官方接口）')
assert(platformRows.some((t) => t.includes('知乎') && t.includes('可发布')), '知乎 可发布（半自动）')
assert(platformRows.some((t) => t.includes('CSDN') && t.includes('待适配')), 'CSDN 待适配')

// 5. 公众号「配置」按钮
const gzhBtn = await evaluate(`([...document.querySelectorAll('.ant-modal-content button')].some(b => b.textContent.includes('配置')))`)
assert(gzhBtn === true, '公众号「配置」按钮存在')

console.log('PUBLISH P3 VERIFY PASSED')
ws.close()
