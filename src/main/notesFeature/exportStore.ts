/* ============================================
 * 一键导出 / 导入（JSON 全量包 + Markdown 人读版）
 * 职责：组装 NoteExportBundle（标签/分类规则/检索表/全部笔记）；
 *       Markdown 版：目录 + 每篇笔记（YAML frontmatter + 正文）；
 *       导入：恢复数据（笔记按 id upsert，配置替换）
 * ============================================ */

import type { NoteExportBundle, NoteImportResult, NoteMeta } from '../../shared/types'
import { readIndex, writeIndex, ensureDir, noteFile, getAllNotesWithContent } from '../notes'
import { readTags, writeTags } from './tagsStore'
import { readRules, writeRules } from './rulesStore'
import { readTables, writeTables } from './indexStore'
import { promises as fs } from 'fs'

export async function exportBundle(): Promise<NoteExportBundle> {
  const [tags, rules, indexTables, notes] = await Promise.all([
    readTags(),
    readRules(),
    readTables(),
    getAllNotesWithContent()
  ])
  return {
    version: 1,
    exportedAt: Date.now(),
    tags,
    rules,
    indexTables,
    notes
  }
}

function mdEscape(s: string): string {
  return s.replace(/"/g, '\\"')
}

/** Markdown 人读版：目录 + 每篇笔记（含 frontmatter 元数据） */
export async function exportMarkdown(): Promise<string> {
  const [tags, rules, indexTables, notes] = await Promise.all([
    readTags(),
    readRules(),
    readTables(),
    getAllNotesWithContent()
  ])
  const lines: string[] = []
  lines.push('# 笔记导出', '')
  lines.push(`> 导出时间：${new Date().toLocaleString('zh-CN')}`)
  lines.push(`> 笔记 ${notes.length} 篇 · 标签 ${tags.length} 个 · 分类规则 ${rules.length} 条 · 检索表 ${indexTables.length} 张`, '')
  if (tags.length > 0) {
    lines.push('## 标签', '', tags.map((t) => `- \`${t.name}\``).join('\n'), '')
  }
  if (rules.length > 0) {
    lines.push('## 分类规则', '')
    for (const r of rules) {
      lines.push(`- **${r.name}** → \`${r.category}\`（关键词：${r.keywords.join('、')}）`)
    }
    lines.push('')
  }
  if (indexTables.length > 0) {
    lines.push('## 检索表', '')
    for (const t of indexTables) {
      const dims = [
        t.keywords?.length ? `关键词:${t.keywords.join('、')}` : null,
        t.tags?.length ? `标签:${t.tags.join('、')}` : null,
        t.dateFrom ? `起始:${new Date(t.dateFrom).toLocaleDateString('zh-CN')}` : null,
        t.dateTo ? `截止:${new Date(t.dateTo).toLocaleDateString('zh-CN')}` : null
      ].filter(Boolean)
      lines.push(`- **${t.name}**（${dims.join(' / ')}）`)
    }
    lines.push('')
  }
  lines.push('---', '', '## 笔记', '')
  for (const n of notes) {
    lines.push(
      `### ${n.title}`,
      '',
      '```yaml',
      `id: ${n.id}`,
      `created: ${new Date(n.createdAt).toISOString()}`,
      `updated: ${new Date(n.updatedAt).toISOString()}`,
      `tags: [${(n.tags ?? []).map((t) => `"${mdEscape(t)}"`).join(', ')}]`,
      `category: ${n.category ? `"${mdEscape(n.category)}"` : ''}`,
      '```',
      '',
      n.content.trim(),
      '',
      '---',
      ''
    )
  }
  return lines.join('\n')
}

/** 导入恢复：笔记按 id upsert（保留现有、覆盖同名、新增导入的）；配置整体替换 */
export async function importBundle(bundle: NoteExportBundle): Promise<NoteImportResult> {
  try {
    if (!bundle || bundle.version !== 1 || !Array.isArray(bundle.notes)) {
      return { ok: false, error: '数据包格式不正确（version 或 notes 缺失）' }
    }
    // 1) 配置：标签/规则/检索表 整体替换
    const tags = Array.isArray(bundle.tags) ? bundle.tags : []
    await writeTags(tags)
    const rules = Array.isArray(bundle.rules) ? bundle.rules : []
    await writeRules(rules)
    const tables = Array.isArray(bundle.indexTables) ? bundle.indexTables : []
    await writeTables(tables)

    // 2) 笔记：按 id upsert
    const metas = await readIndex()
    const byId = new Map(metas.map((m) => [m.id, m]))
    let added = 0
    let updated = 0
    await ensureDir()
    for (const n of bundle.notes) {
      const content = typeof n.content === 'string' ? n.content : ''
      const meta: NoteMeta = {
        id: n.id,
        title: n.title || '未命名笔记',
        createdAt: n.createdAt ?? Date.now(),
        updatedAt: n.updatedAt ?? Date.now(),
        tags: Array.isArray(n.tags) ? n.tags : [],
        category: typeof n.category === 'string' ? n.category : undefined,
        categorizedBy: n.categorizedBy
      }
      const existed = byId.has(n.id)
      byId.set(n.id, meta)
      if (existed) updated++
      else added++
      await fs.writeFile(noteFile(n.id), content, 'utf-8')
    }
    await writeIndex([...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt))
    return { ok: true, counts: { notes: bundle.notes.length, tags: tags.length, rules: rules.length, indexTables: tables.length } }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
