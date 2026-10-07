/* 打包探针：stub 掉 pdfToHtml.ts / pdfTextBlocks.ts 里的 Vite 专用 `?worker` 动态导入
 * （Node/esbuild 下无法解析该 specifier；stub 返回 default=null，
 *  于是 loadPdfjs() 不会设 workerPort，改由 entry*.ts 设置的 workerSrc 生效）。
 *
 * 产物：
 *   bundle.js          ← entry.ts        （既有链路，pdfBytesToHtml）
 *   bundle-textruns.js ← entry-textruns.ts（本次新增，pdfBytesToTextRuns）
 */
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))

const stubViteWorkerImport = {
  name: 'stub-vite-worker-import',
  setup(b) {
    b.onResolve({ filter: /\?worker$/ }, () => ({ path: 'vite-worker-stub', namespace: 'stubworker' }))
    b.onLoad({ filter: /.*/, namespace: 'stubworker' }, () => ({
      contents: 'export default null',
      loader: 'js'
    }))
  }
}

const TARGETS = [
  { entry: 'entry.ts', out: 'bundle.js' },
  { entry: 'entry-textruns.ts', out: 'bundle-textruns.js' }
]

for (const target of TARGETS) {
  await build({
    entryPoints: [path.join(DIR, target.entry)],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    sourcemap: false,
    outfile: path.join(DIR, target.out),
    logLevel: 'info',
    plugins: [stubViteWorkerImport]
  })
  console.log('bundle built ->', path.join(DIR, target.out))
}
