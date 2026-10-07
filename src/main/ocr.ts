import { app, BrowserWindow, dialog, net } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { OcrImageInfo } from '../shared/types'
import {
  MODEL_NAMES,
  WASM_NAMES,
  resourcesRoot,
  modelDirCandidates,
  wasmDirCandidates,
  devModelsDir,
  devWasmDir,
  readFirstFile,
  type OcrEnv
} from './ocrPaths'

const DICT_URL =
  'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/ppocr_keys_v1.txt'

function ocrEnv(): OcrEnv {
  return { isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath }
}

function dictFile(): string {
  return join(app.getPath('userData'), 'models', 'ppocr_keys_v1.txt')
}

/** 打包资源路径：dev 用项目 resources/，打包后用 process.resourcesPath/resources/ */
function resourcePath(name: string): string {
  return join(resourcesRoot(ocrEnv()), name)
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
  const env = ocrEnv()
  // 打包资源（resources/ocr-models/ 子目录优先，兼容扁平 resources/）
  const bundled = await readFirstFile(modelDirCandidates(env), name)
  if (bundled) return bundled
  // 开发态回退：node_modules/paddle-ocr-onnx-models/models
  return readFirstFile([devModelsDir(env.appPath)], name)
}

export async function readWasm(name: string): Promise<Uint8Array | null> {
  if (!WASM_NAMES.includes(name)) return null
  const env = ocrEnv()
  // 打包资源（resources/onnxruntime/）
  const bundled = await readFirstFile(wasmDirCandidates(env), name)
  if (bundled) return bundled
  // 开发态回退：node_modules/onnxruntime-web/dist
  return readFirstFile([devWasmDir(env.appPath)], name)
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
