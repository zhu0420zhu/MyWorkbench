/**
 * 压缩前的「受保护源文件」闸门。
 *
 * 背景（真实数据安全事故，非小瑕疵）：
 * 用户拿一个自己加了密的 PDF 去「压缩」，旧实现没有任何提示，而后果因模式而异：
 *   - 结构压缩：丢 /Encrypt，且内容流仍是**密文**（我们没有口令、解不开）→
 *     产出一份「不需要口令、但文本 0 字」的损坏文件（实测 qa-fixtures/real-large-aes128.pdf）；
 *   - 图像化压缩：渲染阶段由 pdf.js 解密（仅对「无口令即可打开」的文件成立）→
 *     产出一份**能正常显示但没有任何保护**的副本（实测 qa-fixtures/owner-only-r4.pdf）；
 *   - fixtures/encrypted/* 结构压缩直接抛错（内部结构无法解析）。
 *
 * 处理原则：**保留功能 + 让后果可见**（不做减法）。检测到加密时：
 *   1. 面板常驻警示（算法/版本 + 该模式的真实后果）；
 *   2. 导出前二次确认，用户显式选择后才继续；
 *   3. 取消 → 返回 'canceled'，调用方**不得写入任何文件**。
 *
 * 本模块不依赖 React，可在无头环境下驱动同一条决策路径做验收。
 */
import { describePdfSecurity, isPdfEncrypted, type PdfSecurityInfo } from './pdfSecurity'

export interface EncryptionVerdict {
  encrypted: boolean
  /** 加密算法/版本信息（未加密或解析失败时为 null），用于提示文案 */
  info: PdfSecurityInfo | null
}

/** 源文件是否受口令保护；顺带取出算法信息供提示使用 */
export async function detectEncryption(
  bytes: Uint8Array,
  deps: {
    isEncrypted?: (b: Uint8Array) => Promise<boolean>
    describe?: (b: Uint8Array) => Promise<PdfSecurityInfo>
  } = {}
): Promise<EncryptionVerdict> {
  const isEncrypted = deps.isEncrypted ?? isPdfEncrypted
  const describe = deps.describe ?? describePdfSecurity
  let encrypted = false
  try {
    encrypted = await isEncrypted(bytes)
  } catch {
    encrypted = false
  }
  if (!encrypted) return { encrypted: false, info: null }
  let info: PdfSecurityInfo | null = null
  try {
    info = await describe(bytes)
  } catch {
    info = null
  }
  return { encrypted: true, info }
}

export type ProtectDecision = 'proceed' | 'canceled'

/**
 * 压缩前的强制闸门。
 * - 未加密：直接放行，不打扰用户；
 * - 已加密：调用 `confirm` 取得**显式确认**，被拒则返回 'canceled'（调用方必须零写入）。
 */
export async function guardProtectedSource(opts: {
  bytes: Uint8Array
  confirm: (verdict: EncryptionVerdict) => Promise<boolean>
  isEncrypted?: (b: Uint8Array) => Promise<boolean>
  describe?: (b: Uint8Array) => Promise<PdfSecurityInfo>
}): Promise<ProtectDecision> {
  const verdict = await detectEncryption(opts.bytes, {
    isEncrypted: opts.isEncrypted,
    describe: opts.describe
  })
  if (!verdict.encrypted) return 'proceed'
  return (await opts.confirm(verdict)) ? 'proceed' : 'canceled'
}

/** 加密信息 → 一句人话（用于警示文案） */
export function describeProtection(verdict: EncryptionVerdict): string {
  if (!verdict.encrypted) return ''
  const info = verdict.info
  if (!info) return '该文件受密码保护。'
  const alg = [info.algorithm, info.revision ? `R${info.revision}` : ''].filter(Boolean).join(' · ')
  const bits = info.keyBytes ? `${info.keyBytes * 8} 位密钥` : ''
  const details = [alg, bits].filter(Boolean).join('，')
  return details ? `该文件受密码保护（${details}）。` : '该文件受密码保护。'
}

export type CompressMode = 'structure' | 'raster'

export interface ProtectedOutcome {
  /** 后果：这一步会发生什么（含实测结论，不含含糊措辞） */
  consequence: string
  /** 建议：用户应该怎么做 */
  advice: string
}

/**
 * 「加密源 + 该模式」的真实后果。
 *
 * 两个模式的后果并不相同，文案必须分开写（以下均为 tests/pdf-audit/
 * verify-compress-encrypt-guard.mjs 的实测结论）：
 *
 * - **structure**：本工具没有口令、无法解密。pdf-lib 的 copyPages 只是把**密文**
 *   原样搬到新文档，重建后又丢掉 /Encrypt → 实测 real-large-aes128.pdf 产出
 *   34 页、不传口令即可打开，但**文本 0 字**（内容流仍是被 AES 加密的字节）。
 *   即：既没有保护、也**不是一个可用的文件**。
 * - **raster**：渲染交给 pdf.js，只有「不需要用户口令即可打开」的加密文件才走得下去
 *   （否则渲染阶段就抛错、根本不会写文件）。这类文件渲染时是能解密的，产出一份
 *   **能正常显示、但没有任何保护**的副本 → 保护永久丢失。
 */
export function describeProtectedOutcome(
  mode: CompressMode,
  verdict: EncryptionVerdict
): ProtectedOutcome {
  if (!verdict.encrypted) return { consequence: '', advice: '' }
  const who = describeProtection(verdict)
  if (mode === 'raster') {
    return {
      consequence:
        `${who}图像化压缩用渲染出的图像重建 PDF，产出副本不再需要任何口令，` +
        '任何拿到它的人都能直接打开、复制内容。',
      advice: '若要保留保护：先取消，压缩完成后到「加密 / 解密」面板重新加密。'
    }
  }
  return {
    consequence:
      `${who}结构压缩需要重建文档结构，而本工具没有您的口令、无法解密内容：` +
      '产出会丢掉加密信息，页面内容流仍是被加密的字节 —— 实测（34 页 AES-128 样本）' +
      '产出不传口令即可打开，但**文本 0 字**，是一份内容无法显示、无法检索的损坏文件。',
    advice: '正确做法：先取消，到「加密 / 解密」面板解密后再压缩。继续压缩不会得到可用结果。'
  }
}
