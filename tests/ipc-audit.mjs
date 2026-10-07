/* IPC 通道审计：跨行安全地提取 ipcMain.handle / invoke 的通道名，算双向差集。
 * 用法：node tests/ipc-audit.mjs  （仅读取 src，不修改） */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'out' || name === 'dist') continue
      walk(p, out)
    } else if (['.ts', '.tsx', '.mts', '.js'].includes(extname(name))) {
      out.push(p)
    }
  }
  return out
}

// 提取 `callee(` 之后第一个字符串字面量（允许跨行/空白）
function extract(files, callee) {
  const set = new Set()
  const re = new RegExp(callee + '\\s*\\(\\s*[\'"`]([a-zA-Z][a-zA-Z0-9:_-]*)[\'"`]', 'g')
  for (const f of files) {
    let src
    try { src = readFileSync(f, 'utf-8') } catch { continue }
    let m
    while ((m = re.exec(src))) set.add(m[1])
  }
  return set
}

const mainFiles = walk(join(ROOT, 'src/main'))
const feFiles = [...walk(join(ROOT, 'src/preload')), ...walk(join(ROOT, 'src/renderer'))]

const registered = extract(mainFiles, 'ipcMain\\.handle')
const called = extract(feFiles, '(?:ipcRenderer\\.)?invoke')

const dead = [...registered].filter((c) => !called.has(c)).sort()
const missing = [...called].filter((c) => !registered.has(c)).sort()

console.log(`注册 ${registered.size} / 调用 ${called.size}`)
console.log('\n注册但未被调用（候选死通道，需人工甄别是否主进程内部调用）:')
dead.forEach((c) => console.log('  ' + c))
console.log('\n调用但未注册（崩溃隐患，应为空）:')
missing.forEach((c) => console.log('  ' + c))
