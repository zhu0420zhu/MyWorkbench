/* ============================================================
 * 手术式文档编辑 · ODF 家族（ODT / ODS / ODP 共用，content.xml）
 *
 * 抽取：按 <text:p> / <text:h> 切段落（ODF 规定二者不互相嵌套，
 * 非贪婪安全）；<text:s/>→空格（text:c 支持数量）、<text:tab/>→制表、
 * <text:line-break/>→换行。含占位符的段落照常抽出文本（展示用），
 * 但 apply 时拒绝写回（写回会破坏占位符语义）。
 *
 * 写回：与 DOCX 同思路——公共前后缀之外的变化区间写回首段字符数据，
 * 其余段清空，未受影响的标签（text:span 等）与字符数据一字不动。
 * 含内嵌对象（draw:/office: 前缀元素）的段落拒绝写回。
 *
 * ODS：单元格内就是 text:p，kind='cell'；ODP：页面文本框内也是
 * text:p，kind='paragraph'。两个格式直接复用本文件逻辑。
 * ============================================================ */

import type { SurgicalUnit } from '../../../../shared/types'
import { entryText, withEntryText, type CoreApplyResult } from '../zipCore'
import {
  replaceChunkText,
  scanInnerText,
  spliceInnerText
} from '../xmlText'

const ODF_ENTRY = 'content.xml'

/** text:p / text:h，含自闭合空段；\b 防止误配 text:tab 等 */
const P_RE = /<text:(p|h)\b[^>]*(?:\/>|>[\s\S]*?<\/text:\1>)/g
/** 空白占位符（写回拒绝项） */
const PLACEHOLDER_RE = /<text:(s|tab|line-break)\b/
/** 内嵌对象（写回拒绝项） */
const OBJECT_RE = /<(draw:|office:)/

/** 把占位符标签换算成对应字符，返回可扫描的内部 XML 与是否含占位符 */
function expandPlaceholders(inner: string): { s: string; hasPlaceholder: boolean } {
  const has = PLACEHOLDER_RE.test(inner)
  const s = inner
    .replace(/<text:s\b[^>]*text:c="(\d+)"[^>]*\/>/g, (_m, c) => ' '.repeat(Number(c)))
    .replace(/<text:s\b[^>]*\/>/g, ' ')
    .replace(/<text:tab\b[^>]*\/>/g, '\t')
    .replace(/<text:line-break\b[^>]*\/>/g, '\n')
  return { s, hasPlaceholder: has }
}

/** 拆段落元素为 开始标签 / 内部 / 结束标签（自闭合段内部为 null） */
function splitParagraph(paraXml: string): { opening: string; inner: string | null; closing: string } {
  const gt = paraXml.indexOf('>')
  if (gt < 0) return { opening: paraXml, inner: null, closing: '' }
  if (paraXml[gt - 1] === '/') {
    return { opening: paraXml.slice(0, gt + 1), inner: null, closing: '' }
  }
  const opening = paraXml.slice(0, gt + 1)
  const nameM = paraXml.match(/^<text:(p|h)\b/)
  const closing = `</text:${nameM ? nameM[1] : 'p'}>`
  return { opening, inner: paraXml.slice(opening.length, paraXml.length - closing.length), closing }
}

export function extractOdfUnits(
  entries: Map<string, Buffer>,
  kind: 'paragraph' | 'cell'
): SurgicalUnit[] {
  const xml = entryText(entries, ODF_ENTRY)
  if (xml == null) return []
  const units: SurgicalUnit[] = []
  let idx = 0
  for (const p of xml.match(P_RE) ?? []) {
    const i = idx++
    const { inner } = splitParagraph(p)
    if (inner == null) continue
    const { s } = expandPlaceholders(inner)
    const text = scanInnerText(s, true).chunks.map((c) => c.text).join('')
    if (text.trim() === '') continue
    units.push({ id: `${ODF_ENTRY}#${i}`, text, kind, entry: ODF_ENTRY })
  }
  return units
}

export function applyOdfEdits(
  entries: Map<string, Buffer>,
  edits: Array<{ id: string; newText: string }>
): CoreApplyResult {
  const xml = entryText(entries, ODF_ENTRY)
  if (xml == null) {
    return {
      changed: 0,
      skipped: (edits ?? []).map((e) => ({ id: e.id, reason: 'content.xml 不存在' })),
      entries: null
    }
  }

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
    const m = edit.id.match(/^content\.xml#(\d+)$/)
    if (!m) {
      skipped.push({ id: edit.id, reason: 'id 不是本格式的段落 id' })
      continue
    }
    const para = paras[Number(m[1])]
    if (!para) {
      skipped.push({ id: edit.id, reason: '段落不存在或文档已变化' })
      continue
    }
    const paraXml = xml.slice(para.start, para.end)
    const { opening, inner, closing } = splitParagraph(paraXml)
    if (inner == null) {
      skipped.push({ id: edit.id, reason: '段落无文本' })
      continue
    }
    if (OBJECT_RE.test(inner)) {
      skipped.push({ id: edit.id, reason: '含内嵌对象，暂不支持安全替换' })
      continue
    }
    const { s, hasPlaceholder } = expandPlaceholders(inner)
    const scan = scanInnerText(s, true)
    if (scan.chunks.length === 0) {
      skipped.push({ id: edit.id, reason: '段落无文本' })
      continue
    }
    const parts = replaceChunkText(scan.chunks, edit.newText)
    if (parts === null) {
      skipped.push({ id: edit.id, reason: '文本未变化' })
      continue
    }
    if (hasPlaceholder) {
      skipped.push({
        id: edit.id,
        reason: '含空白占位符（text:s/tab/line-break），暂不支持安全替换'
      })
      continue
    }
    const newInner = spliceInnerText(s, scan, parts)
    if (newInner === inner) {
      skipped.push({ id: edit.id, reason: '文本未变化' })
      continue
    }
    replacements.push({ start: para.start, end: para.end, xml: opening + newInner + closing })
    changed++
  }

  if (replacements.length === 0) return { changed: 0, skipped, entries: null }

  replacements.sort((a, b) => b.start - a.start)
  let out = xml
  for (const r of replacements) out = out.slice(0, r.start) + r.xml + out.slice(r.end)

  return { changed, skipped, entries: withEntryText(entries, ODF_ENTRY, out) }
}

/** 供 odsCore / 统一入口复用的导出 */
export { extractOdfUnits as extractOdtUnits, applyOdfEdits as applyOdtEdits }
