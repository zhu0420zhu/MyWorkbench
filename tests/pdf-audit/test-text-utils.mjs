/**
 * pdfText.ts 纯逻辑部分的验证（不依赖 DOM 的函数）。
 * renderTextToPng / stampTextAuto 需要 canvas，另在 Electron 探针中验证。
 */
import { isWinAnsiSafe, pickRenderMode, expandPlaceholders } from '../../src/renderer/src/utils/pdfText.ts'

let pass = 0
let fail = 0
function check(label, cond, detail = '') {
  if (cond) {
    pass++
    console.log('  ✅ ' + label + (detail ? '  → ' + detail : ''))
  } else {
    fail++
    console.log('  ❌ ' + label + (detail ? '  → ' + detail : ''))
  }
}

console.log('='.repeat(74))
console.log('pdfText.ts 纯逻辑验证')
console.log('='.repeat(74))

/* ---------- 1. WinAnsi 可编码性判定（决定走矢量还是栅格） ---------- */
console.log('\n[1] isWinAnsiSafe / pickRenderMode')
{
  const cases = [
    ['Watermark', true, 'vector'],
    ['CONFIDENTIAL 2026', true, 'vector'],
    ['Café Résumé', true, 'vector'],          // Latin-1 补充应放行
    ['第 1 页', false, 'raster'],              // 中文必须走栅格
    ['机密 - Confidential', false, 'raster'],
    ['→ 箭头', false, 'raster'],               // 非 Latin 符号
    ['emoji ✅', false, 'raster'],
    ['', true, 'vector'],
    ['line1\nline2', true, 'vector']
  ]
  let allOk = true
  for (const [text, safeExpect, modeExpect] of cases) {
    const safe = isWinAnsiSafe(text)
    const mode = pickRenderMode(text)
    const ok = safe === safeExpect && mode === modeExpect
    if (!ok) allOk = false
    console.log('    ' + (ok ? '✓' : '✗') + ' ' + JSON.stringify(text).padEnd(26) +
      ' WinAnsi安全=' + String(safe).padEnd(5) + ' 路径=' + mode)
  }
  check('全部判定正确', allOk)
  check('中文走栅格路径', pickRenderMode('内部资料') === 'raster')
  check('纯英文走矢量路径（文字可选可检索）', pickRenderMode('DRAFT') === 'vector')
}

/* ---------- 2. 占位符替换 ---------- */
console.log('\n[2] expandPlaceholders')
{
  const d = new Date(2026, 8, 28, 14, 5) // 2026-09-28 14:05
  const cases = [
    ['第 {page} 页', 1, '第 1 页'],
    ['{page} / {total}', 1, '1 / 10'],
    ['{date}', 1, '2026-09-28'],
    ['{time}', 1, '14:05'],
    ['Confidential · {date} · p{page}/{total}', 3, 'Confidential · 2026-09-28 · p3/10'],
    ['{PAGE}/{TOTAL}', 4, '4/10'], // 大小写不敏感
    ['无占位符', 1, '无占位符']
  ]
  let allOk = true
  for (const [tpl, page, expect] of cases) {
    const got = expandPlaceholders(tpl, page, 10, d)
    const ok = got === expect
    if (!ok) allOk = false
    console.log('    ' + (ok ? '✓' : '✗') + ' ' + JSON.stringify(tpl).padEnd(44) + ' → ' + JSON.stringify(got) +
      (ok ? '' : '  期望 ' + JSON.stringify(expect)))
  }
  check('全部替换正确', allOk)
  check('未识别的占位符保持原样', expandPlaceholders('{foo}', 1, 2, d) === '{foo}')
}

console.log('\n' + '='.repeat(74))
console.log('汇总: ' + pass + ' 项通过, ' + fail + ' 项失败')
console.log('='.repeat(74))
process.exit(fail ? 1 : 0)
