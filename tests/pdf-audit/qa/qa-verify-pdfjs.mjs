/**
 * QA 独立验证——第三方实现 B：pdf.js（pdfjs-dist）。
 * 含【渲染验证】：用 @napi-rs/canvas（Skia 后端）把页面渲染成像素图，
 * 统计非白像素占比，并与「未加密参照文件」的渲染结果逐像素比对。
 *
 * 运行：
 *   NODE_OPTIONS="" "<node>" tests/pdf-audit/qa/qa-verify-pdfjs.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createCanvas, ImageData } from '@napi-rs/canvas'

const HERE = dirname(fileURLToPath(import.meta.url))
const AUDIT = join(HERE, '..')
const QA_FIX = join(AUDIT, 'qa-fixtures')
const WORK = join(AUDIT, 'qa-work')
const FIX = join(AUDIT, 'fixtures')
const PDFJS_ROOT = join(AUDIT, '..', '..', 'node_modules', 'pdfjs-dist')
const STD_FONTS = join(PDFJS_ROOT, 'standard_fonts') + '/'
const CMAPS = join(PDFJS_ROOT, 'cmaps') + '/'
const USER = 'LingmoAuditPass123'
mkdirSync(WORK, { recursive: true })

let passed = 0, failed = 0
const fails = []
const check = (ok, msg) => {
  console.log((ok ? '  [OK] ' : '  [XX] ') + msg)
  ok ? passed++ : (failed++, fails.push(msg))
}

const BASE = {
  isEvalSupported: false,
  disableFontFace: true,
  standardFontDataUrl: STD_FONTS,
  cMapUrl: CMAPS,
  cMapPacked: true
}

async function extractText(bytes, password) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), password, ...BASE })
  const doc = await task.promise
  const n = doc.numPages
  let out = ''
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i)
    const c = await page.getTextContent()
    out += c.items.map((it) => ('str' in it ? it.str : '')).join('')
  }
  await task.destroy()
  return { text: out, pages: n }
}

/** 渲染第 1 页 → 像素统计 */
async function renderPage1(bytes, password, scale = 1.5) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), password, ...BASE })
  const doc = await task.promise
  const page = await doc.getPage(1)
  const viewport = page.getViewport({ scale })
  const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height))
  const ctx = canvas.getContext('2d')
  await page.render({ canvas, canvasContext: ctx, viewport }).promise
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  let nonWhite = 0, sum = 0
  for (let k = 0; k < img.length; k += 4) {
    const v = (img[k] + img[k + 1] + img[k + 2]) / 3
    sum += v
    if (v < 240) nonWhite++
  }
  const total = img.length / 4
  await task.destroy()
  return {
    w: canvas.width, h: canvas.height, total,
    nonWhite, coveragePct: +(nonWhite / total * 100).toFixed(3),
    avgLuma: +(sum / total).toFixed(2), data: img
  }
}

function diffPixels(a, b) {
  if (a.w !== b.w || a.h !== b.h) return { same: -1, mad: -1, dims: `${a.w}x${a.h} vs ${b.w}x${b.h}` }
  let same = 0, absSum = 0
  for (let k = 0; k < a.data.length; k += 4) {
    const da = a.data[k] - b.data[k], dg = a.data[k + 1] - b.data[k + 1], db = a.data[k + 2] - b.data[k + 2]
    if (Math.abs(da) + Math.abs(dg) + Math.abs(db) === 0) same++
    absSum += Math.abs(da) + Math.abs(dg) + Math.abs(db)
  }
  return { same: +(same / (a.data.length / 4) * 100).toFixed(3), mad: +(absSum / (a.data.length / 4) / 3).toFixed(3) }
}

console.log('='.repeat(78))
console.log('QA 交叉验证 B：pdf.js（pdfjs-dist）+ @napi-rs/canvas 真实渲染')
console.log('='.repeat(78))

// ---- 参照文本 ----
const srcRef = await extractText(readFileSync(join(FIX, 'enhance-source.pdf')))
const realRefBytes = readFileSync(join(QA_FIX, 'real-large-plain.pdf'))
const realRef = await extractText(realRefBytes)
console.log(`\n参照 enhance-source.pdf : ${srcRef.pages} 页 / ${srcRef.text.length} 字`)
console.log(`参照 real-large-plain   : ${realRef.pages} 页 / ${realRef.text.length} 字`)
console.log(`  预览: ${JSON.stringify(srcRef.text.slice(0, 50))}…`)

// ---- 参照渲染 ----
console.log('\n[0] 参照渲染（page1 非白像素占比）')
const rSrcPlain = await renderPage1(readFileSync(join(FIX, 'enhance-source.pdf')))
const rRealPlain = await renderPage1(realRefBytes)
console.log(`  enhance-source : ${rSrcPlain.w}×${rSrcPlain.h} 非白 ${rSrcPlain.coveragePct}% 均亮 ${rSrcPlain.avgLuma}`)
console.log(`  real-large     : ${rRealPlain.w}×${rRealPlain.h} 非白 ${rRealPlain.coveragePct}% 均亮 ${rRealPlain.avgLuma}`)

// ---- 解密产物：文本 + 渲染 ----
console.log('\n[1] 解密产物 → 文本逐字符一致 + 渲染非白像素合理')
const DEC = [
  { f: 'dec-owner-only-r4.pdf', ref: srcRef, refRender: rSrcPlain, label: 'owner-only(空用户口令)' },
  { f: 'dec-classic-xref-aes128.pdf', ref: srcRef, refRender: rSrcPlain, label: '经典xref AES-128' },
  { f: 'dec-classic-xref-rc4.pdf', ref: srcRef, refRender: rSrcPlain, label: '经典xref RC4-128' },
  { f: 'dec-incremental-aes128.pdf', ref: srcRef, refRender: rSrcPlain, label: '增量/Prev' },
  { f: 'dec-real-large-aes128.pdf', ref: realRef, refRender: rRealPlain, label: '真实大文件 AES' },
  { f: 'dec-real-large-rc4.pdf', ref: realRef, refRender: rRealPlain, label: '真实大文件 RC4' },
  { f: 'dec-long-pwd-aes128.pdf', ref: srcRef, refRender: rSrcPlain, label: '40字超长口令' }
]
for (const d of DEC) {
  const p = join(WORK, d.f)
  try {
    const { text, pages } = await extractText(readFileSync(p))
    const textOk = text === d.ref.text && pages === d.ref.pages
    check(textOk, `${d.f.padEnd(30)} ${pages}页/${text.length}字 文本${text === d.ref.text ? '一致' : '★不一致★'} ${d.label}`)
    if (!textOk) {
      // 找第一个差异位置
      let i = 0
      while (i < Math.min(text.length, d.ref.text.length) && text[i] === d.ref.text[i]) i++
      console.log(`       首个差异 @${i}: 期望 ${JSON.stringify(d.ref.text.slice(i, i + 30))} 实际 ${JSON.stringify(text.slice(i, i + 30))}`)
    }
    const r = await renderPage1(readFileSync(p))
    const dp = diffPixels(r, d.refRender)
    const coverageOk = r.coveragePct > 0.3
    check(coverageOk, `${d.f.padEnd(30)} 渲染非白 ${r.coveragePct}% (${r.nonWhite}/${r.total}px) 均亮 ${r.avgLuma}`)
    console.log(`       与参照渲染逐像素: 完全相同 ${dp.same}%  平均通道差 ${dp.mad}  ${dp.dims || ''}`)
  } catch (e) {
    check(false, `${d.f} 失败: ${String(e).slice(0, 120)}`)
  }
}

// ---- 加密产物：文本 + 口令 + 渲染 ----
console.log('\n[2] 加密产物（AES-128）→ 带口令文本一致、渲染正常、无口令抛 PasswordException')
for (const [name, ref, refRender, pw] of [
  ['enc-source.pdf', srcRef, rSrcPlain, USER],
  ['enc-real.pdf', realRef, rRealPlain, USER],
  ['enc-longpwd.pdf', srcRef, rSrcPlain, 'A'.repeat(40)]
]) {
  const bytes = readFileSync(join(WORK, name))
  try {
    const { text, pages } = await extractText(bytes, pw)
    check(text === ref.text && pages === ref.pages,
      `${name.padEnd(16)} 带口令 ${pages}页/${text.length}字 文本${text === ref.text ? '一致' : '★不一致★'}`)
    const r = await renderPage1(bytes, pw)
    check(r.coveragePct > 0.3, `${name.padEnd(16)} 带口令渲染非白 ${r.coveragePct}% (${r.nonWhite}/${r.total}px)`)
  } catch (e) {
    check(false, `${name} 带口令失败: ${String(e).slice(0, 120)}`)
  }
  try {
    await extractText(bytes)
    check(false, `${name.padEnd(16)} 无口令竟然读出（应抛 PasswordException）`)
  } catch (e) {
    const isPwd = e && (e.name === 'PasswordException' || /password/i.test(String(e.message)))
    check(isPwd, `${name.padEnd(16)} 无口令抛异常 name=${e && e.name} (${String((e && e.message) || '').slice(0, 40)})`)
  }
}

// ---- 渲染对比：解密产物 vs 原参照，截图留档 ----
console.log('\n[3] 渲染截图落盘（供人工核对）')
try {
  const rDec = await renderPage1(readFileSync(join(WORK, 'dec-real-large-aes128.pdf')))
  const c1 = createCanvas(rDec.w, rDec.h)
  c1.getContext('2d').putImageData(new ImageData(rDec.data, rDec.w, rDec.h), 0, 0)
  writeFileSync(join(WORK, 'render-dec-real-large-p1.png'), c1.encodeSync('png'))
  const c2 = createCanvas(rRealPlain.w, rRealPlain.h)
  c2.getContext('2d').putImageData(new ImageData(rRealPlain.data, rRealPlain.w, rRealPlain.h), 0, 0)
  writeFileSync(join(WORK, 'render-plain-real-large-p1.png'), c2.encodeSync('png'))
  console.log('  已写出 render-dec-real-large-p1.png / render-plain-real-large-p1.png')
} catch (e) {
  console.log('  截图失败: ' + e.message)
}

console.log('\n' + '='.repeat(78))
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed) console.log('  - ' + fails.join('\n  - '))
console.log('='.repeat(78))
process.exit(failed ? 1 : 0)
