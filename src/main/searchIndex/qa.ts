/* ============================================
 * 与本地文件对话（Chat with Files）
 * 移植自 awesome-llm-apps 的 RAG / Chat with X 模式，并含 CRAG 检索质量增强。
 *
 * 复用：
 *   - Indexer.queryChunks()（分词 / 切分 / 倒排检索，本地、离线）
 *   - ai.ts complete()（云端 LLM 生成，由调用方注入，保持本文件无 electron 依赖）
 *
 * 设计要点：
 *   - 纯逻辑、不引入 electron，便于无头测试与复用。
 *   - 离线优先：检索本地完成；仅生成阶段走云端 LLM；LLM 不可用时降级为「仅检索」。
 *   - graded 模式 = CRAG：扩召回 → LLM 相关性自检 → 不足则改写查询重召回。
 * ============================================================ */

import { getLogger } from '../tools/logger.ts'
import type {
  AiChatMessage,
  QaPrefs,
  ToolAwareLlm,
  ToolBridge
} from '../../shared/types.ts'
import type { AskRequest, AskResult, QaCitation, QaMode } from '../../shared/types.ts'
import type { ScoredChunk } from './types.ts'
import { selectContext } from './contextOptimizer.ts'
import type { ContextSelection } from './contextOptimizer.ts'

const logger = getLogger('searchIndex:qa')

/** LLM 调用契约（工具感知，与 ai.ts complete 一致），可注入以便测试 */
export type CompleteFn = ToolAwareLlm

/** Indexer 上 QaService 所需的检索接口（便于注入假实现测试） */
export interface QaIndexerLike {
  queryChunks(q: string, topK?: number, scope?: string): ScoredChunk[]
}

export interface QaOptions {
  defaultTopK?: number
  /** 喂给 LLM 的每段上下文最大字符数（软上限，默认 600） */
  maxContextChars?: number
  /** 引用片段最大字符数 */
  maxSnippetChars?: number
  /** 上下文 token 总预算（含系统提示与问题占位，默认 3000） */
  maxTokens?: number
  /** 系统提示与问题预留 token（默认 400） */
  reservedTokens?: number
}

export class QaService {
  private indexer: QaIndexerLike
  private llm: CompleteFn
  private opts: QaOptions
  /** 可选的工具桥（MCP 等）：存在时问答可调用外部工具后再生成答案 */
  private bridge?: ToolBridge

  constructor(indexer: QaIndexerLike, llm: CompleteFn, opts: QaOptions = {}, bridge?: ToolBridge) {
    this.indexer = indexer
    this.llm = llm
    this.opts = opts
    this.bridge = bridge
  }

  async ask(req: AskRequest): Promise<AskResult> {
    const mode: QaMode = req.mode ?? 'graded'
    const topK = Math.max(1, req.topK ?? 6)
    const chunks = await this.retrieve(req.question, topK, mode, req.scope)

    if (!chunks.length) {
      return {
        ok: true,
        answer: '未在本地索引中检索到相关内容。请先对目标文件执行索引（searchIndex.ingest）。',
        citations: [],
        usedChunks: 0,
        mode,
        answerMode: 'empty'
      }
    }

    const sel = selectContext(chunks, {
      maxTokens: req.maxTokens ?? this.opts.maxTokens ?? 3000,
      reservedTokens: this.opts.reservedTokens ?? 400,
      maxContextChars: this.opts.maxContextChars ?? 600
    })
    const context = this.renderContext(sel)
    const prefs = req.prefs ?? {}
    const messages = this.buildMessages(req.question, context, prefs)

    // 工具桥存在：先让 LLM 按需调用外部工具（如 MCP），再生成最终答案
    if (this.bridge) {
      const loop = await this.bridge.runToolLoop(this.llm, messages, { maxIterations: 4 })
      if (!loop.ok) {
        logger.warning(`工具增强问答失败，降级为仅检索: ${loop.error ?? '空响应'}`)
        return {
          ok: false,
          answer: context,
          citations: this.toCitations(sel, prefs),
          usedChunks: sel.selectedCount,
          mode,
          answerMode: 'retrieval-only',
          contextTokens: sel.totalTokens,
          truncated: sel.truncated,
          mcpToolCalls: loop.invocations.length ? loop.invocations : undefined,
          error: loop.error ?? 'LLM 未返回内容'
        }
      }
      return {
        ok: true,
        answer: loop.answer,
        citations: this.toCitations(sel, prefs),
        usedChunks: sel.selectedCount,
        mode,
        answerMode: 'generated',
        contextTokens: sel.totalTokens,
        truncated: sel.truncated,
        mcpToolCalls: loop.invocations.length ? loop.invocations : undefined
      }
    }

    const res = await this.llm(messages)

    // LLM 不可用 → 降级为「仅检索」，返回拼接的检索片段
    if (!res.ok || !res.text) {
      logger.warning(`问答生成失败，降级为仅检索: ${res.error ?? '空响应'}`)
      return {
        ok: false,
        answer: context,
        citations: this.toCitations(sel, prefs),
        usedChunks: sel.selectedCount,
        mode,
        answerMode: 'retrieval-only',
        contextTokens: sel.totalTokens,
        truncated: sel.truncated,
        error: res.error ?? 'LLM 未返回内容'
      }
    }

    return {
      ok: true,
      answer: res.text,
      citations: this.toCitations(sel, prefs),
      usedChunks: sel.selectedCount,
      mode,
      answerMode: 'generated',
      contextTokens: sel.totalTokens,
      truncated: sel.truncated
    }
  }

  /** 检索：basic=直接召回 topK；graded=CRAG（扩召回→LLM 相关性自检→不足则改写查询重召回） */
  private async retrieve(
    q: string,
    topK: number,
    mode: QaMode,
    scope?: string
  ): Promise<ScoredChunk[]> {
    if (mode === 'basic') return this.indexer.queryChunks(q, topK, scope)

    const candidates = this.indexer.queryChunks(q, topK * 2, scope)
    if (!candidates.length) return []

    const graded = await this.grade(q, candidates)
    let kept = graded.filter((g) => g.relevant).map((g) => g.chunk)

    const minRelevant = Math.max(2, Math.ceil(topK / 2))
    if (kept.length < minRelevant) {
      const alt = await this.reformulate(q, candidates)
      if (alt && alt !== q) {
        const more = this.indexer.queryChunks(alt, topK, scope)
        const merged = new Map(more.map((c) => [c.id, c]))
        for (const c of candidates) merged.set(c.id, c)
        kept = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, topK)
      } else {
        kept = candidates.slice(0, topK)
      }
    }
    return kept.slice(0, topK)
  }

  /** CRAG 相关性自检：让 LLM 判定哪些候选块与问题相关 */
  private async grade(
    q: string,
    candidates: ScoredChunk[]
  ): Promise<Array<{ chunk: ScoredChunk; relevant: boolean }>> {
    const numbered = candidates
      .map((c, i) => `[${i + 1}] ${c.text.slice(0, 300)}`)
      .join('\n\n')
    const messages: AiChatMessage[] = [
      {
        role: 'system',
        content:
          '你是检索质量评估器。判断每个候选文本片段是否与用户问题相关、可用于作答。仅输出 JSON 数组，元素形如 {"idx": 编号, "relevant": true}。不要输出其他内容。'
      },
      {
        role: 'user',
        content: `问题：${q}\n\n候选片段：\n${numbered}\n\n请输出相关性判定 JSON 数组。`
      }
    ]
    const res = await this.llm(messages)
    if (!res.ok || !res.text) {
      // 评估失败 → 保守保留全部候选
      return candidates.map((c) => ({ chunk: c, relevant: true }))
    }
    try {
      const arr = JSON.parse(this.extractJson(res.text)) as Array<{ idx: number; relevant: boolean }>
      const relevantSet = new Set(arr.filter((x) => x.relevant).map((x) => x.idx))
      return candidates.map((c, i) => ({ chunk: c, relevant: relevantSet.has(i + 1) }))
    } catch {
      return candidates.map((c) => ({ chunk: c, relevant: true }))
    }
  }

  /** CRAG 查询改写：相关性不足时，让 LLM 生成更优检索词 */
  private async reformulate(q: string, candidates: ScoredChunk[]): Promise<string | null> {
    const keywords = candidates
      .flatMap((c) => c.text.split(/\s+/).filter(Boolean).slice(0, 20))
      .join(' ')
    const messages: AiChatMessage[] = [
      {
        role: 'system',
        content:
          '你是检索查询改写器。根据用户问题与已有片段，生成一个更可能命中相关内容的简短检索查询（≤30 字，仅输出查询文本，不要解释）。'
      },
      {
        role: 'user',
        content: `原问题：${q}\n已有片段关键词：${keywords}\n请生成改写后的检索查询：`
      }
    ]
    const res = await this.llm(messages)
    if (!res.ok || !res.text) return null
    return res.text.trim().replace(/[。.？?！!，,、\n]/g, ' ').slice(0, 60).trim() || null
  }

  private renderContext(sel: ContextSelection): string {
    return sel.items
      .map(
        (it) =>
          `【${it.index}】文件：${it.filePath}${it.heading ? `（${it.heading}）` : ''}${it.truncated ? '（已截断）' : ''}\n${it.text}`
      )
      .join('\n\n')
  }

  private buildMessages(question: string, context: string, prefs: QaPrefs): AiChatMessage[] {
    const style =
      prefs.answerStyle === 'detailed'
        ? '回答应详尽展开，包含必要的背景与细节。'
        : '回答应简洁凝练，直击要点。'
    const lang = prefs.language ? `回答语言使用${prefs.language}。` : '回答使用中文。'
    const system: AiChatMessage = {
      role: 'system',
      content: `你是灵墨工作台的本地文件问答助手。仅依据【参考内容】作答，使用 [n] 标注引用对应片段编号；若参考内容不足以回答，明确说明「根据本地索引内容无法回答」。${style}${lang}`
    }
    const user: AiChatMessage = {
      role: 'user',
      content: `问题：${question}\n\n参考内容：\n${context}`
    }
    return [system, user]
  }

  private toCitations(sel: ContextSelection, prefs: QaPrefs): QaCitation[] {
    const capped =
      prefs.maxCitations && prefs.maxCitations > 0
        ? sel.items.slice(0, prefs.maxCitations)
        : sel.items
    const max = this.opts.maxSnippetChars ?? 200
    return capped.map((it) => ({
      index: it.index,
      filePath: it.filePath,
      startChar: it.startChar,
      snippet: it.text.slice(0, max),
      heading: it.heading
    }))
  }

  /** 从 LLM 文本中提取首个 JSON 片段（容错） */
  private extractJson(text: string): string {
    const a1 = text.indexOf('[')
    const b1 = text.lastIndexOf(']')
    if (a1 >= 0 && b1 > a1) return text.slice(a1, b1 + 1)
    const a2 = text.indexOf('{')
    const b2 = text.lastIndexOf('}')
    if (a2 >= 0 && b2 > a2) return text.slice(a2, b2 + 1)
    return text
  }
}
