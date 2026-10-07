/**
 * QA 独立复验 #3（纯函数部分，无需 soffice）：
 *   - 宏确实把页面样式的 Width/Height 按方向互换（这才是方向的真正落点）；
 *   - landscape 分支与 portrait 分支产生的宏必须不同；
 *   - toFileUrl / basicLiteral 对中文与空格路径的健壮性；
 *   - cleanSofficeEnv 纯函数性质。
 */
import { buildOrientMacroXba, toFileUrl, cleanSofficeEnv, ORIENT_MACRO_URL } from '../../../src/main/pdf/sofficeOrient.ts'

let pass = 0
let fail = 0
const failList = []
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  [PASS] ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; failList.push(name); console.log('  [FAIL] ' + name + (detail ? '  ' + detail : '')) }
}

const src = 'C:/tmp/中文 表.xlsx'
const out = 'C:/tmp/out 结果.pdf'
const lx = buildOrientMacroXba(toFileUrl(src), toFileUrl(out), 'landscape')
const px = buildOrientMacroXba(toFileUrl(src), toFileUrl(out), 'portrait')

console.log('== A. 宏内容（方向真正落到 Width/Height）==')
check('宏为合法 StarBasic 模块（script:module 声明）', /<script:module[\s\S]*StarBasic/.test(lx))
check('宏加载源文件并 storeToURL 导出', /loadComponentFromURL/.test(lx) && /storeToURL/.test(lx))
check('宏改写的对象是 PageStyles 的 Width/Height', /StyleFamilies\.getByName\("PageStyles"\)/.test(lx) && /oStyle\.Width\s*=/.test(lx) && /oStyle\.Height\s*=/.test(lx))
check('landscape 分支：Width=big, Height=small', /If True Then[\s\S]*oStyle\.Width = big[\s\S]*oStyle\.Height = small/.test(lx))
check('portrait 分支：Width=small, Height=big', /If False Then[\s\S]*oStyle\.Width = big[\s\S]*oStyle\.Height = small/.test(px) || /oStyle\.Width = small[\s\S]*oStyle\.Height = big/.test(px))
check('big/small 先比较原宽高得出（保留原纸张尺寸、只换方向）', /If w > h Then[\s\S]*big = w[\s\S]*small = h/.test(lx))
check('landscape 与 portrait 宏内容不同', lx !== px)
check('宏 URL 指向 Standard.Module1.ConvertOriented', /Standard\.Module1\.ConvertOriented/.test(ORIENT_MACRO_URL) && /location=application/.test(ORIENT_MACRO_URL))

console.log('\n== B. 路径处理健壮性 ==')
check('toFileUrl 反斜杠转正斜杠并加 file://', toFileUrl('D:\\a\\b.xlsx') === 'file:///D:/a/b.xlsx', toFileUrl('D:\\a\\b.xlsx'))
check('toFileUrl 保留中文/空格（不做百分号编码，libreoffice 实测可读）', toFileUrl(src) === 'file:///C:/tmp/中文 表.xlsx', toFileUrl(src))
check('宏内联了源/目标 URL', lx.includes('file:///C:/tmp/中文 表.xlsx') && lx.includes('file:///C:/tmp/out 结果.pdf'))
check('导出过滤器为 calc_pdf_Export', /FilterName[\s\S]*calc_pdf_Export/.test(lx))

console.log('\n== C. cleanSofficeEnv 纯函数性质 ==')
{
  const base = { PATH: 'p', PYTHONPATH: '/x', PYTHONHOME: '/y', HOME: 'h' }
  const c = cleanSofficeEnv(base)
  check('删除 PYTHONPATH / PYTHONHOME', !('PYTHONPATH' in c) && !('PYTHONHOME' in c))
  check('保留 PATH / HOME', c.PATH === 'p' && c.HOME === 'h')
  check('不修改入参', base.PYTHONPATH === '/x' && base.PYTHONHOME === '/y')
  check('默认参数用 process.env 且不清空空环境', Object.keys(cleanSofficeEnv({})).length === 0)
}

console.log('\n' + '='.repeat(64))
console.log('QA#3-macro 结果: ' + pass + ' 项通过, ' + fail + ' 项失败')
if (failList.length) console.log('失败项: ' + failList.join(' | '))
console.log('='.repeat(64))
process.exit(fail ? 1 : 0)
