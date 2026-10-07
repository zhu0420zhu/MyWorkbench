/* ============================================================
 * 手术式文档编辑 · PPTX（ppt/slides/slide*.xml）
 * 最简单的格式：<a:t> 不嵌套，每个 <a:t> 就是一个单元，无 run 合并。
 * 写回：整体替换该 <a:t> 的文本内容（标签原样保留）。
 * 仅处理幻灯片正文页；备注页（notesSlides）不在抽取范围。
 * ============================================================ */

import type { SurgicalUnit } from '../../../../shared/types'
import { entryText, withEntryText, type CoreApplyResult } from '../zipCore'
import { escapeXmlText, unescapeXml } from '../xmlText'

const SLIDE_RE = /^ppt\/slides\/slide\d+\.xml$/
const AT_RE = /<a:t(\s[^>]*)?>([\s\S]*?)<\/a:t>/g

export function extractPptxUnits(entries: Map<string, Buffer>): SurgicalUnit[] {
  const units: SurgicalUnit[] = []
  // 按条目名排序保证幻灯片顺序稳定（slide1, slide10, slide2 → 数字序）
  const names = [...entries.keys()].filter((n) => SLIDE_RE.test(n)).sort(compareSlide)
  for (const name of names) {
    const xml = entries.get(name)!.toString('utf8')
    let idx = 0
    for (const t of xml.matchAll(AT_RE)) {
      const i = idx++
      const text = unescapeXml(t[2])
      if (text.trim() === '') continue
      units.push({ id: `${name}#${i}`, text, kind: 'slide-text', entry: name })
    }
  }
  return units
}

function compareSlide(a: string, b: string): number {
  const na = Number(a.match(/(\d+)/)?.[1] ?? 0)
  const nb = Number(b.match(/(\d+)/)?.[1] ?? 0)
  return na - nb || a.localeCompare(b)
}

export function applyPptxEdits(
  entries: Map<string, Buffer>,
  edits: Array<{ id: string; newText: string }>
): CoreApplyResult {
  // 按条目分组
  const byEntry = new Map<string, Array<{ id: string; newText: string }>>()
  const skipped: Array<{ id: string; reason: string }> = []
  for (const e of edits ?? []) {
    const i = e.id.lastIndexOf('#')
    const entry = i < 0 ? '' : e.id.slice(0, i)
    if (!entry || !SLIDE_RE.test(entry)) {
      skipped.push({ id: e.id, reason: 'id 不是本格式的幻灯片文本 id' })
      continue
    }
    if (!byEntry.has(entry)) byEntry.set(entry, [])
    byEntry.get(entry)!.push(e)
  }

  let changed = 0
  const outEntries = new Map<string, Buffer | string>(entries as Map<string, Buffer | string>)
  let touched = false

  for (const [entry, list] of byEntry) {
    const xml = entryText(entries, entry)
    if (xml == null) {
      for (const e of list) skipped.push({ id: e.id, reason: '幻灯片条目不存在' })
      continue
    }
    const spans: Array<{ start: number; end: number }> = []
    for (const m of xml.matchAll(AT_RE)) {
      spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length })
    }
    const replacements: Array<{ start: number; end: number; xml: string }> = []
    const seen = new Set<string>()
    for (const edit of list) {
      if (seen.has(edit.id)) {
        skipped.push({ id: edit.id, reason: '重复的编辑 id' })
        continue
      }
      seen.add(edit.id)
      const span = spans[Number(edit.id.slice(entry.length + 1))]
      if (!span) {
        skipped.push({ id: edit.id, reason: '文本框不存在或文档已变化' })
        continue
      }
      const atXml = xml.slice(span.start, span.end)
      const gt = atXml.indexOf('>')
      const old = atXml.slice(gt + 1, atXml.length - '</a:t>'.length)
      const escaped = escapeXmlText(edit.newText)
      if (escaped === old) {
        skipped.push({ id: edit.id, reason: '文本未变化' })
        continue
      }
      replacements.push({
        start: span.start,
        end: span.end,
        xml: atXml.slice(0, gt + 1) + escaped + '</a:t>'
      })
      changed++
    }
    if (replacements.length > 0) {
      replacements.sort((a, b) => b.start - a.start)
      let out = xml
      for (const r of replacements) out = out.slice(0, r.start) + r.xml + out.slice(r.end)
      outEntries.set(entry, out)
      touched = true
    }
  }

  return { changed, skipped, entries: touched ? outEntries : null }
}
