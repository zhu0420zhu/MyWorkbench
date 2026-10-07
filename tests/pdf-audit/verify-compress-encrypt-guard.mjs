/**
 * 验收：压缩面板的「受保护源文件」闸门（structure + raster 两个模式）。
 *
 * 背景（真实数据安全事故）：旧实现压缩加密 PDF 时没有任何提示，而后果因模式而异
 * （下列均为本脚本实测结论）：
 *   - 结构压缩：/Encrypt 被丢掉，且内容流仍是**密文**（我们没有口令、解不开）→
 *     产出一份「不需要口令、但文本 0 字」的损坏文件；
 *   - 图像化压缩：渲染由 pdf.js 解密（只对「无口令即可打开」的文件成立）→
 *     产出一份能正常显示、但**没有任何保护**的副本。
 *
 * 本脚本直接驱动生产模块，按 CompressPanel.run() 的真实顺序
 * （read → 闸门 → 按模式压缩 → 写盘）复刻决策链路，打印三态证据：
 *   (a) 警示 / 确认路径确被触发（confirm 只调一次，带算法信息）
 *   (b) 取消时零写入（write 未调用、目录零新文件、压缩甚至未执行）
 *   (c) 确认后产出确实不再需要口令（pdf.js 不传口令即可打开），且如实记录产出可用性
 *
 * 两个模式都是**真实链路**：结构压缩用生产 structureCompressPdf；图像化压缩用生产
 * rasterCompressPdf，仅把渲染函数换成 pdf.js + @napi-rs/canvas 的等价实现
 * （浏览器里是 Chromium canvas，见 pdfRender.renderPdfPages）。
 *
 * 运行：
 *   NODE_OPTIONS="" node --experimental-loader=./tests/loader.mjs \
 *     --experimental-strip-types tests/pdf-audit/verify-compress-encrypt-guard.mjs
 */
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import {
  detectEncryption,
  describeProtectedOutcome,
  describeProtection,
  guardProtectedSource
} from '../../src/renderer/src/utils/pdfCompressGuard.ts'
import { structureCompressPdf, keepSmallerOutput } from '../../src/renderer/src/utils/pdfCompress.ts'
import { rasterCompressPdf } from '../../src/renderer/src/utils/pdfRasterCompress.ts'
import { encryptPdf, isPdfEncrypted } from '../../src/renderer/src/utils/pdfSecurity.ts'
import {
  nodeRender,
  noiseJpeg,
  openWithPdfjs,
  renderInkCount,
  installCanvasShim
} from './lib/node-render-backend.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIX = join(HERE, 'fixtures')
const QA = join(HERE, 'qa-fixtures')
const WORK = join(HERE, 'work', 'guard-out')
const USER_PWD = 'LingmoAuditPass123'

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail) {
  if (cond) {
    pass++
    console.log('  [PASS] ' + name + (detail ? '  ' + detail : ''))
  } else {
    fail++
    failures.push(name)
    console.log('  [FAIL] ' + name + (detail ? '  ' + detail : ''))
  }
}
function section(t) {
  console.log('\n' + '='.repeat(78))
  console.log(t)
  console.log('='.repeat(78))
}

/**
 * 复刻 CompressPanel.run() 的决策顺序（去掉 React 部分）。
 *
 * 闸门调用**位于模式分支之前**，`produce` 才区分结构 / 图像化 —— 这正是
 * 「两个模式都覆盖」的实现依据（F 节另有源码顺序断言）。
 * 取消时直接 return：既不 produce，也不 write。
 */
async function runPanelLike({ bytes, answer, produce, outName }) {
  const confirmCalls = []
  const produceCalls = []
  const writes = []
  const decision = await guardProtectedSource({
    bytes,
    confirm: async (v) => {
      confirmCalls.push({
        encrypted: v.encrypted,
        text: describeProtection(v),
        alg: v.info?.algorithm ?? null,
        structureOutcome: describeProtectedOutcome('structure', v).consequence,
        rasterOutcome: describeProtectedOutcome('raster', v).consequence
      })
      return answer
    }
  })
  if (decision === 'canceled') return { decision, confirmCalls, produceCalls, writes }
  const produced = await produce(bytes)
  produceCalls.push('produced')
  if (produced.bytes == null || produced.keptOriginal) return { decision, confirmCalls, produceCalls, writes }
  await mkdir(WORK, { recursive: true })
  await writeFile(join(WORK, outName), produced.bytes)
  writes.push(outName)
  return { decision, confirmCalls, produceCalls, writes }
}

/** 生产管线：结构压缩 / 图像化压缩（真实实现，仅渲染后端替换） */
const producers = {
  structure: (bytes, level) => structureCompressPdf(bytes, level),
  raster: (bytes, level) => rasterCompressPdf(bytes, level, nodeRender)
}

/**
 * 现造「图像主导 + 空用户口令」的加密素材：
 * pdf.js 不给口令就能解密渲染、pdf-lib 又能读出页树 —— 正是旧实现会**静默**
 * 产出无保护副本的那一类（qa-fixtures/owner-only-r4.pdf 属同类，但它被 ObjStm
 * 加密，pdf-lib 读不出页树，图像化路径会先如实抛错、盖住这个风险）。
 */
async function buildProtectedImagePdf() {
  const base = await PDFDocument.create()
  const jpg = await base.embedJpg(noiseJpeg(1600, 1100, 90))
  const page = base.addPage([595, 842])
  page.drawImage(jpg, { x: 0, y: 0, width: 595, height: 842 })
  const plainBytes = await base.save()
  return { bytes: await encryptPdf(plainBytes, { userPassword: '' }), plainBytes }
}

installCanvasShim()

/* ══════════════════════════════════════════════════════════════════════ */
section('A. 未加密文件：不得打扰用户（confirm 零调用）')
{
  const plain = await readFile(join(QA, 'real-large-plain.pdf'))
  const v = await detectEncryption(plain)
  check('real-large-plain.pdf 判定为未加密', v.encrypted === false, 'encrypted=' + v.encrypted)
  let calls = 0
  const d = await guardProtectedSource({ bytes: plain, confirm: async () => (calls++, true) })
  check('未加密直接放行', d === 'proceed', d)
  check('未加密不弹确认框', calls === 0, 'confirm 调用 ' + calls + ' 次')
  check('未加密不产生警示文案', describeProtection(v) === '' && describeProtectedOutcome('structure', v).consequence === '')
}

/* ══════════════════════════════════════════════════════════════════════ */
section('B. 加密素材：判定 + 警示文案（真素材，全部实测）')
const ENCRYPTED = [
  ['fixtures/encrypted/aes128-r4.pdf', join(FIX, 'encrypted', 'aes128-r4.pdf'), true],
  ['fixtures/encrypted/aes256-r6.pdf', join(FIX, 'encrypted', 'aes256-r6.pdf'), true],
  ['fixtures/encrypted/rc4-40-r2.pdf', join(FIX, 'encrypted', 'rc4-40-r2.pdf'), true],
  ['qa-fixtures/real-large-aes128.pdf', join(QA, 'real-large-aes128.pdf'), true],
  ['qa-fixtures/classic-xref-aes128.pdf', join(QA, 'classic-xref-aes128.pdf'), true],
  ['qa-fixtures/incremental-aes128.pdf', join(QA, 'incremental-aes128.pdf'), true],
  // 用户口令为空：不给口令也能打开 → 图像化路径能跑通，旧实现会静默产出无保护副本
  ['qa-fixtures/owner-only-r4.pdf', join(QA, 'owner-only-r4.pdf'), false]
]
const encBytes = {}
for (const [label, path, needPwd] of ENCRYPTED) {
  const bytes = await readFile(path)
  encBytes[label] = bytes
  const v = await detectEncryption(bytes)
  const text = describeProtection(v)
  check(label + ' 判定为加密', v.encrypted === true, 'encrypted=' + v.encrypted)
  check(
    label + ' 警示文案给出算法信息',
    /密码保护/.test(text) && text.length > '该文件受密码保护。'.length,
    JSON.stringify(text)
  )
  let needsPwd = false
  try {
    await openWithPdfjs(bytes)
  } catch (e) {
    needsPwd = e && (e.name === 'PasswordException' || /password/i.test(String(e.message)))
  }
  check(
    label + ' 源文件保护状态（不传口令）',
    needsPwd === needPwd,
    needsPwd ? '抛 PasswordException（确实需要口令）' : '空口令即可打开 → 旧实现会静默产出无保护副本'
  )
  if (needPwd) {
    const withPwd = await openWithPdfjs(bytes, USER_PWD)
    check(label + ' 带正确口令可在 pdf.js 打开（素材有效）', withPwd.pages > 0, withPwd.pages + ' 页')
  }
}

/* ══════════════════════════════════════════════════════════════════════ */
section('C.(a) 警示 / 确认路径确被触发')
{
  // C1：加密源 → confirm 被调用，且带算法信息 + 分模式后果
  for (const mode of ['structure', 'raster']) {
    const label = 'qa-fixtures/real-large-aes128.pdf'
    const r = await runPanelLike({
      bytes: encBytes[label],
      answer: false,
      produce: async () => {
        throw new Error('不应执行')
      },
      outName: 'never.pdf'
    })
    check('[' + mode + '] 加密源 → confirm 恰好调用 1 次', r.confirmCalls.length === 1, '实际 ' + r.confirmCalls.length + ' 次')
    check('[' + mode + '] confirm 收到 encrypted=true', r.confirmCalls[0]?.encrypted === true, String(r.confirmCalls[0]?.encrypted))
    check('[' + mode + '] 文案含「密码保护」+ 算法', /密码保护/.test(r.confirmCalls[0]?.text ?? ''), JSON.stringify(r.confirmCalls[0]?.text))
    console.log('      → 保护信息: ' + JSON.stringify(r.confirmCalls[0]?.text))
    console.log('      → 结构模式后果: ' + r.confirmCalls[0]?.structureOutcome)
    console.log('      → 图像模式后果: ' + r.confirmCalls[0]?.rasterOutcome)
  }
  // C2：两模式后果文案必须不同（同一句话糊两个模式 = 文案与实际不符）
  {
    const v = await detectEncryption(encBytes['qa-fixtures/real-large-aes128.pdf'])
    const s = describeProtectedOutcome('structure', v)
    const r = describeProtectedOutcome('raster', v)
    check('两种模式的后果文案确实不同', s.consequence !== r.consequence)
    check(
      '结构模式文案如实说明产出内容不可用（含「0 字」）',
      /0 字/.test(s.consequence) && /无法/.test(s.consequence),
      JSON.stringify(s.consequence.slice(0, 60) + '…')
    )
    check('图像模式文案说明副本不再需要口令', /不再需要任何口令/.test(r.consequence))
    check('两模式都给出「先解密再压缩」等可行建议', s.advice.length > 0 && r.advice.length > 0)
  }
  // C3：小加密样本结构压缩会解析失败 → 必须如实抛错且不写文件
  await rm(WORK, { recursive: true, force: true })
  await mkdir(WORK, { recursive: true })
  let threw = null
  try {
    await structureCompressPdf(encBytes['fixtures/encrypted/aes128-r4.pdf'], 'medium')
  } catch (e) {
    threw = e
  }
  const left = (await readdir(WORK)).length
  check('小加密样本结构压缩如实抛错（不静默产出）', !!threw, threw ? String(threw.message).slice(0, 64) : '未抛错')
  check('抛错路径未写任何文件', left === 0, '目录内文件数 ' + left)
}

/* ══════════════════════════════════════════════════════════════════════ */
section('D.(b) 取消 → 零写入（两个模式分别取证，走真实生产管线）')
{
  const label = 'qa-fixtures/real-large-aes128.pdf'
  const bytes = encBytes[label]

  for (const mode of ['structure', 'raster']) {
    await rm(WORK, { recursive: true, force: true })
    await mkdir(WORK, { recursive: true })
    const before = (await readdir(WORK)).length
    let calls = 0
    const r = await runPanelLike({
      bytes,
      answer: false,
      produce: async (b) => {
        calls++
        return producers[mode](b, 'medium')
      },
      outName: mode + '.pdf'
    })
    const after = (await readdir(WORK)).length
    check('[' + mode + '] 取消 → decision=canceled', r.decision === 'canceled', r.decision)
    check('[' + mode + '] 取消 → 未写文件（writes 空）', r.writes.length === 0, JSON.stringify(r.writes))
    check('[' + mode + '] 取消 → 目录零新增文件', after === before, before + ' → ' + after)
    check('[' + mode + '] 取消 → 连压缩都没执行', calls === 0, 'produce 调用 ' + calls + ' 次')
  }
  // 对照：目录本身可写（排除「目录不可写导致的假零写入」）
  await writeFile(join(WORK, 'sanity.txt'), 'ok')
  check('对照：该目录本身可写（零写入不是权限造成的假象）', existsSync(join(WORK, 'sanity.txt')))
  await rm(WORK, { recursive: true, force: true })
}

/* ══════════════════════════════════════════════════════════════════════ */
section('E.(c) 确认后的产出：确实不再需要口令（两个模式分别实测）')
{
  await mkdir(WORK, { recursive: true })

  /* E1 —— 结构压缩 + 需要用户口令的加密文件 */
  {
    const path = join(QA, 'real-large-aes128.pdf')
    const bytes = encBytes['qa-fixtures/real-large-aes128.pdf']
    const src = await openWithPdfjs(bytes, USER_PWD)
    const r = await runPanelLike({
      bytes,
      answer: true,
      produce: (b) => producers.structure(b, 'medium'),
      outName: 'structure-min.pdf'
    })
    check('[structure] 确认 → 写出 1 个文件', r.writes.length === 1, JSON.stringify(r.writes))
    const out = await readFile(join(WORK, 'structure-min.pdf'))
    console.log('      源 ' + bytes.byteLength + ' B → 产出 ' + out.byteLength + ' B（' + src.pages + ' 页）')
    check('[structure] 产出不再带加密标记', (await isPdfEncrypted(out)) === false)
    let opened = null
    try {
      opened = await openWithPdfjs(out) // 关键：不传口令
    } catch {
      /* 下面断言会报 */
    }
    check('[structure] 产出不传口令即可打开', !!opened, opened ? '无需口令' : '打开失败')
    check('[structure] 产出页数与源一致', !!opened && opened.pages === src.pages, (opened?.pages ?? '?') + ' = ' + src.pages)
    check(
      '[structure] 产出文本 0 字（与警示文案「内容不可用」一致）',
      !!opened && opened.text.length === 0,
      (opened?.text.length ?? '?') + ' 字（源 ' + src.text.length + ' 字）'
    )
    const ink = await renderInkCount(out)
    check('[structure] 产出页面确实画不出内容（非白像素占比极低）', ink.ink / ink.total < 0.01, ink.ink + '/' + ink.total)
  }

  /* E2 —— 图像化压缩 + 空用户口令的加密文件（真实渲染路径）
   *
   * 为什么素材要自造：图像化路径先要 pdf-lib 读出页数、再由 pdf.js 渲染。
   *   - fixtures/encrypted/*（ObjStm 加密）→ pdf-lib 读不了页树 → 如实抛错（不是静默脱保护）；
   *   - qa-fixtures/*-aes128.pdf（需用户口令）→ pdf.js 渲染阶段抛 PasswordException → 也如实失败；
   *   - owner-only 类（空用户口令）才是**静默脱保护**的那一类。
   * 这里用生产 encryptPdf 现造一个「空用户口令」素材：pdf.js 不给口令就能解密渲染，
   * 而 pdf-lib 又能读出页树 —— 正是旧实现会悄悄产出无保护副本的场景。
   */
  {
    const path = join(WORK, 'raster-src.pdf')
    await mkdir(WORK, { recursive: true })
    const { bytes, plainBytes } = await buildProtectedImagePdf()
    await writeFile(path, bytes)
    console.log('      素材：图像主导 1 页，明文 ' + plainBytes.byteLength + ' B → 加密后 ' + bytes.byteLength + ' B')

    check('[raster] 自造素材确实带加密标记', (await isPdfEncrypted(bytes)) === true)
    check('[raster] 自造素材被判定为加密（闸门会拦）', (await detectEncryption(bytes)).encrypted === true)
    const libRead = await PDFDocument.load(bytes, { ignoreEncryption: true })
    check('[raster] 自造素材 pdf-lib 可读出页数（能走到渲染）', libRead.getPageCount() === 1, libRead.getPageCount() + ' 页')

    const src = await openWithPdfjs(bytes) // 不传口令
    const srcInk = await renderInkCount(bytes)
    console.log('      源：' + src.pages + ' 页，无口令可打开，第 1 页非白像素 ' + srcInk.ink + '/' + srcInk.total)
    check('[raster] 源文件渲染确实解出了内容（非白像素 > 0）', srcInk.ink > 0)

    const r = await runPanelLike({
      bytes,
      answer: true,
      produce: (b) => producers.raster(b, 'high'),
      outName: 'raster-min.pdf'
    })
    check('[raster] 确认 → 写出 1 个文件', r.writes.length === 1, JSON.stringify(r.writes))
    const out = await readFile(join(WORK, 'raster-min.pdf'))
    console.log('      源 ' + bytes.byteLength + ' B → 产出 ' + out.byteLength + ' B')
    check('[raster] 产出不再带加密标记', (await isPdfEncrypted(out)) === false)
    let opened = null
    try {
      opened = await openWithPdfjs(out)
    } catch {
      /* 下面断言会报 */
    }
    check('[raster] 产出不传口令即可打开（保护已丢失）', !!opened, opened ? '无需口令' : '打开失败')
    check('[raster] 产出页数与源一致', !!opened && opened.pages === src.pages, (opened?.pages ?? '?') + ' = ' + src.pages)
    check('[raster] 产出文本 0 字（栅格化后无文字层，属预期）', !!opened && opened.text.length === 0, (opened?.text.length ?? '?') + ' 字')
    const outInk = await renderInkCount(out)
    check('[raster] 产出内容可见（非白像素与源同量级）', outInk.ink > 0 && outInk.ink >= srcInk.ink * 0.3, outInk.ink + ' vs 源 ' + srcInk.ink)

    // 对照：需要用户口令的素材，图像化路径会如实失败（不会静默产出）
    let rasterThrew = null
    try {
      await producers.raster(encBytes['qa-fixtures/real-large-aes128.pdf'], 'high')
    } catch (e) {
      rasterThrew = e
    }
    check(
      '[raster] 需用户口令的素材 → 渲染阶段如实失败（不静默产出）',
      !!rasterThrew,
      rasterThrew ? String(rasterThrew.name || rasterThrew.message).slice(0, 60) : '未抛错'
    )
  }

  /* E3 —— 兜底政策：产出不得大于原文件（两模式共用同一实现） */
  {
    const bytes = encBytes['qa-fixtures/real-large-aes128.pdf']
    const bigger = new Uint8Array(bytes.byteLength + 10)
    const p1 = keepSmallerOutput(bytes, bigger)
    check('兜底：产出更大时返回原文件', p1.keptOriginal === true && p1.bytes.byteLength === bytes.byteLength)
    const smaller = bytes.slice(0, 1000)
    const p2 = keepSmallerOutput(bytes, smaller)
    check('兜底：产出更小时采用产出', p2.keptOriginal === false && p2.bytes === smaller)
    // 结构压缩与图像化压缩都 import 自同一处（避免两处政策分叉）
    const srcCompress = await readFile(join(HERE, '..', '..', 'src', 'renderer', 'src', 'utils', 'pdfCompress.ts'), 'utf8')
    const srcRaster = await readFile(join(HERE, '..', '..', 'src', 'renderer', 'src', 'utils', 'pdfRasterCompress.ts'), 'utf8')
    check(
      '两模式的兜底来自同一处实现（keepSmallerOutput）',
      /export function keepSmallerOutput/.test(srcCompress) && /keepSmallerOutput/.test(srcRaster)
    )
  }
  await rm(WORK, { recursive: true, force: true })
}

/* ══════════════════════════════════════════════════════════════════════ */
section('F. 模式覆盖：图像化路径同样在闸门之后')
{
  const src = await readFile(join(HERE, '..', '..', 'src', 'renderer', 'src', 'pages', 'PdfTools.tsx'), 'utf8')
  const gi = src.indexOf('guardProtectedSource({')
  const mi = src.indexOf("if (mode === 'raster')")
  const cancelIdx = src.indexOf("if (decision === 'canceled')")
  check('源码中 guardProtectedSource 出现', gi > 0, 'offset ' + gi)
  check('闸门位于模式分支之前（两模式共用同一处确认）', gi > 0 && mi > gi, 'guard@' + gi + ' < modeBranch@' + mi)
  check('闸门取消即 return（return 位于模式分支之前）', cancelIdx > 0 && cancelIdx < mi, 'cancel-return@' + cancelIdx + ' < modeBranch@' + mi)
  // 面板文案确实按模式取（不是写死一句话）
  check('面板按模式取后果文案', /describeProtectedOutcome\(mode, v\)/.test(src) || /describeProtectedOutcome\(mode, verdict\)/.test(src))

  // owner-only-r4：无口令即可渲染 → 图像化模式本可跑通 → 旧实现必然静默脱保护
  const ownerOnly = encBytes['qa-fixtures/owner-only-r4.pdf']
  const opened = await openWithPdfjs(ownerOnly).catch(() => null)
  check('owner-only-r4.pdf 无口令即可渲染（图像化路径可跑通）', !!opened, opened ? opened.pages + ' 页' : '打开失败')
  check('同一文件仍被判定为加密 → 图像化模式也会被闸门拦住', (await detectEncryption(ownerOnly)).encrypted === true)
}

console.log('\n' + '='.repeat(78))
console.log(`结果: ${pass} 项通过, ${fail} 项失败`)
if (fail) console.log('  失败项:\n   - ' + failures.join('\n   - '))
console.log('='.repeat(78))
process.exit(fail ? 1 : 0)
