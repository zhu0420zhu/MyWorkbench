/**
 * 写作工作流无头冒烟测试（纯逻辑，不引 electron）
 * 跑法：node --experimental-strip-types tests/smoke-workflow.ts
 *
 * 覆盖：
 *   - 5 套内置工作流结构完整
 *   - 题材智能推荐
 *   - 工作流引用的 Skill 全部能被 seedWorkflowSkills / seedBuiltinSkills 覆盖
 *   - 步骤 id 唯一、skill 模板含 {{context}}
 *   - 进度 nextStep 逻辑
 *   - 流畅度：网文快写流步骤顺序符合「设定→大纲→正文→收束」
 */
import {
  builtinWorkflows,
  getWorkflow,
  recommendWorkflowId,
  seedWorkflowSkills,
  workflowSkillIds,
  DEFAULT_WORKFLOW_ID,
  allWorkflowSkillIds
} from '../src/main/novel/workflowCore.ts'
import { seedBuiltinSkills, buildSkillPrompt } from '../src/main/novel/inspirationCore.ts'

let pass = 0
let fail = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++
    console.log('  ✓ ' + msg)
  } else {
    fail++
    console.error('  ✗ ' + msg)
  }
}

console.log('== 工作流清单 ==')
const wfs = builtinWorkflows()
assert(wfs.length === 5, `内置工作流数量 = 5（实际 ${wfs.length}）`)
assert(wfs.some((w) => w.id === DEFAULT_WORKFLOW_ID), `默认流 ${DEFAULT_WORKFLOW_ID} 存在`)
assert(wfs.every((w) => w.steps.length >= 4), '每套流至少 4 步')
assert(wfs.every((w) => w.name.trim().length > 0 && w.description.trim().length > 0), '名称与描述非空')
const wfIds = wfs.map((w) => w.id)
assert(new Set(wfIds).size === wfIds.length, '工作流 id 唯一')

console.log('\n== 题材推荐 ==')
assert(recommendWorkflowId('') === DEFAULT_WORKFLOW_ID, '空题材 → 默认网文快写流')
assert(recommendWorkflowId('玄幻') === 'webnovel-fast', '玄幻 → 网文快写流')
assert(recommendWorkflowId('网文') === 'webnovel-fast', '网文 → 网文快写流')
assert(recommendWorkflowId('奇幻') === 'hero-journey', '奇幻 → 英雄之旅')
assert(recommendWorkflowId('冒险') === 'hero-journey', '冒险 → 英雄之旅')
assert(recommendWorkflowId('结构') === 'snowflake', '结构 → 雪花（标签命中）')
assert(getWorkflow('three-act')?.name === '三幕结构', 'getWorkflow 可取到三幕')
assert(getWorkflow('nope') === null, '未知 id 返回 null')

console.log('\n== Skill 覆盖（工作流引用不得悬空）==')
const wfSkills = seedWorkflowSkills()
const baseSkills = seedBuiltinSkills()
const allSeeds = new Map<string, { template: string; name: string }>()
for (const s of [...wfSkills, ...baseSkills]) allSeeds.set(s.id, s)

let missing: string[] = []
for (const w of wfs) {
  for (const sid of workflowSkillIds(w)) {
    if (!allSeeds.has(sid)) missing.push(`${w.id}→${sid}`)
  }
}
assert(missing.length === 0, `工作流引用的 Skill 全部有种子${missing.length ? '，缺失: ' + missing.join(',') : ''}`)

let badTemplate: string[] = []
for (const w of wfs) {
  for (const sid of workflowSkillIds(w)) {
    const s = allSeeds.get(sid)
    if (s && !s.template.includes('{{context}}') && !s.template.includes('{{input}}')) {
      badTemplate.push(sid)
    }
  }
}
assert(badTemplate.length === 0, `工作流 Skill 模板含占位符${badTemplate.length ? '，异常: ' + badTemplate.join(',') : ''}`)

const wfSkillIds = wfSkills.map((s) => s.id)
assert(new Set(wfSkillIds).size === wfSkillIds.length, '工作流 Skill id 唯一')
assert(wfSkills.every((s) => s.builtin), '工作流 Skill 均为 builtin')
assert(wfSkills.length >= 12, `工作流配套 Skill ≥ 12（实际 ${wfSkills.length}）`)

// 两次播种稳定
const again = seedWorkflowSkills()
assert(again.map((s) => s.id).join() === wfSkillIds.join(), '两次 seedWorkflowSkills id 稳定')

console.log('\n== 步骤结构 ==')
for (const w of wfs) {
  const stepIds = w.steps.map((s) => s.id)
  assert(new Set(stepIds).size === stepIds.length, `${w.id} 步骤 id 唯一`)
  assert(w.steps.every((s) => s.title.trim() && s.hint.trim()), `${w.id} 每步 title/hint 非空`)
  // 至少一半步骤可一键 AI
  const withSkill = w.steps.filter((s) => s.skillId).length
  assert(withSkill >= Math.ceil(w.steps.length / 2), `${w.id} 可运行步骤 ${withSkill}/${w.steps.length} ≥ 一半`)
}

console.log('\n== 网文快写流顺序（流畅度）==')
const web = getWorkflow('webnovel-fast')!
const order = web.steps.map((s) => s.id)
assert(order[0] === 'setup', '第 1 步：开书三件套')
assert(order.includes('core-hook') && order.indexOf('core-hook') < order.indexOf('draft-loop'), '金手指在正文之前')
assert(order.includes('volume-outline') && order.indexOf('volume-outline') < order.indexOf('golden3'), '分卷在黄金三章之前')
assert(order[order.length - 1] === 'audit', '最后一步：一致性自查')
assert(order.includes('hook') && order.indexOf('hook') >= order.indexOf('draft-loop'), '章末钩子在正文之后')

console.log('\n== 进度 nextStep 模拟 ==')
function nextUndone(done: string[], steps: Array<{ id: string }>): string | null {
  const set = new Set(done)
  return steps.find((s) => !set.has(s.id))?.id ?? null
}
assert(nextUndone([], web.steps) === 'setup', '空进度 → 下一步 setup')
assert(nextUndone(['setup'], web.steps) === 'core-hook', '完成 setup → core-hook')
assert(
  nextUndone(web.steps.map((s) => s.id), web.steps) === null,
  '全部完成 → next 为 null'
)

console.log('\n== 模板渲染 ==')
const setup = wfSkills.find((s) => s.id === 'wf-book-setup')!
const prompt = buildSkillPrompt(setup.template, '书名：测试\n题材：玄幻', '要偏轻松')
assert(prompt.includes('书名：测试'), '渲染注入 context')
assert(prompt.includes('要偏轻松'), '渲染注入 input')
assert(!prompt.includes('{{context}}'), '无残留 context 占位符')

console.log('\n== allWorkflowSkillIds 自洽 ==')
const covered = allWorkflowSkillIds()
for (const w of wfs) {
  for (const id of workflowSkillIds(w)) {
    assert(covered.has(id), `allWorkflowSkillIds 含 ${w.id}/${id}`)
  }
}

console.log(`\n工作流冒烟测试：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
