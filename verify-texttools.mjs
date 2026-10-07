// verify-texttools.mjs - 文本工具页渲染 + 真实交互验证（去重/高亮/diff）
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
    const timer = setTimeout(() => reject(new Error('evaluate timeout')), 20000)
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id === id) {
        clearTimeout(timer)
        ws.removeEventListener('message', onMsg)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else if (msg.result?.exceptionDetails)
          reject(new Error(JSON.stringify(msg.result.exceptionDetails)))
        else resolve(msg.result?.result?.value)
      }
    }
    ws.addEventListener('message', onMsg)
    ws.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true }
      })
    )
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

// 1. 切到「文本工具」页
const clicked = await evaluate(
  `(() => { const el = [...document.querySelectorAll('.ant-menu-item')].find(e => e.textContent.includes('文本工具')); if (el) { el.click(); return true } return false })()`
)
assert(clicked === true, '侧边栏「文本工具」菜单可点击')
await sleep(1500)

const pageVisible = await evaluate(`!!document.querySelector('.texttools-page')`)
assert(pageVisible === true, '文本工具页渲染')

// 2. 去重交互：设置输入 → 点「去重行」→ 检查输出
await evaluate(
  `(() => { const ta = document.querySelector('.texttools-pane .texttools-textarea'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, 'a\\nb\\na\\nc\\nb'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true })()`
)
await sleep(300)
const btnClicked = await evaluate(
  `(() => { const btn = [...document.querySelectorAll('.texttools-tools button')].find(b => b.textContent.includes('去重行')); if (btn) { btn.click(); return true } return false })()`
)
assert(btnClicked === true, '「去重行」按钮可点击')
await sleep(400)
const output = await evaluate(`document.querySelector('.texttools-output')?.textContent`)
console.log('dedupe output:', JSON.stringify(output))
assert(output === 'a\nb\nc', '去重输出正确')

// 3. 加引号
await evaluate(
  `(() => { const btn = [...document.querySelectorAll('.texttools-tools button')].find(b => b.textContent.includes('每行加引号')); if (btn) { btn.click(); return true } return false })()`
)
await sleep(300)
const quoted = await evaluate(`document.querySelector('.texttools-output')?.textContent`)
console.log('quote output:', JSON.stringify(quoted))
assert(quoted === '"a"\n"b"\n"a"\n"c"\n"b"', '每行加双引号输出正确（作用于输入区原始内容）')

// 4. 符号添加：英文模式多选逗号+百分号，批量添加到每行
await evaluate(
  `(() => { const ta = document.querySelector('.texttools-pane .texttools-textarea'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, 'a\\nb\\nc'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true })()`
)
await sleep(300)
// 勾选预设符号（受控组件需分开点击，避免状态覆盖）：逗号、百分号
const commaClicked = await evaluate(
  `(() => { const w = [...document.querySelectorAll('.texttools-tools .ant-checkbox-wrapper')].find(w => w.textContent.trim() === ','); if (w) { w.querySelector('input').click(); return true } return false })()`
)
assert(commaClicked === true, '英文模式预设「逗号」可勾选')
await sleep(300)
const pctClicked = await evaluate(
  `(() => { const w = [...document.querySelectorAll('.texttools-tools .ant-checkbox-wrapper')].find(w => w.textContent.trim() === '%'); if (w) { w.querySelector('input').click(); return true } return false })()`
)
assert(pctClicked === true, '英文模式预设「百分号」可勾选')
await sleep(300)
await evaluate(
  `(() => { const btn = [...document.querySelectorAll('.texttools-tools button')].find(b => b.textContent.includes('添加符号')); if (btn) { btn.click(); return true } return false })()`
)
await sleep(400)
const symbolOut = await evaluate(`document.querySelector('.texttools-output')?.textContent`)
console.log('symbol output:', JSON.stringify(symbolOut))
assert(symbolOut === 'a,\na%\nb,\nb%\nc,\nc%', '符号添加：逗号+百分号批量添加到每行（独立成行）')

// 5. 关键词高亮模式
await evaluate(
  `(() => { const seg = [...document.querySelectorAll('.ant-segmented-item')].find(e => e.textContent.includes('关键词高亮')); if (seg) { seg.click(); return true } return false })()`
)
await sleep(800)
await evaluate(
  `(() => { const ta = document.querySelector('.texttools-single textarea'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, 'error: disk full, warning: low memory, error again'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true })()`
)
await sleep(300)
await evaluate(
  `(() => { const inp = document.querySelector('.texttools-option-row input'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(inp, 'error'); inp.dispatchEvent(new Event('input', { bubbles: true })); return true })()`
)
await sleep(500)
const markCount = await evaluate(`document.querySelectorAll('.texttools-output mark').length`)
console.log('highlight marks:', markCount)
assert(markCount >= 2, '关键词高亮标出所有匹配')

// 6. 差异对比模式
await evaluate(
  `(() => { const seg = [...document.querySelectorAll('.ant-segmented-item')].find(e => e.textContent.includes('差异对比')); if (seg) { seg.click(); return true } return false })()`
)
await sleep(800)
await evaluate(
  `(() => { const tas = document.querySelectorAll('.texttools-diff-panes .texttools-textarea'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(tas[0], 'a\\nb\\nc'); tas[0].dispatchEvent(new Event('input', { bubbles: true })); setter.call(tas[1], 'a\\nx\\nc'); tas[1].dispatchEvent(new Event('input', { bubbles: true })); return true })()`
)
await sleep(600)
const diffInfo = await evaluate(
  `(() => { const add = document.querySelectorAll('.diff-add').length; const rem = document.querySelectorAll('.diff-remove').length; const same = document.querySelectorAll('.diff-same').length; return { add, rem, same } })()`
)
console.log('diff:', JSON.stringify(diffInfo))
assert(diffInfo.add === 1 && diffInfo.rem === 1 && diffInfo.same === 2, 'diff 红绿行正确（+x / -b / =a,c）')

console.log('TEXTTOOLS VERIFY PASSED')
ws.close()
