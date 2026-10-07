/* 媒体工具底层：统一解析内置 ffmpeg，并封装探测 / 转换 / 抽帧 / GIF / 音频抽取 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, statSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface MediaProbe {
  ok: boolean
  error?: string
  durationSec: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  hasVideo: boolean
  sizeBytes: number
  formatName: string
  videoCodec: string
  audioCodec: string
}

export interface MediaOpResult {
  ok: boolean
  error?: string
  outputPath?: string
  sizeBytes?: number
  durationMs?: number
}

function bundledToolsDir(): string {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return join(base, 'resources', 'tools')
}

function which(tool: string): string {
  const pathEnv = process.env.PATH ?? ''
  const sep = process.platform === 'win32' ? ';' : ':'
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue
    for (const s of suffixes) {
      const c = join(dir, tool + s)
      if (existsSync(c)) return c
    }
  }
  return ''
}

export function resolveFfmpeg(): string {
  const dir = bundledToolsDir()
  const candidates =
    process.platform === 'win32'
      ? [join(dir, 'ffmpeg', 'ffmpeg.exe'), join(dir, 'ffmpeg.exe')]
      : [join(dir, 'ffmpeg', 'ffmpeg'), join(dir, 'ffmpeg')]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return which('ffmpeg') || 'ffmpeg'
}

export function ffmpegAvailable(): boolean {
  const p = resolveFfmpeg()
  return p !== 'ffmpeg' || which('ffmpeg') !== ''
}

function safeSize(p: string): number {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

function ensureDir(p: string): void {
  try {
    mkdirSync(dirname(p), { recursive: true })
  } catch {
    /* ignore */
  }
}

export function runFfmpeg(args: string[], timeoutSec = 600): Promise<{ ok: boolean; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const bin = resolveFfmpeg()
    let done = false
    let stderr = ''
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        resolve({ ok: false, stderr: stderr + `\n超时(${timeoutSec}s)`, code: null })
      }
    }, timeoutSec * 1000)

    const child = spawn(bin, args, { windowsHide: true })
    child.stdout?.on('data', () => undefined)
    child.stderr?.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, stderr: err.message, code: null })
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: code === 0, stderr, code })
    })
  })
}

/** 解析 ffmpeg -i 的 stderr 元信息（不引入 ffprobe，保持单二进制依赖） */
export async function probeMedia(filePath: string): Promise<MediaProbe> {
  const base: MediaProbe = {
    ok: false,
    durationSec: 0,
    width: 0,
    height: 0,
    fps: 0,
    hasAudio: false,
    hasVideo: false,
    sizeBytes: safeSize(filePath),
    formatName: '',
    videoCodec: '',
    audioCodec: ''
  }
  if (!existsSync(filePath)) {
    return { ...base, error: '文件不存在' }
  }
  // ffmpeg 对未知输入退出码非 0，但 -i 信息仍在 stderr
  const { stderr } = await runFfmpeg(['-hide_banner', '-i', filePath], 30)
  const text = stderr || ''

  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text)
  if (dur) {
    base.durationSec = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])
  }

  const fmt = /Input #0,\s*([^,]+)/.exec(text)
  if (fmt) base.formatName = fmt[1].trim()

  const vStream = /Stream #\d+:\d+.*?: Video:\s*([^\s,(]+)/.exec(text)
  if (vStream) {
    base.hasVideo = true
    base.videoCodec = vStream[1]
    const size = /(\d{2,5})x(\d{2,5})/.exec(text)
    if (size) {
      base.width = Number(size[1])
      base.height = Number(size[2])
    }
    const fps = /([\d.]+)\s*fps/.exec(text) || /([\d.]+)\s*tbr/.exec(text)
    if (fps) base.fps = Number(fps[1])
  }

  const aStream = /Stream #\d+:\d+.*?: Audio:\s*([^\s,(]+)/.exec(text)
  if (aStream) {
    base.hasAudio = true
    base.audioCodec = aStream[1]
  }

  if (!base.durationSec && /Video:|Audio:/.test(text)) {
    base.ok = base.hasVideo || base.hasAudio
    if (!base.ok) base.error = '无法识别媒体流'
    return base
  }
  base.ok = base.hasVideo || base.hasAudio || base.durationSec > 0
  if (!base.ok) base.error = text.slice(-200) || '无法解析媒体信息'
  return base
}

function qualityArgs(quality: 'low' | 'medium' | 'high', kind: 'video' | 'audio' | 'gif'): string[] {
  if (kind === 'audio') {
    if (quality === 'low') return ['-b:a', '96k']
    if (quality === 'high') return ['-b:a', '320k']
    return ['-b:a', '192k']
  }
  if (kind === 'gif') {
    return []
  }
  if (quality === 'low') return ['-crf', '28', '-preset', 'ultrafast']
  if (quality === 'high') return ['-crf', '18', '-preset', 'slow']
  return ['-crf', '23', '-preset', 'medium']
}

const VIDEO_OUT_CODEC: Record<string, string[]> = {
  '.mp4': ['-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart'],
  '.m4v': ['-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart'],
  '.mov': ['-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart'],
  '.webm': ['-c:v', 'libvpx-vp9', '-c:a', 'libopus'],
  '.avi': ['-c:v', 'mpeg4', '-c:a', 'libmp3lame'],
  '.mkv': ['-c:v', 'libx264', '-c:a', 'aac'],
  '.flv': ['-c:v', 'libx264', '-c:a', 'aac'],
  '.wmv': ['-c:v', 'wmv2', '-c:a', 'wmav2'],
  '.ts': ['-c:v', 'libx264', '-c:a', 'aac']
}

const AUDIO_OUT_CODEC: Record<string, string[]> = {
  '.mp3': ['-c:a', 'libmp3lame'],
  '.aac': ['-c:a', 'aac'],
  '.m4a': ['-c:a', 'aac'],
  '.wav': ['-c:a', 'pcm_s16le'],
  '.flac': ['-c:a', 'flac'],
  '.alac': ['-c:a', 'alac'],
  '.ogg': ['-c:a', 'libvorbis'],
  '.opus': ['-c:a', 'libopus'],
  '.wma': ['-c:a', 'wmav2'],
  '.aiff': ['-c:a', 'pcm_s16be']
}

export function normExt(f: string): string {
  const s = (f || '').toLowerCase().trim()
  if (!s) return ''
  return s.startsWith('.') ? s : `.${s}`
}

/** 视频/音频/GIF 格式转换 */
export async function convertMedia(
  sourcePath: string,
  targetFormat: string,
  outputPath: string,
  quality: 'low' | 'medium' | 'high' = 'medium',
  opts: { kind?: 'video' | 'audio' | 'gif'; extra?: string[] } = {}
): Promise<MediaOpResult> {
  const start = Date.now()
  const tf = normExt(targetFormat)
  if (!existsSync(sourcePath)) return { ok: false, error: '源文件不存在' }
  ensureDir(outputPath)

  const kind =
    opts.kind ??
    (['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.opus', '.wma', '.alac', '.aiff'].includes(tf)
      ? 'audio'
      : tf === '.gif'
        ? 'gif'
        : 'video')

  const args = ['-y', '-i', sourcePath]
  if (kind === 'audio') {
    args.push('-vn', ...(AUDIO_OUT_CODEC[tf] ?? ['-c:a', 'copy']), ...qualityArgs(quality, 'audio'))
  } else if (kind === 'gif') {
    // 两遍调色板，兼容性与画质更稳
    args.push(
      '-vf',
      'fps=12,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4'
    )
  } else {
    args.push(...(VIDEO_OUT_CODEC[tf] ?? []), ...qualityArgs(quality, 'video'))
    if (tf === '.gif') args.push('-vf', 'fps=12,scale=480:-1:flags=lanczos')
  }
  if (opts.extra?.length) args.push(...opts.extra)
  args.push(outputPath)

  const { ok, stderr } = await runFfmpeg(args, 900)
  if (!ok) return { ok: false, error: stderr.slice(-400) || '转换失败', durationMs: Date.now() - start }
  return { ok: true, outputPath, sizeBytes: safeSize(outputPath), durationMs: Date.now() - start }
}

/** 抽取单帧（高清单帧图） */
export async function extractFrame(
  sourcePath: string,
  timeSec: number,
  outputPath: string,
  opts: { format?: 'png' | 'jpg' | 'webp'; fullResolution?: boolean; width?: number } = {}
): Promise<MediaOpResult> {
  const start = Date.now()
  if (!existsSync(sourcePath)) return { ok: false, error: '源文件不存在' }
  ensureDir(outputPath)
  const fmt = opts.format ?? 'png'
  const args = ['-y', '-ss', String(Math.max(0, timeSec)), '-i', sourcePath, '-frames:v', '1']
  if (opts.width && opts.width > 0) {
    args.push('-vf', `scale=${opts.width}:-2:flags=lanczos`)
  } else if (!opts.fullResolution) {
    // 默认保持原始分辨率（与「原始分辨率」能力一致）
  }
  if (fmt === 'jpg') args.push('-q:v', '2')
  else if (fmt === 'webp') args.push('-quality', '90')
  args.push(outputPath)

  const { ok, stderr } = await runFfmpeg(args, 120)
  if (!ok) return { ok: false, error: stderr.slice(-300) || '抽帧失败', durationMs: Date.now() - start }
  return { ok: true, outputPath, sizeBytes: safeSize(outputPath), durationMs: Date.now() - start }
}

/** 视频截取 GIF（起止时间，最长 30 秒） */
export async function videoToGif(
  sourcePath: string,
  startSec: number,
  endSec: number,
  outputPath: string,
  opts: { fps?: number; width?: number; quality?: 'low' | 'medium' | 'high' } = {}
): Promise<MediaOpResult> {
  const start = Date.now()
  if (!existsSync(sourcePath)) return { ok: false, error: '源文件不存在' }
  const dur = Math.min(Math.max(endSec - startSec, 0.1), 30)
  const fps = Math.min(Math.max(opts.fps ?? 12, 1), 30)
  const width = Math.min(Math.max(opts.width ?? 480, 64), 1920)
  ensureDir(outputPath)

  const scale = `scale=${width}:-2:flags=lanczos`
  const args = [
    '-y',
    '-ss',
    String(Math.max(0, startSec)),
    '-t',
    String(dur),
    '-i',
    sourcePath,
    '-vf',
    `fps=${fps},${scale},split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4`,
    '-loop',
    '0',
    outputPath
  ]
  const { ok, stderr } = await runFfmpeg(args, 300)
  if (!ok) return { ok: false, error: stderr.slice(-400) || 'GIF 生成失败', durationMs: Date.now() - start }
  return { ok: true, outputPath, sizeBytes: safeSize(outputPath), durationMs: Date.now() - start }
}

/** 从视频提取音频 */
export async function extractAudio(
  sourcePath: string,
  outputPath: string,
  targetFormat = '.mp3',
  quality: 'low' | 'medium' | 'high' = 'medium'
): Promise<MediaOpResult> {
  const start = Date.now()
  if (!existsSync(sourcePath)) return { ok: false, error: '源文件不存在' }
  ensureDir(outputPath)
  const tf = normExt(targetFormat) || '.mp3'
  const args = ['-y', '-i', sourcePath, '-vn', ...(AUDIO_OUT_CODEC[tf] ?? ['-c:a', 'libmp3lame']), ...qualityArgs(quality, 'audio'), outputPath]
  const { ok, stderr } = await runFfmpeg(args, 600)
  if (!ok) return { ok: false, error: stderr.slice(-400) || '音频提取失败', durationMs: Date.now() - start }
  return { ok: true, outputPath, sizeBytes: safeSize(outputPath), durationMs: Date.now() - start }
}

/** 音频/视频片段截取（剪辑导出） */
export async function trimMedia(
  sourcePath: string,
  startSec: number,
  endSec: number,
  outputPath: string,
  opts: { reencode?: boolean } = {}
): Promise<MediaOpResult> {
  const start = Date.now()
  if (!existsSync(sourcePath)) return { ok: false, error: '源文件不存在' }
  const dur = Math.max(endSec - startSec, 0.05)
  ensureDir(outputPath)
  // -ss 在 -i 前是快速定位；需要精确时再用 reencode
  const args = opts.reencode
    ? ['-y', '-i', sourcePath, '-ss', String(Math.max(0, startSec)), '-t', String(dur), '-c:v', 'libx264', '-c:a', 'aac', outputPath]
    : ['-y', '-ss', String(Math.max(0, startSec)), '-t', String(dur), '-i', sourcePath, '-c', 'copy', outputPath]
  const { ok, stderr } = await runFfmpeg(args, 300)
  if (!ok && !opts.reencode) {
    // 流拷贝失败时回退重编码
    return trimMedia(sourcePath, startSec, endSec, outputPath, { reencode: true })
  }
  if (!ok) return { ok: false, error: stderr.slice(-400) || '剪辑失败', durationMs: Date.now() - start }
  return { ok: true, outputPath, sizeBytes: safeSize(outputPath), durationMs: Date.now() - start }
}
