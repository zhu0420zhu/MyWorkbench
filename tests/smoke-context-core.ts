/* 上下文编排器纯逻辑冒烟：node --experimental-strip-types tests/smoke-context-core.ts */
import { buildContextBlocks, applyBudget, renderBundlePrompt } from '../src/main/novel/contextCore.ts'
import type { ContextBuildData } from '../src/main/novel/contextCore.ts'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, extra = '') {
  if (ok) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${extra ? `\n       ${extra}` : ''}`)
  }
}

function data(over: Partial<ContextBuildData> = {}): ContextBuildData {
  return {
    projectTitle: '斗破苍穹',
    genre: '玄幻',
    synopsis: '少年萧炎从天才沦为废人，誓要重回巅峰。',
    chapterTitle: '第 30 章 断臂',
    chapterSummary: '萧炎在黑角域遭遇魂殿强者，右臂被废。',
    previous: [
      { id: 'c27', title: '第 27 章', summary: '抵达黑角域', volumeTitle: '第一卷' },
      { id: 'c28', title: '第 28 章', summary: '打探魂殿消息', volumeTitle: '第一卷' },
      { id: 'c29', title: '第 29 章', summary: '与魂殿护法交手', volumeTitle: '第一卷' }
    ],
    prevChapterContent: '二人战至黄昏。'.repeat(80),
    entities: [
      {
        id: 'e1',
        name: '萧炎',
        kind: 'character',
        tagline: '萧家天才',
        content: '性格坚毅，不服输。'.repeat(20),
        pinned: true,
        states: [{ id: 's1', projectId: 'p', entityId: 'e1', chapterId: 'c29', text: '斗气损耗严重', createdAt: 1 }],
        relations: [
          { targetName: '药老', label: '师徒', bidirectional: true }
        ],
        mentions: 5
      },
      {
        id: 'e2',
        name: '魂殿护法',
        kind: 'character',
        tagline: '反派',
        content: '阴狠。',
        pinned: false,
        // 这条状态起效于"未来章节"，不该被编排进来（会剧透）
        states: [{ id: 's2', projectId: 'p', entityId: 'e2', chapterId: 'c40', text: '已死', createdAt: 2 }],
        relations: [],
        mentions: 3
      }
    ],
    retrieval: [
      { chapterTitle: '第 12 章', text: '黑角域混乱无序，强者为尊。', score: 3 }
    ],
    pinnedNotes: ['写战斗时少用招式名，多写身体感受'],
    ...over
  }
}

/* 1. 块齐全且按优先级排序 */
{
  const blocks = buildContextBlocks(data())
  const kinds = blocks.map((b) => b.kind)
  check(
    '块类型与顺序',
    JSON.stringify(kinds) ===
      JSON.stringify(['synopsis', 'outline', 'prev-tail', 'entities', 'summary-chain', 'retrieval', 'note']),
    JSON.stringify(kinds)
  )
  check('结构性块不可删除', blocks.filter((b) => !b.removable).map((b) => b.kind).join() === 'synopsis,outline')
}

/* 2. 空内容块自动关闭 */
{
  const blocks = buildContextBlocks(
    data({ synopsis: '', prevChapterContent: '', retrieval: [], pinnedNotes: [] })
  )
  const off = blocks.filter((b) => !b.enabled).map((b) => b.kind)
  check('空内容块不启用', off.includes('prev-tail') && off.includes('retrieval') && off.includes('note'), JSON.stringify(off))
}

/* 3. 摘要链只取最近 N 章（不自己编序号，避免和作者标题里的章号打架） */
{
  const blocks = buildContextBlocks(data(), { summaryDepth: 2 })
  const chain = blocks.find((b) => b.kind === 'summary-chain')!
  check(
    '摘要链深度',
    chain.text.includes('第 29 章') && chain.text.includes('第 28 章') && !chain.text.includes('第 27 章'),
    chain.text
  )
}

/* 4. 动态状态与关系进入设定块 */
{
  const blocks = buildContextBlocks(data())
  const ent = blocks.find((b) => b.kind === 'entities')!
  check('包含动态状态', ent.text.includes('斗气损耗严重'))
  check('包含一跳关系', ent.text.includes('药老') && ent.text.includes('师徒'))
}

/* 5. 未来章节的状态不进上下文（防剧透由调用方过滤，这里只验证块渲染正确） */
{
  const blocks = buildContextBlocks(data(), { maxEntities: 2 })
  const ent = blocks.find((b) => b.kind === 'entities')!
  check('两个实体都纳入', ent.title.includes('2'), ent.title)
}

/* 6. 出场实体上限 */
{
  const blocks = buildContextBlocks(data(), { maxEntities: 1 })
  const ent = blocks.find((b) => b.kind === 'entities')!
  check('上限生效', ent.title.includes('1'), ent.title)
}

/* 7. 预算裁剪：从低优先级开始关 */
{
  const blocks = buildContextBlocks(data())
  const total = blocks.reduce((s, b) => s + b.tokens, 0)
  const r = applyBudget(blocks, Math.floor(total * 0.4))
  check('裁剪后不超预算', r.totalTokens <= Math.floor(total * 0.4), `${r.totalTokens} > ${Math.floor(total * 0.4)}`)
  check('有块被关闭', r.trimmed.length > 0, JSON.stringify(r.trimmed))
  const onKinds = r.blocks.filter((b) => b.enabled).map((b) => b.kind)
  check('高优先级保留', onKinds.includes('synopsis') && onKinds.includes('outline'), JSON.stringify(onKinds))
  check('低优先级先砍', !onKinds.includes('note'), JSON.stringify(onKinds))
}

/* 8. 预算极小：只剩最高优先级，其余全关，最高的那块被标记截断。
   注意截断有 200 token 下限——低于 200 的上下文没有意义，宁可超一点也别给模型一堆残句。 */
{
  const blocks = buildContextBlocks(data())
  const r = applyBudget(blocks, 10)
  const on = r.blocks.filter((b) => b.enabled)
  check('只剩作品设定', on.length === 1 && on[0].kind === 'synopsis', JSON.stringify(on.map((b) => b.kind)))
  check('标记为截断', r.trimmed.some((t) => t.includes('截断')), JSON.stringify(r.trimmed))
  check('受 200 token 下限保护', r.totalTokens <= 400, String(r.totalTokens))
}

/* 9. 渲染为提示词：只含已启用块 */
{
  const blocks = buildContextBlocks(data())
  const off = blocks.map((b) => (b.kind === 'retrieval' ? { ...b, enabled: false } : b))
  const text = renderBundlePrompt(off)
  check('渲染排除已关闭块', !text.includes('黑角域混乱无序'), text.slice(0, 200))
  check('渲染包含细纲', text.includes('右臂被废'))
}

/* 10. 全空数据不炸 */
{
  const blocks = buildContextBlocks(
    data({ synopsis: '', genre: '', chapterSummary: '', previous: [], prevChapterContent: '', entities: [], retrieval: [], pinnedNotes: [] })
  )
  check('全空时仍有 7 个块结构', blocks.length === 7)
  // 书名是有用信息，即使题材/梗概都空也保留；因此只应剩"作品设定"一块启用
  const on = blocks.filter((b) => b.enabled)
  check('全空时只剩作品设定启用', on.length === 1 && on[0].kind === 'synopsis', JSON.stringify(on.map((b) => b.kind)))
  check('全空时提示词只剩书名', renderBundlePrompt(blocks).includes('书名：斗破苍穹'))
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) process.exit(1)
