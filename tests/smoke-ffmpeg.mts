// ffmpeg 真机转码冒烟（不依赖 electron，直接调内置二进制）
// 运行：node --experimental-strip-types tests/smoke-ffmpeg.mts
import { spawn } from 'node:child_process'
import { existsSync, statSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const ffmpeg =
  process.platform === 'win32'
    ? join(root, 'resources', 'tools', 'ffmpeg', 'ffmpeg.exe')
    : join(root, 'resources', 'tools', 'ffmpeg', 'ffmpeg')
const src = join(root, '.toolcache', 'test.mp4')
const outDir = join(tmpdir(), `lingmo-ff-${Date.now()}`)

let passed = 0
let failed = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log('  ✓ ' + msg)
  } else {
    failed++
    console.log('  ✗ ' + msg)
  }
}

function run(args: string[], timeoutMs = 60000): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = ''
    let done = false
    const child = spawn(ffmpeg, args, { windowsHide: true })
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        child.kill('SIGKILL')
        resolve({ ok: false, stderr: stderr + '\ntimeout' })
      }
    }, timeoutMs)
    child.stderr?.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', (e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, stderr: e.message })
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: code === 0, stderr })
    })
  })
}

console.log('smoke-ffmpeg')

assert(existsSync(ffmpeg), '内置 ffmpeg 存在')
assert(existsSync(src), '测试视频 test.mp4 存在')
if (!existsSync(ffmpeg) || !existsSync(src)) {
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

// ---- probe ----
{
  const { stderr } = await run(['-hide_banner', '-i', src], 30000)
  assert(/Video:\s*h264/i.test(stderr), 'probe 识别 h264 视频流')
  assert(/Duration:\s*00:00:01/.test(stderr), 'probe 时长约 1s')
  assert(/128x96/.test(stderr), 'probe 分辨率 128x96')
}

// ---- 转码 mp4 → webm ----
{
  const out = join(outDir, 'out.webm')
  const { ok, stderr } = await run(['-y', '-i', src, '-c:v', 'libvpx', '-b:v', '200k', out], 90000)
  assert(ok && existsSync(out) && statSync(out).size > 0, `mp4→webm 转码成功${ok ? '' : ' :: ' + stderr.slice(-120)}`)
}

// ---- 抽帧 PNG ----
{
  const out = join(outDir, 'frame.png')
  const { ok } = await run(['-y', '-ss', '0.2', '-i', src, '-frames:v', '1', out], 30000)
  assert(ok && existsSync(out) && statSync(out).size > 100, '抽帧 PNG 成功')
}

// ---- 截取 GIF ----
{
  const out = join(outDir, 'clip.gif')
  const { ok } = await run(
    ['-y', '-t', '0.5', '-i', src, '-vf', 'fps=8,scale=96:-2:flags=lanczos', out],
    60000
  )
  assert(ok && existsSync(out) && statSync(out).size > 0, 'GIF 截取成功')
}

// ---- 音频提取（无声视频也应产出合法文件或明确失败）----
{
  const out = join(outDir, 'audio.wav')
  const { ok, stderr } = await run(['-y', '-i', src, '-vn', '-acodec', 'pcm_s16le', out], 30000)
  const produced = existsSync(out) && statSync(out).size > 0
  const noAudio = /does not contain any stream|Output file #0 does not contain any stream|Stream map/i.test(stderr)
  assert(ok || noAudio ? produced || noAudio : false, `音频提取：${produced ? '已导出' : noAudio ? '源无音轨（预期）' : '失败'}`)
}

// ---- 剪辑 ----
{
  const out = join(outDir, 'trim.mp4')
  const { ok } = await run(['-y', '-ss', '0', '-t', '0.5', '-i', src, '-c', 'copy', out], 30000)
  assert(ok && existsSync(out) && statSync(out).size > 0, '流拷贝剪辑成功')
}

try {
  rmSync(outDir, { recursive: true, force: true })
} catch {
  /* ignore */
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
