/**
 * 上下文编排器 —— 纯逻辑内核（不依赖 electron，可无头单测）
 *
 * **它解决什么问题**：长篇写作里 AI 犯的绝大多数"蠢错误"不是文笔问题，是失忆——
 * 它不知道三章前主角断了一只手，不知道反派已经死了，不知道这个法术有冷却。
 * 把"这一章该看什么"显式地组装成一个可见、可编辑的 Bundle，比往 prompt 里
 * 无脑塞最近 N 万字可靠得多，也更省 token。
 *
 * **为什么块要有优先级**：预算不够时必须有取舍。优先级从高到低是
 *   作品设定 → 本章细纲 → 上一章结尾 → 出场实体 → 摘要链 → 检索片段 → 备忘。
 * 前三者是"写这一章的地基"，后三者是"参考资料"，先砍参考资料。
 *
 * **为什么摘要链不直接塞前文全文**：5000 字 × 5 章 = 2.5 万字，直接吃掉大半窗口，
 * 而其中真正影响本章的通常只有几句话。细纲是作者自己写的压缩表示，
 * 比让模型临时总结更准，也不额外花 token。
 */
import type { ContextBlock, ContextBlockKind, BuildContextOptions, EntityState } from '../../shared/types.ts'
import { ENTITY_KIND_META } from '../../shared/types.ts'
import { estimateTokens, truncateToTokens } from '../searchIndex/contextOptimizer.ts'

/** 块的优先级：数字越小越重要，超预算时从大到小砍 */
const PRIORITY: Record<ContextBlockKind, number> = {
  synopsis: 0,
  outline: 1,
  'prev-tail': 2,
  entities: 3,
  'summary-chain': 4,
  retrieval: 5,
  note: 6
}

export interface ChapterBrief {
  id: string
  title: string
  summary: string
  volumeTitle: string
}

export interface EntityBrief {
  id: string
  name: string
  kind: EntityKindName
  tagline: string
  content: string
  pinned: boolean
  /** 截至本章已生效的动态状态（按时间升序） */
  states: EntityState[]
  /** 与本章其它出场实体的一跳关系 */
  relations: Array<{ targetName: string; label: string; bidirectional: boolean }>
  /** 本章出现次数 */
  mentions: number
}

type EntityKindName = keyof typeof ENTITY_KIND_META

export interface RetrievalHit {
  chapterTitle: string
  text: string
  score: number
}

export interface ContextBuildData {
  projectTitle: string
  genre: string
  synopsis: string
  chapterTitle: string
  chapterSummary: string
  /** 当前章之前的所有章节（按全书顺序） */
  previous: ChapterBrief[]
  /** 上一章正文（取结尾用） */
  prevChapterContent: string
  entities: EntityBrief[]
  retrieval: RetrievalHit[]
  /** 作者钉住的备忘 */
  pinnedNotes: string[]
}

const DEFAULTS = {
  summaryDepth: 4,
  prevTailChars: 800,
  retrievalTopK: 3,
  budgetTokens: 24000,
  maxEntities: 12,
  entityChars: 400
}

function cut(text: string, max: number): string {
  const t = (text ?? '').trim()
  if (t.length <= max) return t
  return `${t.slice(0, max).trimEnd()}…`
}

let seq = 0
function block(
  kind: ContextBlockKind,
  title: string,
  text: string,
  removable: boolean
): ContextBlock {
  seq += 1
  const body = text.trim()
  return {
    id: `${kind}-${seq}`,
    kind,
    title,
    text: body,
    tokens: estimateTokens(body),
    enabled: body.length > 0,
    removable,
    order: PRIORITY[kind]
  }
}

/* ------------------------------ 组装 ------------------------------ */

export function buildContextBlocks(
  data: ContextBuildData,
  opts: BuildContextOptions = {}
): ContextBlock[] {
  const o = { ...DEFAULTS, ...opts }
  const blocks: ContextBlock[] = []

  /* 1. 作品设定 */
  {
    const lines = [`书名：${data.projectTitle}`]
    if (data.genre) lines.push(`题材：${data.genre}`)
    if (data.synopsis) lines.push(`梗概：${data.synopsis}`)
    blocks.push(block('synopsis', '作品设定', lines.join('\n'), false))
  }

  /* 2. 前文摘要链：只取最近 summaryDepth 章的细纲
     不自己编章节序号：作者的章节标题通常已经带"（第 28 章）"，再叠一个算出来的
     序号，一旦作者跳过某章或调整顺序，两个数字就会打架，反而误导模型。 */
  {
    const chain = data.previous.slice(-o.summaryDepth)
    const text = chain
      .map((c) => {
        const s = c.summary.trim()
        const head = c.volumeTitle ? `${c.volumeTitle} · ${c.title || '（未命名）'}` : c.title || '（未命名）'
        return `- ${head}：${s || '（未写细纲）'}`
      })
      .join('\n')
    blocks.push(
      block(
        'summary-chain',
        `前文摘要链（最近 ${chain.length} 章）`,
        chain.length ? `【前文进展】\n${text}` : '',
        true
      )
    )
  }

  /* 3. 上一章结尾原文 */
  {
    const tail = cut(data.prevChapterContent, o.prevTailChars)
    blocks.push(
      block(
        'prev-tail',
        '上一章结尾',
        tail ? `【上一章结尾原文】\n${tail}` : '',
        true
      )
    )
  }

  /* 4. 本章细纲 */
  {
    blocks.push(
      block(
        'outline',
        '本章细纲',
        data.chapterSummary.trim()
          ? `【本章细纲】\n${data.chapterSummary.trim()}`
          : '',
        false
      )
    )
  }

  /* 5. 本章出场实体：钉住的优先，其次按出场次数 */
  {
    const picked = [...data.entities]
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.mentions - a.mentions
      })
      .slice(0, o.maxEntities)

    const parts = picked.map((e) => {
      const lines = [`### ${e.name}（${ENTITY_KIND_META[e.kind].label}）`]
      if (e.tagline) lines.push(e.tagline)
      const body = cut(e.content, o.entityChars)
      if (body) lines.push(body)
      // 动态状态是长篇一致性的命门：只放"截至本章已生效"的
      if (e.states.length) {
        lines.push(`当前状态：${e.states.map((s) => s.text).join('；')}`)
      }
      if (e.relations.length) {
        lines.push(
          `关系：${e.relations
            .map((r) => `${r.bidirectional ? '⟷' : '→'} ${r.targetName}（${r.label}）`)
            .join('，')}`
        )
      }
      return lines.join('\n')
    })

    blocks.push(
      block(
        'entities',
        `本章出场实体（${picked.length}）`,
        parts.length ? `【本章出场设定】\n${parts.join('\n\n')}` : '',
        true
      )
    )
  }

  /* 6. 检索召回的旧章片段 */
  {
    const hits = data.retrieval.slice(0, o.retrievalTopK)
    const text = hits
      .map((h) => `> 出自《${h.chapterTitle}》\n${cut(h.text, 400)}`)
      .join('\n\n')
    blocks.push(
      block('retrieval', `相关旧章片段（${hits.length}）`, text ? `【相关前文回忆】\n${text}` : '', true)
    )
  }

  /* 7. 钉住备忘 */
  {
    const notes = data.pinnedNotes.map((n) => n.trim()).filter(Boolean)
    blocks.push(
      block('note', '钉住的备忘', notes.length ? notes.map((n) => `- ${n}`).join('\n') : '', true)
    )
  }

  return blocks.sort((a, b) => a.order - b.order)
}

/* ------------------------------ 预算裁剪 ------------------------------ */

export interface BudgetResult {
  blocks: ContextBlock[]
  totalTokens: number
  /** 因超预算被自动关闭的块标题 */
  trimmed: string[]
}

/**
 * 按预算裁剪：从优先级最低的块开始关闭，直到装得下；
 * 若只剩最高优先级仍超预算，则截断它的正文（宁可少给，也不能让请求超限失败）。
 */
export function applyBudget(blocks: ContextBlock[], budgetTokens: number): BudgetResult {
  const list = blocks.map((b) => ({ ...b }))
  const trimmed: string[] = []
  const sum = () => list.filter((b) => b.enabled).reduce((s, b) => s + b.tokens, 0)

  // 优先级从低到高关闭
  const byDropOrder = [...list].sort((a, b) => b.order - a.order)
  for (const b of byDropOrder) {
    if (sum() <= budgetTokens) break
    if (!b.enabled) continue
    // 至少留一块：预算给得再小，也不能把上下文清空后照常发请求——
    // 那比超预算更糟，模型会以为"没有前文"而胡编。剩下的交给下面的截断处理。
    if (list.filter((x) => x.enabled).length <= 1) break
    b.enabled = false
    trimmed.push(b.title)
  }

  // 仍超预算：截断还开着的最高优先级块
  if (sum() > budgetTokens) {
    const open = list.filter((b) => b.enabled).sort((a, b) => a.order - b.order)
    let remain = budgetTokens
    for (const b of open) {
      if (b.tokens <= remain) {
        remain -= b.tokens
        continue
      }
      b.text = truncateToTokens(b.text, Math.max(200, remain))
      b.tokens = estimateTokens(b.text)
      remain = 0
      trimmed.push(`${b.title}（已截断）`)
    }
  }

  return { blocks: list, totalTokens: sum(), trimmed }
}

/* ------------------------------ 渲染为提示词 ------------------------------ */

/** 把已启用的块渲染成一段给模型的参考材料（不含指令，指令由调用方给） */
export function renderBundlePrompt(
  blocks: ContextBlock[],
  header = '以下是写本章时必须遵守的参考资料：'
): string {
  const on = blocks.filter((b) => b.enabled && b.text.trim())
  if (!on.length) return ''
  return [`${header}\n`, ...on.map((b) => b.text), ''].join('\n')
}

/** 重新计算 tokens（面板里手动编辑文本后调用） */
export function recountTokens(blocks: ContextBlock[]): ContextBlock[] {
  return blocks.map((b) => ({ ...b, tokens: estimateTokens(b.text) }))
}
