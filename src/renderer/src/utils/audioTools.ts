/* 音频工具核心：BPM 检测 / 波形峰值 —— Web Audio API 本地计算 */

export interface BpmResult {
  ok: boolean
  error?: string
  bpm: number
  confidence: number
  durationSec: number
  peaks: number[]
}

/** 从 File 解码 AudioBuffer */
export async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, 1, 44100)
  const buf = await file.arrayBuffer()
  return ctx.decodeAudioData(buf.slice(0))
}

/** 提取单声道包络（能量峰值序列），用于 BPM 自相关 */
function buildOnsetEnvelope(buffer: AudioBuffer, hopMs = 10): Float32Array {
  const channel = buffer.getChannelData(0)
  const sampleRate = buffer.sampleRate
  const hop = Math.max(1, Math.floor((hopMs / 1000) * sampleRate))
  const n = Math.floor(channel.length / hop)
  const env = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    const start = i * hop
    const end = Math.min(channel.length, start + hop)
    for (let j = start; j < end; j++) {
      const v = channel[j]
      sum += v * v
    }
    env[i] = Math.sqrt(sum / Math.max(1, end - start))
  }
  // 一阶差分（强调 onset）
  const flux = new Float32Array(n)
  for (let i = 1; i < n; i++) {
    const d = env[i] - env[i - 1]
    flux[i] = d > 0 ? d : 0
  }
  return flux
}

/**
 * BPM 检测：onset 包络 + 自相关
 * 参考成熟思路（aubio / librosa onset autocorrelation），无外部依赖。
 */
export async function detectBpm(file: File): Promise<BpmResult> {
  try {
    const buffer = await decodeAudioFile(file)
    const durationSec = buffer.duration
    if (durationSec < 1) {
      return { ok: false, error: '音频过短', bpm: 0, confidence: 0, durationSec, peaks: [] }
    }

    const hopMs = 10
    const flux = buildOnsetEnvelope(buffer, hopMs)
    const n = flux.length
    if (n < 32) {
      return { ok: false, error: '音频过短', bpm: 0, confidence: 0, durationSec, peaks: [] }
    }

    // 归一化 + 轻微平滑
    let maxV = 0
    for (let i = 0; i < n; i++) if (flux[i] > maxV) maxV = flux[i]
    if (maxV <= 0) {
      return { ok: false, error: '未检测到有效节拍能量', bpm: 0, confidence: 0, durationSec, peaks: [] }
    }
    const norm = new Float32Array(n)
    for (let i = 0; i < n; i++) norm[i] = flux[i] / maxV

    // 去均值，利于自相关
    let mean = 0
    for (let i = 0; i < n; i++) mean += norm[i]
    mean /= n
    for (let i = 0; i < n; i++) norm[i] -= mean

    // 自相关：搜索 BPM 60~200 对应滞后
    const fps = 1000 / hopMs
    const minLag = Math.max(2, Math.floor((60 / 200) * fps)) // 200 BPM
    const maxLag = Math.min(n - 2, Math.ceil((60 / 50) * fps)) // 50 BPM

    let bestLag = minLag
    let bestScore = -Infinity
    let secondScore = -Infinity
    const scores: number[] = []

    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0
      let energy = 0
      for (let i = 0; i + lag < n; i++) {
        sum += norm[i] * norm[i + lag]
        energy += norm[i] * norm[i]
      }
      const score = energy > 0 ? sum / energy : 0
      scores.push(score)
      if (score > bestScore) {
        secondScore = bestScore
        bestScore = score
        bestLag = lag
      } else if (score > secondScore) {
        secondScore = score
      }
    }

    let bpm = (60 * fps) / bestLag
    // 折半/加倍到 70~180 常用区间
    while (bpm > 180) bpm /= 2
    while (bpm < 70 && bpm * 2 <= 180) bpm *= 2
    bpm = Math.round(bpm * 10) / 10

    const confidence =
      bestScore > 0 ? Math.max(0, Math.min(1, (bestScore - (secondScore || 0)) / (bestScore || 1) + bestScore * 0.5)) : 0

    // 生成波形峰值（预览用）
    const peaks = buildPeaks(buffer, 240)

    return {
      ok: true,
      bpm,
      confidence: Math.round(confidence * 100) / 100,
      durationSec: Math.round(durationSec * 100) / 100,
      peaks
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      bpm: 0,
      confidence: 0,
      durationSec: 0,
      peaks: []
    }
  }
}

/** 波形峰值（用于画布预览） */
export function buildPeaks(buffer: AudioBuffer, buckets = 400): number[] {
  const ch = buffer.getChannelData(0)
  const size = Math.floor(ch.length / buckets)
  const peaks: number[] = []
  for (let i = 0; i < buckets; i++) {
    let min = 1
    let max = -1
    const start = i * size
    const end = Math.min(ch.length, start + size)
    for (let j = start; j < end; j++) {
      const v = ch[j]
      if (v < min) min = v
      if (v > max) max = v
    }
    peaks.push(Math.max(Math.abs(min), Math.abs(max)))
  }
  return peaks
}

export function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: number[],
  opts: {
    selection?: { startRatio: number; endRatio: number } | null
    color?: string
    selectionColor?: string
    bg?: string
  } = {}
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)
  if (opts.bg) {
    ctx.fillStyle = opts.bg
    ctx.fillRect(0, 0, w, h)
  }
  if (!peaks.length) return

  const color = opts.color || 'rgba(40,96,125,0.75)'
  const selColor = opts.selectionColor || 'rgba(29,158,117,0.35)'
  const mid = h / 2

  // 选区底
  if (opts.selection) {
    const x1 = opts.selection.startRatio * w
    const x2 = opts.selection.endRatio * w
    ctx.fillStyle = selColor
    ctx.fillRect(Math.min(x1, x2), 0, Math.abs(x2 - x1), h)
  }

  const barW = Math.max(1, w / peaks.length)
  for (let i = 0; i < peaks.length; i++) {
    const ph = Math.max(1, peaks[i] * (h * 0.46))
    const x = i * barW
    const inSel =
      opts.selection &&
      i / peaks.length >= Math.min(opts.selection.startRatio, opts.selection.endRatio) &&
      i / peaks.length <= Math.max(opts.selection.startRatio, opts.selection.endRatio)
    ctx.fillStyle = inSel && opts.selection ? (opts.selectionColor || color) : color
    ctx.fillRect(x, mid - ph, Math.max(1, barW * 0.85), ph * 2)
  }

  // 中线
  ctx.strokeStyle = 'rgba(128,128,128,0.25)'
  ctx.beginPath()
  ctx.moveTo(0, mid)
  ctx.lineTo(w, mid)
  ctx.stroke()
}

/** 导出 AudioBuffer 片段为 WAV */
export async function sliceAudioToWav(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number
): Promise<Blob> {
  const sampleRate = buffer.sampleRate
  const start = Math.max(0, Math.floor(startSec * sampleRate))
  const end = Math.min(buffer.length, Math.floor(endSec * sampleRate))
  const length = Math.max(1, end - start)
  const channels = Math.min(2, buffer.numberOfChannels)
  const data = new DataView(new ArrayBuffer(44 + length * channels * 2))

  const writeStr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) data.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  data.setUint32(4, 36 + length * channels * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  data.setUint32(16, 16, true)
  data.setUint16(20, 1, true)
  data.setUint16(22, channels, true)
  data.setUint32(24, sampleRate, true)
  data.setUint32(28, sampleRate * channels * 2, true)
  data.setUint16(32, channels * 2, true)
  data.setUint16(34, 16, true)
  writeStr(36, 'data')
  data.setUint32(40, length * channels * 2, true)

  let off = 44
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < channels; c++) {
      const ch = buffer.getChannelData(c)
      const v = Math.max(-1, Math.min(1, ch[start + i] || 0))
      data.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true)
      off += 2
    }
  }
  return new Blob([data.buffer], { type: 'audio/wav' })
}

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00.0'
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`
}
