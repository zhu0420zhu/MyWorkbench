/* ============================================================
 * 手术式文档编辑 · EPUB（全部 .xhtml / .html 条目）
 *
 * 抽取：块级元素 p / h1-h6 / li / td，且只取「叶子块」——
 * 内部还嵌着块级元素（如 td 包 p、li 套嵌套列表）的容器不产出单元，
 * 由其内部块各自成为单元，避免改容器时把内层结构抹掉。
 * 文本 = 内部字符数据合并（扩展实体解码：&nbsp; 等）。
 *
 * 写回：变化区间映射回字符数据段，块内行内标签（strong/em/a…）与
 * 前后文本尽量原样保留；整段替换退化为「替换整个内部」。
 * ============================================================ */

import type { SurgicalUnit } from '../../../../shared/types'
import { entryText, withEntryText, type CoreApplyResult } from '../zipCore'
import {
  replaceChunkText,
  scanInnerText,
  spliceInnerText
} from '../xmlText'

const ENTRY_RE = /\.(xhtml|html|htm)$/i
/** 块级元素匹配（非贪婪；XHTML 块级不互相嵌套——除 li 套列表等，见叶子过滤） */
const BLOCK_RE = /<(p|h[1-6]|li|td)\b[^>]*(?:\/>|>[\s\S]*?<\/\1\s*>)/gi
/** 内部还含块级/列表/表格容器 → 视为容器，不产出单元 */
const CONTAINER_RE = /<(p|h[1-6]|li|td|ul|ol|table|div|blockquote)\b/i

export function extractEpubUnits(entries: Map<string, Buffer>): SurgicalUnit[] {
  const units: SurgicalUnit[] = []
  for (const [name, buf] of entries) {
    if (!ENTRY_RE.test(name)) continue
    const xml = buf.toString('utf8')
    let idx = 0
    for (const b of xml.match(BLOCK_RE) ?? []) {
      const i = idx++
      const gt = b.indexOf('>')
      if (b[gt - 1] === '/') continue // 自闭合（如 <p/>）
      const selfClosingEnd = gt + 1
      const nameM = b.match(/^<([a-zA-Z0-9]+)/)
      const tag = nameM ? nameM[1] : 'p'
      const closing = new RegExp(`</${tag}\\s*>$`, 'i')
      const closingM = b.slice(selfClosingEnd).match(closing)
      if (!closingM) continue
      const inner = b.slice(selfClosingEnd, b.length - closingM[0].length)
      if (CONTAINER_RE.test(inner)) continue // 叶子块过滤
      const text = scanInnerText(inner, true).chunks.map((c) => c.text).join('')
      if (text.trim() === '') continue
      units.push({ id: `${name}#${i}`, text, kind: 'xhtml-block', entry: name })
    }
  }
  return units
}

export function applyEpubEdits(
  entries: Map<string, Buffer>,
  edits: Array<{ id: string; newText: string }>
): CoreApplyResult {
  // 按条目分组
  const byEntry = new Map<string, Array<{ id: string; newText: string }>>()
  const skipped: Array<{ id: string; reason: string }> = []
  for (const e of edits ?? []) {
    const i = e.id.lastIndexOf('#')
    const entry = i < 0 ? '' : e.id.slice(0, i)
    if (!entry || !ENTRY_RE.test(entry)) {
      skipped.push({ id: e.id, reason: 'id 不是本格式的块 id' })
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
      for (const e of list) skipped.push({ id: e.id, reason: '条目不存在' })
      continue
    }
    const spans: Array<{ start: number; end: number }> = []
    for (const m of xml.matchAll(BLOCK_RE)) {
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
        skipped.push({ id: edit.id, reason: '块不存在或文档已变化' })
        continue
      }
      const blockXml = xml.slice(span.start, span.end)
      const gt = blockXml.indexOf('>')
      if (blockXml[gt - 1] === '/') {
        skipped.push({ id: edit.id, reason: '空块无文本' })
        continue
      }
      const opening = blockXml.slice(0, gt + 1)
      const nameM = blockXml.match(/^<([a-zA-Z0-9]+)/)
      const tag = nameM ? nameM[1] : 'p'
      const closingM = blockXml.slice(opening.length).match(new RegExp(`</${tag}\\s*>$`, 'i'))
      if (!closingM) {
        skipped.push({ id: edit.id, reason: '块结构异常，暂不支持替换' })
        continue
      }
      const inner = blockXml.slice(opening.length, blockXml.length - closingM[0].length)
      if (CONTAINER_RE.test(inner)) {
        skipped.push({ id: edit.id, reason: '块含嵌套结构，暂不支持安全替换' })
        continue
      }
      const scan = scanInnerText(inner, true)
      if (scan.chunks.length === 0) {
        skipped.push({ id: edit.id, reason: '块无文本' })
        continue
      }
      const parts = replaceChunkText(scan.chunks, edit.newText)
      if (parts === null) {
        skipped.push({ id: edit.id, reason: '文本未变化' })
        continue
      }
      const newInner = spliceInnerText(inner, scan, parts)
      if (newInner === inner) {
        skipped.push({ id: edit.id, reason: '文本未变化' })
        continue
      }
      replacements.push({ start: span.start, end: span.end, xml: opening + newInner + closingM[0] })
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
