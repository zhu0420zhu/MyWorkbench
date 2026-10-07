import { normalizeAliasText, findDuplicateEntities, buildAliasIssues } from '../src/main/novel/consistencyCore.ts'
import type { EntityMention, EntityMeta } from '../src/shared/types.ts'

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

/* ---------- normalizeAliasText ---------- */
{
  // 基础替换
  const r = normalizeAliasText('小李飞刀出门了', '李寻欢', ['小李飞刀'])
  check('基础别名替换', r === '李寻欢出门了', r)

  // 子串别名必须跳过，否则 "林动" → "林动动"
  const r2 = normalizeAliasText('林动在林中走着', '林动', ['林'])
  check('子串别名被跳过', r2 === '林动在林中走着', r2)

  // 多个出现
  const r3 = normalizeAliasText('小李飞刀和小李飞刀', '李寻欢', ['小李飞刀'])
  check('多处别名替换', r3 === '李寻欢和李寻欢', r3)

  // 长别名优先，不拆坏
  const r4 = normalizeAliasText('孙行者悟空心想', '孙悟空', ['孙行者', '悟空', '行者'])
  check('长别名优先且子串不残留', !r4.includes('孙行者') && !r4.includes('行者'), r4)

  // 别名与正式名相同则无操作
  const r5 = normalizeAliasText('原样文本', '无名', ['无名'])
  check('同名别名无操作', r5 === '原样文本', r5)
}

/* ---------- findDuplicateEntities ---------- */
function ent(id: string, name: string, aliases: string[] = []): EntityMeta {
  return {
    id,
    projectId: 'p',
    kind: 'character',
    name,
    aliases,
    tagline: '',
    pinned: false,
    index: 0,
    createdAt: 0,
    updatedAt: 0
  }
}
{
  check('同名 → 报错', findDuplicateEntities([ent('a', '张三'), ent('b', '张三')]).length === 1)
  check(
    '同别名 → 报错',
    findDuplicateEntities([ent('a', '张三', ['阿三']), ent('b', '李四', ['阿三'])]).length === 1
  )
  check('无重复 → 空', findDuplicateEntities([ent('a', '张三'), ent('b', '李四')]).length === 0)
  const three = findDuplicateEntities([ent('a', '王五'), ent('b', '王五'), ent('c', '王五')])
  check('三个同名仍只报一次', three.length === 1, JSON.stringify(three))
  check(
    '错误级严重程度',
    findDuplicateEntities([ent('a', '张三'), ent('b', '张三')])[0]?.severity === 'error'
  )
}

/* ---------- buildAliasIssues ---------- */
function mention(entityId: string, name: string, matched: string, count = 1): EntityMention {
  return { entityId, name, kind: 'character', matched, count }
}
{
  const m1 = [mention('e1', '李寻欢', '小李飞刀'), mention('e1', '李寻欢', '李探花')]
  const iss = buildAliasIssues('c1', '第一章', m1)
  check('同一实体多别名只报一次', iss.length === 1, JSON.stringify(iss))
  check('问题可自动修正', iss[0]?.autoFixable === true)

  const m2 = [mention('e1', '李寻欢', '李寻欢')]
  check('用正式名不报', buildAliasIssues('c1', '第一章', m2).length === 0)

  check('空提及 → 空', buildAliasIssues('c1', '第一章', []).length === 0)

  const m3 = [mention('e1', '李寻欢', '小李'), mention('e2', '林诗音', '诗音')]
  check('两个不同实体报两条', buildAliasIssues('c1', '第一章', m3).length === 2)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail > 0) process.exit(1)
