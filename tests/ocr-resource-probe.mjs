/**
 * OCR 资源探针（无头，不依赖 electron）
 *
 * 验证「打包后 PDF 提取文字 → OCR」所需的资源是否齐全。做法：
 *   1. 直接调用 src/main/ocrPaths.ts 的**纯路径解析函数**（该模块不 import electron）；
 *   2. 把打包态模拟为 resourcesPath=仓库根（此时 resourcesRoot()=<仓库>/resources，
 *      与 electron-builder extraResources `{from:'resources',to:'resources'}` 的产物一致）；
 *   3. 断言 MODEL_NAMES / WASM_NAMES 里每个文件都能在 resources 目录找到且非空；
 *   4. 断言缺文件时解析函数返回明确 null（不抛未捕获异常）。
 *
 * 运行：npm run probe:ocr-resource
 */
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MODEL_NAMES,
  WASM_NAMES,
  resourcesRoot,
  modelDirCandidates,
  wasmDirCandidates,
  readFirstFile,
  devModelsDir,
  devWasmDir
} from '../src/main/ocrPaths.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// 模拟打包态：electron-builder 把 resources/ 拷到 <process.resourcesPath>/resources/
const packagedEnv = { isPackaged: true, appPath: join(repoRoot, 'out', 'main'), resourcesPath: repoRoot }
// 开发态：直接在仓库根
const devEnv = { isPackaged: false, appPath: repoRoot, resourcesPath: repoRoot }

const results = []
let failed = 0
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function sizeOf(p) {
  try {
    return statSync(p).size
  } catch {
    return -1
  }
}
function findInDirs(dirs, file) {
  for (const d of dirs) {
    const p = join(d, file)
    if (existsSync(p)) return p
  }
  return null
}

console.log('== 打包态资源根 ==')
const packagedRoot = resourcesRoot(packagedEnv)
console.log(`  resourcesRoot(packaged) = ${packagedRoot}`)
console.log(`  modelDirCandidates       = ${modelDirCandidates(packagedEnv).join(' ; ')}`)
console.log(`  wasmDirCandidates        = ${wasmDirCandidates(packagedEnv).join(' ; ')}`)
check('打包态资源根指向仓库 resources/', packagedRoot === join(repoRoot, 'resources'), packagedRoot)

console.log('\n== ① MODEL_NAMES 每个模型都在 resources 且 >0 ==')
const modelDirs = modelDirCandidates(packagedEnv)
for (const name of MODEL_NAMES) {
  const found = findInDirs(modelDirs, name)
  const size = found ? sizeOf(found) : -1
  check(`模型 ${name}`, found !== null && size > 0, found ? `${size} bytes @ ${found}` : '未找到')
}

console.log('\n== ② WASM_NAMES 每个 wasm 都在 resources/onnxruntime 且 >0 ==')
const wasmDirs = wasmDirCandidates(packagedEnv)
for (const name of WASM_NAMES) {
  const found = findInDirs(wasmDirs, name)
  const size = found ? sizeOf(found) : -1
  check(`wasm ${name}`, found !== null && size > 0, found ? `${size} bytes @ ${found}` : '未找到')
}

console.log('\n== ③ 渲染层实际请求的 wasm 被覆盖 ==')
// renderer/src/utils/ppocr.ts 请求这一文件名；必须在上面的 WASM_NAMES 中
const REQUESTED_WASM = 'ort-wasm-simd-threaded.jsep.wasm'
check('WASM_NAMES 含渲染层请求的 jsep wasm', WASM_NAMES.includes(REQUESTED_WASM), REQUESTED_WASM)

console.log('\n== ④ 缺文件时返回明确 null（不抛异常） ==')
let threw = false
let missing = 'n/a'
try {
  const bogus = await readFirstFile([join(repoRoot, '__no_such_dir__')], 'ch_PP-OCRv4_det_infer.onnx')
  missing = String(bogus)
  const notWhitelisted = await readFirstFile(wasmDirs, 'ort-wasm-nonexistent.wasm')
  check('不存在的目录/文件 → null', bogus === null, `返回 ${missing}`)
  check('不存在的 wasm → null', notWhitelisted === null)
} catch (e) {
  threw = true
  check('缺文件不抛未捕获异常', false, String(e))
}
check('缺文件路径解析未抛异常', !threw)

console.log('\n== ⑤ dev 回退路径仍可解析（node_modules 存在时） ==')
const devModelProbe = join(devModelsDir(repoRoot), 'ch_PP-OCRv4_det_infer.onnx')
const devWasmProbe = join(devWasmDir(repoRoot), 'ort-wasm-simd-threaded.jsep.wasm')
const devAvailable = existsSync(devModelsDir(repoRoot)) && existsSync(devWasmDir(repoRoot))
check(
  'devModelsDir/devWasmDir 指向 node_modules（仅当本机装有 devDependency 时校验存在）',
  devAvailable ? existsSync(devModelProbe) && existsSync(devWasmProbe) : true,
  devAvailable ? 'node_modules 存在，已校验' : 'node_modules 未安装，跳过存在性校验'
)

// 开发态 resourcesRoot 同样指向仓库 resources/
check('开发态资源根指向仓库 resources/', resourcesRoot(devEnv) === join(repoRoot, 'resources'))

console.log(`\n=== 结果：${results.length - failed}/${results.length} 通过 ===`)
if (failed > 0) {
  console.error(`有 ${failed} 项失败`)
  process.exit(1)
}
console.log('全部通过')
