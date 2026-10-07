/* ============================================================
 * 手术式文档编辑 · 统一入口
 * surgicalExtract(buf, ext) / surgicalApply(buf, ext, edits)
 * 按扩展名分发到各格式 Core；本文件不 import electron，
 * IPC 薄包装见 surgicalIpc.ts。
 * ============================================================ */

import type { SurgicalApplyResult, SurgicalEdit, SurgicalExtractResult, SurgicalUnit } from '../../../shared/types'
import { readZip, writeZip, type CoreApplyResult } from './zipCore'
import { extractDocxUnits, applyDocxEdits } from './formats/docxCore'
import { extractOdtUnits, applyOdtEdits } from './formats/odtCore'
import { extractOdsUnits, applyOdsEdits } from './formats/odsCore'
import { extractXlsxUnits, applyXlsxEdits } from './formats/xlsxCore'
import { extractPptxUnits, applyPptxEdits } from './formats/pptxCore'
import { extractEpubUnits, applyEpubEdits } from './formats/epubCore'

export type SurgicalFormat = 'docx' | 'odt' | 'xlsx' | 'ods' | 'pptx' | 'odp' | 'epub'

const FORMAT_BY_EXT: Record<string, SurgicalFormat> = {
  docx: 'docx',
  odt: 'odt',
  ods: 'ods',
  odp: 'odp',
  xlsx: 'xlsx',
  pptx: 'pptx',
  epub: 'epub'
}

/** 从扩展名（可带点，也可传整个路径）识别手术格式；不支持返回 null */
export function surgicalFormatOf(extOrPath: string): SurgicalFormat | null {
  const ext = extOrPath.replace(/^.*\./, '').toLowerCase()
  return FORMAT_BY_EXT[ext] ?? null
}

type ExtractFn = (entries: Map<string, Buffer>) => SurgicalUnit[]
type ApplyFn = (entries: Map<string, Buffer>, edits: SurgicalEdit[]) => CoreApplyResult

const EXTRACTORS: Record<SurgicalFormat, ExtractFn> = {
  docx: extractDocxUnits,
  odt: (e) => extractOdtUnits(e, 'paragraph'),
  odp: (e) => extractOdtUnits(e, 'paragraph'), // ODP 的 text:p 在页面文本框内，同一条 content.xml 路径
  ods: extractOdsUnits,
  xlsx: extractXlsxUnits,
  pptx: extractPptxUnits,
  epub: extractEpubUnits
}

const APPLIERS: Record<SurgicalFormat, ApplyFn> = {
  docx: applyDocxEdits,
  odt: applyOdtEdits,
  odp: applyOdtEdits,
  ods: applyOdsEdits,
  xlsx: applyXlsxEdits,
  pptx: applyPptxEdits,
  epub: applyEpubEdits
}

/** 抽取可编辑单元。不支持的格式 / 损坏的 zip → ok:false */
export async function surgicalExtract(buf: Buffer, ext: string): Promise<SurgicalExtractResult> {
  const format = FORMAT_BY_EXT[String(ext || '').replace(/^\./, '').toLowerCase()]
  if (!format) return { ok: false, error: `不支持的格式: ${ext || '(空)'}` }
  try {
    const entries = await readZip(buf)
    return { ok: true, format, units: EXTRACTORS[format](entries) }
  } catch (err) {
    return { ok: false, error: `文档解析失败: ${(err as Error).message}` }
  }
}

/** 应用编辑。有变更时返回写回字节（调用方负责备份与落盘）；无变更时 bytes 为 null */
export async function surgicalApply(
  buf: Buffer,
  ext: string,
  edits: SurgicalEdit[]
): Promise<SurgicalApplyResult & { bytes?: Buffer | null }> {
  const format = FORMAT_BY_EXT[String(ext || '').replace(/^\./, '').toLowerCase()]
  if (!format) return { ok: false, error: `不支持的格式: ${ext || '(空)'}` }
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: '没有可应用的编辑' }
  }
  try {
    const entries = await readZip(buf)
    const r = APPLIERS[format](entries, edits)
    if (r.changed === 0 || !r.entries) {
      return { ok: true, changedCount: 0, skipped: r.skipped, bytes: null }
    }
    const bytes = await writeZip(r.entries)
    return { ok: true, changedCount: r.changed, skipped: r.skipped, bytes }
  } catch (err) {
    return { ok: false, error: `应用编辑失败: ${(err as Error).message}` }
  }
}
