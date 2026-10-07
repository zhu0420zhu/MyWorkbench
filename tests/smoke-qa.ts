/* 无头冒烟测试：与本地文件对话（Chat with Files）
 * 复用真实 Indexer（ingest → queryChunks），注入假 LLM，覆盖 basic/graded/empty/retrieval-only/scope。
 * 运行：node --experimental-strip-types tests/smoke-qa.ts
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Indexer } from '../src/main/searchIndex/indexer.ts'
import { QaService } from '../src/main/searchIndex/qa.ts'
import type { AiChatMessage } from '../src/shared/types.ts'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name} ${extra}`)
  }
}

const docText = `第一章 合同基本条款
本合同由甲乙双方于2024年签署。双方应当诚实守信。

第二章 违约责任
若一方违约，应当赔偿对方因此受到的损失，并支付违约金。违约方应承担相应法律责任。

第三章 争议解决
双方发生争议时，应首先协商解决；协商不成的，提交仲裁机构处理。`

/** 假 LLM：依据 system 提示区分 评估/改写/作答 三类调用 */
function fakeComplete(role: 'grade-all' | 'rewrite' | 'answer'): (m: AiChatMessage[]) => Promise<{ ok: boolean; text?: string; error?: string }> {
  return async (messages: AiChatMessage[]) => {
    const sys = messages[0]?.content ?? ''
    if (sys.includes('检索质量评估器')) {
      // 标记全部相关（按候选数量）
      const user = messages[1]?.content ?? ''
      const count = (user.match(/\[\d+\]/g) ?? []).length
      const arr = Array.from({ length: count }, (_, i) => ({ idx: i + 1, relevant: true }))
      return { ok: true, text: JSON.stringify(arr) }
    }
    if (sys.includes('查询改写器')) return { ok: true, text: '违约责任 赔偿 仲裁' }
    if (role === 'answer') return { ok: true, text: '根据【1】合同违约应赔偿损失并支付违约金【2】争议可提交仲裁。' }
    return { ok: true, text: 'answer' }
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'qa-smoke-'))
  const idxPath = join(root, 'search-index.json')
  const docA = join(root, 'docA.txt')
  const sub = join(root, 'sub')
  const docB = join(sub, 'docB.txt')
  writeFileSync(docA, docText, 'utf-8')
  writeFileSync(sub, '', { flag: 'a' }) // ensure dir (writeFileSync to dir fails; use mkdir)
  // 重新正确建目录
  rmSync(sub, { recursive: true, force: true })
  const { mkdirSync } = await import('node:fs')
  mkdirSync(sub, { recursive: true })
  writeFileSync(docB, '这是另一份关于财务报销的文档，与合同无关。', 'utf-8')

  const idx = new Indexer(idxPath)
  const rA = await idx.ingest(docA)
  const rB = await idx.ingest(docB)
  check('ingest docA 成功', rA.success && rA.chunkCount > 0)
  check('ingest docB 成功', rB.success && rB.chunkCount > 0)

  // A. queryChunks 返回带评分块
  const chunks = idx.queryChunks('合同 违约', 5)
  check('queryChunks 命中块', chunks.length > 0)
  check('queryChunks 含 startChar 数字', typeof chunks[0]?.startChar === 'number')
  check('queryChunks 评分降序', chunks.every((c, i) => i === 0 || chunks[i - 1].score >= c.score))

  // B. basic 模式：生成 + 引用
  const qaBasic = new QaService(idx, fakeComplete('answer'))
  const rb = await qaBasic.ask({ question: '合同违约怎么办', mode: 'basic' })
  check('basic: answerMode=generated', rb.answerMode === 'generated' && rb.ok)
  check('basic: 引用指向 docA', rb.citations.length > 0 && rb.citations[0].filePath === docA)
  check('basic: 引用含 startChar', rb.citations.every((c) => typeof c.startChar === 'number'))
  check('basic: 引用片段被截断', rb.citations.every((c) => c.snippet.length <= 200))
  check('basic: usedChunks>0', rb.usedChunks > 0)

  // C. graded 模式（含 CRAG 评估+改写）
  const qaGraded = new QaService(idx, fakeComplete('answer'))
  const rg = await qaGraded.ask({ question: '违约赔偿', mode: 'graded' })
  check('graded: answerMode=generated', rg.answerMode === 'generated')
  check('graded: 引用非空', rg.citations.length > 0)

  // D. 空检索（使用完全不重叠的拉丁查询，避免 CJK 单字命中）
  const qaEmpty = new QaService(idx, fakeComplete('answer'))
  const re = await qaEmpty.ask({ question: 'zzzqqqxyz', mode: 'basic' })
  check('empty: answerMode=empty', re.answerMode === 'empty' && re.ok && re.citations.length === 0, `got ${re.answerMode}`)

  // E. LLM 不可用 → 降级 retrieval-only
  const failingLlm = async () => ({ ok: false, error: 'network' })
  const qaFail = new QaService(idx, failingLlm)
  const rf = await qaFail.ask({ question: '合同违约', mode: 'basic' })
  check('fallback: answerMode=retrieval-only', rf.answerMode === 'retrieval-only' && !rf.ok)
  check('fallback: 仍返回引用', rf.citations.length > 0)
  check('fallback: answer=检索片段拼接', rf.answer.includes('【1】') || rf.answer.length > 0)

  // F. scope 限定目录
  const scoped = idx.queryChunks('合同', 10, docA)
  check('scope=docA 仅命中 docA', scoped.length > 0 && scoped.every((c) => c.filePath === docA), JSON.stringify(scoped.map(c=>c.filePath)))
  const scopedSub = idx.queryChunks('财务', 10, sub + '/')
  check('scope=sub/ 仅命中 docB', scopedSub.length > 0 && scopedSub.every((c) => c.filePath === docB), JSON.stringify(scopedSub.map(c=>c.filePath)))

  rmSync(root, { recursive: true, force: true })
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

void main()
