/* 首字母拼音：纯逻辑回归校验（node --experimental-strip-types 直跑，无 electron 依赖） */
import { firstLetterPinyin } from '../src/renderer/src/utils/textTools.ts'

let failed = 0
function eq(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    console.error(`✗ ${label}\n    期望: ${JSON.stringify(expected)}\n    实际: ${JSON.stringify(actual)}`)
    failed++
  } else {
    console.log(`✓ ${label}`)
  }
}

eq(firstLetterPinyin('赵钱孙李'), 'z q s l', '基础汉字逐字首字母')
eq(firstLetterPinyin('灵墨工作台'), 'l m g z t', '四字词组')
eq(firstLetterPinyin('Hello World'), 'Hello World', '纯英文按连续片段原样保留')
eq(firstLetterPinyin('我爱AI'), 'w a AI', '中英混排：中文取首字母、英文保留')
eq(firstLetterPinyin('重庆'), 'c q', '多音字取默认读音首字母')
eq(firstLetterPinyin('   '), '', '纯空白返回空串')
eq(firstLetterPinyin(''), '', '空串返回空串')

if (failed > 0) {
  console.error(`\n首字母拼音校验失败：${failed} 项`)
  process.exit(1)
}
console.log('\n首字母拼音校验全部通过（7/7）')
