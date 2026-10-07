// 空内容守卫 e2e 专用 ESM loader：把 `electron` 解析到 docs-save-guard-electron.mjs，
// 并为相对、无扩展名的导入补全 `.ts`（与 tests/loader.mjs 同规则）。
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: new URL('./docs-save-guard-electron.mjs', import.meta.url).href, shortCircuit: true }
  }
  if (specifier.endsWith('?worker')) {
    return { url: new URL('./stub-worker.mjs', import.meta.url).href, shortCircuit: true }
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
      /* 回退默认解析 */
    }
  }
  return nextResolve(specifier, context)
}
