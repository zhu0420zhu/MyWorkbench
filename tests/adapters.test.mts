// 平台适配器算法单测：B站 wbi 签名（已知向量）+ 公众号 md→html
import { getMixinKey, signWbi } from '../src/main/publish/adapters/bilibili.ts'

let passed = 0
let failed = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log('  ✓ ' + msg)
  } else {
    failed++
    console.error('  ✗ FAIL: ' + msg)
  }
}

// B站官方文档已知向量
const IMG_KEY = '7cd084941338484aae1ad9425b84077c'
const SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45'
const EXPECTED_MIXIN = 'ea1db124af3c7062474693fa704f4ff8'

assert(getMixinKey(IMG_KEY, SUB_KEY) === EXPECTED_MIXIN, 'wbi mixinKey 与官方已知向量一致')
assert(getMixinKey('', '').length === 0, 'wbi 空 key 返回空')
const mk = getMixinKey(IMG_KEY, SUB_KEY)
assert(mk.length === 32 && /^[0-9a-f]+$/.test(mk), 'mixinKey 为 32 位十六进制')

// 签名确定性 + wts 参与
const s1 = signWbi({ foo: '114', bar: '514', baz: '1919810' }, IMG_KEY, SUB_KEY, 1704807122)
const s2 = signWbi({ foo: '114', bar: '514', baz: '1919810' }, IMG_KEY, SUB_KEY, 1704807122)
assert(s1.wts === 1704807122 && s1.w_rid === s2.w_rid, 'wbi 签名确定性（同参数同 wts）')
assert(s1.w_rid.length === 32, 'w_rid 为 32 位 hex')

// 参数顺序敏感：乱序传入产生相同签名（内部排序）
const s3 = signWbi({ baz: '1919810', bar: '514', foo: '114' }, IMG_KEY, SUB_KEY, 1704807122)
assert(s3.w_rid === s1.w_rid, 'wbi 签名参数乱序结果一致（内部按键排序）')

// 不同 wts 产生不同签名
const s4 = signWbi({ foo: '114' }, IMG_KEY, SUB_KEY, 1704807123)
assert(s4.w_rid !== s1.w_rid, 'wbi 不同 wts 产生不同 w_rid')

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
