/* ============================================
 * 笔记批量导入：多格式解析 + 数据校验 + 格式转换
 * 支持：txt/md（原文）、csv/tsv（→ Markdown 表格）、
 *       json（校验 JSON 语法 → 格式化）、xlsx/xls（→ Markdown 表格）
 * 校验：空文件 / 大小上限 / 二进制内容 / 语法错误 / 不支持类型
 * ============================================ */

import { parseExcelImport, parseTextImport } from './ioFormats'
import type { TableField, TableRow } from '@shared/types'

export interface ImportedNote {
  title: string
  content: string
}

export interface ImportIssue {
  name: string
  reason: string
}

export interface NoteImportSummary {
  created: ImportedNote[]
  skipped: ImportIssue[]
}

/** 单文件大小上限（10MB，避免大文件拖垮渲染进程） */
const MAX_FILE_SIZE = 10 * 1024 * 1024

/** 文件名去扩展名作为标题 */
function titleFromName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '')
  return base.trim() || name
}

/** UTF-8 解码并去除 BOM */
function decodeText(data: Uint8Array): string {
  const s = new TextDecoder('utf-8').decode(data)
  return s.replace(/^\uFEFF/, '')
}

/** 粗略二进制检测：文本文件不应在头部出现 NUL 字节 */
function looksBinary(data: Uint8Array): boolean {
  const sample = data.slice(0, 1024)
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true
  }
  return false
}

/** 表格结构 → Markdown 表格（供 CSV/TSV/Excel 转换） */
function tableToMarkdown(table: { fields: TableField[]; rows: TableRow[] }): string {
  const headers = table.fields.map((f) => f.name)
  const esc = (v: string): string => v.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const lines: string[] = ['| ' + headers.map(esc).join(' | ') + ' |', '| ' + headers.map(() => '---').join(' | ') + ' |']
  for (const r of table.rows) {
    const cells = table.fields.map((f) => esc(String(r.values[f.id] ?? '')))
    lines.push('| ' + cells.join(' | ') + ' |')
  }
  return lines.join('\n')
}

/**
 * 解析单个文件为笔记内容。
 * 返回 { title, content } 或 { error }（错误原因即用户提示语）
 */
export function parseNoteFile(name: string, data: Uint8Array): { title: string; content: string } | { error: string } {
  const ext = (name.split('.').pop() ?? '').toLowerCase()

  if (data.length === 0) return { error: '文件为空' }
  if (data.length > MAX_FILE_SIZE) return { error: `文件超过 ${MAX_FILE_SIZE / 1024 / 1024}MB 上限` }

  try {
    switch (ext) {
      case 'txt':
      case 'md':
      case 'markdown':
      case 'text':
      case 'log': {
        if (looksBinary(data)) return { error: '检测到二进制内容，不是文本文件' }
        return { title: titleFromName(name), content: decodeText(data) }
      }
      case 'csv':
      case 'tsv': {
        if (looksBinary(data)) return { error: '检测到二进制内容，不是文本文件' }
        const format = ext === 'tsv' ? 'tsv' : 'csv'
        const table = parseTextImport(name, decodeText(data), format)
        return { title: titleFromName(name), content: tableToMarkdown(table) }
      }
      case 'json': {
        if (looksBinary(data)) return { error: '检测到二进制内容，不是文本文件' }
        const text = decodeText(data)
        const parsed: unknown = JSON.parse(text) // 语法校验：失败即抛错
        const content =
          typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2)
        return { title: titleFromName(name), content }
      }
      case 'xlsx':
      case 'xls': {
        // Excel 是二进制容器，跳过 NUL 检测
        const buf = data.slice().buffer as ArrayBuffer
        const table = parseExcelImport(name, buf)
        return { title: titleFromName(name), content: tableToMarkdown(table) }
      }
      default:
        return { error: ext ? `不支持的文件类型 .${ext}` : '无法识别文件类型（无扩展名）' }
    }
  } catch (err) {
    return { error: `解析失败：${(err as Error).message}` }
  }
}

/** 批量导入：逐文件解析 → 收集成功/跳过明细 → 批量创建笔记 */
export async function importFilesToNotes(
  files: Array<{ name: string; data: Uint8Array; size: number }>
): Promise<NoteImportSummary> {
  const created: ImportedNote[] = []
  const skipped: ImportIssue[] = []
  for (const f of files) {
    const r = parseNoteFile(f.name, f.data)
    if ('error' in r) {
      skipped.push({ name: f.name, reason: r.error })
      continue
    }
    created.push(r)
  }
  if (created.length > 0) {
    await window.api.notes.createBatch(created)
  }
  return { created, skipped }
}
