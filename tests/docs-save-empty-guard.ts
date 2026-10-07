/**
 * 「另存为」空内容守卫验收：逐条打印 isEffectivelyEmptyContent 的真实返回值。
 *
 * 运行：
 *   node --experimental-strip-types tests/docs-save-empty-guard.ts
 *
 * 期望：空串 / 纯空白 / 各种「标签壳」→ true（拦下）；有可见文字 → false（放行）。
 */
import { isEffectivelyEmptyContent, htmlToVisibleText } from '../src/main/docs/emptyContent.ts'

type Src = 'text' | 'html'

const CASES: Array<{ source: Src; content: string; expect: boolean; note: string }> = [
  { source: 'text', content: '', expect: true, note: '空串' },
  { source: 'text', content: '   ', expect: true, note: '纯空格' },
  { source: 'text', content: '\n\t', expect: true, note: '换行+制表符' },
  { source: 'html', content: '', expect: true, note: '空串' },
  { source: 'html', content: '   ', expect: true, note: '纯空格' },
  { source: 'html', content: '\n\t', expect: true, note: '换行+制表符' },
  { source: 'html', content: '<p><br></p>', expect: true, note: '标签壳：p+br' },
  { source: 'html', content: '<br>', expect: true, note: '标签壳：单个 br' },
  { source: 'html', content: '<div>&nbsp;</div>', expect: true, note: '标签壳：nbsp' },
  { source: 'html', content: '<p>  </p>', expect: true, note: '标签壳：空格' },
  { source: 'html', content: '<p>&#160;</p>', expect: true, note: '标签壳：数字实体 160' },
  { source: 'html', content: '<style>p{color:red}</style>', expect: true, note: '仅 style 段' },
  { source: 'html', content: '<script>var a=1;\nconsole.log(a)</script>', expect: true, note: '仅 script 段' },
  { source: 'html', content: '<!-- 只是一段注释 -->', expect: true, note: '仅注释' },
  { source: 'html', content: '<p><br/></p><p>&nbsp;&nbsp;</p>', expect: true, note: '标签壳：br 自闭合 + 多个 nbsp' },
  { source: 'html', content: '<p>&ensp;&emsp;&thinsp;</p>', expect: true, note: '标签壳：其余空白类命名实体' },
  { source: 'html', content: '<p>&#8194;</p>', expect: true, note: '标签壳：数字实体 ensp(8194)' },
  { source: 'text', content: '\u00a0\u3000', expect: true, note: '纯文本：NBSP + 全角空格' },
  { source: 'html', content: '<p>正文</p>', expect: false, note: '有中文正文' },
  { source: 'html', content: '正常文字', expect: false, note: '裸文本' },
  { source: 'html', content: '<p>中文&nbsp;正文</p>', expect: false, note: '实体夹在文字中' },
  { source: 'html', content: '<p>&amp;</p>', expect: false, note: '转义实体本身是可见字符 &' },
  { source: 'html', content: '<p>&lt;tag&gt;</p>', expect: false, note: '转义后的尖括号是可见字符' },
  { source: 'html', content: '<style>p{color:red}</style><p>正文</p>', expect: false, note: 'style 之外仍有正文' },
  { source: 'html', content: '<script>var a=1</script>正文', expect: false, note: 'script 之外仍有正文' },
  { source: 'text', content: '\r\n', expect: true, note: '纯文本：CRLF' }
]

let pass = 0
let fail = 0
for (const c of CASES) {
  const actual = isEffectivelyEmptyContent(c.source, c.content)
  const ok = actual === c.expect
  if (ok) pass++
  else fail++
  const shown = JSON.stringify(c.content)
  const visible = c.source === 'html' ? JSON.stringify(htmlToVisibleText(c.content)) : '-'
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  [${c.source}] ${shown.padEnd(28)} 期望=${c.expect} 实际=${actual}  可见文本=${visible}  // ${c.note}`
  )
}

console.log(`\n合计 ${CASES.length} 条：pass=${pass} fail=${fail}`)
process.exitCode = fail === 0 ? 0 : 1
