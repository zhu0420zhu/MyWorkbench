/* 别名识别冒烟测试：node --experimental-strip-types tests/smoke-entity-match.ts */
import { buildCandidates, matchEntities } from '../src/main/novel/entityMatch.ts'
import type { EntityKind, EntityMeta } from '../src/shared/types.ts'

function ent(id: string, name: string, aliases: string[], kind: EntityKind = 'character'): EntityMeta {
  return {
    id,
    projectId: 'p',
    kind,
    name,
    aliases,
    tagline: '',
    pinned: false,
    index: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

let pass = 0
let fail = 0
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}\n       实际=${a}\n       期望=${e}`)
  }
}

/* 1. 长名优先：「萧炎」不能被短名「炎」抢走 */
{
  const cands = buildCandidates([ent('a', '萧炎', ['炎帝']), ent('b', '炎', [])])
  const text = '萧炎抬手，炎帝之名震四方。'
  const r = matchEntities(cands, text)
  check(
    '长名优先：萧炎计 1 次、炎不再重复计数',
    r.map((m) => [m.name, m.count]),
    [
      ['萧炎', 2],
      ['炎', 0]
    ].filter((x) => x[1] > 0)
  )
}

/* 2. 别名命中：用别名「药老」也要能认出实体「药尘」 */
{
  const cands = buildCandidates([ent('a', '药尘', ['药老', '药尊者'])])
  const r = matchEntities(cands, '药老笑了笑，药尊者的威压散去。')
  check('别名识别', r.map((m) => [m.name, m.count]), [['药尘', 2]])
}

/* 3. 占位不重复计数：重叠候选只认领一次 */
{
  const cands = buildCandidates([ent('a', '唐三', []), ent('b', '三', [])])
  const r = matchEntities(cands, '唐三唐三唐三')
  check('重叠占位', r.map((m) => [m.name, m.count]), [['唐三', 3]])
}

/* 4. 英文大小写不敏感，且索引不错位 */
{
  const cands = buildCandidates([ent('a', 'Frodo', [])])
  const r = matchEntities(cands, 'frodo and FRODO and Frodo')
  check('ASCII 大小写不敏感', r.map((m) => [m.name, m.count]), [['Frodo', 3]])
}

/* 5. 空输入 / 空候选不炸 */
{
  const cands = buildCandidates([ent('a', '萧炎', [''])])
  check('空文本', matchEntities(cands, ''), [])
  check('空候选', matchEntities([], '任意文本'), [])
  check('别名去空', cands[0].terms, ['萧炎'])
}

/* 6. 本名自动并入候选 */
{
  const cands = buildCandidates([ent('a', '云韵', ['云宗主'])])
  check('本名并入候选', cands[0].terms, ['云宗主', '云韵'])
}

/* 7. 多次出现 + 排序（次数降序） */
{
  const cands = buildCandidates([ent('a', '甲', []), ent('b', '乙', [])])
  const r = matchEntities(cands, '乙 乙 乙 甲')
  check('按次数降序', r.map((m) => [m.name, m.count]), [
    ['乙', 3],
    ['甲', 1]
  ])
}

/* 8. 数与量词穿插不影响（部分重叠的短名在边界处） */
{
  const cands = buildCandidates([ent('a', '林动', []), ent('b', '动', [])])
  const r = matchEntities(cands, '林动动了一下')
  check('边界：林动 1 次 + 单字动 1 次', r.map((m) => [m.name, m.count]), [
    ['林动', 1],
    ['动', 1]
  ])
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) process.exit(1)
