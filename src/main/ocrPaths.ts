/* 灵墨工作台 · OCR 资源路径解析（纯函数，不依赖 electron）
 *
 * 拆出本模块的原因：ocr.ts 依赖 electron（app / net / dialog），无法在无头 Node 下
 * 直接加载测试。资源路径解析（模型 / wasm / 字典）是纯字符串运算，下沉到这里后
 * tests/ocr-resource-probe.mjs 可以脱离 electron 断言「打包态资源是否齐全」。
 *
 * 打包约定（与 baseConverter.getBundledToolsDir 一致）：
 *   - 开发态：资源在 <appPath>/resources/
 *   - 打包态：extraResources 把 resources/ 整目录映射到 <process.resourcesPath>/resources/
 * 因此同一批文件在两个环境下只差一个根。
 */
import { join } from 'path'
import { promises as fs } from 'fs'

/** PP-OCR / SLANet 模型白名单（readModel 只接受这些名字） */
export const MODEL_NAMES: readonly string[] = [
  'ch_PP-OCRv4_det_infer.onnx',
  'ch_PP-OCRv4_rec_infer.onnx',
  'ch_ppocr_mobile_v2.0_cls_infer.onnx',
  'slanet-plus.onnx' // 表格结构识别
]

/**
 * onnxruntime-web WASM 白名单。
 * 仅保留 dist 内**实际存在**、渲染层可能请求的变体：渲染层 ppocr.ts 请求 jsep 版，
 * 非 jsep 版作为 wasmBinary 缺失时的回退。原先列表里的 `ort-wasm-simd.wasm` /
 * `ort-wasm.wasm` 在当前 onnxruntime-web 1.16 dist 中并不存在，属陈旧项，已移除。
 */
export const WASM_NAMES: readonly string[] = [
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.wasm'
]

/** 打包后的 PP-OCR 模型子目录（resources/ocr-models/） */
export const OCR_MODELS_SUBDIR = 'ocr-models'
/** 打包后的 onnxruntime wasm 子目录（resources/onnxruntime/） */
export const ONNXRUNTIME_SUBDIR = 'onnxruntime'

export interface OcrEnv {
  isPackaged: boolean
  /** electron app.getAppPath()（打包态为 app.asar 所在目录，开发态为仓库根） */
  appPath: string
  /** electron process.resourcesPath（打包态 electron resources 目录） */
  resourcesPath: string
}

/** 资源根：开发态 <appPath>/resources；打包态 <resourcesPath>/resources */
export function resourcesRoot(env: OcrEnv): string {
  return env.isPackaged ? join(env.resourcesPath, 'resources') : join(env.appPath, 'resources')
}

/** 模型候选目录（按优先级）：ocr-models/ 子目录优先，兼容历史上扁平放在 resources/ 的模型 */
export function modelDirCandidates(env: OcrEnv): string[] {
  const root = resourcesRoot(env)
  return [join(root, OCR_MODELS_SUBDIR), root]
}

/** wasm 候选目录：resources/onnxruntime/ */
export function wasmDirCandidates(env: OcrEnv): string[] {
  return [join(resourcesRoot(env), ONNXRUNTIME_SUBDIR)]
}

/** 开发态回退：node_modules/paddle-ocr-onnx-models/models */
export function devModelsDir(appPath: string): string {
  return join(appPath, 'node_modules', 'paddle-ocr-onnx-models', 'models')
}

/** 开发态回退：node_modules/onnxruntime-web/dist */
export function devWasmDir(appPath: string): string {
  return join(appPath, 'node_modules', 'onnxruntime-web', 'dist')
}

/**
 * 依次在候选目录中读取首个「存在且非空」的文件内容；全部缺失返回 null（不抛异常）。
 * 供 readModel / readWasm 复用，也是无头探针断言「缺文件返回 null」的入口。
 */
export async function readFirstFile(dirs: string[], name: string): Promise<Uint8Array | null> {
  for (const dir of dirs) {
    try {
      const buf = await fs.readFile(join(dir, name))
      if (buf.length > 0) return new Uint8Array(buf)
    } catch {
      /* 尝试下一个候选目录 */
    }
  }
  return null
}
