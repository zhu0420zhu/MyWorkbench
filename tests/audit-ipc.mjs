import fs from 'fs'
import path from 'path'

function walk(d, out = []) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name)
    if (f.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const files = [
  ...walk('src/main'),
  ...walk('src/preload'),
  ...walk('src/renderer')
].filter((f) => /\.(ts|tsx)$/.test(f))

const reg = new Set()
const inv = new Set()
const QT = String.fromCharCode(96) + "'\"" // backtick + single + double quote
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8')
  for (const m of s.matchAll(/ipcMain\.handle\(\s*[`'"]([^`'"]+)/g)) reg.add(m[1])
  for (const m of s.matchAll(/ipcRenderer\.invoke\(\s*[`'"]([^`'"]+)/g)) inv.add(m[1])
}
const dead = [...inv].filter((x) => !reg.has(x))
const unused = [...reg].filter((x) => !inv.has(x))
console.log('registered', reg.size, 'invoked', inv.size)
console.log('dead-invoked (call renderer but no handler):', dead.length ? dead : 'none')
console.log('unused (handler but nobody calls):', unused.length ? unused : 'none')
const nv = [...reg].filter((x) => x.startsWith('novel:')).sort()
console.log('novel channels', nv.length)
console.log(nv.join('\n'))
