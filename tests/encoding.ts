/* 灵墨工作台 · 编码检测/解码无头测试
 * 运行：node --experimental-strip-types tests/encoding.ts
 */
import { detectEncoding, decodeBytes, encodingLabel, SUPPORTED_ENCODINGS } from '../src/renderer/src/utils/encoding.ts'

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

// UTF-8 正确识别
const utf8 = new TextEncoder().encode('月份,销售额\n1月,120\n')
assert(detectEncoding(utf8) === 'utf-8', `expected utf-8, got ${detectEncoding(utf8)}`)
assert(decodeBytes(utf8, 'auto') === '月份,销售额\n1月,120\n', 'UTF-8 decode failed')

// GBK/GB18030：手工构造 GBK 字节，确保 UTF-8 fatal 失败后能被识别为中文编码
// "中"=D6D0, "文"=CEC4, ","=2C, "\n"=0A
const gbkBytes = new Uint8Array([0xd6, 0xd0, 0x2c, 0xce, 0xc4, 0x0a])
const detectedGbk = detectEncoding(gbkBytes)
assert(detectedGbk === 'gbk', `expected gbk, got ${detectedGbk}`)
assert(decodeBytes(gbkBytes, 'auto') === '中,文\n', `auto decode failed: ${decodeBytes(gbkBytes, 'auto')}`)
assert(decodeBytes(gbkBytes, 'gbk') === '中,文\n', `gbk decode failed`)

// 非 UTF-8 回退：包含 0x00 会阻断任何多字节编码，确保不会错误识别为 UTF-8
const broken = new Uint8Array([0xd6, 0x00, 0x82])
assert(detectEncoding(broken) !== 'utf-8', 'broken bytes should not be detected as utf-8')
assert(typeof decodeBytes(broken, 'auto') === 'string', 'auto decode should not throw')

// 手动指定编码覆盖自动识别
assert(decodeBytes(gbkBytes, 'utf-8') !== '中,文\n', 'manual utf-8 should not produce Chinese chars from gbk bytes')
assert(decodeBytes(utf8, 'gbk') !== '月份,销售额\n', 'manual gbk should not be used for utf-8 bytes')

// 工具函数
assert(encodingLabel('utf-8') === 'UTF-8', 'encodingLabel failed')
assert(encodingLabel('gbk') === 'GBK', 'encodingLabel failed')
assert(SUPPORTED_ENCODINGS.some((e) => e.value === 'auto'), 'missing auto option')

console.log('encoding tests passed')
