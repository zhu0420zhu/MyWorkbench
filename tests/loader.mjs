// ESM loader：
// 1) 把 `electron` 解析到本地替身，使 main 进程模块可在 Node 下无头运行；
// 2) 为相对、无扩展名的导入补全 `.ts`（模拟 electron-vite 打包器的扩展解析）；
// 3) 把 vite 的 `?worker` 导入解析到空壳（Node 下没有打包器，模块只需可加载）；
// 4) 解析 tsconfig 的路径别名（@shared/@renderer/@gameui），使渲染层 / 共享层源码
//    无需为测试改动即可被 Node 直接 import（例如 ioFormats.ts → `@shared/csv`）。
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 仓库根（tests/ 的上一级）
const ROOT = new URL('../', import.meta.url)

// 与 tsconfig.web.json 的 compilerOptions.paths 对齐；前缀互不重叠，匹配即可用
const ALIASES = [
  ['@shared/', 'src/shared/'],
  ['@renderer/', 'src/renderer/src/'],
  ['@gameui/', 'src/modules/gameUi/']
]
// 别名补全候选后缀：先按源码扩展名，再退化到目录 index 文件
const EXTS = ['.ts', '.tsx', '.mts', '.mjs', '.js']

function resolveAlias(specifier) {
  for (const [prefix, target] of ALIASES) {
    if (!specifier.startsWith(prefix)) continue
    const base = target + specifier.slice(prefix.length)
    const candidates = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => `${base}/index${e}`)]
    for (const cand of candidates) {
      try {
        const url = new URL(cand, ROOT)
        if (existsSync(fileURLToPath(url))) return url.href
      } catch {
        /* 忽略，尝试下一个候选 */
      }
    }
  }
  return null
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: new URL('./electron-stub.mjs', import.meta.url).href, shortCircuit: true }
  }
  if (specifier.endsWith('?worker')) {
    return { url: new URL('./stub-worker.mjs', import.meta.url).href, shortCircuit: true }
  }
  // 路径别名（@shared/* 等）；不匹配任何别名则返回 null，交回默认解析，
  // 因此 `@napi-rs/canvas` 这类 npm 作用域包不受影响。
  if (specifier.startsWith('@')) {
    const aliasUrl = resolveAlias(specifier)
    if (aliasUrl) return { url: aliasUrl, shortCircuit: true }
  }
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    !/\.(ts|mts|cts|mjs|cjs|js|json|node)$/.test(specifier)
  ) {
    const url = new URL(specifier + '.ts', context.parentURL).href
    try {
      if (existsSync(fileURLToPath(url))) {
        return { url, shortCircuit: true }
      }
    } catch {
      /* 忽略，回退默认解析 */
    }
  }
  return nextResolve(specifier, context)
}
