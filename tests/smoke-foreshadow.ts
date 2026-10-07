import { buildChapterOrder, detectOverdue } from '../src/main/novel/foreshadowCore.ts'
import type { ChapterMeta, Foreshadow, Volume } from '../src/shared/types.ts'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++
    console.log('  ok  ', name)
  } else {
    fail++
    console.log('  FAIL', name, extra)
  }
}

/* ---------- 构造测试数据 ---------- */
function vol(id: string, index: number): Volume {
  return { id, projectId: 'p', index, title: `卷${index}` }
}
function ch(id: string, volumeId: string, index: number, title: string): ChapterMeta {
  return {
    id,
    projectId: 'p',
    volumeId,
    index,
    title,
    summary: '',
    status: 'draft',
    wordGoal: 0,
    wordCount: 0,
    updatedAt: 0
  }
}
function fs(id: string, plantedChapterId: string, status: Foreshadow['status'] = 'planted'): Foreshadow {
  return {
    id,
    projectId: 'p',
    content: `伏笔${id}`,
    plantedChapterId,
    plantedChapterTitle: '',
    status,
    createdAt: 0,
    updatedAt: 0
  }
}

// 两卷：卷0 有 c1,c2,c3；卷1 有 c4,c5
const volumes = [vol('v0', 0), vol('v1', 1)]
const chapters = [
  ch('c3', 'v0', 2, '第3章'),
  ch('c1', 'v0', 0, '第1章'),
  ch('c2', 'v0', 1, '第2章'),
  ch('c5', 'v1', 1, '第5章'),
  ch('c4', 'v1', 0, '第4章')
]

/* ---------- buildChapterOrder：卷序 → 卷内章序 ---------- */
{
  const order = buildChapterOrder(volumes, chapters).map((c) => c.id)
  check('阅读顺序正确（卷内按 index）', JSON.stringify(order) === JSON.stringify(['c1', 'c2', 'c3', 'c4', 'c5']), order.join(','))
  check('乱序输入也能排好', order[0] === 'c1' && order[4] === 'c5')
}

/* ---------- detectOverdue：跨过阈值才提醒 ---------- */
{
  // 当前在第5章(c5)，伏笔埋在c1 → 跨过 4 章
  const list = [fs('f1', 'c1', 'planted')]
  check('阈值=5 时不提醒（差4章）', detectOverdue(list, buildChapterOrder(volumes, chapters), 'c5', 5).length === 0)
  check('阈值=4 时提醒（差4章）', detectOverdue(list, buildChapterOrder(volumes, chapters), 'c5', 4).length === 1)

  // 已回收的伏笔不提醒
  const list2 = [fs('f2', 'c1', 'payed-off')]
  check('已回收不提醒', detectOverdue(list2, buildChapterOrder(volumes, chapters), 'c5', 1).length === 0)

  // 埋在当前章不提醒
  const list3 = [fs('f3', 'c5', 'planted')]
  check('埋在当前章不提醒', detectOverdue(list3, buildChapterOrder(volumes, chapters), 'c5', 1).length === 0)

  // 章节被删（找不到埋下章）不提醒
  const list4 = [fs('f4', 'deleted', 'planted')]
  check('埋下章已删除不提醒', detectOverdue(list4, buildChapterOrder(volumes, chapters), 'c5', 1).length === 0)

  // 当前章本身找不到 → 不提醒
  check('当前章找不到不提醒', detectOverdue(list, buildChapterOrder(volumes, chapters), 'nope', 1).length === 0)

  // 多条混合：只有「仍 planted」且「跨过阈值」的会触发
  //   a 埋在 c1，距当前 c5 跨 4 章 → 触发
  //   b 埋在 c4，距当前 c5 跨 1 章 → 阈值=1 时触发，阈值=2 时不触发
  //   c 已放弃 → 永不触发
  const mixed = [fs('a', 'c1', 'planted'), fs('b', 'c4', 'planted'), fs('c', 'c1', 'abandoned')]
  const od1 = detectOverdue(mixed, buildChapterOrder(volumes, chapters), 'c5', 2)
  check('混合（阈值2）：只报埋得早的 a', od1.length === 1 && od1[0].id === 'a', od1.map((f) => f.id).join(','))
  const od2 = detectOverdue(mixed, buildChapterOrder(volumes, chapters), 'c5', 1)
  check('混合（阈值1）：报 a 与 b，不含已放弃的 c', od2.length === 2 && od2.every((f) => f.id === 'a' || f.id === 'b'), od2.map((f) => f.id).join(','))
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail > 0) process.exit(1)
