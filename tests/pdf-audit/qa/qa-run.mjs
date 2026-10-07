/**
 * QA 独立验证（第一/二层）：用【我们的解密器】跑 QA 新素材 + 失败路径 + 加密侧产出。
 *
 * 运行：
 *   NODE_OPTIONS="" "<node>" --experimental-loader=./tests/loader.mjs \
 *     --experimental-strip-types tests/pdf-audit/qa/qa-run.mjs
 *
 * 本脚本只【驱动实现 + 记录原始行为】，不做「自洽即正确」的判定；
 * 真伪由 qa-verify-pikepdf.py / qa-verify-pdfjs.mjs 两个第三方实现裁定。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decryptPdf,
  encryptPdf,
  isPdfEncrypted,
  describePdfSecurity,
  PdfSecurityError
} from '../../../src/renderer/src/utils/pdfSecurity.ts'
import { latin1FromBytes } from '../../../src/renderer/src/utils/pdfObjects.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const QA_FIX = join(HERE, '..', 'qa-fixtures')
const ENC_FIX = join(HERE, '..', 'fixtures', 'encrypted')
const SRC = join(HERE, '..', 'fixtures', 'enhance-source.pdf')
const OUT = join(HERE, '..', 'qa-work')
mkdirSync(OUT, { recursive: true })

const USER = 'LingmoAuditPass123'
const OWNER = 'OwnerPass456'
const res = { decrypt: [], fail: [], encrypt: [], notes: [] }
const say = (s) => console.log(s)
const code = (e) =>
  e instanceof PdfSecurityError ? e.code : 'NON_SECURITY_ERROR(' + (e && e.name) + ')'

async function tryDecrypt(bytes, pwd) {
  try {
    return { ok: true, out: await decryptPdf(bytes, pwd) }
  } catch (e) {
    return { ok: false, err: code(e), msg: String(e && e.message) }
  }
}

/* ============ 第二层：新素材解密 ============ */
say('='.repeat(78))
say('QA 解密矩阵（QA 自造素材）')
say('='.repeat(78))

const DEC = [
  { file: 'owner-only-r4.pdf', alg: 'AES-128', userPwd: '', note: '空用户口令/仅所有者口令' },
  { file: 'classic-xref-aes128.pdf', alg: 'AES-128', userPwd: USER, note: '经典 xref 表' },
  { file: 'classic-xref-rc4.pdf', alg: 'RC4 128-bit', userPwd: USER, note: '经典 xref 表' },
  { file: 'incremental-aes128.pdf', alg: 'AES-128', userPwd: USER, note: '增量更新 /Prev 链' },
  { file: 'real-large-aes128.pdf', alg: 'AES-128', userPwd: USER, note: '真实大文件 34 页' },
  { file: 'real-large-rc4.pdf', alg: 'RC4 128-bit', userPwd: USER, note: '真实大文件 34 页' },
  { file: 'long-pwd-aes128.pdf', alg: 'AES-128', userPwd: 'A'.repeat(40), note: '40 字超长口令(须按32字节截断)' }
]

for (const f of DEC) {
  const bytes = readFileSync(join(QA_FIX, f.file))
  say('\n--- ' + f.file + '  (' + f.note + ') ---')
  const enc = await isPdfEncrypted(bytes)
  const info = await describePdfSecurity(bytes)
  say(`  isPdfEncrypted=${enc}  describe=${info.algorithm}/supported=${info.supported}`)

  const u = await tryDecrypt(bytes, f.userPwd)
  let ownerEqUser = null
  let ownerOut = null
  if (u.ok) {
    writeFileSync(join(OUT, 'dec-' + f.file), Buffer.from(u.out))
    const o = await tryDecrypt(bytes, OWNER)
    if (o.ok) {
      ownerOut = o.out
      ownerEqUser = Buffer.compare(Buffer.from(u.out), Buffer.from(o.out)) === 0
      writeFileSync(join(OUT, 'dec-owner-' + f.file), Buffer.from(o.out))
    } else {
      ownerEqUser = 'OWNER_THREW:' + o.err
    }
  }
  say(`  用户口令(${JSON.stringify(f.userPwd)}) 解密: ${u.ok ? '成功 ' + u.out.length + 'B' : '失败 ' + u.err}`)
  say(`  所有者口令解密字节一致: ${ownerEqUser}`)

  // 错误口令
  const w = await tryDecrypt(bytes, 'definitely-wrong-password')
  const wrongOk = !w.ok && w.err === 'PASSWORD_INCORRECT'
  say(`  错误口令 → ${w.ok ? '竟然成功(BUG)' : w.err}  ${wrongOk ? '✅' : '❌'}`)

  res.decrypt.push({
    file: f.file, note: f.note, alg: f.alg,
    detected: info.algorithm, supported: info.supported,
    userPwdLen: f.userPwd.length, userOk: u.ok, userBytes: u.ok ? u.out.length : 0,
    ownerEqUser, wrongPwdCode: w.ok ? 'SUCCESS' : w.err
  })
}

/* ============ 第二层：失败路径 ============ */
say('\n' + '='.repeat(78))
say('失败路径')
say('='.repeat(78))

// 1) 未加密文件
for (const p of [SRC, join(QA_FIX, 'real-large-plain.pdf')]) {
  const b = readFileSync(p)
  const r = await tryDecrypt(b, 'whatever')
  const ok = !r.ok && r.err === 'NOT_ENCRYPTED'
  say(`  未加密 ${p.split(/[\\/]/).pop()} → ${r.ok ? '成功(BUG)' : r.err} ${ok ? '✅' : '❌'}`)
  res.fail.push({ case: 'unencrypted ' + p.split(/[\\/]/).pop(), got: r.ok ? 'SUCCESS' : r.err, expected: 'NOT_ENCRYPTED', ok })
}

// 2) AES-256
{
  const b = readFileSync(join(ENC_FIX, 'aes256-r6.pdf'))
  const r = await tryDecrypt(b, USER)
  const ok = !r.ok && r.err === 'UNSUPPORTED_CRYPTO' && /AES-256/.test(r.msg || '')
  say(`  AES-256 → ${r.ok ? '成功(BUG)' : r.err} / "${r.msg}" ${ok ? '✅' : '❌'}`)
  res.fail.push({ case: 'aes256', got: (r.err || '') + ' | ' + r.msg, expected: 'UNSUPPORTED_CRYPTO + AES-256', ok })
}

// 3) 截断 / 损坏
const truncCases = [
  ['classic-xref-aes128.pdf', 0.5, '截断 50%'],
  ['classic-xref-aes128.pdf', 0.85, '截断 85%'],
  ['incremental-aes128.pdf', 0.4, '截断 40%'],
  ['real-large-aes128.pdf', 0.6, '截断 60%'],
  ['classic-xref-aes128.pdf', 0.98, '截断 2%(仅缺尾部)']
]
for (const [file, frac, label] of truncCases) {
  const full = readFileSync(join(QA_FIX, file))
  const cut = full.subarray(0, Math.max(1, Math.floor(full.length * frac)))
  const t0 = Date.now()
  let r, timedOut = false
  try {
    r = await Promise.race([
      tryDecrypt(cut, USER),
      new Promise((_, rej) => setTimeout(() => { timedOut = true; rej(new Error('TIMEOUT')) }, 8000))
    ])
  } catch (e) {
    r = { ok: false, err: 'TIMEOUT/HANG', msg: String(e) }
  }
  const ms = Date.now() - t0
  // 判定：不得挂死；且要么报错，要么（若"成功"）产出物不得被第三方当作有效加密残留
  const graceful = !timedOut
  say(`  ${label} (${file}) → ${r.ok ? `产出 ${r.out.length}B` : r.err}  [${ms}ms] timeout=${timedOut}`)
  if (r.ok) {
    const txt = latin1FromBytes(r.out)
    say(`      产出含 /Encrypt? ${/\/Encrypt\b/.test(txt)}`)
    writeFileSync(join(OUT, `trunc-${label.replace(/[^\w]/g, '_')}-${file}`), Buffer.from(r.out))
  }
  res.fail.push({ case: label, got: r.ok ? 'SUCCESS returned bytes' : r.err, ms, timedOut, graceful })
}

// 4) 空口令但文件确有非空用户口令（应报 PASSWORD_INCORRECT，不能静默成功）
{
  const b = readFileSync(join(ENC_FIX, 'aes128-r4.pdf'))
  const r = await tryDecrypt(b, '')
  const ok = !r.ok && r.err === 'PASSWORD_INCORRECT'
  say(`  非空用户口令文件 + 空口令 → ${r.ok ? '成功(BUG)' : r.err} ${ok ? '✅' : '❌'}`)
  res.fail.push({ case: 'empty pwd on non-empty-user file', got: r.ok ? 'SUCCESS' : r.err, expected: 'PASSWORD_INCORRECT', ok })
}

/* ============ 第二层 #6：所有者口令路径（我们自己的解密器） ============ */
// 已在上方每个 fixture 断言 ownerEqUser；这里额外对工程师原矩阵也做一次
say('\n' + '='.repeat(78))
say('所有者口令路径（工程师原矩阵，逐字节一致）')
say('='.repeat(78))
for (const file of ['rc4-40-r2.pdf', 'rc4-128-r3.pdf', 'rc4-128-r4.pdf', 'aes128-r4.pdf', 'aes128-r4-nometa.pdf']) {
  const b = readFileSync(join(ENC_FIX, file))
  const u = await tryDecrypt(b, USER)
  const o = await tryDecrypt(b, OWNER)
  const eq = u.ok && o.ok && Buffer.compare(Buffer.from(u.out), Buffer.from(o.out)) === 0
  say(`  ${file.padEnd(24)} user=${u.ok ? u.out.length : u.err} owner=${o.ok ? o.out.length : o.err} 字节一致=${eq} ${eq ? '✅' : '❌'}`)
  res.decrypt.push({ file, ownerEqUser: eq, viaMatrix: true })
}

/* ============ 加密侧：产出密文供第三方验证 ============ */
say('\n' + '='.repeat(78))
say('加密侧产出（AES-128 / V4 R4）')
say('='.repeat(78))
for (const [label, srcPath, uPwd, oPwd] of [
  ['enc-source.pdf', SRC, USER, OWNER],
  ['enc-real.pdf', join(QA_FIX, 'real-large-plain.pdf'), USER, OWNER],
  ['enc-longpwd.pdf', SRC, 'A'.repeat(40), OWNER]
]) {
  const b = readFileSync(srcPath)
  try {
    const o = await encryptPdf(b, { userPassword: uPwd, ownerPassword: oPwd })
    writeFileSync(join(OUT, label), Buffer.from(o))
    const txt = latin1FromBytes(o)
    // 精确解析 /Encrypt 字典对象取 /P（不能全文抓第一处 /P，真实文件里别的字典也有 /P）
    const ref = /\/Encrypt\s+(\d+)\s+(\d+)\s+R/.exec(txt)
    let pInEnc = null
    if (ref) {
      const om = new RegExp(`(?<![0-9])${ref[1]}\\s+${ref[2]}\\s+obj`).exec(txt)
      if (om) {
        const s = txt.indexOf('<<', om.index)
        let depth = 0, i = s
        while (i < txt.length - 1) {
          if (txt[i] === '<' && txt[i + 1] === '<') { depth++; i += 2; continue }
          if (txt[i] === '>' && txt[i + 1] === '>') { depth--; i += 2; if (depth === 0) break; continue }
          i++
        }
        const dictTxt = txt.slice(s, i)
        const pm = /\/P\s+(-?\d+)/.exec(dictTxt)
        pInEnc = pm ? Number(pm[1]) : null
      }
    }
    const chk = {
      hasEncrypt: /\/Encrypt\b/.test(txt),
      V4: /\/V 4\b/.test(txt),
      R4: /\/R 4\b/.test(txt),
      AESV2: /\/CFM\s*\/AESV2/.test(txt),
      P_in_encrypt_dict: pInEnc,
      classicXref: /\bxref\r?\n/.test(txt),
      noObjStm: !/\/Type\s*\/ObjStm/.test(txt),
      noXRefStream: !/\/Type\s*\/XRef/.test(txt)
    }
    say(`  ${label}: ${o.length}B  ${JSON.stringify(chk)}`)
    res.encrypt.push({ label, uPwdLen: uPwd.length, bytes: o.length, ...chk })
  } catch (e) {
    say(`  ${label}: 失败 ${code(e)} ${e && e.message}`)
    res.encrypt.push({ label, error: code(e) })
  }
}

/* ============ 附加边界 ============ */
say('\n' + '='.repeat(78))
say('附加边界')
say('='.repeat(78))
{
  const encb = readFileSync(join(ENC_FIX, 'aes128-r4.pdf'))
  try {
    await encryptPdf(encb, { userPassword: USER })
    say('  encrypt(已加密文件) → 竟然成功 (BUG)')
    res.fail.push({ case: 'encrypt already-encrypted', got: 'SUCCESS', ok: false })
  } catch (e) {
    const c = code(e)
    const ok = c === 'MALFORMED'
    say(`  encrypt(已加密文件) → ${c} ${ok ? '✅' : '❌'}`)
    res.fail.push({ case: 'encrypt already-encrypted', got: c, expected: 'MALFORMED', ok })
  }
}
{
  const dec = readFileSync(join(OUT, 'dec-classic-xref-aes128.pdf'))
  const r = await tryDecrypt(dec, USER)
  const ok = !r.ok && r.err === 'NOT_ENCRYPTED'
  say(`  decrypt(已解密产物) → ${r.ok ? '成功(BUG)' : r.err} ${ok ? '✅' : '❌'}`)
  res.fail.push({ case: 'decrypt already-decrypted', got: r.ok ? 'SUCCESS' : r.err, expected: 'NOT_ENCRYPTED', ok })
}
{
  // 确定性：解密无随机源，两次应字节一致
  const b = readFileSync(join(QA_FIX, 'classic-xref-aes128.pdf'))
  const a1 = await decryptPdf(b, USER)
  const a2 = await decryptPdf(b, USER)
  const ok = Buffer.compare(Buffer.from(a1), Buffer.from(a2)) === 0
  say(`  解密确定性（两次输出字节一致）→ ${ok} ${ok ? '✅' : '❌'}`)
  res.fail.push({ case: 'decrypt determinism', got: String(ok), ok })
}

writeFileSync(join(OUT, '_qa-run-result.json'), JSON.stringify(res, null, 2))
say('\n结果 JSON → qa-work/_qa-run-result.json')
