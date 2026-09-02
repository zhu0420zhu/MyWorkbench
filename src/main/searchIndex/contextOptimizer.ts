/* ============================================
 * 上下文窗口优化（Token / Context Budget）
 * 移植自 awesome-llm-apps 的「Token / 上下文优化」类应用：
 *   在把检索片段喂给 LLM 前，按模型上下文窗口预算做「智能选择 + 压缩」，
 *   避免超出上下文窗导致生成失败，同时尽量保留高相关信息。
 *
 * 设计要点：
 *   - 纯逻辑、零外部依赖（不引入 tiktoken 等），用中英文混合启发式估算 token。
 *   - 估算法仅用于「预算分配」，非精确计费，足够驱动上下文裁剪决策。
 *   - 选择策略：按检索评分降序贪心填充；单块超限则截断（优先保留句/段边界），
 *     仍超剩余预算则停止并标记 truncated。引用编号在选集内连续稳定。
 * ============================================================ */

import type { ScoredChunk } from './types.ts'

/* ---- Token 估算 ---- */

/**
 * 粗略 token 估算（中英文混合，无需外部依赖）。
 * - CJK 统一表意文字/全角符号：约 0.6 token/字符（1 字≈1~2 token，取保守值）。
 * - 拉丁字母/数字/半角标点：约 0.25 token/字符（≈4 字符/token）。
 * - 空白不计入。
 * 用于上下文预算分配，非精确计费。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let latin = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (
      // CJK 统一表意文字（含扩展 A）、CJK 符号与标点、全角 Forms、假名、谚文
      (code >= 0x3000 && code <= 0x303f) || // CJK 符号和标点
      (code >= 0x3040 && code <= 0x30ff) || // 平/片假名
      (code >= 0x3400 && code <= 0x9fff) || // CJK 扩展 A + 基本汉字
      (code >= 0xac00 && code <= 0xd7af) || // 谚文音节
      (code >= 0xf900 && code <= 0xfaff) || // 兼容表意文字
      (code >= 0xff00 && code <= 0xffef) // 全角 ASCII / 全角标点
    ) {
      cjk++
    } else if (!/\s/.test(ch)) {
      latin++
    }
  }
  const t = cjk * 0.6 + latin * 0.25
  return Math.max(1, Math.round(t))
}

/* ---- 预算选择 ---- */

export interface ContextItem {
  /** 1-based 稳定引用编号（对应回答中的 [n]） */
  index: number
  filePath: string
  heading?: string
  text: string
  startChar: number
  /** 该块是否被 token/字符预算截断 */
  truncated: boolean
  origin?: string
}

export interface ContextBudget {
  /** 上下文 token 总预算（含 system + 问题占位，由 reservedTokens 预留） */
  maxTokens: number
  /** 系统提示与问题预留 token（默认 400） */
  reservedTokens?: number
  /** 单块字符软上限（保留旧行为，默认 600） */
  maxContextChars?: number
  /** 单块 token 软上限（可选；设了则单块超此被截断但不丢块） */
  perChunkTokens?: number
}

export interface ContextSelection {
  items: ContextItem[]
  totalTokens: number
  /** 是否有块被截断，或预算不足以容纳全部候选（上下文被压缩） */
  truncated: boolean
  selectedCount: number
  skippedCount: number
}

/**
 * 按 token 预算从已排序（评分降序）的检索块中选择上下文。
 * 不改变输入顺序，仅做选择/截断；引用编号在选集内连续重排。
 */
export function selectContext(chunks: ScoredChunk[], budget: ContextBudget): ContextSelection {
  const reserved = budget.reservedTokens ?? 400
  const maxChars = budget.maxContextChars ?? 600
  const perChunkTok = budget.perChunkTokens
  const budgetTokens = Math.max(0, budget.maxTokens - reserved)

  const items: ContextItem[] = []
  let total = 0
  let truncated = false
  let idx = 0

  for (const c of chunks) {
    // 1) 单块字符软上限（保留既有行为）
    let text = c.text.length > maxChars ? c.text.slice(0, maxChars) : c.text
    // 2) 单块 token 软上限
    if (perChunkTok && estimateTokens(text) > perChunkTok) {
      text = truncateToTokens(text, perChunkTok)
      truncated = true
    }
    const tok = estimateTokens(text)
    // 3) 总预算判断
    if (total + tok > budgetTokens) {
      const remain = budgetTokens - total
      if (remain >= 50 && tok > remain) {
        const cut = truncateToTokens(text, remain)
        if (cut.trim().length > 0) {
          idx++
          items.push({
            index: idx,
            filePath: c.filePath,
            heading: c.heading,
            text: cut,
            startChar: c.startChar,
            truncated: true,
            origin: c.origin
          })
          total += estimateTokens(cut)
          truncated = true
        }
      }
      break
    }
    idx++
    items.push({
      index: idx,
      filePath: c.filePath,
      heading: c.heading,
      text,
      startChar: c.startChar,
      truncated: false,
      origin: c.origin
    })
    total += tok
  }

  const skipped = Math.max(0, chunks.length - idx)
  return {
    items,
    totalTokens: total,
    // 截断块 或 因预算丢弃候选项，均视为「上下文被压缩」
    truncated: truncated || skipped > 0,
    selectedCount: items.length,
    skippedCount: skipped
  }
}

/**
 * 按 token 预算截断文本：优先保留句/段边界（。！？；换行），
 * 退化到逐字符逼近。始终保留开头部分。
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text
  const sentences = text.split(/(?<=[。！？.!?；;\n])/)
  let acc = ''
  for (const s of sentences) {
    if (estimateTokens(acc + s) > maxTokens) break
    acc += s
  }
  if (acc.trim().length > 0) return acc.trimEnd()
  // 退化：逐字符逼近
  let cut = text
  while (cut.length > 1 && estimateTokens(cut) > maxTokens) {
    cut = cut.slice(0, Math.ceil(cut.length * 0.9))
  }
  return cut
}
