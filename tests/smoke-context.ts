/* 无头冒烟测试：上下文窗口优化（Token / Context Budget）
 * 覆盖 estimateTokens 启发式、selectContext 预算选择/截断、编号连续，
 * 以及 QaService 集成后 AskResult.truncated/contextTokens 透传。
 * 运行：node --experimental-strip-types tests/smoke-context.ts
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Indexer } from '../src/main/searchIndex/indexer.ts'
import { QaService } from '../src/main/searchIndex/qa.ts'
import { estimateTokens, selectContext, truncateToTokens } from '../src/main/searchIndex/contextOptimizer.ts'
import type { ScoredChunk } from '../src/main/searchIndex/types.ts'
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

function mkChunk(text: string, score: number, filePath = '/tmp/a.txt', startChar = 0): ScoredChunk {
  return {
    id: `d#${startChar}`,
    docId: 'd',
    filePath,
    text,
    startChar,
    score
  }
}

function fakeComplete(): (m: AiChatMessage[]) => Promise<{ ok: boolean; text?: string; error?: string }> {
  return async (messages: AiChatMessage[]) => {
    const sys = messages[0]?.content ?? ''
    if (sys.includes('检索质量评估器')) {
      const user = messages[1]?.content ?? ''
      const count = (user.match(/\[\d+\]/g) ?? []).length
      const arr = Array.from({ length: count }, (_, i) => ({ idx: i + 1, relevant: true }))
      return { ok: true, text: JSON.stringify(arr) }
    }
    if (sys.includes('查询改写器')) return { ok: true, text: '合同 违约' }
    return { ok: true, text: '根据【1】合同违约应赔偿损失。' }
  }
}

async function main(): Promise<void> {
  /* ---- 1. estimateTokens 启发式 ---- */
  check('estimateTokens 空串=0', estimateTokens('') === 0)
  check('estimateTokens 英文偏少', estimateTokens('hello') >= 1 && estimateTokens('hello') <= 3, `got ${estimateTokens('hello')}`)
  const cn = estimateTokens('合同违约应当赔偿对方损失')
  check('estimateTokens 中文≈字符*0.6', cn >= 6 && cn <= 9, `got ${cn}`)
  const longCn = estimateTokens('法'.repeat(1000))
  check('estimateTokens 千字中文≈600', longCn >= 550 && longCn <= 650, `got ${longCn}`)

  /* ---- 2. selectContext 预算充足全选 ---- */
  const chunks = [
    mkChunk('合同违约应当赔偿损失并支付违约金。', 3),
    mkChunk('争议解决可提交仲裁机构处理。', 2),
    mkChunk('双方应当诚实守信履行义务。', 1)
  ]
  const big = selectContext(chunks, { maxTokens: 3000 })
  check('预算充足：全选', big.selectedCount === 3 && big.skippedCount === 0)
  check('预算充足：未截断', big.truncated === false)
  check('预算充足：编号连续 1..3', big.items.map((i) => i.index).join(',') === '1,2,3')
  check('预算充足：totalTokens>0', big.totalTokens > 0)

  /* ---- 3. selectContext 超预算丢弃候选（truncated） ---- */
  const tight = selectContext(chunks, { maxTokens: 420 })
  check('超预算：选中数<总数', tight.selectedCount < 3, `sel=${tight.selectedCount}`)
  check('超预算：skipped>0', tight.skippedCount > 0, `skip=${tight.skippedCount}`)
  check('超预算：标记 truncated', tight.truncated === true)
  check('超预算：编号连续', tight.items.every((it, i) => it.index === i + 1))

  /* ---- 4. selectContext 单块超大→截断该块（不丢块） ---- */
  const huge = [mkChunk('违约'.repeat(600), 5)]
  const cut = selectContext(huge, { maxTokens: 500 })
  check('单块超大：仍选 1 块', cut.selectedCount === 1 && cut.skippedCount === 0)
  check('单块超大：标记 truncated', cut.truncated === true)
  check('单块超大：块被截断', cut.items[0].truncated === true)
  check(
    '单块超大：token 收敛到预算附近',
    cut.totalTokens <= 200 && cut.totalTokens >= 50,
    `tok=${cut.totalTokens}`
  )

  /* ---- 5. truncateToTokens 句边界优先 ---- */
  const para = '第一句内容很长很重要。第二句也需要保留。第三句可以略过一些细节信息。'
  const t1 = truncateToTokens(para, 20)
  check('截断保留开头', t1.startsWith('第一句'))
  check('截断未超过预算太多', estimateTokens(t1) <= 25, `tok=${estimateTokens(t1)}`)

  /* ---- 6. QaService 集成：透传 truncated / contextTokens ---- */
  const root = mkdtempSync(join(tmpdir(), 'ctx-smoke-'))
  const docA = join(root, 'docA.txt')
  const docText = `第一章 合同基本条款
本合同由甲乙双方于2024年签署。双方应当诚实守信，按照约定全面履行义务。

第二章 违约责任
若一方违约，应当赔偿对方因此受到的损失，并支付违约金。违约方应承担相应法律责任。

第三章 争议解决
双方发生争议时，应首先协商解决；协商不成的，提交仲裁机构处理。`
  writeFileSync(docA, docText, 'utf-8')

  const idx = new Indexer(join(root, 'search-index.json'))
  const rA = await idx.ingest(docA)
  check('ingest 成功', rA.success && rA.chunkCount > 0)

  // 极小 token 预算 → 必触发压缩
  const qa = new QaService(idx, fakeComplete(), { maxTokens: 450, reservedTokens: 400 })
  const res = await qa.ask({ question: '合同违约', mode: 'basic', maxTokens: 450 })
  check('集成：answerMode=generated', res.answerMode === 'generated' && res.ok)
  check('集成：truncated 透传为 true', res.truncated === true, `truncated=${res.truncated}`)
  check('集成：contextTokens 有值', typeof res.contextTokens === 'number' && res.contextTokens > 0)
  check('集成：引用编号连续', res.citations.every((c, i) => c.index === i + 1))
  check('集成：usedChunks 反映选中数', res.usedChunks === res.citations.length)

  // 充足预算 → 不压缩
  const qaFull = new QaService(idx, fakeComplete(), { maxTokens: 8000, reservedTokens: 400 })
  const resFull = await qaFull.ask({ question: '合同违约', mode: 'basic', maxTokens: 8000 })
  check('集成(充足)：truncated=false', resFull.truncated === false, `truncated=${resFull.truncated}`)

  rmSync(root, { recursive: true, force: true })
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

void main()
