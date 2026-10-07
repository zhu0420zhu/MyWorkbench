/**
 * 角色卡存盘缺陷修复探针（PNG/json 双源数据丢失）
 * =================================================
 * 复现并验证修复：
 *   ① 对 PNG 卡编辑保存必须回写 PNG（旧实现只写 .json → 永远读不到 → 静默丢数据）
 *   ② updateCharacterAvatar 换头像不得回滚刚编辑的内容
 *   ③ embedCharaInPng 必须去重（反复保存不得让 chara chunk 累积膨胀）
 *
 * 断言：
 *   a. pngCards 纯逻辑：最小合法 PNG → embed → extract 一致；连续 embed 3 次后取到最后一次
 *      JSON、chara tEXt chunk 只有 1 个、非 chara 字节段与首次一致；
 *   b. charCards：PNG 卡 saveCharacter 改 name + extensions.lingmoSkills → .png 被更新、
 *      .json 不存在、getCharacter 读回新卡；
 *   c. 回归：纯 JSON 卡（无 png）saveCharacter 仍写 .json 且读回正确；
 *   d. updateCharacterAvatar：先 saveCharacter 改内容 → 再换图 → 内容不丢、hasAvatar=true、无 .json。
 *   e. 未知顶层字段往返零损：含 character_book（内嵌世界书）/group_only_greetings/creation_date 的
 *      卡片经 read → save → read 往返，这些顶层字段逐字段深比较相等；PNG 与纯 JSON 两条路径都测，
 *      并回归 14 个 V2 字段与 extensions.lingmoSkills；老数据（无未知字段）读取不报错、不产生 __extra。
 *
 * 运行（emit 前 / 复跑）：
 *   NODE_OPTIONS="" node --experimental-loader=./tests/loader.mjs --experimental-strip-types tests/charcard-probe.mjs
 * 或：npm run probe:charcard
 */
import { deflateSync } from 'node:zlib'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import { embedCharaInPng, extractCharaFromPng, isPng } from '../src/main/sillytavern/pngCards'
import { saveCharacter, getCharacter, updateCharacterAvatar } from '../src/main/sillytavern/charCards'
import { charactersDir } from '../src/main/sillytavern/dataStore'

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log('  [PASS] ' + name + (detail ? '  ' + detail : ''))
  } else {
    fail++
    console.log('  [FAIL] ' + name + (detail ? '  ' + detail : ''))
  }
}

/* ---------- 最小合法 PNG（1x1 RGBA 红点），正确 CRC ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
function makePng(seed = 0) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0) // width
  ihdr.writeUInt32BE(1, 4) // height
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const raw = Buffer.from([0x00, 0x10 + (seed & 0x7f), 0x20, 0x30, 0xff]) // filter0 + RGBA
  const idat = deflateSync(raw)
  const iend = pngChunk('IEND', Buffer.alloc(0))
  return new Uint8Array(Buffer.concat([PNG_SIG, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), iend]))
}

/* ---------- 独立 chunk 解析（不信任被测模块实现） ---------- */
function walkChunks(bytes) {
  const buf = Buffer.from(bytes)
  const out = []
  let offset = 8
  while (offset + 12 <= buf.length) {
    const len = buf.readUInt32BE(offset)
    const dataStart = offset + 8
    const dataEnd = dataStart + len
    const crcEnd = dataEnd + 4
    if (crcEnd > buf.length) break
    const type = buf.toString('ascii', offset + 4, offset + 8)
    let keyword = null
    if (type === 'tEXt') {
      let nul = dataStart
      while (nul < dataEnd && buf[nul] !== 0) nul++
      if (nul < dataEnd) keyword = buf.toString('latin1', dataStart, nul)
    }
    out.push({ type, keyword, raw: buf.slice(offset, crcEnd) })
    offset = crcEnd
  }
  return out
}
function countCharaChunks(bytes) {
  return walkChunks(bytes).filter((c) => c.type === 'tEXt' && c.keyword === 'chara').length
}
/** 剔除所有 chara tEXt 后的字节（签名 + 其它 chunk 原样），用于比对「非 chara 段一致」 */
function nonCharaBytes(bytes) {
  const buf = Buffer.from(bytes)
  const kept = walkChunks(bytes)
    .filter((c) => !(c.type === 'tEXt' && c.keyword === 'chara'))
    .map((c) => c.raw)
  return Buffer.concat([buf.slice(0, 8), ...kept])
}

async function exists(p) {
  return fs.access(p).then(
    () => true,
    () => false
  )
}

/** 深比较（node:assert.deepStrictEqual），转成布尔给 ok() */
function deepEq(a, b) {
  try {
    assert.deepStrictEqual(a, b)
    return true
  } catch {
    return false
  }
}

const CARD1 = {
  name: '旧名',
  description: '原始描述',
  personality: '',
  scenario: '',
  first_mes: '',
  mes_example: '',
  creator_notes: '',
  system_prompt: '',
  post_history_instructions: '',
  alternate_greetings: [],
  tags: ['t1'],
  creator: 'probe',
  character_version: '1',
  extensions: {}
}

async function main() {
  /* ================= a. pngCards 纯逻辑 ================= */
  console.log('\n[a] pngCards：embed/extract 往返 + 去重')
  const base = makePng()
  ok('构造的最小 PNG 被 isPng 认可', isPng(base), `len=${base.length}`)

  const j1 = JSON.stringify({ name: '第一版' })
  const j2 = JSON.stringify({ name: '第二版' })
  const j3 = JSON.stringify({ name: '第三版' })

  const e1 = embedCharaInPng(base, j1)
  ok('embed 后 extract 取回一致', extractCharaFromPng(e1) === j1)
  ok('首次 embed chara chunk 数 = 1', countCharaChunks(e1) === 1, `got=${countCharaChunks(e1)}`)
  ok('首次 embed 非 chara 段 == 原始 PNG', nonCharaBytes(e1).equals(Buffer.from(base)))

  const e2 = embedCharaInPng(e1, j2)
  const e3 = embedCharaInPng(e2, j3)
  ok('连续 embed 3 次后 extract 为最后一次 JSON', extractCharaFromPng(e3) === j3, `got=${extractCharaFromPng(e3)}`)
  ok('连续 embed 3 次后 chara chunk 仍只有 1 个', countCharaChunks(e3) === 1, `got=${countCharaChunks(e3)}`)
  ok(
    '非 chara 字节段与首次一致（不膨胀、不改其它 chunk）',
    nonCharaBytes(e3).equals(nonCharaBytes(e1)),
    `len3=${e3.length}`
  )
  // 额外：直接对同一 PNG 重复 embed 也去重
  const eAgain = embedCharaInPng(embedCharaInPng(base, j1), j1)
  ok('同源重复 embed chara chunk 数 = 1', countCharaChunks(eAgain) === 1, `got=${countCharaChunks(eAgain)}`)

  /* ================= b. PNG 卡 saveCharacter ================= */
  console.log('\n[b] charCards：PNG 卡编辑保存回写 PNG')
  const dir = charactersDir()
  await fs.mkdir(dir, { recursive: true })

  const idB = 'probe_png_card'
  const pngPathB = join(dir, `${idB}.png`)
  const jsonPathB = join(dir, `${idB}.json`)
  await fs.writeFile(pngPathB, Buffer.from(embedCharaInPng(base, JSON.stringify(CARD1))))
  await fs.rm(jsonPathB, { force: true })

  const edited = {
    ...CARD1,
    name: '新名',
    extensions: { lingmoSkills: ['技能A', '技能B'] }
  }
  const savedB = await saveCharacter(idB, edited)
  ok('saveCharacter 返回 hasAvatar=true', savedB.hasAvatar === true)

  const pngNow = await fs.readFile(pngPathB)
  const inner = extractCharaFromPng(new Uint8Array(pngNow))
  const innerCard = inner ? JSON.parse(inner) : null
  ok('PNG 内嵌 JSON 已含新 name', innerCard?.name === '新名', `got=${innerCard?.name}`)
  ok(
    'PNG 内嵌 JSON 已含 extensions.lingmoSkills',
    JSON.stringify(innerCard?.extensions?.lingmoSkills) === JSON.stringify(['技能A', '技能B'])
  )
  ok('同 id 的 .json 已被删除（无双份影子）', !(await exists(jsonPathB)))
  ok('PNG 内嵌 chara chunk 只有 1 个', countCharaChunks(pngNow) === 1, `got=${countCharaChunks(pngNow)}`)

  const readB = await getCharacter(idB)
  ok('getCharacter 读回的是新卡（name）', readB?.card.name === '新名', `got=${readB?.card.name}`)
  ok('getCharacter hasAvatar=true', readB?.hasAvatar === true)
  ok(
    'getCharacter 读回 lingmoSkills 未丢',
    JSON.stringify(readB?.card.extensions?.lingmoSkills) === JSON.stringify(['技能A', '技能B'])
  )

  /* ================= c. 纯 JSON 卡回归 ================= */
  console.log('\n[c] charCards：纯 JSON 卡（无 PNG）走原逻辑')
  const idC = 'probe_json_card'
  const pngPathC = join(dir, `${idC}.png`)
  const jsonPathC = join(dir, `${idC}.json`)
  await fs.rm(pngPathC, { force: true })
  await fs.rm(jsonPathC, { force: true })

  const cardC = { ...CARD1, name: 'JSON卡' }
  const savedC = await saveCharacter(idC, cardC)
  ok('无 png 时 saveCharacter 返回 hasAvatar=false', savedC.hasAvatar === false)
  ok('.json 文件已写入', await exists(jsonPathC))
  ok('.png 文件不存在', !(await exists(pngPathC)))
  const readC = await getCharacter(idC)
  ok('JSON 卡 getCharacter 读回正确', readC?.card.name === 'JSON卡' && readC?.hasAvatar === false, `got=${readC?.card.name}`)

  /* ================= d. updateCharacterAvatar 不回滚编辑 ================= */
  console.log('\n[d] charCards：换头像不回滚刚编辑的内容')
  const idD = 'probe_avatar_card'
  const pngPathD = join(dir, `${idD}.png`)
  const jsonPathD = join(dir, `${idD}.json`)
  await fs.writeFile(pngPathD, Buffer.from(embedCharaInPng(base, JSON.stringify(CARD1))))
  await fs.rm(jsonPathD, { force: true })

  const editedD = { ...CARD1, name: '编辑后', extensions: { lingmoSkills: ['保留我'] } }
  await saveCharacter(idD, editedD) // 先编辑保存
  const newAvatar = makePng(99) // 再换一张新图
  const okAvatar = await updateCharacterAvatar(idD, newAvatar)
  ok('updateCharacterAvatar 返回 true', okAvatar === true)

  const readD = await getCharacter(idD)
  ok('换头像后 name 仍是编辑后的值（不丢编辑）', readD?.card.name === '编辑后', `got=${readD?.card.name}`)
  ok(
    '换头像后 lingmoSkills 仍在（不丢编辑）',
    JSON.stringify(readD?.card.extensions?.lingmoSkills) === JSON.stringify(['保留我']),
    `got=${JSON.stringify(readD?.card.extensions?.lingmoSkills)}`
  )
  ok('换头像后 hasAvatar=true', readD?.hasAvatar === true)
  ok('换头像后 .json 不存在', !(await exists(jsonPathD)))
  // 头像确实换成了新图（非 chara 段应与新图一致）
  const pngD = await fs.readFile(pngPathD)
  ok('回写的 PNG 保留新图字节（非 chara 段 == 新图）', nonCharaBytes(pngD).equals(Buffer.from(newAvatar)))
  ok('换头像后 PNG 内 chara chunk 只有 1 个', countCharaChunks(pngD) === 1, `got=${countCharaChunks(pngD)}`)

  /* ================= e. 未知顶层字段 read→save 往返零损 ================= */
  console.log('\n[e] charCards：未知顶层字段（character_book 等）往返零损保留')

  const V2_FIELDS = [
    'name',
    'description',
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
    'creator_notes',
    'system_prompt',
    'post_history_instructions',
    'alternate_greetings',
    'tags',
    'creator',
    'character_version',
    'extensions'
  ]
  // 模拟一张真实 SillyTavern 导出卡：含内嵌世界书 character_book、群聊问候、创建时间等非契约顶层字段
  const CARD_EXTRA = {
    name: '带扩展卡',
    description: '描述',
    personality: '性格',
    scenario: '场景',
    first_mes: '开场白',
    mes_example: '示例',
    creator_notes: '作者注',
    system_prompt: '系统提示',
    post_history_instructions: '后历史指令',
    alternate_greetings: ['备选问候A', '备选问候B'],
    tags: ['标签1', '标签2'],
    creator: '原作者',
    character_version: '2.0',
    extensions: { talkativeness: 0.5, lingmoSkills: ['skill-x'] },
    // —— 以下为非契约顶层字段 ——
    character_book: {
      name: '内嵌世界书',
      description: '随卡携带的 lorebook',
      scan_depth: 2,
      token_budget: 512,
      recursive_scanning: false,
      extensions: { position: 0 },
      entries: [
        { keys: ['龙'], content: '龙会飞。', enabled: true, insertion_order: 100, case_sensitive: false, name: '龙' },
        { keys: ['海'], content: '海很深。', enabled: false, insertion_order: 50, case_sensitive: false, name: '海' }
      ]
    },
    group_only_greetings: ['群聊专用问候'],
    creation_date: 1700000000
  }
  const EXPECTED_EXTRA = {
    character_book: CARD_EXTRA.character_book,
    group_only_greetings: CARD_EXTRA.group_only_greetings,
    creation_date: CARD_EXTRA.creation_date
  }
  const V2_EXPECTED = Object.fromEntries(V2_FIELDS.map((k) => [k, CARD_EXTRA[k]]))

  // ---- e1. PNG 卡路径 ----
  const idE1 = 'probe_extra_png'
  const pngPathE1 = join(dir, `${idE1}.png`)
  const jsonPathE1 = join(dir, `${idE1}.json`)
  await fs.writeFile(pngPathE1, Buffer.from(embedCharaInPng(base, JSON.stringify(CARD_EXTRA))))
  await fs.rm(jsonPathE1, { force: true })

  const readE1 = await getCharacter(idE1)
  ok('PNG：读取后 __extra 收集到 character_book', deepEq(readE1?.card.__extra?.character_book, EXPECTED_EXTRA.character_book))
  ok('PNG：读取后 __extra 收集到 group_only_greetings', deepEq(readE1?.card.__extra?.group_only_greetings, EXPECTED_EXTRA.group_only_greetings))
  ok('PNG：读取后 __extra 收集到 creation_date', readE1?.card.__extra?.creation_date === EXPECTED_EXTRA.creation_date)

  // 编辑一个已知字段后保存（模拟用户改名字再存）
  await saveCharacter(idE1, { ...readE1.card, name: '改名后' })
  const pngBytesE1 = await fs.readFile(pngPathE1)
  const embedE1Json = extractCharaFromPng(new Uint8Array(pngBytesE1))
  const parsedE1 = JSON.parse(embedE1Json)
  ok('PNG：保存后文件顶层 character_book 深比较相等', deepEq(parsedE1.character_book, EXPECTED_EXTRA.character_book))
  ok('PNG：保存后文件顶层 group_only_greetings 深比较相等', deepEq(parsedE1.group_only_greetings, EXPECTED_EXTRA.group_only_greetings))
  ok('PNG：保存后文件顶层 creation_date 相等', parsedE1.creation_date === EXPECTED_EXTRA.creation_date)
  ok('PNG：保存后文件不含内部键 __extra', !('__extra' in parsedE1))
  ok('PNG：保存后 name 是编辑后的值', parsedE1.name === '改名后', `got=${parsedE1.name}`)
  ok(
    'PNG：保存后 14 个 V2 字段仍正确（除被编辑的 name）',
    V2_FIELDS.every((k) => deepEq(parsedE1[k], k === 'name' ? '改名后' : V2_EXPECTED[k]))
  )
  ok('PNG：lingmoSkills 未丢', deepEq(parsedE1.extensions?.lingmoSkills, ['skill-x']))

  const rereadE1 = await getCharacter(idE1)
  ok('PNG：二次读取 __extra 仍逐字段深比较相等', deepEq(rereadE1?.card.__extra, EXPECTED_EXTRA))
  ok('PNG：二次读取 name 为编辑后值', rereadE1?.card.name === '改名后')
  ok('PNG：二次读取 lingmoSkills 未丢', deepEq(rereadE1?.card.extensions?.lingmoSkills, ['skill-x']))

  // ---- e2. 纯 JSON 卡路径 ----
  const idE2 = 'probe_extra_json'
  const pngPathE2 = join(dir, `${idE2}.png`)
  const jsonPathE2 = join(dir, `${idE2}.json`)
  await fs.rm(pngPathE2, { force: true })
  await fs.writeFile(jsonPathE2, JSON.stringify(CARD_EXTRA), 'utf-8')

  const readE2 = await getCharacter(idE2)
  ok('JSON：读取后 __extra 收集到 character_book', deepEq(readE2?.card.__extra?.character_book, EXPECTED_EXTRA.character_book))
  ok('JSON：读取后 hasAvatar=false', readE2?.hasAvatar === false)

  await saveCharacter(idE2, { ...readE2.card, description: '改后的描述' })
  const parsedE2 = JSON.parse(await fs.readFile(jsonPathE2, 'utf-8'))
  ok('JSON：保存后文件顶层 character_book 深比较相等', deepEq(parsedE2.character_book, EXPECTED_EXTRA.character_book))
  ok('JSON：保存后文件顶层 group_only_greetings 深比较相等', deepEq(parsedE2.group_only_greetings, EXPECTED_EXTRA.group_only_greetings))
  ok('JSON：保存后文件顶层 creation_date 相等', parsedE2.creation_date === EXPECTED_EXTRA.creation_date)
  ok('JSON：保存后文件不含内部键 __extra', !('__extra' in parsedE2))
  ok('JSON：保存后 description 是编辑后的值', parsedE2.description === '改后的描述')
  ok(
    'JSON：保存后 14 个 V2 字段仍正确（除被编辑的 description）',
    V2_FIELDS.every((k) => deepEq(parsedE2[k], k === 'description' ? '改后的描述' : V2_EXPECTED[k]))
  )
  ok('JSON：lingmoSkills 未丢', deepEq(parsedE2.extensions?.lingmoSkills, ['skill-x']))

  const rereadE2 = await getCharacter(idE2)
  ok('JSON：二次读取 __extra 仍逐字段深比较相等', deepEq(rereadE2?.card.__extra, EXPECTED_EXTRA))

  // ---- e3. 兼容性：老数据（无未知字段）读取不报错、无 __extra ----
  const idE3 = 'probe_extra_none'
  const jsonPathE3 = join(dir, `${idE3}.json`)
  await fs.rm(join(dir, `${idE3}.png`), { force: true })
  await fs.writeFile(jsonPathE3, JSON.stringify(CARD1), 'utf-8')
  const readE3 = await getCharacter(idE3)
  ok('兼容：无未知字段的老卡读取正常', readE3?.card.name === CARD1.name)
  ok('兼容：无未知字段时不产生 __extra 键', readE3 != null && !('__extra' in readE3.card))

  /* ---------- 汇总 ---------- */
  console.log(`\n==== charcard-probe: ${pass} passed, ${fail} failed ====`)
  if (fail > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('probe crashed:', e)
  process.exitCode = 1
})
