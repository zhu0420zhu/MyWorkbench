/* 灵墨工作台 · 自研 PP-OCR 推理管线（onnxruntime-web WASM）
 * det(DB) → cls(方向) → rec(CRNN+CTC) 全流程，模型为 PP-OCRv4 中文 ONNX
 */
import * as ort from 'onnxruntime-web'
import type { OcrLineResult } from '@shared/types'

const MODEL_FILES = {
  det: 'ch_PP-OCRv4_det_infer.onnx',
  rec: 'ch_PP-OCRv4_rec_infer.onnx',
  cls: 'ch_ppocr_mobile_v2.0_cls_infer.onnx'
}

const IMAGENET_MEAN = [0.485, 0.456, 0.406]
const IMAGENET_STD = [0.229, 0.224, 0.225]
const HALF_MEAN = [0.5, 0.5, 0.5]
const HALF_STD = [0.5, 0.5, 0.5]

const DET_LIMIT_SIDE = 640
const REC_HEIGHT = 48 // PP-OCRv4 rec 输入高度
const REC_MAX_WIDTH = 800 // 单块识别上限（超长才切分）
const REC_OVERLAP = 32 // 切分重叠像素
const CLS_H = 48
const CLS_W = 192
const BIN_THRESH = 0.3
const BOX_SCORE_THRESH = 0.3
const MIN_REGION_AREA = 3
const BOX_EXPAND = 8 // det 框扩展（覆盖完整文字，原图约 12px）

const sessions: Partial<Record<'det' | 'rec' | 'cls', ort.InferenceSession>> = {}
let dict: string[] = []
let wasmReady = false

async function initWasm(): Promise<void> {
  if (wasmReady) return
  // 从主进程读取 wasm 二进制（vite 下动态 import/fetch 不可靠），绕开静态资源路径问题
  const bin = await window.api.ocr.wasm('ort-wasm-simd-threaded.jsep.wasm')
  if (bin && bin.byteLength > 0) {
    ort.env.wasm.wasmBinary = bin
  } else {
    ort.env.wasm.wasmPaths = './'
  }
  wasmReady = true
}

async function loadSession(kind: 'det' | 'rec' | 'cls'): Promise<ort.InferenceSession> {
  if (sessions[kind]) return sessions[kind]
  const data = await window.api.ocr.model(MODEL_FILES[kind])
  if (!data) throw new Error(`模型文件缺失: ${MODEL_FILES[kind]}`)
  try {
    sessions[kind] = await ort.InferenceSession.create(data, { executionProviders: ['wasm'] })
  } catch (err) {
    console.error('[ppocr] create session', kind, err)
    throw new Error(
      `模型会话创建失败(${MODEL_FILES[kind]}): ${err instanceof Error ? err.message : String(err)}`
    )
  }
  return sessions[kind]
}

async function ensureDict(): Promise<string[]> {
  if (dict.length > 0) return dict
  const raw = await window.api.ocr.dict()
  dict = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  return dict
}

/* ---------- 图像工具 ---------- */
async function loadImageData(dataUrl: string): Promise<ImageData> {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('canvas 不可用')
  ctx.drawImage(img, 0, 0)
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

function scaleImage(
  src: ImageData,
  targetW: number,
  targetH: number
): { data: Uint8ClampedArray; w: number; h: number } {
  const canvas = document.createElement('canvas')
  canvas.width = src.width
  canvas.height = src.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('canvas 不可用')
  ctx.putImageData(src, 0, 0)
  const out = document.createElement('canvas')
  out.width = targetW
  out.height = targetH
  const octx = out.getContext('2d', { willReadFrequently: true })
  if (!octx) throw new Error('canvas 不可用')
  octx.drawImage(canvas, 0, 0, src.width, src.height, 0, 0, targetW, targetH)
  return { data: octx.getImageData(0, 0, targetW, targetH).data, w: targetW, h: targetH }
}

function toCHW(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  mean: number[],
  std: number[]
): Float32Array {
  const out = new Float32Array(3 * h * w)
  for (let i = 0; i < w * h; i++) {
    const p = i * 4
    for (let c = 0; c < 3; c++) {
      out[c * h * w + i] = (rgba[p + c] / 255 - mean[c]) / std[c]
    }
  }
  return out
}

function cropRect(src: ImageData, x: number, y: number, w: number, h: number): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = src.width
  canvas.height = src.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return { data: new Uint8ClampedArray(0), width: 0, height: 0 } as ImageData
  ctx.putImageData(src, 0, 0)
  const cx = Math.max(0, Math.floor(x))
  const cy = Math.max(0, Math.floor(y))
  const cw = Math.min(src.width - cx, Math.max(1, Math.floor(w)))
  const ch = Math.min(src.height - cy, Math.max(1, Math.floor(h)))
  return ctx.getImageData(cx, cy, cw, ch)
}

/* 按垂直投影间隙把连通域切成若干文字行 */
function splitRegionByGaps(region: number[], probW: number, gapThresh = 3): number[][] {
  const byY = new Map<number, number[]>()
  for (const px of region) {
    const y = Math.floor(px / probW)
    if (!byY.has(y)) byY.set(y, [])
    byY.get(y)!.push(px)
  }
  const ys = [...byY.keys()].sort((a, b) => a - b)
  const groups: number[][] = []
  let cur: number[] = []
  let prev = -100
  for (const y of ys) {
    if (y - prev > gapThresh && cur.length > 0) {
      groups.push(cur)
      cur = []
    }
    cur.push(...(byY.get(y) as number[]))
    prev = y
  }
  if (cur.length > 0) groups.push(cur)
  return groups
}

/* ---------- det 后处理（DB） ---------- */
interface Box {
  x: number
  y: number
  w: number
  h: number
  score: number
}

function dbPostProcess(
  prob: Float32Array,
  probW: number,
  probH: number,
  scaleX: number,
  scaleY: number
): Box[] {
  // det ONNX 输出已是 sigmoid 后的概率图（0~1），直接阈值
  const mask = new Uint8Array(probW * probH)
  for (let i = 0; i < prob.length; i++) {
    mask[i] = prob[i] > BIN_THRESH ? 1 : 0
  }
  const visited = new Uint8Array(probW * probH)
  const regions: Array<Array<number>> = []
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0 || visited[i]) continue
    const queue = [i]
    visited[i] = 1
    const region: number[] = []
    while (queue.length > 0) {
      const cur = queue.pop() as number
      region.push(cur)
      const cx = cur % probW
      const cy = Math.floor(cur / probW)
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= probW || ny >= probH) continue
          const ni = ny * probW + nx
          if (mask[ni] === 1 && visited[ni] === 0) {
            visited[ni] = 1
            queue.push(ni)
          }
        }
      }
    }
    if (region.length >= MIN_REGION_AREA) {
      // 按垂直间隙分裂（拆开被合并的多行）
      for (const sub of splitRegionByGaps(region, probW)) {
        if (sub.length >= MIN_REGION_AREA) regions.push(sub)
      }
    }
  }

  const boxes: Box[] = []
  for (const region of regions) {
    let minX = probW
    let minY = probH
    let maxX = -1
    let maxY = -1
    let sum = 0
    for (const px of region) {
      const x = px % probW
      const y = Math.floor(px / probW)
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      sum += prob[px]
    }
    const bx = (minX - BOX_EXPAND) / scaleX
    const by = (minY - BOX_EXPAND) / scaleY
    const bw = (maxX - minX + 1 + BOX_EXPAND * 2) / scaleX
    const bh = (maxY - minY + 1 + BOX_EXPAND * 2) / scaleY
    const score = sum / region.length
    if (score < BOX_SCORE_THRESH) continue
    if (bw < 2 || bh < 2) continue
    boxes.push({ x: bx, y: by, w: bw, h: bh, score })
  }
  return boxes
}

/* ---------- rec 单块识别 ---------- */
async function recognizeOne(
  crop: ImageData,
  recSess: ort.InferenceSession
): Promise<{ text: string; score: number } | null> {
  if (crop.width <= 0 || crop.height <= 0) return null
  const ratio = crop.height > 0 ? crop.width / crop.height : 1
  const targetW = Math.max(2, Math.min(REC_MAX_WIDTH, Math.round(REC_HEIGHT * ratio)))
  const { data, w, h } = scaleImage(crop, targetW, REC_HEIGHT)
  const input = toCHW(data, w, h, HALF_MEAN, HALF_STD)
  const name = recSess.inputNames[0]
  const outName = recSess.outputNames[0]
  let result: Record<string, ort.Tensor>
  try {
    result = await recSess.run({ [name]: new ort.Tensor('float32', input, [1, 3, h, w]) })
  } catch (err) {
    console.error('[ppocr] rec run failed', err)
    throw new Error(
      '识别推理失败(输入 ' + w + 'x' + h + '): ' + (err instanceof Error ? err.message : String(err))
    )
  }
  const out = result[outName] as ort.Tensor
  const dims = out.dims
  const seqLen = dims[dims.length - 2]
  const numClasses = dims[dims.length - 1]
  const dataArr = out.data as Float32Array
  let text = ''
  let lastIdx = -1
  let sum = 0
  let count = 0
  for (let t = 0; t < seqLen; t++) {
    let maxIdx = 0
    let maxVal = -Infinity
    const offset = t * numClasses
    for (let c = 0; c < numClasses; c++) {
      const v = dataArr[offset + c]
      if (v > maxVal) {
        maxVal = v
        maxIdx = c
      }
    }
    sum += maxVal
    count++
    if (maxIdx !== lastIdx && maxIdx !== 0) {
      const ch = dict[maxIdx - 1]
      if (ch !== undefined) text += ch
    }
    lastIdx = maxIdx
  }
  if (text.trim() === '') return null
  return { text, score: count > 0 ? sum / count : 0 }
}

/* ---------- rec 主入口（超长切分） ---------- */
async function recognizeCrop(
  crop: ImageData,
  recSess: ort.InferenceSession
): Promise<{ text: string; score: number } | null> {
  const maxW = Math.round(REC_MAX_WIDTH * (crop.height / REC_HEIGHT))
  if (crop.width <= maxW) {
    return recognizeOne(crop, recSess)
  }
  // 超长：按 REC_MAX_WIDTH 切块（重叠 REC_OVERLAP）
  const parts: string[] = []
  const scores: number[] = []
  let x = 0
  let blocks = 0
  while (x < crop.width && blocks < 8) {
    const w = Math.min(maxW, crop.width - x)
    const part = cropRect(crop, x, 0, w, crop.height)
    const res = await recognizeOne(part, recSess)
    if (res) {
      parts.push(res.text)
      scores.push(res.score)
    }
    x += maxW - REC_OVERLAP
    blocks++
    if (x >= crop.width) break
  }
  if (parts.length === 0) return null
  return {
    text: parts.join(''),
    score: scores.reduce((a, b) => a + b, 0) / scores.length
  }
}

/* ---------- cls 方向分类 ---------- */
async function isRotated(crop: ImageData, clsSess: ort.InferenceSession): Promise<boolean> {
  try {
    const { data, w, h } = scaleImage(crop, CLS_W, CLS_H)
    const input = toCHW(data, w, h, HALF_MEAN, HALF_STD)
    const name = clsSess.inputNames[0]
    const outName = clsSess.outputNames[0]
    const result = await clsSess.run({ [name]: new ort.Tensor('float32', input, [1, 3, h, w]) })
    const out = result[outName] as ort.Tensor
    const arr = out.data as Float32Array
    return arr.length >= 2 && arr[1] > arr[0]
  } catch {
    return false
  }
}

/* ---------- 行排序 ---------- */
function sortBoxes(boxes: Box[]): Box[] {
  const sorted = [...boxes].sort((a, b) => {
    const ay = a.y + a.h / 2
    const by = b.y + b.h / 2
    if (Math.abs(ay - by) > Math.max(a.h, b.h) * 0.6) return ay - by
    return a.x - b.x
  })
  return sorted
}

/* ---------- 主入口 ---------- */
export async function recognizeImage(
  dataUrl: string,
  onProgress?: (stage: string) => void
): Promise<OcrLineResult[]> {
  onProgress?.('加载模型…')
  await initWasm()
  const [detSess, recSess, clsSess] = await Promise.all([
    loadSession('det'),
    loadSession('rec'),
    loadSession('cls')
  ])
  await ensureDict()

  onProgress?.('解码图片…')
  const img = await loadImageData(dataUrl)
  if (img.width <= 0 || img.height <= 0) throw new Error('图片解码失败')

  onProgress?.('文本检测…')
  const detSide = Math.min(DET_LIMIT_SIDE, Math.max(img.width, img.height))
  const scale = detSide / Math.max(img.width, img.height)
  const align32 = (n: number): number => Math.max(32, Math.ceil(n / 32) * 32)
  const tw = align32(Math.round(img.width * scale))
  const th = align32(Math.round(img.height * scale))
  const scaled = scaleImage(img, tw, th)
  const detInput = toCHW(scaled.data, tw, th, IMAGENET_MEAN, IMAGENET_STD)
  const detName = detSess.inputNames[0]
  const detOutName = detSess.outputNames[0]
  let detResult: Record<string, ort.Tensor>
  try {
    detResult = await detSess.run({
      [detName]: new ort.Tensor('float32', detInput, [1, 3, th, tw])
    })
  } catch (err) {
    console.error('[ppocr] det run failed', err)
    throw new Error(
      '检测推理失败(输入 ' + tw + 'x' + th + '): ' + (err instanceof Error ? err.message : String(err))
    )
  }
  const prob = detResult[detOutName] as ort.Tensor
  const pdims = prob.dims
  const probH = pdims[pdims.length - 2]
  const probW = pdims[pdims.length - 1]
  const boxes = dbPostProcess(prob.data as Float32Array, probW, probH, tw / img.width, th / img.height)

  onProgress?.('识别文字…')
  const lines: OcrLineResult[] = []
  for (const box of sortBoxes(boxes)) {
    const crop = cropRect(img, box.x, box.y, box.w, box.h)
    if (crop.width <= 0 || crop.height <= 0) continue
    let finalCrop = crop
    let rotated = false
    try {
      rotated = await isRotated(crop, clsSess)
    } catch {
      /* cls 失败不阻塞 */
    }
    if (rotated) {
      const canvas = document.createElement('canvas')
      canvas.width = finalCrop.width
      canvas.height = finalCrop.height
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (ctx) {
        ctx.translate(canvas.width, canvas.height)
        ctx.rotate(Math.PI)
        ctx.putImageData(finalCrop, 0, 0)
        finalCrop = ctx.getImageData(0, 0, canvas.width, canvas.height)
      }
    }
    const rec = await recognizeCrop(finalCrop, recSess)
    if (rec) {
      lines.push({
        text: rec.text,
        score: Number(rec.score.toFixed(3)),
        box: [box.x, box.y, box.x + box.w, box.y, box.x + box.w, box.y + box.h, box.x, box.y + box.h]
      })
    }
  }
  return lines
}

/* ================= 表格识别（SLANet） ================= */
export interface TableCell {
  text: string
  score: number
  x: number
  y: number
  w: number
  h: number
}

const TABLE_MAX_LEN = 488
let tableSess: ort.InferenceSession | null = null
let tableDict: string[] = []

async function loadTableSession(): Promise<ort.InferenceSession> {
  if (tableSess) return tableSess
  const data = await window.api.ocr.model('slanet-plus.onnx')
  if (!data) throw new Error('表格模型缺失: slanet-plus.onnx')
  try {
    tableSess = await ort.InferenceSession.create(data, { executionProviders: ['wasm'] })
  } catch (err) {
    console.error('[ppocr] slanet session failed', err)
    throw new Error('表格模型加载失败: ' + (err instanceof Error ? err.message : String(err)))
  }
  return tableSess
}

async function ensureTableDict(): Promise<string[]> {
  if (tableDict.length > 0) return tableDict
  const raw = await window.api.ocr.tableDict()
  tableDict = raw.split('\n').filter((l) => l.length > 0)
  // 对齐 RapidTable TableLabelDecode：merge_no_span_structure + add_special_char
  if (!tableDict.includes('<td></td>')) tableDict.push('<td></td>')
  const tdIdx = tableDict.indexOf('<td>')
  if (tdIdx >= 0) tableDict.splice(tdIdx, 1)
  tableDict = ['sos', ...tableDict, 'eos']
  return tableDict
}

/** SLANet 预处理：长边 488 + pad 488x488 + ImageNet 归一化 */
function tablePreprocess(img: ImageData): { data: Float32Array } {
  const ratio = TABLE_MAX_LEN / Math.max(img.width, img.height)
  const rw = Math.max(1, Math.round(img.width * ratio))
  const rh = Math.max(1, Math.round(img.height * ratio))
  const scaled = scaleImage(img, rw, rh)
  const { data, w, h } = scaled
  const padded = new Float32Array(3 * TABLE_MAX_LEN * TABLE_MAX_LEN)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sp = (y * w + x) * 4
      const dp = y * TABLE_MAX_LEN + x
      for (let ch = 0; ch < 3; ch++) {
        padded[ch * TABLE_MAX_LEN * TABLE_MAX_LEN + dp] =
          (data[sp + ch] / 255 - IMAGENET_MEAN[ch]) / IMAGENET_STD[ch]
      }
    }
  }
  return { data: padded }
}

function argmaxRow(arr: Float32Array, offset: number, len: number): { idx: number; val: number } {
  let maxIdx = 0
  let maxVal = -Infinity
  for (let i = 0; i < len; i++) {
    const v = arr[offset + i]
    if (v > maxVal) {
      maxVal = v
      maxIdx = i
    }
  }
  return { idx: maxIdx, val: maxVal }
}

/** 解码 SLANet 输出：token 序列 + 单元格 bbox（归一化 × max(h,w) → 原图） */
function decodeTable(
  structProbs: Float32Array,
  seqLen: number,
  numTokens: number,
  bboxPreds: Float32Array,
  imgW: number,
  imgH: number
): { tokens: string[]; cells: Array<{ x: number; y: number; w: number; h: number }> } {
  const endIdx = tableDict.indexOf('eos')
  const begIdx = tableDict.indexOf('sos')
  const ignored = new Set([begIdx, endIdx])
  const tdTokens = new Set(['<td>', '<td', '<td></td>'])
  // ppstructure 的 bbox 为原图归一化坐标
  const scaleX = imgW
  const scaleY = imgH

  const tokens: string[] = []
  const cells: Array<{ x: number; y: number; w: number; h: number }> = []
  for (let idx = 0; idx < seqLen; idx++) {
    const { idx: charIdx } = argmaxRow(structProbs, idx * numTokens, numTokens)
    if (idx > 0 && charIdx === endIdx) break
    if (ignored.has(charIdx)) continue
    const text = tableDict[charIdx]
    if (text !== undefined) {
      tokens.push(text)
      if (tdTokens.has(text)) {
        // bbox 为 4 点 8 坐标 [x1,y1,x2,y2,x3,y3,x4,y4]，取 min/max 构成矩形
        const base = idx * 8
        if (base + 7 < bboxPreds.length) {
          const xs = [bboxPreds[base], bboxPreds[base + 2], bboxPreds[base + 4], bboxPreds[base + 6]]
          const ys = [bboxPreds[base + 1], bboxPreds[base + 3], bboxPreds[base + 5], bboxPreds[base + 7]]
          let x = Math.min(...xs) * scaleX
          let y = Math.min(...ys) * scaleY
          let x2 = Math.max(...xs) * scaleX
          let y2 = Math.max(...ys) * scaleY
          // 钳制到图片范围，过滤异常 bbox
          if (!isFinite(x) || !isFinite(y) || !isFinite(x2) || !isFinite(y2)) continue
          x = Math.max(0, x)
          y = Math.max(0, y)
          x2 = Math.min(imgW, x2)
          y2 = Math.min(imgH, y2)
          if (x2 - x < 2 || y2 - y < 2) continue
          if (x2 - x > imgW || y2 - y > imgH) continue
          cells.push({ x, y, w: x2 - x, h: y2 - y })
        }
      }
    }
  }
  return { tokens, cells }
}

/** 由 token 流 + 单元格文本组装 Markdown 表格 */
function tokensToMarkdown(
  tokens: string[],
  cells: Array<{ x: number; y: number; w: number; h: number }>,
  cellTexts: string[]
): string {
  const rows: string[][] = []
  let cur: string[] = []
  let cellIdx = 0
  let rowHeader = false
  for (const tok of tokens) {
    if (tok === '<tr>') {
      cur = []
    } else if (tok === '</tr>') {
      if (cur.length > 0) rows.push(cur)
      cur = []
    } else if (tok === '<thead>' || tok === '<tbody>') {
      rowHeader = tok === '<thead>'
    } else if (tok === '</thead>' || tok === '</tbody>') {
      rowHeader = false
    } else if (tok === '<td>' || tok === '<td' || tok === '<td></td>') {
      cur.push(cellTexts[cellIdx] ?? '')
      cellIdx++
    } else if (tok.startsWith('<td colspan=')) {
      const m = tok.match(/colspan="?(\d+)"?/)
      const n = m ? parseInt(m[1], 10) : 1
      const text = cellTexts[cellIdx] ?? ''
      cellIdx++
      cur.push(text)
      for (let k = 1; k < n; k++) cur.push('')
    }
    // 其他 token（</td> 等）忽略
  }
  if (cur.length > 0) rows.push(cur)
  if (rows.length === 0) return ''

  const colCount = Math.max(...rows.map((r) => r.length))
  const esc = (s: string): string => s.replace(/\|\|\n/g, ' ').replace(/\|/g, '\|')
  const lines: string[] = []
  rows.forEach((row, ri) => {
    const padded = [...row]
    while (padded.length < colCount) padded.push('')
    lines.push('| ' + padded.map(esc).join(' | ') + ' |')
    if (ri === 0) {
      lines.push('|' + Array(colCount).fill('---').join('|') + '|')
    }
  })
  return lines.join('\n')
}

export interface TableResult {
  markdown: string
  cells: TableCell[]
}

/** 表格识别主入口：SLANet 结构识别 + 单元格 PP-OCR 识别 → Markdown */
export async function recognizeTable(
  dataUrl: string,
  onProgress?: (stage: string) => void
): Promise<TableResult> {
  onProgress?.('加载模型…')
  await initWasm()
  const [slanet, recSess] = await Promise.all([loadTableSession(), loadSession('rec')])
  await Promise.all([ensureDict(), ensureTableDict()])

  onProgress?.('解码图片…')
  const img = await loadImageData(dataUrl)
  if (img.width <= 0 || img.height <= 0) throw new Error('图片解码失败')

  onProgress?.('表格结构识别…')
  const { data: input } = tablePreprocess(img)
  const inputName = slanet.inputNames[0]
  const result = await slanet.run({
    [inputName]: new ort.Tensor('float32', input, [1, 3, TABLE_MAX_LEN, TABLE_MAX_LEN])
  })
  const outNames = slanet.outputNames
  // 自动识别：bbox 输出最后一维为 4，structure 输出为 token 数
  const a = result[outNames[0]] as ort.Tensor
  const b = result[outNames[1]] as ort.Tensor
  const isStruct = (t: ort.Tensor): boolean => t.dims[t.dims.length - 1] > 10 // structure 输出为 token 数(50)，bbox 为 4/8
  const structOut = isStruct(a) ? a : b
  const bboxOut = isStruct(a) ? b : a
  const bDims = bboxOut.dims
  const sDims = structOut.dims
  const seqLen = sDims[sDims.length - 2]
  const numTokens = sDims[sDims.length - 1]
  const { tokens, cells } = decodeTable(
    structOut.data as Float32Array,
    seqLen,
    numTokens,
    bboxOut.data as Float32Array,
    img.width,
    img.height
  )
  void bDims

  onProgress?.('识别单元格内容…')
  const cellTexts: string[] = []
  const cellResults: TableCell[] = []
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]
    const crop = cropRect(img, cell.x, cell.y, cell.w, cell.h)
    if (crop.width <= 0 || crop.height <= 0) {
      cellTexts.push('')
      continue
    }
    const rec = await recognizeCrop(crop, recSess)
    const text = rec?.text ?? ''
    cellTexts.push(text)
    cellResults.push({
      text,
      score: rec?.score ?? 0,
      x: Math.round(cell.x),
      y: Math.round(cell.y),
      w: Math.round(cell.w),
      h: Math.round(cell.h)
    })
  }

  onProgress?.('整理表格…')
  const markdown = tokensToMarkdown(tokens, cells, cellTexts)
  return { markdown, cells: cellResults }
}
