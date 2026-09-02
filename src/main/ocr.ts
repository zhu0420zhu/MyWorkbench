import { app, BrowserWindow, dialog, net } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { OcrImageInfo } from '../shared/types'

const MODEL_NAMES = [
  'ch_PP-OCRv4_det_infer.onnx',
  'ch_PP-OCRv4_rec_infer.onnx',
  'ch_ppocr_mobile_v2.0_cls_infer.onnx',
  'slanet-plus.onnx' // 表格结构识别（resources/ 打包）
]

const WASM_NAMES = [
  'ort-wasm-simd.wasm',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm.wasm',
  'ort-wasm-simd-threaded.jsep.wasm'
]

const DICT_URL =
  'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/ppocr_keys_v1.txt'

function modelsDir(): string {
  return join(app.getAppPath(), 'node_modules', 'paddle-ocr-onnx-models', 'models')
}

function wasmDir(): string {
  return join(app.getAppPath(), 'node_modules', 'onnxruntime-web', 'dist')
}

function dictFile(): string {
  return join(app.getPath('userData'), 'models', 'ppocr_keys_v1.txt')
}

/** 打包资源路径：dev 用项目 resources/，打包后用 process.resourcesPath/resources/ */
function resourcePath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources', name)
    : join(app.getAppPath(), 'resources', name)
}

async function ensureDict(): Promise<string> {
  // 1) 打包资源（离线优先）
  try {
    const bundled = resourcePath('ppocr_keys_v1.txt')
    await fs.access(bundled)
    return await fs.readFile(bundled, 'utf-8')
  } catch {
    /* 继续 */
  }
  // 2) userData 缓存
  try {
    await fs.access(dictFile())
    return await fs.readFile(dictFile(), 'utf-8')
  } catch {
    /* 继续 */
  }
  // 3) 兜底在线下载
  await fs.mkdir(join(app.getPath('userData'), 'models'), { recursive: true })
  const res = await net.fetch(DICT_URL)
  if (!res.ok) throw new Error(`字典下载失败 HTTP ${res.status}`)
  const text = await res.text()
  await fs.writeFile(dictFile(), text, 'utf-8')
  return text
}

export async function readModel(name: string): Promise<Uint8Array | null> {
  if (!MODEL_NAMES.includes(name)) return null
  // SLANet 等打包模型优先从 resources 读，PP-OCR 模型从 node_modules 读
  try {
    const bundled = resourcePath(name)
    await fs.access(bundled)
    const buf = await fs.readFile(bundled)
    return new Uint8Array(buf)
  } catch {
    /* 回退 node_modules */
  }
  try {
    const buf = await fs.readFile(join(modelsDir(), name))
    return new Uint8Array(buf)
  } catch {
    return null
  }
}

export async function readWasm(name: string): Promise<Uint8Array | null> {
  if (!WASM_NAMES.includes(name)) return null
  try {
    const buf = await fs.readFile(join(wasmDir(), name))
    return new Uint8Array(buf)
  } catch {
    return null
  }
}

export async function getDict(): Promise<string> {
  return ensureDict()
}

export async function getTableDict(): Promise<string> {
  try {
    const bundled = resourcePath('table_structure_dict.txt')
    await fs.access(bundled)
    return await fs.readFile(bundled, 'utf-8')
  } catch {
    return ''
  }
}

export async function pickImages(win: BrowserWindow): Promise<OcrImageInfo[]> {
  const result = await dialog.showOpenDialog(win, {
    title: '选择要识别的图片（可多选）',
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp'] }],
    properties: ['openFile', 'multiSelections']
  })
  if (result.canceled || result.filePaths.length === 0) return []
  const out: OcrImageInfo[] = []
  for (const file of result.filePaths) {
    const buf = await fs.readFile(file)
    const ext = (file.split('.').pop() ?? 'png').toLowerCase()
    const mime = ext === 'jpg' ? 'jpeg' : ext
    out.push({
      dataUrl: 'data:image/' + mime + ';base64,' + buf.toString('base64'),
      name: file.split(/[\\/]/).pop() ?? file,
      size: buf.length
    })
  }
  return out
}

export async function pickImage(win: BrowserWindow): Promise<OcrImageInfo | null> {
  const result = await dialog.showOpenDialog(win, {
    title: '选择要识别的图片',
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp'] }],
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const file = result.filePaths[0]
  const buf = await fs.readFile(file)
  const ext = (file.split('.').pop() ?? 'png').toLowerCase()
  const mime = ext === 'jpg' ? 'jpeg' : ext
  return {
    dataUrl: `data:image/${mime};base64,${buf.toString('base64')}`,
    name: file.split(/[\\/]/).pop() ?? file,
    size: buf.length
  }
}
