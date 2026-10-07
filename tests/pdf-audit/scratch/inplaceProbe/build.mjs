/* 打包探针：esbuild 把 entry.ts（含真实实现）打成浏览器 ESM。
 * 与 pdfEditProbe 不同，这里不需要 stub vite 的 `?worker` 导入
 * （pdfInPlaceReplace / pdfText 都不依赖打包器专有语法）。 */
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [path.join(DIR, 'entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  sourcemap: false,
  outfile: path.join(DIR, 'bundle.js'),
  logLevel: 'info'
})
console.log('bundle built ->', path.join(DIR, 'bundle.js'))
