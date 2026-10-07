/* ============================================================
 * 手术式文档编辑 · ODS（content.xml，表格单元格）
 * ODS 单元格内就是 <text:p>，完整复用 odtCore 的 ODF 逻辑，
 * 仅 kind 标为 'cell'（id 仍为 content.xml#<段落序号>）。
 * ============================================================ */

import type { SurgicalUnit } from '../../../../shared/types'
import { extractOdfUnits, applyOdfEdits } from './odtCore'
import type { CoreApplyResult } from '../zipCore'

export function extractOdsUnits(entries: Map<string, Buffer>): SurgicalUnit[] {
  return extractOdfUnits(entries, 'cell')
}

export function applyOdsEdits(
  entries: Map<string, Buffer>,
  edits: Array<{ id: string; newText: string }>
): CoreApplyResult {
  return applyOdfEdits(entries, edits)
}
