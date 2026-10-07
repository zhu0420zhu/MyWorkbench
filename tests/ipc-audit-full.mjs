/* 全维度 IPC 接线审计（只读）。用法：node tests/ipc-audit-full.mjs
 *
 * 维度：
 *  A. 注册集(src/main ipcMain.handle) × preload 曝光集(ipcRenderer.invoke) 双向差集
 *  B. preload index.ts 方法树 × index.d.ts Api 接口 方法树 一致性（缩进+命名空间栈解析）
 *  C. preload 曝光方法 × 渲染层真实调用(window.api.x.y) 死暴露
 *  D. 渲染层直调 invoke 但主进程未注册（崩溃隐患）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (['node_modules', 'out', 'dist'].includes(name)) continue
      walk(p, out)
    } else if (['.ts', '.tsx', '.mts', '.js', '.html'].includes(extname(name))) out.push(p)
  }
  return out
}

function extractChannels(files, calleeRe) {
  const set = new Set()
  const re = new RegExp(calleeRe + '\\s*\\(\\s*[\'"`]([a-zA-Z][a-zA-Z0-9:_-]*)[\'"`]', 'g')
  for (const f of files) {
    let src
    try { src = readFileSync(f, 'utf-8') } catch { continue }
    let m
    while ((m = re.exec(src))) set.add(m[1])
  }
  return set
}

/**
 * 解析对象字面量 / 接口成员树（缩进 + 命名空间栈）。
 * 规则：只有缩进等于「当前命名空间成员缩进」的行才被认作成员/命名空间，
 *       因此多行参数里的 `x: T` 不会被误判为成员。
 * 返回 Map<path, {channel, kind}>。
 */
function parseTree(file, rootIndent, startMarker) {
  let lines = readFileSync(file, 'utf-8').split(/\r?\n/)
  if (startMarker) {
    const at = lines.findIndex((l) => l.includes(startMarker))
    lines = at >= 0 ? lines.slice(at) : []
  }
  const stack = [] // {indent, name}
  const out = new Map() // path -> {channel, kind, ns}
  let current = null
  const nsRe = /^([A-Za-z_$][\w$]*)\s*:\s*\{\s*$/
  const memRe = /^([A-Za-z_$][\w$]*)\s*:/
  const invRe = /ipcRenderer\.(invoke|send|sendSync|on)\(\s*['"`]([^'"`]+)['"`]/
  for (const line of lines) {
    const indent = line.match(/^\s*/)[0].length
    const trimmed = line.trim()
    if (!trimmed) continue
    const base = stack.length ? stack[stack.length - 1].indent + 2 : rootIndent
    const nsM = nsRe.exec(trimmed)
    if (nsM && indent === base) {
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
      const path = [...stack.map((s) => s.name), nsM[1]].join('.')
      stack.push({ indent, name: nsM[1] })
      out.set(path, { channel: null, kind: null, ns: true })
      current = null
      continue
    }
    if (trimmed.startsWith('}')) {
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    }
    const memM = memRe.exec(trimmed)
    if (memM && indent === base) {
      current = { path: [...stack.map((s) => s.name), memM[1]].join('.') }
      if (!out.has(current.path)) out.set(current.path, { channel: null, kind: null, ns: false })
    }
    const im = invRe.exec(line)
    if (im && current) out.set(current.path, { channel: im[2], kind: im[1], ns: false })
  }
  return out
}

// ---------- A ----------
const mainFiles = walk(join(ROOT, 'src/main'))
const registered = extractChannels(mainFiles, 'ipcMain\\.handle')
const preloadFile = join(ROOT, 'src/preload/index.ts')
const preloadInvoke = extractChannels([preloadFile], 'ipcRenderer\\.invoke')
const preloadSend = extractChannels([preloadFile], 'ipcRenderer\\.send')

// ---------- B ----------
const tsTree = parseTree(preloadFile, 2, 'const api = {')
const dtsTree = parseTree(join(ROOT, 'src/preload/index.d.ts'), 2, 'interface Api {')
const tsPaths = new Set(tsTree.keys())
const dtsPaths = new Set(dtsTree.keys())

// 自检：解析出的 invoke 通道数应等于正则口径
const parsedInvoke = new Set([...tsTree.values()].filter((v) => v.kind === 'invoke').map((v) => v.channel))
console.log(`[自检] 结构解析得 invoke 通道 ${parsedInvoke.size} / 正则口径 ${preloadInvoke.size}` +
  (parsedInvoke.size === preloadInvoke.size ? ' ✅一致' : ' ⚠️不一致'))
const onlyRegex = [...preloadInvoke].filter((c) => !parsedInvoke.has(c))
if (onlyRegex.length) console.log('  正则有而结构解析漏:', onlyRegex.join(', '))

// ---------- C ----------
const rendererFiles = walk(join(ROOT, 'src/renderer'))
const usedPaths = new Set()
// 允许 `window.api\n  .ns\n  .method` 这类跨行链式调用
const useRe = /window\s*\.\s*api(?:\s*\.\s*[A-Za-z_$][\w$]*){1,3}/g
for (const f of rendererFiles) {
  const src = readFileSync(f, 'utf-8')
  let m
  while ((m = useRe.exec(src))) usedPaths.add(m[0].replace(/\s+/g, '').replace(/^window\.api\.?/, ''))
}

// ---------- D ----------
const rendererDirectInvoke = extractChannels(rendererFiles, 'ipcRenderer\\.invoke')

// ================= 输出 =================
const sort = (s) => [...s].sort()
const regNotExp = sort([...registered].filter((c) => !preloadInvoke.has(c)))
const expNotReg = sort([...preloadInvoke].filter((c) => !registered.has(c)))
const inTsNotDts = sort([...tsPaths].filter((p) => !dtsPaths.has(p)))
const inDtsNotTs = sort([...dtsPaths].filter((p) => !tsPaths.has(p)))

const leaves = [...tsTree.entries()].filter(([, v]) => v.kind)
const deadExposed = leaves.filter(([p]) => !usedPaths.has(p)).sort((a, b) => a[0].localeCompare(b[0]))

console.log('\n=== A. 通道双向差集 ===')
console.log(`注册(ipcMain.handle) ${registered.size} / preload曝光(invoke) ${preloadInvoke.size} / preload send ${preloadSend.size}`)
console.log(`\n[A1] 注册但 preload 未曝光（${regNotExp.length}）:`)
regNotExp.forEach((c) => console.log('   ' + c))
console.log(`\n[A2] preload 曝光但主进程未注册（应为空，崩溃隐患）（${expNotReg.length}）:`)
expNotReg.forEach((c) => console.log('   ' + c))

console.log('\n=== B. preload index.ts × index.d.ts 方法树一致性 ===')
console.log(`ts 节点 ${tsPaths.size} / dts 节点 ${dtsPaths.size}`)
console.log(`\n[B1] index.ts 有、index.d.ts 缺（${inTsNotDts.length}）:`)
inTsNotDts.forEach((p) => console.log('   ' + p))
console.log(`\n[B2] index.d.ts 有、index.ts 缺（${inDtsNotTs.length}）:`)
inDtsNotTs.forEach((p) => console.log('   ' + p))

console.log('\n=== C. 死暴露（preload 暴露的 IPC 方法但渲染层零 window.api 调用） ===')
console.log(`渲染层使用路径 ${usedPaths.size} / preload IPC 叶子 ${leaves.length}`)
console.log(`死暴露 ${deadExposed.length}:`)
deadExposed.forEach(([p, v]) => console.log(`   ${p}\t${v.kind}\t${v.channel}`))

console.log('\n=== D. 渲染层直调 invoke 但未注册 ===')
const dmiss = sort([...rendererDirectInvoke].filter((c) => !registered.has(c)))
console.log(`渲染层直调 invoke 通道 ${rendererDirectInvoke.size}，未注册 ${dmiss.length}:`)
dmiss.forEach((c) => console.log('   ' + c))

console.log('\n=== 附：preload ipcRenderer.on 事件订阅通道 ===')
console.log(sort(extractChannels([preloadFile], 'ipcRenderer\\.on')).join('\n'))
