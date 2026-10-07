/* ============================================================
 * 手术式文档编辑 · XLSX（xl/sharedStrings.xml + 工作表 inlineStr）
 *
 * ⚠ 语义说明（有意为之，风险可接受）：共享字符串 <si> 是全簿共享的，
 * 同一 <si> 可能被多个单元格引用——修改一个 si 等于修改所有引用格。
 * 这正是共享字符串机制的本义；extract 正常抽出、apply 正常改写。
 *
 * 抽取：
 *   - sharedStrings：<si> 为单元，合并内部所有 <t>（含富文本 <r><t> run）；
 *     <rPh>（拼音注音）不参与文本、apply 拒写；
 *   - inlineStr：工作表（xl/worksheets/sheet*.xml）的 <is> 为单元。
 * 写回：与 DOCX 同思路，变化区间映射回 <t> 区间，未受影响 run 不动。
 * ============================================================ */

import type { SurgicalUnit } from '../../../../shared/types'
import { entryText, withEntryText, type CoreApplyResult } from '../zipCore'
import {
  replaceChunkText,
  unescapeXml,
  withXmlSpacePreserve,
  type TextChunk
} from '../xmlText'

const SHARED_ENTRY = 'xl/sharedStrings.xml'
const SHEET_RE = /^xl\/worksheets\/sheet[^/]*\.xml$/

const SI_RE = /<si(?:\s[^>]*)?>[\s\S]*?<\/si>/g
const IS_RE = /<is(?:\s[^>]*)?>[\s\S]*?<\/is>/g
/** <t> 文本节点（si 与 is 内通用；无嵌套） */
const T_RE = /<t(\s[^>]*)?>([\s\S]*?)<\/t>/g

/** 收集一组 XML 内的所有 <t> 块 */
function collectTChunks(xml: string): TextChunk[] {
  const chunks: TextChunk[] = []
  for (const t of xml.matchAll(T_RE)) {
    const attrs = t[1] ?? ''
    chunks.push({
      head: `<t${attrs}>`,
      raw: t[2],
      text: unescapeXml(t[2]),
      tail: '</t>',
      xml: t[0]
    })
  }
  return chunks
}

/** 剔除 <rPh>（拼音注音）区间，避免其内部 <t> 混入文本 */
function stripPhonetic(xml: string): string {
  return xml.replace(/<rPh(?:\s[^>]*)?>[\s\S]*?<\/rPh>/g, '')
}

function isEmptyText(s: string): boolean {
  return s.trim() === ''
}

export function extractXlsxUnits(entries: Map<string, Buffer>): SurgicalUnit[] {
  const units: SurgicalUnit[] = []

  // 1) 共享字符串
  const shared = entryText(entries, SHARED_ENTRY)
  if (shared != null) {
    let idx = 0
    for (const si of shared.match(SI_RE) ?? []) {
      const i = idx++
      const gt = si.indexOf('>')
      const inner = si.slice(gt + 1, si.length - '</si>'.length)
      const text = collectTChunks(stripPhonetic(inner)).map((c) => c.text).join('')
      if (isEmptyText(text)) continue
      units.push({ id: `${SHARED_ENTRY}#${i}`, text, kind: 'cell', entry: SHARED_ENTRY })
    }
  }

  // 2) 工作表 inlineStr
  for (const [name, buf] of entries) {
    if (!SHEET_RE.test(name)) continue
    const xml = buf.toString('utf8')
    let idx = 0
    for (const is of xml.match(IS_RE) ?? []) {
      const i = idx++
      const gt = is.indexOf('>')
      const inner = is.slice(gt + 1, is.length - '</is>'.length)
      const text = collectTChunks(inner).map((c) => c.text).join('')
      if (isEmptyText(text)) continue
      units.push({ id: `${name}#${i}`, text, kind: 'cell', entry: name })
    }
  }

  return units
}

export function applyXlsxEdits(
  entries: Map<string, Buffer>,
  edits: Array<{ id: string; newText: string }>
): CoreApplyResult {
  const skipped: Array<{ id: string; reason: string }> = []
  // 按条目分组处理
  const byEntry = new Map<string, Array<{ id: string; newText: string }>>()
  for (const e of edits ?? []) {
    const i = e.id.lastIndexOf('#')
    const entry = i < 0 ? '' : e.id.slice(0, i)
    if (!entry || (!SHEET_RE.test(entry) && entry !== SHARED_ENTRY)) {
      skipped.push({ id: e.id, reason: 'id 不是本格式的单元格 id' })
      continue
    }
    if (!byEntry.has(entry)) byEntry.set(entry, [])
    byEntry.get(entry)!.push(e)
  }

  let changed = 0
  const outEntries = new Map<string, Buffer | string>(entries as Map<string, Buffer | string>)
  let touched = false
  const setEntry = (name: string, xml: string) => {
    outEntries.set(name, xml)
    touched = true
  }

  for (const [entry, list] of byEntry) {
    const xml = entryText(entries, entry)
    if (xml == null) {
      for (const e of list) skipped.push({ id: e.id, reason: '条目不存在' })
      continue
    }
    // 单元定位：si 或 is
    const UNIT_RE = entry === SHARED_ENTRY ? SI_RE : IS_RE
    const TAG = entry === SHARED_ENTRY ? 'si' : 'is'
    const spans: Array<{ start: number; end: number }> = []
    for (const m of xml.matchAll(UNIT_RE)) {
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
      const idx = Number(edit.id.slice(entry.length + 1))
      const span = spans[idx]
      if (!span) {
        skipped.push({ id: edit.id, reason: '单元格不存在或文档已变化' })
        continue
      }
      const unitXml = xml.slice(span.start, span.end)
      const gt = unitXml.indexOf('>')
      let inner = unitXml.slice(gt + 1, unitXml.length - `</${TAG}>`.length)
      if (TAG === 'si' && /<rPh\b/.test(unitXml)) {
        skipped.push({ id: edit.id, reason: '含拼音注音（rPh），暂不支持安全替换' })
        continue
      }
      const chunks = collectTChunks(inner)
      if (chunks.length === 0) {
        skipped.push({ id: edit.id, reason: '单元格无文本节点' })
        continue
      }
      const parts = replaceChunkText(chunks, edit.newText, { adjustHead: withXmlSpacePreserve })
      if (parts === null) {
        skipped.push({ id: edit.id, reason: '文本未变化' })
        continue
      }
      // 回填 <t> 区间
      const tSpans: Array<{ start: number; end: number }> = []
      for (const t of inner.matchAll(T_RE)) {
        tSpans.push({ start: t.index ?? 0, end: (t.index ?? 0) + t[0].length })
      }
      let newInner = ''
      let last = 0
      for (let i = 0; i < tSpans.length; i++) {
        newInner += inner.slice(last, tSpans[i].start) + parts[i]
        last = tSpans[i].end
      }
      newInner += inner.slice(last)
      const opening = unitXml.slice(0, gt + 1)
      const newUnit = opening + newInner + `</${TAG}>`
      if (newUnit === unitXml) {
        skipped.push({ id: edit.id, reason: '文本未变化' })
        continue
      }
      replacements.push({ start: span.start, end: span.end, xml: newUnit })
      changed++
    }

    if (replacements.length > 0) {
      replacements.sort((a, b) => b.start - a.start)
      let out = xml
      for (const r of replacements) out = out.slice(0, r.start) + r.xml + out.slice(r.end)
      setEntry(entry, out)
    }
  }

  return { changed, skipped, entries: touched ? outEntries : null }
}
