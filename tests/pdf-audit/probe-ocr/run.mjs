/**
 * probe-ocr 的构建与启动（跨平台）：
 *   1. esbuild 把渲染进程入口（含生产模块 ppocr / pdfRender / pdfOcrExtract）打成
 *      浏览器 ESM bundle——onnxruntime-web 解析到**浏览器构建**（jsep），这正是
 *      渲染进程真实后端，与 node 无头 E2E 的 node 构建不同；
 *   2. 以「删掉 ELECTRON_RUN_AS_NODE」的方式拉起真实 Electron 跑探针。
 *
 * 用法：npm run probe:pdf-ocr
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const DIST = join(HERE, 'dist')

/* vite 的 ?worker 导入在 esbuild 下替换为 file:// module worker（与 pdf.js 自身
 * workerSrc 的加载方式一致；URL 由生成的 index.html 内联注入） */
const workerShimPlugin = {
  name: 'pdf-worker-shim',
  setup(build) {
    build.onResolve({ filter: /pdf\.worker\.min\.mjs\?worker$/ }, () => ({
      path: 'pdf-worker-shim',
      namespace: 'probe-shim'
    }))
    build.onLoad({ filter: /.*/, namespace: 'probe-shim' }, () => ({
      contents: `
        // 生产代码 import PdfWorker from '...pdf.worker.min.mjs?worker'
        // 探针里替换为 file:// module worker（与 tests/pdf-audit/probe 同一加载方式）
        export default class PdfWorkerShim {
          constructor() {
            return new Worker(window.__PDF_WORKER_URL__, { type: 'module' })
          }
        }`,
      loader: 'js'
    }))
  }
}

mkdirSync(DIST, { recursive: true })
console.log('[1/2] esbuild 打包渲染进程探针（浏览器构建，含 jsep）…')
await esbuild.build({
  entryPoints: [join(HERE, 'renderer-entry.ts')],
  outfile: join(DIST, 'probe-bundle.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  conditions: ['browser'],
  target: 'chrome120',
  plugins: [workerShimPlugin],
  logLevel: 'info'
})

console.log('[2/2] 启动 Electron 探针…')
const electronBin = join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
if (!existsSync(electronBin)) {
  console.error('❌ 未找到 Electron 可执行文件: ' + electronBin)
  process.exit(1)
}
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const r = spawnSync(electronBin, [HERE], { env, stdio: 'inherit' })
process.exit(r.status ?? 1)
