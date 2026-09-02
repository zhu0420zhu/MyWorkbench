/* ============================================================
 * 分类纠正记忆 — 纯逻辑核心（无 electron 依赖，便于无头测试）
 * 移植自 awesome-llm-apps 的 "LLM Apps with Personalized Memory"：
 *   记录用户对分类的纠正（文件扩展名 → 类别），达到阈值后在分类时优先采用，
 *   形成「越用越懂你」的个性化分类。
 * ============================================================ */

import type { ClassificationMemoryEntry } from '../../shared/types.ts'

/** 记忆键：文件扩展名（含点，小写）或 "__noext__" */
function extKeyOf(filePath: string): string {
  const lower = filePath.toLowerCase()
  const i = lower.lastIndexOf('.')
  if (i < 0) return '__noext__'
  // 隐藏文件（如 .gitignore）按整名作为键，避免与常规扩展名混淆
  if (i === lower.lastIndexOf('/') || i === lower.lastIndexOf('\\')) return lower
  return lower.slice(i)
}

export class MemoryCore {
  entries: ClassificationMemoryEntry[] = []

  /** 记录一次纠正（同键累加计数，类别以最新为准） */
  record(filePath: string, category: string): void {
    const pattern = extKeyOf(filePath)
    const idx = this.entries.findIndex((e) => e.pattern === pattern)
    if (idx >= 0) {
      this.entries[idx] = {
        pattern,
        category,
        count: this.entries[idx].count + 1,
        updatedAt: Date.now()
      }
    } else {
      this.entries.push({ pattern, category, count: 1, updatedAt: Date.now() })
    }
  }

  /** 查询学习到的类别：该键学习次数 >= minVotes 时返回其类别，否则 null */
  lookup(filePath: string, minVotes = 2): string | null {
    const pattern = extKeyOf(filePath)
    const e = this.entries.find((x) => x.pattern === pattern)
    if (e && e.count >= minVotes) return e.category
    return null
  }

  list(): ClassificationMemoryEntry[] {
    return [...this.entries]
  }

  clear(): void {
    this.entries = []
  }
}
