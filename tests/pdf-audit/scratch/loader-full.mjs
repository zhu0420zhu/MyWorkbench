// 验证专用 ESM loader：electron 指向本目录的完整替身；相对导入补 .ts 扩展。
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: new URL('./electron-full-stub.mjs', import.meta.url).href, shortCircuit: true }
  }
  if (specifier.endsWith('?worker')) {
    return { url: new URL('../../stub-worker.mjs', import.meta.url).href, shortCircuit: true }
  }
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    !/\.(ts|mts|cts|mjs|cjs|js|json|node)$/.test(specifier)
  ) {
    const url = new URL(specifier + '.ts', context.parentURL).href
    try {
      if (existsSync(fileURLToPath(url))) return { url, shortCircuit: true }
    } catch {
      /* 回退默认解析 */
    }
  }
  return nextResolve(specifier, context)
}
