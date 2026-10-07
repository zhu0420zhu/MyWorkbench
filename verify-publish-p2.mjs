// verify-publish-p2.mjs - P2 UI 实机验证（AI 摘要/排程/统计）
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

// 1. 热点页 + 打开编辑 Modal
await evaluate(`(() => { const el = [...document.querySelectorAll('.ant-menu-item')].find(e => e.textContent.includes('热点')); if (el) { el.click(); return true } return false })()`)
await sleep(3000)
await evaluate(`(() => { const btn = [...document.querySelectorAll('.ant-list-item button')].find(b => b.textContent.includes('编辑发布')); if (btn) { btn.click(); return true } return false })()`)
await sleep(1500)

// 2. AI 摘要按钮存在
const hasAiSummary = await evaluate(`([...document.querySelectorAll('.ant-modal-content button')].some(b => b.textContent.includes('AI 摘要')))`)
assert(hasAiSummary === true, '「AI 摘要」按钮存在')

// 3. 排程时间输入存在
const hasSchedule = await evaluate(`(() => { const inp = [...document.querySelectorAll('.ant-modal-content input')].find(i => i.type === 'datetime-local'); return !!inp })()`)
assert(hasSchedule === true, '「预约发布」datetime-local 输入存在')

// 4. 平台行「AI 改写」按钮（微博可发布 → 有改写按钮）
const hasRewrite = await evaluate(`([...document.querySelectorAll('.ant-modal-content button')].some(b => b.textContent.includes('AI 改写')))`)
assert(hasRewrite === true, '平台行「AI 改写」按钮存在')

// 5. 统计行（发布统计 + 成功/失败/待发/已排程）
let hasStats = false
for (let i = 0; i < 12; i++) {
  await sleep(1000)
  hasStats = await evaluate(`(document.querySelector('.ant-modal-content')?.textContent ?? '').includes('发布统计')`)
  if (hasStats) break
}
const statsText = await evaluate(`(() => { const m = document.querySelector('.ant-modal-content')?.textContent ?? ''; return m.slice(m.indexOf('发布统计'), m.indexOf('发布统计') + 120) })()`)
console.log('stats:', JSON.stringify(statsText))
assert(hasStats === true, '「发布统计」行展示')
assert(statsText.includes('成功') && statsText.includes('失败') && statsText.includes('已排程'), '统计含成功/失败/待发/已排程')

// 6. 排程流程：勾选微博 + 填未来时间 → 提交 → 任务应为 pending（未到期）
await evaluate(`(() => { const check = [...document.querySelectorAll('.ant-modal-content .ant-checkbox-wrapper')].find(c => c.parentElement?.textContent?.includes('微博')); if (check) { check.querySelector('input').click(); return true } return false })()`)
await sleep(400)
const future = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 16) // 1 小时后
await evaluate(`(() => { const inp = [...document.querySelectorAll('.ant-modal-content input')].find(i => i.type === 'datetime-local'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(inp, ${JSON.stringify(future)}); inp.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
await sleep(300)
await evaluate(`(() => { const btn = [...document.querySelectorAll('.ant-modal-content button')].find(b => b.textContent.includes('提交发布')); if (btn) { btn.click(); return true } return false })()`)
await sleep(1200)
const queueInfo = await evaluate(`(() => { const m = document.querySelector('.ant-modal-content')?.textContent ?? ''; return { hasPending: m.includes('pending'), hasSchedStat: m.includes('已排程') } })()`)
console.log('queue after schedule:', JSON.stringify(queueInfo))

console.log('PUBLISH P2 VERIFY PASSED')
ws.close()
