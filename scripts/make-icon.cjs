/* 生成多尺寸 icon.ico（无外部依赖）
 * 输入：build/icon.png（1242×1242 LOGO）
 * 输出：build/icon.ico（含 16/24/32/48/64/128/256 七档 PNG-in-ICO）
 * ICO 格式：ICONDIR + ICONDIRENTRY×N + 各尺寸 PNG 数据（Vista+ 支持 PNG 压缩）
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'build', 'icon.png')
const OUT = path.join(ROOT, 'build', 'icon.ico')
const FFMPEG = path.join(ROOT, 'resources', 'tools', 'ffmpeg', 'ffmpeg.exe')

const SIZES = [16, 24, 32, 48, 64, 128, 256]
const tmpPngs = []

// 1) ffmpeg 生成各尺寸 PNG
for (const size of SIZES) {
  const tmp = path.join(ROOT, 'build', `_icon_${size}.png`)
  execFileSync(FFMPEG, ['-y', '-i', SRC, '-vf', `scale=${size}:${size}`, '-c:v', 'png', '-frames:v', '1', tmp], { stdio: 'ignore' })
  tmpPngs.push({ size, file: tmp })
}

// 2) 合成 ICO
const pngBuffers = tmpPngs.map(({ file }) => fs.readFileSync(file))
const count = pngBuffers.length
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(count, 4)

const entries = []
let offset = 6 + 16 * count
pngBuffers.forEach((buf, i) => {
  const size = SIZES[i]
  const entry = Buffer.alloc(16)
  entry.writeUInt8(size >= 256 ? 0 : size, 0) // width（256 用 0 表示）
  entry.writeUInt8(size >= 256 ? 0 : size, 1) // height
  entry.writeUInt8(0, 2) // palette
  entry.writeUInt8(0, 3) // reserved
  entry.writeUInt16LE(1, 4) // planes
  entry.writeUInt16LE(32, 6) // bitcount
  entry.writeUInt32LE(buf.length, 8) // bytes in resource
  entry.writeUInt32LE(offset, 12) // offset
  entries.push(entry)
  offset += buf.length
})

const ico = Buffer.concat([header, ...entries, ...pngBuffers])
fs.writeFileSync(OUT, ico)

// 3) 清理临时 PNG（沙箱 shim 下 unlink 可能失败，容错处理）
for (const { file } of tmpPngs) {
  try {
    fs.unlinkSync(file)
  } catch {
    /* 临时文件残留可稍后手动清理 */
  }
}

console.log(`OK: ${OUT} (${ico.length} bytes, ${count} sizes: ${SIZES.join('/')}）`)
