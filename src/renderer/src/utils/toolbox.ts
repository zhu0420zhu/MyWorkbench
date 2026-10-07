/* 灵墨工作台 · 工具箱纯函数（移植自 ToolKnit 开源能力思路，全部本地计算） */

// ── UUID ──────────────────────────────────────────────────────────
export function generateUuidV4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function generateUuidBatch(count: number): string[] {
  const n = Math.max(1, Math.min(500, Math.floor(count) || 1))
  return Array.from({ length: n }, () => generateUuidV4())
}

// ── JWT ───────────────────────────────────────────────────────────
export interface JwtView {
  ok: boolean
  header?: unknown
  payload?: unknown
  error?: string
  /** 是否签名校验（仅展示，不验证密钥） */
  alg?: string
  expiresAt?: string
  issuedAt?: string
  subject?: string
}

function b64UrlDecode(s: string): string {
  const t = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = t.length % 4 === 0 ? '' : '='.repeat(4 - (t.length % 4))
  return atob(t + pad)
}

export function parseJwt(token: string): JwtView {
  const raw = token.trim()
  if (!raw) return { ok: false, error: '请输入 JWT' }
  const parts = raw.split('.')
  if (parts.length < 2) return { ok: false, error: 'JWT 至少需要 header.payload 两段' }
  try {
    const header = JSON.parse(b64UrlDecode(parts[0]))
    const payload = JSON.parse(b64UrlDecode(parts[1]))
    const alg = typeof header?.alg === 'string' ? header.alg : undefined
    const fmt = (sec: unknown): string | undefined => {
      if (typeof sec !== 'number') return undefined
      try {
        return new Date(sec * 1000).toISOString()
      } catch {
        return undefined
      }
    }
    return {
      ok: true,
      header,
      payload,
      alg,
      expiresAt: fmt(payload?.exp),
      issuedAt: fmt(payload?.iat),
      subject: typeof payload?.sub === 'string' ? payload.sub : undefined
    }
  } catch (e) {
    return { ok: false, error: `解析失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

// ── Hash / HMAC ───────────────────────────────────────────────────
export type HashAlgo = 'MD5' | 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512'

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 紧凑 MD5（兼容旧摘要，敏感场景请用 SHA-256+） */
export function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ]
  const K = new Uint32Array(64)
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32)
  const ml = bytes.length * 8
  const withPad = new Uint8Array(((bytes.length + 8) >> 6) * 64 + 64)
  withPad.set(bytes)
  withPad[bytes.length] = 0x80
  const dv = new DataView(withPad.buffer)
  dv.setUint32(withPad.length - 8, ml >>> 0, true)
  dv.setUint32(withPad.length - 4, Math.floor(ml / 2 ** 32), true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  const rot = (x: number, n: number) => (x << n) | (x >>> (32 - n))

  for (let off = 0; off < withPad.length; off += 64) {
    const M = new Uint32Array(16)
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true)
    let A = a0
    let B = b0
    let C = c0
    let D = d0
    for (let i = 0; i < 64; i++) {
      let F: number
      let g: number
      if (i < 16) {
        F = (B & C) | (~B & D)
        g = i
      } else if (i < 32) {
        F = (D & B) | (~D & C)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        F = B ^ C ^ D
        g = (3 * i + 5) % 16
      } else {
        F = C ^ (B | ~D)
        g = (7 * i) % 16
      }
      F = (F + A + K[i] + M[g]) >>> 0
      A = D
      D = C
      C = B
      B = (B + rot(F, S[i])) >>> 0
    }
    a0 = (a0 + A) >>> 0
    b0 = (b0 + B) >>> 0
    c0 = (c0 + C) >>> 0
    d0 = (d0 + D) >>> 0
  }
  return [a0, b0, c0, d0]
    .map((x) => {
      const s = x >>> 0
      return [s & 0xff, (s >>> 8) & 0xff, (s >>> 16) & 0xff, (s >>> 24) & 0xff]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    })
    .join('')
}

export async function hashText(algo: HashAlgo, text: string): Promise<string> {
  if (algo === 'MD5') return md5Hex(text)
  const buf = await crypto.subtle.digest(algo, new TextEncoder().encode(text))
  return toHex(buf)
}

export async function hmacText(algo: 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512', key: string, text: string): Promise<string> {
  const enc = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: algo }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(text))
  return toHex(sig)
}

// ── 密码生成 ──────────────────────────────────────────────────────
export interface PasswordOptions {
  length: number
  upper: boolean
  lower: boolean
  digits: boolean
  symbols: boolean
  excludeAmbiguous: boolean
}

export function generatePassword(opts: PasswordOptions): string {
  const ambiguous = 'O0Il1|`\'"{}[]()/\\'
  let pool = ''
  if (opts.lower) pool += 'abcdefghijklmnopqrstuvwxyz'
  if (opts.upper) pool += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  if (opts.digits) pool += '0123456789'
  if (opts.symbols) pool += '!@#$%^&*_-+=?.,:;~'
  if (opts.excludeAmbiguous) {
    pool = pool
      .split('')
      .filter((c) => !ambiguous.includes(c))
      .join('')
  }
  if (!pool) throw new Error('至少选择一种字符集')
  const len = Math.max(4, Math.min(128, Math.floor(opts.length) || 16))
  const out: string[] = []
  const rnd = new Uint32Array(len)
  crypto.getRandomValues(rnd)
  for (let i = 0; i < len; i++) out.push(pool[rnd[i] % pool.length])
  return out.join('')
}

// ── 时间戳 ────────────────────────────────────────────────────────
export function timestampNow(): number {
  return Math.floor(Date.now() / 1000)
}

export function timestampToDate(sec: number): { iso: string; local: string; ms: number } | null {
  if (!Number.isFinite(sec)) return null
  // 自动识别秒/毫秒
  const ms = sec > 1e12 ? sec : sec * 1000
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  return { iso: d.toISOString(), local: d.toLocaleString('zh-CN', { hour12: false }), ms }
}

export function dateToTimestamp(localStr: string): number | null {
  const t = Date.parse(localStr)
  if (Number.isNaN(t)) return null
  return Math.floor(t / 1000)
}

// ── 房贷 / 利息 ───────────────────────────────────────────────────
export interface MortgageResult {
  monthly: number
  totalInterest: number
  totalPayment: number
  schedule: Array<{ month: number; payment: number; principal: number; interest: number; remain: number }>
}

export function calcMortgage(
  principal: number,
  annualRatePercent: number,
  years: number,
  method: 'equal-installment' | 'equal-principal' = 'equal-installment',
  withSchedule = false
): MortgageResult {
  const months = Math.max(1, Math.round(years * 12))
  const r = annualRatePercent / 100 / 12
  const schedule: MortgageResult['schedule'] = []
  let totalInterest = 0
  let totalPayment = 0
  let monthly = 0

  if (method === 'equal-installment') {
    monthly = r === 0 ? principal / months : (principal * r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1)
    let remain = principal
    for (let m = 1; m <= months; m++) {
      const interest = remain * r
      const principalPart = monthly - interest
      remain = Math.max(0, remain - principalPart)
      totalInterest += interest
      totalPayment += monthly
      if (withSchedule) schedule.push({ month: m, payment: monthly, principal: principalPart, interest, remain })
    }
  } else {
    const principalPart = principal / months
    let remain = principal
    let maxPay = 0
    for (let m = 1; m <= months; m++) {
      const interest = remain * r
      const payment = principalPart + interest
      remain = Math.max(0, remain - principalPart)
      totalInterest += interest
      totalPayment += payment
      if (payment > maxPay) maxPay = payment
      if (withSchedule) schedule.push({ month: m, payment, principal: principalPart, interest, remain })
    }
    monthly = maxPay
  }
  return { monthly, totalInterest, totalPayment, schedule }
}

export function calcInterest(
  principal: number,
  annualRatePercent: number,
  years: number,
  compound: 'simple' | 'annual' | 'monthly' = 'simple'
): { total: number; interest: number } {
  const r = annualRatePercent / 100
  let total: number
  if (compound === 'simple') {
    total = principal * (1 + r * years)
  } else if (compound === 'annual') {
    total = principal * Math.pow(1 + r, years)
  } else {
    total = principal * Math.pow(1 + r / 12, years * 12)
  }
  return { total, interest: total - principal }
}

// ── 体脂率（BMI / 美军公式近似） ─────────────────────────────────
export interface BodyFatResult {
  bmi: number
  bodyFat: number
  category: string
}

export function calcBodyFat(
  heightCm: number,
  weightKg: number,
  age: number,
  gender: 'male' | 'female',
  neckCm?: number,
  waistCm?: number,
  hipCm?: number
): BodyFatResult {
  const h = heightCm / 100
  const bmi = weightKg / (h * h)
  let bodyFat = 0
  if (neckCm && waistCm && (gender === 'male' || hipCm)) {
    // 美军体脂公式
    if (gender === 'male') {
      bodyFat = 495 / (1.0324 - 0.19077 * Math.log10(waistCm - neckCm) + 0.15456 * Math.log10(heightCm)) - 450
    } else {
      bodyFat = 495 / (1.29579 - 0.35004 * Math.log10(waistCm + (hipCm ?? 0) - neckCm) + 0.221 * Math.log10(heightCm)) - 450
    }
  } else {
    // BMI 估算（Deurenberg）
    bodyFat = 1.2 * bmi + 0.23 * age - (gender === 'male' ? 16.2 : 5.4)
  }
  bodyFat = Math.max(3, Math.min(60, bodyFat))
  const category =
    gender === 'male'
      ? bodyFat < 6
        ? '偏瘦'
        : bodyFat < 14
          ? '偏瘦'
          : bodyFat < 25
            ? '正常'
            : bodyFat < 31
              ? '偏胖'
              : '肥胖'
      : bodyFat < 14
        ? '偏瘦'
        : bodyFat < 21
          ? '偏瘦'
          : bodyFat < 33
            ? '正常'
            : bodyFat < 39
              ? '偏胖'
              : '肥胖'
  return { bmi: Math.round(bmi * 10) / 10, bodyFat: Math.round(bodyFat * 10) / 10, category }
}

// ── 颜色空间 ──────────────────────────────────────────────────────
export interface Rgb {
  r: number
  g: number
  b: number
}

export function hexToRgb(hex: string): Rgb | null {
  const s = hex.trim().replace(/^#/, '')
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16)
  }
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (x: number) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l: l * 100 }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
  else if (max === gn) h = ((bn - rn) / d + 2) / 6
  else h = ((rn - gn) / d + 4) / 6
  return { h: h * 360, s: s * 100, l: l * 100 }
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const hn = ((h % 360) + 360) % 360 / 360
  const sn = Math.max(0, Math.min(100, s)) / 100
  const ln = Math.max(0, Math.min(100, l)) / 100
  if (sn === 0) {
    const v = ln * 255
    return { r: v, g: v, b: v }
  }
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn
  const p = 2 * ln - q
  const hue = (t: number) => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  return { r: hue(hn + 1 / 3) * 255, g: hue(hn) * 255, b: hue(hn - 1 / 3) * 255 }
}

export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
    else if (max === gn) h = ((bn - rn) / d + 2) / 6
    else h = ((rn - gn) / d + 4) / 6
  }
  return { h: h * 360, s: max === 0 ? 0 : (d / max) * 100, v: max * 100 }
}

export function hsvToRgb(h: number, s: number, v: number): Rgb {
  const hn = (((h % 360) + 360) % 360) / 60
  const sn = Math.max(0, Math.min(100, s)) / 100
  const vn = Math.max(0, Math.min(100, v)) / 100
  const c = vn * sn
  const x = c * (1 - Math.abs((hn % 2) - 1))
  const m = vn - c
  let rgb: Rgb
  if (hn < 1) rgb = { r: c, g: x, b: 0 }
  else if (hn < 2) rgb = { r: x, g: c, b: 0 }
  else if (hn < 3) rgb = { r: 0, g: c, b: x }
  else if (hn < 4) rgb = { r: 0, g: x, b: c }
  else if (hn < 5) rgb = { r: x, g: 0, b: c }
  else rgb = { r: c, g: 0, b: x }
  return { r: (rgb.r + m) * 255, g: (rgb.g + m) * 255, b: (rgb.b + m) * 255 }
}

export function rgbToCmyk(r: number, g: number, b: number): { c: number; m: number; y: number; k: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const k = 1 - Math.max(rn, gn, bn)
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 }
  return {
    c: ((1 - rn - k) / (1 - k)) * 100,
    m: ((1 - gn - k) / (1 - k)) * 100,
    y: ((1 - bn - k) / (1 - k)) * 100,
    k: k * 100
  }
}

export interface ColorSnapshot {
  hex: string
  rgb: Rgb
  hsl: { h: number; s: number; l: number }
  hsv: { h: number; s: number; v: number }
  cmyk: { c: number; m: number; y: number; k: number }
  /** sRGB 十六进制简写；色域检测用相对亮度近似 */
  luminance: number
  isLight: boolean
}

export function colorSnapshot(hex: string): ColorSnapshot | null {
  const rgb = hexToRgb(hex)
  if (!rgb) return null
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b)
  const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b)
  const cmyk = rgbToCmyk(rgb.r, rgb.g, rgb.b)
  const lin = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const luminance = 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b)
  return {
    hex: rgbToHex(rgb.r, rgb.g, rgb.b),
    rgb,
    hsl: { h: Math.round(hsl.h * 10) / 10, s: Math.round(hsl.s * 10) / 10, l: Math.round(hsl.l * 10) / 10 },
    hsv: { h: Math.round(hsv.h * 10) / 10, s: Math.round(hsv.s * 10) / 10, v: Math.round(hsv.v * 10) / 10 },
    cmyk: {
      c: Math.round(cmyk.c),
      m: Math.round(cmyk.m),
      y: Math.round(cmyk.y),
      k: Math.round(cmyk.k)
    },
    luminance: Math.round(luminance * 1000) / 1000,
    isLight: luminance > 0.55
  }
}

// ── 图像：调色板提取 / 压缩 / 转换 / 图标 ────────────────────────
export function extractPalette(imageData: ImageData, count = 6): Array<{ hex: string; ratio: number }> {
  const { data, width, height } = imageData
  const bins = new Map<number, { r: number; g: number; b: number; n: number }>()
  const step = Math.max(1, Math.floor((width * height) / 8000))
  for (let i = 0; i < data.length; i += 4 * step) {
    // 量化到 16 级减少噪声
    const r = data[i] & 0xf0
    const g = data[i + 1] & 0xf0
    const b = data[i + 2] & 0xf0
    const key = (r << 16) | (g << 8) | b
    const cur = bins.get(key)
    if (cur) cur.n++
    else bins.set(key, { r: r + 8, g: g + 8, b: b + 8, n: 1 })
  }
  const sorted = [...bins.values()].sort((a, b) => b.n - a.n).slice(0, count)
  const total = sorted.reduce((s, x) => s + x.n, 0) || 1
  return sorted.map((x) => ({
    hex: rgbToHex(x.r, x.g, x.b),
    ratio: Math.round((x.n / total) * 1000) / 10
  }))
}

export function drawImageToCanvas(img: HTMLImageElement | ImageBitmap): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = 'width' in img ? (img as HTMLImageElement).width || (img as ImageBitmap).width : 0
  canvas.height = 'height' in img ? (img as HTMLImageElement).height || (img as ImageBitmap).height : 0
  if (img instanceof HTMLImageElement) {
    canvas.width = img.naturalWidth || img.width
    canvas.height = img.naturalHeight || img.height
  } else {
    canvas.width = img.width
    canvas.height = img.height
  }
  const ctx = canvas.getContext('2d')
  if (ctx) ctx.drawImage(img as CanvasImageSource, 0, 0)
  return canvas
}

export async function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

export function resizeCanvas(src: HTMLCanvasElement, maxSide: number): HTMLCanvasElement {
  const { width, height } = src
  const scale = Math.min(1, maxSide / Math.max(width, height))
  if (scale >= 1) return src
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height)
  }
  return canvas
}

export function cropCanvas(src: HTMLCanvasElement, sx: number, sy: number, sw: number, sh: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sw))
  canvas.height = Math.max(1, Math.round(sh))
  const ctx = canvas.getContext('2d')
  if (ctx) ctx.drawImage(src, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  return canvas
}

export function makeIconSet(src: HTMLCanvasElement): Array<{ name: string; size: number; canvas: HTMLCanvasElement }> {
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  return sizes.map((size) => {
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(src, 0, 0, size, size)
    }
    return { name: `icon-${size}x${size}.png`, size, canvas }
  })
}

export function stitchImages(
  images: HTMLCanvasElement[],
  direction: 'horizontal' | 'vertical',
  gap = 0,
  background = '#ffffff'
): HTMLCanvasElement {
  if (!images.length) return document.createElement('canvas')
  const canvas = document.createElement('canvas')
  if (direction === 'horizontal') {
    canvas.width = images.reduce((s, c) => s + c.width, 0) + gap * (images.length - 1)
    canvas.height = Math.max(...images.map((c) => c.height))
  } else {
    canvas.width = Math.max(...images.map((c) => c.width))
    canvas.height = images.reduce((s, c) => s + c.height, 0) + gap * (images.length - 1)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  ctx.fillStyle = background
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  let offset = 0
  for (const img of images) {
    if (direction === 'horizontal') {
      const y = Math.floor((canvas.height - img.height) / 2)
      ctx.drawImage(img, offset, y)
      offset += img.width + gap
    } else {
      const x = Math.floor((canvas.width - img.width) / 2)
      ctx.drawImage(img, x, offset)
      offset += img.height + gap
    }
  }
  return canvas
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function downloadText(text: string, filename: string, mime = 'text/plain'): void {
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 ? v : v.toFixed(2)} ${u[i]}`
}
