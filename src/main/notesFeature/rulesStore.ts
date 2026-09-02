/* ============================================
 * 智能分类：规则存储 + 关键词命中引擎（rules.json）
 * 职责：分类规则 CRUD；对全部笔记执行自动分类（可被手动调整覆盖）
 * ============================================ */

import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { CategoryRule } from '../../shared/types'
import { readIndex, writeIndex, getAllNotesWithContent } from '../notes'

function rulesFile(): string {
  return join(app.getPath('userData'), 'notes-feature', 'rules.json')
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(join(app.getPath('userData'), 'notes-feature'), { recursive: true })
}

async function readRules(): Promise<CategoryRule[]> {
  try {
    const raw = await fs.readFile(rulesFile(), 'utf-8')
    const parsed = JSON.parse(raw) as { version: number; rules: CategoryRule[] }
    if (parsed && Array.isArray(parsed.rules)) return parsed.rules
    return []
  } catch {
    return []
  }
}

async function writeRules(rules: CategoryRule[]): Promise<void> {
  await ensureDir()
  await fs.writeFile(rulesFile(), JSON.stringify({ version: 1, rules }, null, 2), 'utf-8')
}

export { readRules, writeRules }

export async function listRules(): Promise<CategoryRule[]> {
  return readRules()
}

export async function addRule(input: { name: string; keywords: string[]; category: string }): Promise<CategoryRule[]> {
  const rules = await readRules()
  rules.push({
    id: randomUUID(),
    name: input.name.trim() || '未命名规则',
    keywords: input.keywords.map((k) => k.trim()).filter(Boolean),
    category: input.category.trim() || '未分类',
    createdAt: Date.now()
  })
  await writeRules(rules)
  return rules
}

export async function updateRule(id: string, input: { name: string; keywords: string[]; category: string }): Promise<CategoryRule[]> {
  const rules = await readRules()
  const rule = rules.find((r) => r.id === id)
  if (!rule) return rules
  rule.name = input.name.trim() || rule.name
  rule.keywords = input.keywords.map((k) => k.trim()).filter(Boolean)
  rule.category = input.category.trim() || '未分类'
  await writeRules(rules)
  return rules
}

export async function removeRule(id: string): Promise<CategoryRule[]> {
  const rules = await readRules()
  const next = rules.filter((r) => r.id !== id)
  await writeRules(next)
  return next
}

/* ---------------- 规则引擎 ---------------- */

function hitText(content: string): string {
  // 命中范围：正文（含标题），小写归一化
  return content.toLowerCase()
}

/**
 * 对单篇笔记应用规则，返回分类结果（首个命中规则优先；无命中返回 null）
 */
export function classifyNote(rules: CategoryRule[], content: string): string | null {
  const text = hitText(content)
  for (const rule of rules) {
    if (rule.keywords.some((k) => k && text.includes(k.toLowerCase()))) {
      return rule.category
    }
  }
  return null
}

/**
 * 全量自动分类：对每篇笔记应用规则并写回（仅覆盖 auto 来源的分类，
 * 用户手动调整过的分类保持不变，保证"手动优先"）。
 */
export async function applyAutoCategorize(): Promise<{ updated: number; classified: number }> {
  const [rules, notes] = await Promise.all([readRules(), getAllNotesWithContent()])
  let updated = 0
  let classified = 0
  const updates = new Map<string, { category: string; categorizedBy: 'auto' | 'manual' }>()
  for (const n of notes) {
    // 跳过用户手动指定的分类
    if (n.categorizedBy === 'manual') continue
    const category = classifyNote(rules, n.content)
    if (category !== null && category !== n.category) {
      updates.set(n.id, { category, categorizedBy: 'auto' })
      updated++
      classified++
    } else if (category === null && n.category) {
      // 规则不再命中：清空旧自动分类
      updates.set(n.id, { category: '', categorizedBy: 'auto' })
      updated++
    }
  }
  if (updates.size === 0) return { updated: 0, classified: 0 }
  const metas = await readIndex()
  for (let i = 0; i < metas.length; i++) {
    const u = updates.get(metas[i].id)
    if (!u) continue
    metas[i] = { ...metas[i], category: u.category, categorizedBy: 'auto' }
  }
  await writeIndex(metas)
  return { updated, classified }
}
