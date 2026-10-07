/* ============================================================
 * 手术式文档编辑 · DOCX（word/document.xml）
 *
 * 抽取：按 <w:p> 切段落（w:p 不嵌套，非贪婪安全），段内所有 <w:t>
 * 反转义后拼接成 text（跨 run 拆分由此解决）；纯空白段不产出单元，
 * 但序号照常递增（id 稳定指向「第 N 个 w:p」）。
 *
 * 写回：把「段落当前文本 → newText」映射回 w:t 区间——
 *   - 公共前后缀之外为变化区间：首个受影响 w:t 保留前缀+写入新中段
 *     （格式继承该 run），其余受影响 w:t 清空，未受影响的前后 run 一字不动；
 *   - 整段全新文本（无公共前后缀）退化为「首 w:t 写全文、其余清空」。
 * 只改 document.xml 字符串，其余条目原样。
 * ============================================================ */

import type { SurgicalUnit } from '../../../../shared/types'
import { entryText, withEntryText, type CoreApplyResult } from '../zipCore'
import {
  replaceChunkText,
  unescapeXml,
  withXmlSpacePreserve,
  type TextChunk
} from '../xmlText'

const DOC_ENTRY = 'word/document.xml'

/** 段落匹配：含自闭合空段（<w:p/>），\b 防止误配 <w:pPr> */
const P_RE = /<w:p\b[^>]*(?:\/>|>[\s\S]*?<\/w:p>)/g
/** 文本节点匹配（w:t 无嵌套；自闭合 <w:t/> 无内容，不构成块） */
const WT_RE = /<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g

export function extractDocxUnits(entries: Map<string, Buffer>): SurgicalUnit[] {
  const xml = entryText(entries, DOC_ENTRY)
  if (xml == null) return []
  const units: SurgicalUnit[] = []
  let idx = 0
  for (const p of xml.match(P_RE) ?? []) {
    const i = idx++
    let text = ''
    for (const t of p.matchAll(WT_RE)) text += unescapeXml(t[2])
    if (text.trim() === '') continue
    units.push({ id: `${DOC_ENTRY}#${i}`, text, kind: 'paragraph', entry: DOC_ENTRY })
  }
  return units
}

export function applyDocxEdits(
  entries: Map<string, Buffer>,
  edits: Array<{ id: string; newText: string }>
): CoreApplyResult {
  const xml = entryText(entries, DOC_ENTRY)
  if (xml == null) {
    return {
      changed: 0,
      skipped: (edits ?? []).map((e) => ({ id: e.id, reason: 'document.xml 不存在' })),
      entries: null
    }
  }

  // 段落 [start, end) 定位
  const paras: Array<{ start: number; end: number }> = []
  for (const m of xml.matchAll(P_RE)) {
    paras.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length })
  }

  const skipped: Array<{ id: string; reason: string }> = []
  const replacements: Array<{ start: number; end: number; xml: string }> = []
  const seen = new Set<string>()
  let changed = 0

  for (const edit of edits ?? []) {
    if (seen.has(edit.id)) {
      skipped.push({ id: edit.id, reason: '重复的编辑 id' })
      continue
    }
    seen.add(edit.id)
    const m = edit.id.match(/^word\/document\.xml#(\d+)$/)
    if (!m) {
      skipped.push({ id: edit.id, reason: 'id 不是本格式的段落 id' })
      continue
    }
    const idx = Number(m[1])
    const para = paras[idx]
    if (!para) {
      skipped.push({ id: edit.id, reason: '段落不存在或文档已变化' })
      continue
    }
    const paraXml = xml.slice(para.start, para.end)

    // 段内 w:t 块（带位置，便于回填）
    const chunks: TextChunk[] = []
    const wtSpans: Array<{ start: number; end: number }> = []
    for (const t of paraXml.matchAll(WT_RE)) {
      const s = t.index ?? 0
      wtSpans.push({ start: s, end: s + t[0].length })
      const attrs = t[1] ?? ''
      chunks.push({
        head: `<w:t${attrs}>`,
        raw: t[2],
        text: unescapeXml(t[2]),
        tail: '</w:t>',
        xml: t[0]
      })
    }
    if (chunks.length === 0) {
      skipped.push({ id: edit.id, reason: '段落无文本节点' })
      continue
    }

    const parts = replaceChunkText(chunks, edit.newText, { adjustHead: withXmlSpacePreserve })
    if (parts === null) {
      skipped.push({ id: edit.id, reason: '文本未变化' })
      continue
    }
    // 按块顺序回填段落（块之间还有 r/rPr 等标签，保持不动）
    let newPara = ''
    let last = 0
    for (let i = 0; i < wtSpans.length; i++) {
      newPara += paraXml.slice(last, wtSpans[i].start) + parts[i]
      last = wtSpans[i].end
    }
    newPara += paraXml.slice(last)
    if (newPara === paraXml) {
      skipped.push({ id: edit.id, reason: '文本未变化' })
      continue
    }
    replacements.push({ start: para.start, end: para.end, xml: newPara })
    changed++
  }

  if (replacements.length === 0) return { changed: 0, skipped, entries: null }

  // 从后往前替换段落，偏移不失效
  replacements.sort((a, b) => b.start - a.start)
  let out = xml
  for (const r of replacements) out = out.slice(0, r.start) + r.xml + out.slice(r.end)

  return { changed, skipped, entries: withEntryText(entries, DOC_ENTRY, out) }
}
