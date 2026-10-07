/**
 * P2-4 无头冒烟测试（纯逻辑，不引 electron）
 * 跑法：node --experimental-strip-types tests/smoke-booktypeset.ts
 *
 * 覆盖 bookTypesetCore：
 *   - buildEpubCss：中文排版关键规则、参数生效
 *   - normalizeHexColor / shadeHexColor：色值校验与明暗混色
 *   - coverTitleFontSize：书名字号自适应
 *   - normalizeCoverOptions：兜底与尺寸夹紧
 *   - buildCoverHtml：四模板产出自包含 HTML、HTML 转义防注入
 */
import {
  buildEpubCss,
  buildCoverHtml,
  coverTitleFontSize,
  escapeHtml,
  normalizeCoverOptions,
  normalizeHexColor,
  shadeHexColor
} from '../src/main/bookTypesetCore.ts'
import type { BookCoverTemplate } from '../src/shared/types.ts'

let pass = 0
let fail = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++
  } else {
    fail++
    console.error('  ✗ ' + msg)
  }
}

/* ---- buildEpubCss ---- */

const css = buildEpubCss()
assert(css.startsWith('@charset "UTF-8";'), 'CSS 以 @charset 开头（EPUB 阅读器要求）')
assert(css.includes('text-align: justify'), '正文两端对齐')
assert(css.includes('text-justify: inter-ideograph'), '按表意文字断行')
assert(/p \{[^}]*text-indent: 2em/s.test(css), '段落默认首行缩进两字符')
assert(/h1 \{[^}]*page-break-before: always/s.test(css), '章标题默认另起一页')
assert(css.includes('line-height: 1.8'), '默认行高 1.8')
assert(css.includes('text-emphasis-style: dot'), '中文强调用着重号而非斜体')
assert(css.includes('Noto Serif CJK SC'), '默认衬线中文字体栈')
assert(css.includes('#cover-image'), '含 Pandoc 封面页样式')
assert(css.includes('blockquote p { text-indent: 0; }'), '引文段落取消首行缩进')

const css2 = buildEpubCss({ lineHeight: 2, indent: 0, serif: false, chapterPageBreak: false })
assert(css2.includes('line-height: 2'), '自定义行高生效')
assert(/p \{[^}]*text-indent: 0em/s.test(css2), 'indent=0 时不缩进')
assert(css2.includes('Noto Sans CJK SC'), 'serif=false 切黑体栈')
assert(/h1 \{[^}]*page-break-before: auto/s.test(css2), 'chapterPageBreak=false 不强制分页')
assert(buildEpubCss({ lineHeight: 99 }).includes('line-height: 2.6'), '行高上限被夹紧到 2.6')

/* ---- 色值 ---- */

assert(normalizeHexColor('#1F3A5F') === '#1f3a5f', '六位色值规范化为小写')
assert(normalizeHexColor('#abc') === '#aabbcc', '三位色值扩展为六位')
assert(normalizeHexColor('  #ABC  ') === '#aabbcc', '前后空格被裁剪')
assert(normalizeHexColor('red') === null, '非十六进制返回 null')
assert(normalizeHexColor('#12345') === null, '五位色值非法')
assert(normalizeHexColor(undefined) === null, 'undefined 返回 null')

assert(shadeHexColor('#808080', -1) === '#000000', 'amount=-1 变纯黑')
assert(shadeHexColor('#808080', 1) === '#ffffff', 'amount=1 变纯白')
assert(shadeHexColor('#808080', 0) === '#808080', 'amount=0 保持原色')
assert(/^#[0-9a-f]{6}$/.test(shadeHexColor('bad-color', -0.4)), '非法输入回落默认色且格式合法')

/* ---- 字号自适应 ---- */

const big = coverTitleFontSize('剑', 1200)
const mid = coverTitleFontSize('山海塔防录', 1200)
const small = coverTitleFontSize('一个非常非常长的书名用来测试自适应', 1200)
assert(big > mid && mid > small, '书名越长字号越小')
assert(small >= 18, '极长书名字号仍不小于 18px')
assert(coverTitleFontSize('剑来', 600) < coverTitleFontSize('剑来', 1200), '字号随封面宽度缩放')

/* ---- normalizeCoverOptions ---- */

const n1 = normalizeCoverOptions({ title: '  ' })
assert(n1.title === '未命名作品', '空书名兜底')
assert(n1.width === 1200 && n1.height === 1600, '默认尺寸 1200x1600')
assert(n1.template === 'classic', '默认模板 classic')
assert(n1.accent === '#1f3a5f', '默认主色')

const n2 = normalizeCoverOptions({
  title: 'T',
  width: 99999,
  height: 1,
  template: 'nope' as BookCoverTemplate,
  accent: 'zzz'
})
assert(n2.width === 2400, '超大宽度夹紧到 2400')
assert(n2.height === 400, '过小高度夹紧到 400')
assert(n2.template === 'classic', '非法模板回落 classic')
assert(n2.accent === '#1f3a5f', '非法主色回落默认')

/* ---- buildCoverHtml ---- */

const templates: BookCoverTemplate[] = ['classic', 'minimal', 'gradient', 'ink']
for (const t of templates) {
  const html = buildCoverHtml({ title: '山海塔防', author: '朱', subtitle: '东方玄幻', template: t })
  assert(html.startsWith('<!DOCTYPE html>'), `${t}: 输出完整 HTML 文档`)
  assert(html.includes('lang="zh-CN"'), `${t}: 标注中文语言`)
  assert(html.includes('class="cover"'), `${t}: 含封面根容器`)
  assert(html.includes('山海塔防'), `${t}: 渲染书名`)
  assert(html.includes('东方玄幻'), `${t}: 渲染副标题`)
  assert(!/https?:\/\//.test(html), `${t}: 不含外链资源（离线可渲染）`)
  assert(!html.includes('#3a3torch'), `${t}: 无残留的非法色值`)
}

const noSub = buildCoverHtml({ title: '只有书名' })
assert(!noSub.includes('class="subtitle"'), '无副标题时不输出副标题节点')
assert(!noSub.includes('class="author"'), '无作者时不输出作者节点')

const sized = buildCoverHtml({ title: 'X', width: 800, height: 1000 })
assert(sized.includes('width: 800px'), '自定义宽度进入样式')
assert(sized.includes('height: 1000px'), '自定义高度进入样式')

const evil = buildCoverHtml({ title: '<script>alert(1)</script>', author: 'a"b' })
assert(!evil.includes('<script>alert(1)</script>'), '书名中的标签被转义，不会注入脚本')
assert(evil.includes('&lt;script&gt;'), '转义后以实体形式出现')
assert(evil.includes('a&quot;b'), '双引号被转义')
assert(escapeHtml(`&<>"'`) === '&amp;&lt;&gt;&quot;&#39;', 'escapeHtml 五类字符全覆盖')

/* ---- 结果 ---- */

console.log(`\nP2-4 bookTypesetCore: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
