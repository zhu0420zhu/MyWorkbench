// 菜单/页面一致性审计（v2）
//
// 2026-09-28 收敛后：页面中文名统一由 src/shared/pageMeta.ts 的 PAGE_LABELS 提供，
// 本脚本据此复核「名表单源」是否真的成立、以及各处页面清单是否还对得上。
//
// 用法: node tests/audit-menus.mjs
import fs from 'node:fs'

const S = 'src'
/** 读文件 + 统一行尾 + 剥离注释（本项目同一目录下 CRLF/LF 混用，必须先归一） */
const read = (p) =>
  fs
    .readFileSync(p, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

const uniq = (a) => [...new Set(a)]
const grab = (s, re) => [...s.matchAll(re)].map((m) => m[1])
const stripIds = (a) => a.filter((x) => x !== 'default')

/* ---------- 1) 权威名表 ---------- */
const meta = read(`${S}/shared/pageMeta.ts`)
const labelBlock = /export const PAGE_LABELS = \{([\s\S]*?)\n\} as const/.exec(meta)[1]
const labelKeys = []
const labelMap = {}
for (const m of labelBlock.matchAll(/^\s*([a-zA-Z]+):\s*'([^']+)'/gm)) {
  labelKeys.push(m[1])
  labelMap[m[1]] = m[2]
}

/* ---------- 2) PageKey 全集 ---------- */
const navTs = read(`${S}/renderer/src/nav.tsx`)
const pageKeys = uniq(grab(/export type PageKey =([\s\S]*?)\n\nexport/.exec(navTs)[1], /'([a-zA-Z]+)'/g))

/* ---------- 3) 各处页面清单 ---------- */
const navItems = read(`${S}/renderer/src/navItems.tsx`)
const navKeys = uniq(grab(navItems, /\{ key: '([a-zA-Z]+)', icon:/g))

const app = read(`${S}/renderer/src/App.tsx`)
const menuBlock = /const MENU_GROUPS[\s\S]*?\}, \[navigate\]\)/.exec(app)[0]
const menuKeys = uniq(grab(menuBlock, /leaf\('([a-zA-Z]+)'\)/g))
const altKeys = uniq(grab(/const ALT_PAGES[^=]*=\s*\[([\s\S]*?)\n\]/.exec(app)[1], /'([a-z]+)'/g))

const pv = read(`${S}/renderer/src/components/PageView.tsx`)
const pvKeys = uniq(grab(pv, /case '([a-zA-Z]+)':/g))

const search = read(`${S}/main/search.ts`)
const searchKeys = uniq(grab(search, /\{ page: '([a-zA-Z]+)', keywords:/g))

const settings = read(`${S}/renderer/src/pages/Settings.tsx`)
const choiceBlock = /const DEFAULT_PAGE_CHOICES: PageKey\[\] = \[([\s\S]*?)\n\]/.exec(settings)
const setKeys = choiceBlock ? uniq(grab(choiceBlock[1], /'([a-zA-Z]+)'/g)) : []

const wm = read(`${S}/main/windowManager.ts`)
const profBlock = /const PAGE_PROFILES: Record<string, WindowProfile> = \{([\s\S]*?)\n\}/.exec(wm)[1]
const profKeys = uniq(grab(profBlock, /^\s{2}([a-zA-Z]+):\s*\{/gm))

const LISTS = {
  'PAGE_LABELS(名表)': labelKeys,
  'PageKey(nav.tsx)': pageKeys,
  'NAV(navItems.tsx)': navKeys,
  '菜单(App.tsx)': menuKeys,
  'Alt+1..9': altKeys,
  'PageView 分发': pvKeys,
  '命令面板(search.ts)': searchKeys,
  '设置默认页(Settings)': setKeys,
  'PAGE_PROFILES(windowMgr)': profKeys
}

console.log('=== 各清单规模 ===')
for (const [k, v] of Object.entries(LISTS)) console.log(`  ${k.padEnd(26)} ${String(v.length).padStart(2)} 项`)

console.log('\n=== A. 名表单源检查（名表 vs PageKey）===')
const onlyMeta = pageKeys.filter((k) => !labelKeys.includes(k))
const onlyKey = labelKeys.filter((k) => !pageKeys.includes(k))
console.log(onlyMeta.length ? `  ✗ PageKey 有但名表缺: ${onlyMeta.join(', ')}` : '  ✓ PageKey 每一项都有中文名')
console.log(onlyKey.length ? `  ✗ 名表有但 PageKey 无: ${onlyKey.join(', ')}` : '  ✓ 名表无多余条目')

console.log('\n=== B. 菜单可达性 ===')
const unreachable = pvKeys.filter((k) => !menuKeys.includes(k))
console.log(`  有页面实现但侧边栏无入口: ${unreachable.join(', ') || '(无)'}`)
for (const k of unreachable) {
  const where = []
  if (searchKeys.includes(k)) where.push('命令面板')
  if (setKeys.includes(k)) where.push('默认页')
  if (altKeys.includes(k)) where.push('Alt 快捷键')
  console.log(`    ${k}（${labelMap[k] ?? '无名'}）: 可从 ${where.join(' / ') || '—'} 进入`)
}
const dead = menuKeys.filter((k) => !pvKeys.includes(k))
console.log(`  菜单项无页面实现: ${dead.join(', ') || '(无)'}`)

console.log('\n=== C. 清单项是否都合法（∈ PageKey）===')
let bad = 0
for (const [name, v] of Object.entries(LISTS)) {
  const extra = stripIds(v).filter((k) => !pageKeys.includes(k))
  if (extra.length) { console.log(`  ✗ ${name}: ${extra.join(', ')}`); bad++ }
}
console.log(bad ? '' : '  ✓ 全部合法')

console.log('\n=== D. 是否还有残留的硬编码页面名表 ===')
const SUSPECTS = [
  'src/main/pageWindows.ts',
  'src/main/search.ts',
  'src/renderer/src/pages/Settings.tsx',
  'src/renderer/src/App.tsx',
  'src/renderer/src/navItems.tsx'
]
const cnValues = new Set(Object.values(labelMap))
let residue = 0
for (const f of SUSPECTS) {
  const txt = read(f)
  for (const m of txt.matchAll(/^\s*([a-zA-Z_]+):\s*'([^']+)'/gm)) {
    if (cnValues.has(m[2])) {
      console.log(`  ✗ ${f}: ${m[1]}: '${m[2]}'`)
      residue++
    }
  }
}
console.log(residue ? '' : '  ✓ 未发现残留名表（中文名只在 pageMeta.ts 出现）')

console.log('\n=== E. 侧边栏分组结构 ===')
for (const m of menuBlock.matchAll(/\{ key: '(g-[a-z]+)', label: '([^']+)'[\s\S]*?children: \[([\s\S]*?)\]\s*\}/g)) {
  const kids = grab(m[3], /leaf\('([a-zA-Z]+)'\)/g)
  console.log(`  ${m[2]} (${kids.length}): ${kids.map((k) => labelMap[k] ?? k).join(' / ')}`)
}

console.log('\n=== F. NAV 与菜单是否一致 ===')
const navOnly = navKeys.filter((k) => !menuKeys.includes(k))
const menuOnly = menuKeys.filter((k) => !navKeys.includes(k))
console.log(navOnly.length ? `  NAV 有但菜单无: ${navOnly.join(', ')}` : '  ✓ NAV 全部进了菜单')
console.log(menuOnly.length ? `  菜单有但 NAV 无: ${menuOnly.join(', ')}` : '  ✓ 菜单项全部来自 NAV')
