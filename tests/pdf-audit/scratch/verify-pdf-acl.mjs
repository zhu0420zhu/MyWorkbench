/**
 * 回归检查：sofficePath 抽取后，PDF 模块的 IPC 是否完好。
 * 运行：node --experimental-loader=./tests/pdf-audit/scratch/loader-full.mjs \
 *        --experimental-strip-types tests/pdf-audit/scratch/verify-pdf-acl.mjs
 */
import { handlers } from 'electron'
import { registerPdfIpc } from '../../../src/main/pdf/pdfIpc.ts'
import { bundledSoffice, sofficeAvailable } from '../../../src/main/pdf/sofficePath.ts'

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

registerPdfIpc()
const expected = ['pdf:soffice-available', 'pdf:pick-pdfs', 'pdf:pick-excel', 'pdf:pick-dir', 'pdf:exists', 'pdf:read', 'pdf:write', 'pdf:save-path', 'pdf:excel-to-pdf']
console.log('已注册 pdf:* handler:', [...handlers.keys()].filter((k) => k.startsWith('pdf:')).join(', '))
check('registerPdfIpc 注册了全部 9 个 handler', expected.every((c) => handlers.has(c)), `缺少 ${expected.filter((c) => !handlers.has(c)).join(',')}`)

const avail = await handlers.get('pdf:soffice-available')({ sender: {} })
console.log('pdf:soffice-available →', avail)
check('pdf:soffice-available 仍返回 true（定位逻辑抽取后未坏）', avail === true)

console.log('bundledSoffice() =', bundledSoffice())
check('bundledSoffice 指向内置 soffice.com', /soffice\.com$/.test(bundledSoffice()))
check('sofficeAvailable() = true', sofficeAvailable() === true)

// 单一来源检查：定义只应出现在 sofficePath.ts
console.log(`\n结论：${failures === 0 ? 'PASS' : 'FAIL'}（${failures} 项失败）`)
process.exit(failures === 0 ? 0 : 1)
