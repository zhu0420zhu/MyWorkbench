/**
 * pdfCrypto.ts 原语验证 —— 全部对照公开标准测试向量。
 *
 * 这些向量来自 RFC 1321（MD5）、RC4 经典测试集，
 * 以及 ISO 32000-1 附录中可推导的一致性关系。
 * 密码学代码没有"看起来对"这回事，必须逐字节比对已知答案。
 */
import {
  md5,
  rc4,
  PAD_BYTES,
  padPassword,
  computeEncryptionKey,
  computeOwnerKey,
  computeUserKey,
  verifyUserPassword,
  objectKey,
  aesCbcEncryptPdf,
  aesCbcDecryptPdf,
  passwordBytes
} from '../../src/renderer/src/utils/pdfCrypto.ts'

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
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const bytes = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)))

console.log('='.repeat(74))
console.log('pdfCrypto.ts 原语验证')
console.log('='.repeat(74))

/* ---------- 1. MD5（RFC 1321 标准向量） ---------- */
console.log('\n[1] MD5 — RFC 1321 测试向量')
{
  const vectors = [
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
    ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', '57edf4a22be3c955ac49da2e2107b67a'],
    ['The quick brown fox jumps over the lazy dog', '9e107d9d372bb6826bd81d3542a419d6']
  ]
  let ok = 0
  for (const [input, expect] of vectors) {
    const got = hex(md5(bytes(input)))
    if (got === expect) ok++
    else console.log('      ✗ ' + JSON.stringify(input.slice(0, 40)) + ' 得到 ' + got + ' 期望 ' + expect)
  }
  check('8 个 RFC 1321 向量全部匹配', ok === vectors.length, ok + '/' + vectors.length)
  // 跨块边界：65 字节触发第二个 64 字节块
  check('跨块长度（200 字节）可计算', hex(md5(new Uint8Array(200))).length === 32)
}

/* ---------- 2. RC4（经典测试向量） ---------- */
console.log('\n[2] RC4 — 经典测试向量')
{
  const vectors = [
    ['Key', 'Plaintext', 'bbf316e8d940af0ad3'],
    ['Wiki', 'pedia', '1021bf0420'],
    ['Secret', 'Attack at dawn', '45a01f645fc35b383552544b9bf5']
  ]
  let ok = 0
  for (const [k, p, expect] of vectors) {
    const got = hex(rc4(bytes(k), bytes(p)))
    if (got === expect) ok++
    else console.log('      ✗ key=' + k + ' 得到 ' + got + ' 期望 ' + expect)
  }
  check('3 个 RC4 向量全部匹配', ok === vectors.length, ok + '/' + vectors.length)

  // RC4 是对合的：加密两次还原
  const k = bytes('LingmoKey')
  const data = new Uint8Array([0, 1, 2, 253, 254, 255, 66, 77])
  const back = rc4(k, rc4(k, data))
  check('RC4 自反（两次调用还原）', hex(back) === hex(data))
}

/* ---------- 3. AES-CBC（Web Crypto 往返 + NIST 向量） ---------- */
console.log('\n[3] AES-CBC（Web Crypto）')
{
  const key = new Uint8Array(16)
  for (let i = 0; i < 16; i++) key[i] = i
  const iv = new Uint8Array(16).fill(0x0f)
  const plain = bytes('PDF AES-128 roundtrip test message!')

  const enc = await aesCbcEncryptPdf(key, plain, iv)
  // PDF 的 AES 存储格式必须带 16 字节前置 IV
  check('密文以 16 字节 IV 前置', hex(enc.subarray(0, 16)) === hex(iv))
  check('密文长度 = IV + 对齐后的明文（PKCS#7）', (enc.length - 16) % 16 === 0, '总长 ' + enc.length)
  const dec = await aesCbcDecryptPdf(key, enc)
  check('解密还原明文', hex(dec) === hex(plain))

  // ---- NIST SP 800-38A F.2.1 / F.2.5 官方向量 ----
  //
  // 注意：官方向量是【无填充】的裸 CBC；而 PDF 的 AESV2 格式必须做 PKCS#7，
  // 因此 aesCbcEncryptPdf 会对 64 字节明文额外补一个整块（16 字节 0x10），
  // 产出 16(IV) + 80 字节。比对时只取前 64 字节密文，逐块对照官方向量。
  const toB = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)))
  const NIST_IV = '000102030405060708090a0b0c0d0e0f'
  const NIST_PT =
    '6bc1bee22e409f96e93d7e117393172a' +
    'ae2d8a571e03ac9c9eb76fac45af8e51' +
    '30c81c46a35ce411e5fbc1191a0a52ef' +
    'f69f2445df4f9b17ad2b417be66c3710'

  const nistCases = [
    {
      name: 'F.2.1 CBC-AES128',
      key: '2b7e151628aed2a6abf7158809cf4f3c',
      ct:
        '7649abac8119b246cee98e9b12e9197d' +
        '5086cb9b507219ee95db113a917678b2' +
        '73bed6b8e3c1743b7116e69e22229516' +
        '3ff1caa1681fac09120eca307586e1a7'
    },
    {
      name: 'F.2.5 CBC-AES256',
      key: '603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4',
      ct:
        'f58c4c04d6e5f1ba779eabfb5f7bfbd6' +
        '9cfc4e967edb808d679f777bc6702c7d' +
        '39f23369a9d9bacfa530e26304231461' +
        'b2eb05e2c39be9fcda6c19078c6a9d1b'
    }
  ]

  for (const c of nistCases) {
    const got = await aesCbcEncryptPdf(toB(c.key), toB(NIST_PT), toB(NIST_IV))
    const body = hex(got.subarray(16, 16 + 64)) // 剥掉前置 IV，取 4 个明文块对应的密文
    let firstBad = -1
    for (let b = 0; b < 4; b++) {
      if (body.slice(b * 32, b * 32 + 32) !== c.ct.slice(b * 32, b * 32 + 32)) {
        firstBad = b
        break
      }
    }
    check(
      'NIST SP 800-38A ' + c.name + ' 四块向量逐块匹配',
      firstBad < 0,
      firstBad < 0
        ? '64 字节密文全等'
        : '第 ' + (firstBad + 1) + ' 块 ' + body.slice(firstBad * 32, firstBad * 32 + 32) +
          ' ≠ ' + c.ct.slice(firstBad * 32, firstBad * 32 + 32)
    )
    // 密文总长必须正好多出一个 PKCS#7 整块
    check('  ' + c.name + ' 填充块存在（密文 = IV + 明文 + 1 块）',
      got.length === 16 + 64 + 16, got.length + ' 字节')
    // 往返
    const back = await aesCbcDecryptPdf(toB(c.key), got)
    check('  ' + c.name + ' 解密往返还原明文', hex(back) === NIST_PT)
  }
}

/* ---------- 4. 口令填充与 O/U 一致性（PDF 规范内部关系） ---------- */
console.log('\n[4] PDF 口令填充 / O / U 一致性')
{
  check('填充串为规范规定的 32 字节', PAD_BYTES.length === 32)
  check('填充串首字节 0x28、末字节 0x7a', PAD_BYTES[0] === 0x28 && PAD_BYTES[31] === 0x7a)

  const short = padPassword(bytes('abc'))
  check('短口令补齐到 32 字节', short.length === 32 &&
    hex(short.subarray(0, 3)) === '616263' &&
    hex(short.subarray(3, 6)) === '28bf4e', '前 3 字节保留原口令，其后接填充串')

  const long = padPassword(bytes('x'.repeat(50)))
  check('超长口令截断到 32 字节', long.length === 32 && hex(long) === '78'.repeat(32))

  // 用规范定义的关系做自洽验证：
  // 正确口令应通过 verifyUserPassword；错误口令应被拒
  const id0 = bytes('0123456789abcdef')
  const userPwd = bytes('user123')
  const ownerPwd = bytes('owner456')
  for (const rev of [2, 3, 4]) {
    const keyLen = rev === 2 ? 5 : 16
    const O = computeOwnerKey(ownerPwd, userPwd, rev, keyLen)
    check('R=' + rev + ' /O 长度为 32 字节', O.length === 32)
    const key = computeEncryptionKey(userPwd, O, -1028, id0, rev, keyLen)
    const U = computeUserKey(key, id0, rev)
    check('R=' + rev + ' /U 长度为 32 字节', U.length === 32)
    check('R=' + rev + ' 正确口令可解出密钥',
      verifyUserPassword(userPwd, O, U, -1028, id0, rev, keyLen) !== null)
    check('R=' + rev + ' 错误口令被拒绝',
      verifyUserPassword(bytes('wrong'), O, U, -1028, id0, rev, keyLen) === null)
  }

  // 所有者口令也能打开（用 ownerPwd 先算出 userPwd 再验证用户口令）
  const rev = 3
  const keyLen = 16
  const O = computeOwnerKey(ownerPwd, userPwd, rev, keyLen)
  // 算法 7 的逆：用 ownerPwd 恢复出被 /O 加密的 userPwd 填充串
  let h = md5(padPassword(ownerPwd))
  for (let i = 0; i < 50; i++) h = md5(h)
  const rc4Key = h.subarray(0, keyLen)
  let recovered = O
  for (let i = 19; i >= 1; i--) {
    const k = new Uint8Array(keyLen)
    for (let j = 0; j < keyLen; j++) k[j] = rc4Key[j] ^ i
    recovered = rc4(k, recovered)
  }
  recovered = rc4(rc4Key, recovered)
  check('由所有者口令可恢复出用户口令（O 可逆）', hex(recovered) === hex(padPassword(userPwd)))

  check('R=4 且 EncryptMetadata=false 会改变密钥',
    hex(computeEncryptionKey(userPwd, O, -1028, id0, 4, 16, true)) !==
    hex(computeEncryptionKey(userPwd, O, -1028, id0, 4, 16, false)))
}

/* ---------- 5. 对象密钥派生（算法 1） ---------- */
console.log('\n[5] 对象密钥派生（算法 1）')
{
  const base = new Uint8Array(16).fill(0x2a)
  const k1 = objectKey(base, 7, 0, false)
  // 文档密钥 16 字节时，对象密钥长度 = min(n+5, 16) = 16
  check('对象密钥长度 = min(n+5,16)', k1.length === 16, k1.length + ' 字节')
  check('不同对象号派生不同密钥', hex(objectKey(base, 7, 0, false)) !== hex(objectKey(base, 8, 0, false)))
  check('不同代数派生不同密钥', hex(objectKey(base, 7, 0, false)) !== hex(objectKey(base, 7, 1, false)))
  check('AES 与 RC4 的派生结果不同（混入 sAlT）',
    hex(objectKey(base, 7, 0, true)) !== hex(objectKey(base, 7, 0, false)))
  check('同一输入派生稳定', hex(objectKey(base, 7, 0, false)) === hex(k1))

  // 40-bit 密钥时对象密钥长度 = min(5+5, 16) = 10
  const short = objectKey(new Uint8Array(5).fill(1), 3, 0, false)
  check('40-bit 文档密钥 → 对象密钥 10 字节', short.length === 10, short.length + ' 字节')
}

console.log('\n' + '='.repeat(74))
console.log('汇总: ' + pass + ' 项通过, ' + fail + ' 项失败')
console.log('='.repeat(74))
void passwordBytes
process.exit(fail ? 1 : 0)
