// verify-publish.mjs - 多平台一键分发 UI 实机验证（发布面板/平台状态/队列）
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

// 1. 切到热点页并等待聚合
await evaluate(
  `(() => { const el = [...document.querySelectorAll('.ant-menu-item')].find(e => e.textContent.includes('热点')); if (el) { el.click(); return true } return false })()`
)
await sleep(3000)

// 2. 打开「编辑发布」Modal
await evaluate(
  `(() => { const btn = [...document.querySelectorAll('.ant-list-item button')].find(b => b.textContent.includes('编辑发布')); if (btn) { btn.click(); return true } return false })()`
)
await sleep(1500)

// 3. 平台列表（发布面板）——轮询等待 checkAllLogin 网络探测完成
let platforms = []
for (let i = 0; i < 15; i++) {
  await sleep(1000)
  platforms = await evaluate(
    `(() => { const rows = [...document.querySelectorAll('.ant-modal-content div')].filter(d => d.textContent.includes('可发布') || d.textContent.includes('待适配')); return rows.map(r => r.textContent.trim().slice(0, 60)) })()`
  )
  if (platforms.length >= 4) break
}
console.log('platform rows:', JSON.stringify(platforms))
assert(platforms.length >= 4, '发布面板渲染 4 个平台（微博可发布 + 3 待适配）')
const weiboRow = platforms.find((t) => t.includes('微博'))
assert(weiboRow !== undefined && weiboRow.includes('可发布'), '微博为可发布状态')
assert(platforms.some((t) => t.includes('知乎') && t.includes('待适配')), '知乎待适配')

// 4. 登录状态区（未登录 → 有「去登录」按钮）
const hasLoginBtn = await evaluate(
  `(() => [...document.querySelectorAll('.ant-modal-content button')].some(b => b.textContent.includes('去登录')))()`
)
assert(hasLoginBtn === true, '平台未登录时显示「去登录」按钮')

// 5. 勾选微博 → 提交发布（未登录，预期队列出现失败任务 + 重试）
await evaluate(
  `(() => { const check = [...document.querySelectorAll('.ant-modal-content .ant-checkbox-wrapper')].find(c => c.parentElement?.textContent?.includes('微博')); if (check) { check.querySelector('input').click(); return true } return false })()`
)
await sleep(400)
await evaluate(
  `(() => { const btn = [...document.querySelectorAll('.ant-modal-content button')].find(b => b.textContent.includes('提交发布')); if (btn) { btn.click(); return true } return false })()`
)
await sleep(2500)
const queue = await evaluate(
  `(() => { const txt = document.querySelector('.ant-modal-content')?.textContent ?? ''; return { hasQueue: txt.includes('发布队列'), hasWeibo: txt.includes('微博'), hasFailed: txt.includes('failed'), hasRetry: txt.includes('重试') } })()`
)
console.log('queue:', JSON.stringify(queue))
assert(queue.hasQueue === true, '发布队列区展示')
assert(queue.hasWeibo === true && queue.hasFailed === true, '微博任务进入队列并标记 failed（未登录）')
assert(queue.hasRetry === true, '失败任务显示「重试」按钮')

console.log('PUBLISH VERIFY PASSED')
ws.close()
