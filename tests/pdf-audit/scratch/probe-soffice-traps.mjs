/**
 * 负向对照实验：验证 HTML→PDF 通道里三个「坑」是否属实。
 *  A. 正向基准（正斜杠路径 + 清 PYTHONPATH + stdio[0]=ignore）
 *  B. 反斜杠路径 → 是否报 "source file could not be loaded"
 *  C. 不清 PYTHONPATH → 是否静默失败
 *  D. 二进制当 utf-8 字符串写 → PDF 是否被破坏（证明必须 Buffer 写）
 *
 * 运行：node tests/pdf-audit/scratch/probe-soffice-traps.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const work = join(here, 'qa-work', 'traps')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const SOFFICE = String.raw`D:\YM\MyWorkbench\resources\tools\soffice\program\soffice.com`
const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>坑验证</title></head><body><h1>灵墨工作台 中文渲染检查</h1><p>这是一段<strong>加粗中文</strong>。</p><ul><li>项目一</li><li>项目二</li></ul></body></html>`

function cleanEnv(env) {
  const e = { ...env }
  delete e.PYTHONPATH
  delete e.PYTHONHOME
  return e
}

function runSoffice(args, env, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let done = false
    let out = ''
    let err = ''
    const child = spawn(SOFFICE, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env })
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      resolve({ code: 'timeout', out, err })
    }, timeoutMs)
    child.stdout?.on('data', (d) => (out += d.toString()))
    child.stderr?.on('data', (d) => (err += d.toString()))
    child.on('error', (e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code: 'spawn-error', out, err: e.message })
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, out, err })
    })
  })
}

function report(tag, caseDir, res) {
  const pdf = join(caseDir, 'out', 'doc.pdf')
  const exists = existsSync(pdf)
  const size = exists ? readFileSync(pdf).byteLength : 0
  const head = exists ? readFileSync(pdf).subarray(0, 5).toString('latin1') : '(无产出)'
  console.log(`\n--- ${tag} ---`)
  console.log('args       :', JSON.stringify(res.args))
  console.log('退出码     :', res.code)
  console.log('stdout     :', JSON.stringify(res.out.trim().slice(-300)))
  console.log('stderr     :', JSON.stringify(res.err.trim().slice(-300)))
  console.log('产出存在   :', exists, ' 字节数:', size, ' 文件头:', JSON.stringify(head))
  return { exists, size, head }
}

const results = {}

// ---- A 正向基准：正斜杠路径 + 清 PYTHONPATH ----
const dirA = join(work, 'caseA')
mkdirSync(join(dirA, 'out'), { recursive: true })
writeFileSync(join(dirA, 'doc.html'), HTML, 'utf-8')
const argsA = [
  '--headless', '--norestore', '--convert-to', 'pdf',
  '--outdir', join(dirA, 'out').replace(/\\/g, '/'),
  join(dirA, 'doc.html').replace(/\\/g, '/')
]
const resA = { ...(await runSoffice(argsA, cleanEnv(process.env))), args: argsA }
results.A = report('A 正向（正斜杠 + 清环境）', dirA, resA)

// ---- B 负向：反斜杠路径（无空格） ----
const dirB = join(work, 'caseB')
mkdirSync(join(dirB, 'out'), { recursive: true })
writeFileSync(join(dirB, 'doc.html'), HTML, 'utf-8')
const argsB = [
  '--headless', '--norestore', '--convert-to', 'pdf',
  '--outdir', join(dirB, 'out'),
  join(dirB, 'doc.html')
]
const resB = { ...(await runSoffice(argsB, cleanEnv(process.env))), args: argsB }
results.B = report('B 负向（反斜杠路径，无空格）', dirB, resB)

// ---- B2/B3 矩阵：路径带空格时，反斜杠 / 正斜杠 各一次 ----
const spaceRoot = join(work, 'qa work 带 空格')
const dirB2 = join(spaceRoot, 'caseB2_backslash')
mkdirSync(join(dirB2, 'out'), { recursive: true })
writeFileSync(join(dirB2, 'doc.html'), HTML, 'utf-8')
const argsB2 = [
  '--headless', '--norestore', '--convert-to', 'pdf',
  '--outdir', join(dirB2, 'out'),
  join(dirB2, 'doc.html')
]
const resB2 = { ...(await runSoffice(argsB2, cleanEnv(process.env))), args: argsB2 }
report('B2 反斜杠路径（带空格）', dirB2, resB2)

const dirB3 = join(spaceRoot, 'caseB3_slash')
mkdirSync(join(dirB3, 'out'), { recursive: true })
writeFileSync(join(dirB3, 'doc.html'), HTML, 'utf-8')
const argsB3 = [
  '--headless', '--norestore', '--convert-to', 'pdf',
  '--outdir', join(dirB3, 'out').replace(/\\/g, '/'),
  join(dirB3, 'doc.html').replace(/\\/g, '/')
]
const resB3 = { ...(await runSoffice(argsB3, cleanEnv(process.env))), args: argsB3 }
report('B3 正斜杠路径（带空格）', dirB3, resB3)

// ---- C 负向：不清 PYTHONPATH ----
console.log('\n=== 当前进程 PYTHONPATH ===')
console.log('PYTHONPATH =', JSON.stringify(process.env.PYTHONPATH))
console.log('PYTHONHOME =', JSON.stringify(process.env.PYTHONHOME))
const dirC = join(work, 'caseC')
mkdirSync(join(dirC, 'out'), { recursive: true })
writeFileSync(join(dirC, 'doc.html'), HTML, 'utf-8')
const argsC = [
  '--headless', '--norestore', '--convert-to', 'pdf',
  '--outdir', join(dirC, 'out').replace(/\\/g, '/'),
  join(dirC, 'doc.html').replace(/\\/g, '/')
]
const resC = { ...(await runSoffice(argsC, { ...process.env })), args: argsC }
results.C = report('C 负向（保留 PYTHONPATH）', dirC, resC)

// ---- D 负向：把 PDF 字节当 utf-8 文本写 ----
const bin = readFileSync(join(dirA, 'out', 'doc.pdf'))
const textWritten = join(work, 'as-utf8-text.pdf')
writeFileSync(textWritten, bin.toString('utf-8'), 'utf-8')
const back = readFileSync(textWritten)
console.log('\n--- D 负向（二进制当 utf-8 文本写） ---')
console.log('原始字节数       :', bin.byteLength)
console.log('utf8 文本写回字节:', back.byteLength)
console.log('原始文件头       :', JSON.stringify(bin.subarray(0, 8).toString('latin1')))
console.log('文本写回文件头   :', JSON.stringify(back.subarray(0, 8).toString('latin1')))
let e2 = null
try {
  const { PDFDocument } = await import('pdf-lib')
  await PDFDocument.load(back)
} catch (e) {
  e2 = e.message
}
console.log('pdf-lib 读取文本写回的结果:', e2 ? '失败 → ' + e2.slice(0, 120) : '竟然成功（pdf-lib 容忍）')

// D 的强判据：用 pdfjs 提取文本，对比原文是否还在（结构能读 ≠ 内容没坏）
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
async function extractText(bytes, label) {
  try {
    const d = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise
    const p = await d.getPage(1)
    const c = await p.getTextContent()
    const t = c.items.map((i) => ('str' in i ? i.str : '')).join('')
    try {
      await d.cleanup()
    } catch {
      /* ignore */
    }
    console.log(`${label} 提取文本:`, JSON.stringify(t.slice(0, 120)))
    return t
  } catch (e) {
    console.log(`${label} 提取文本: 抛错 → ${String(e.message).slice(0, 120)}`)
    return null
  }
}
const tOrig = await extractText(bin, '原始 PDF     :')
const tMangled = await extractText(back, 'utf8 文本写回:')
console.log('原文中文是否保留:', /灵墨|加粗|项目/.test(tMangled || ''))
const dBroken = !(tMangled && /灵墨|加粗|项目/.test(tMangled))
console.log('D 判定：文本写回后内容是否损坏 =', dBroken)

console.log('\n=== 汇总 ===')
console.log('A 正向成功      :', results.A.exists && results.A.head === '%PDF-')
console.log('B 反斜杠是否失败:', !results.B.exists)
console.log('C 保环境是否失败:', !results.C.exists)
console.log('D 文本写是否破坏:', dBroken)
console.log('\n产物目录:', work)
