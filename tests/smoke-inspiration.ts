/**
 * P2-3 无头冒烟测试（纯逻辑，不引 electron）
 * 跑法：node --experimental-strip-types tests/smoke-inspiration.ts
 *
 * 仅验证 inspirationCore 的两条纯函数：
 *   - buildSkillPrompt：占位符 {{context}} / {{input}} 替换
 *   - seedBuiltinSkills：7 个内置 Skill 的种子数据
 */
import { buildSkillPrompt, seedBuiltinSkills } from '../src/main/novel/inspirationCore.ts'

let pass = 0
let fail = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++
  } else {
    fail++
    console.error('  ✗ ' + msg)
  }
}

/* ---- buildSkillPrompt ---- */

assert(
  buildSkillPrompt('前文：{{context}}', '山海世界') === '前文：山海世界',
  '{{context}} 被上下文替换'
)
assert(
  buildSkillPrompt('待润色：{{input}}', '', '一句台词') === '待润色：一句台词',
  '{{input}} 被作者输入替换'
)
assert(
  buildSkillPrompt('ctx={{context}}; in={{input}}', 'A', 'B') === 'ctx=A; in=B',
  '两个占位符同时替换'
)
assert(
  buildSkillPrompt('{{ context }} 和 {{ input }}', 'X', 'Y') === 'X 和 Y',
  '带空格的占位符也能识别'
)
assert(buildSkillPrompt('', 'a', 'b') === '', '空模板返回空串')
assert(
  buildSkillPrompt('只有{{context}}', '') === '只有',
  '缺失的 context 替换为空串'
)
assert(
  buildSkillPrompt('只有{{input}}', 'ctx') === '只有',
  '缺失的 input 替换为空串'
)
assert(
  buildSkillPrompt('重复 {{context}} {{context}}', 'v') === '重复 v v',
  '同一占位符可多次出现'
)

/* ---- seedBuiltinSkills ---- */

const seeds = seedBuiltinSkills()
assert(seeds.length === 7, '内置 Skill 数量为 7')
assert(seeds.every((s) => s.builtin === true), '内置 Skill 的 builtin 标记为真')
assert(seeds.every((s) => s.template.trim().length > 0), '内置 Skill 模板非空')
assert(
  seeds.every((s) => s.template.includes('{{context}}')),
  '内置 Skill 模板都含 {{context}} 占位符'
)
const ids = seeds.map((s) => s.id)
assert(new Set(ids).size === ids.length, '内置 Skill id 唯一')
assert(
  ids.every((id) => id.startsWith('builtin-')),
  '内置 Skill id 带 builtin- 前缀（稳定 slug）'
)

/* ---- 运行两次种子，id 应一致（稳定可去重播种） ---- */

const seeds2 = seedBuiltinSkills()
assert(
  seeds2.map((s) => s.id).join(',') === ids.join(','),
  '两次播种的 id 顺序与值稳定一致'
)

console.log(`\nP2-3 纯逻辑测试：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
