// formatError 轻量测试（node --experimental-strip-types 直接运行）
import { formatError } from '../src/renderer/src/utils/formatError.ts'

let passed = 0
let failed = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log('  ✓ ' + msg)
  } else {
    failed++
    console.log('  ✗ ' + msg)
  }
}

console.log('formatError.test')

assert(formatError(new Error('ENOENT: no such file')) === '文件不存在或已被移动', 'ENOENT → 中文')
assert(formatError(new Error('EACCES permission denied')) === '没有读写权限', 'EACCES → 中文')
assert(formatError(new Error('Invalid PDF document')) === 'PDF 解析失败，文件可能已损坏', 'Invalid PDF → 中文')
assert(formatError(new Error('处理超时')) === '处理超时', '中文原文保留')
assert(formatError(null, '操作失败') === '操作失败', '空值回退')
assert(formatError(new Error(''), '兜底') === '兜底', '空消息回退')

const long = new Error('x'.repeat(300))
assert(formatError(long).endsWith('…') && formatError(long).length <= 121, '超长截断')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
