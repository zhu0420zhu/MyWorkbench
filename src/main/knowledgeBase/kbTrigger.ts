/* ============================================================
 * # 引用解析：把选中的知识库资产编译为可注入 system 的文本块
 *
 * 通道：
 *   - doc/rag        → queryChunks(scope=filePath) 取 Top-K
 *   - doc/full-text  → 全文块拼接
 *   - data/schema    → 列定义 + 样例行（模型理解表结构，不注入全表）
 *   - worldbook      → 世界书条目 comment 全文
 * ============================================================ */

import type { DataAssetRecord, KbInjectBlock, KbRefPick } from '../../shared/types.ts'
import type { Indexer } from '../searchIndex/indexer.ts'
import { getWorld } from '../sillytavern/worlds.ts'

export interface KbResolveDeps {
  indexer: Indexer
  getDataAsset: (assetId: string) => Promise<DataAssetRecord | null>
}

const RAG_TOP_K = 6
const MAX_BLOCK_CHARS = 4000

function clip(s: string, max = MAX_BLOCK_CHARS): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n…（已截断，共 ${s.length} 字）`
}

function dataAssetToSchemaText(a: DataAssetRecord): string {
  const cols = a.columns.map((c) => `${c.name}(${c.type})`).join('、')
  const sample = a.sampleRows
    .slice(0, 5)
    .map((r, i) => {
      const cells = a.columns.map((c) => String(r[c.fieldId] ?? '')).join(' | ')
      return `${i + 1}. ${cells}`
    })
    .join('\n')
  return [
    `【数据表】${a.tableName}`,
    `行数：${a.rowCount}；列：${cols}`,
    sample ? `样例行：\n${sample}` : '',
    `说明：完整数据在本地表 ${a.tableId}，如需统计请基于列名与样例推断结构。`
  ]
    .filter(Boolean)
    .join('\n')
}

function worldbookToText(w: { name?: string; entries?: Array<{ comment?: string; key?: string[]; enabled?: boolean }> }): string {
  const entries = (w.entries ?? []).filter((e) => e.enabled !== false)
  const body = entries
    .map((e, i) => {
      const keys = (e.key ?? []).filter(Boolean).join('/')
      return `### ${i + 1}${keys ? ` [${keys}]` : ''}\n${(e.comment ?? '').trim()}`
    })
    .filter((s) => s.replace(/^### .*\n/, '').trim())
  return [`【世界书】${w.name ?? ''}`, ...body].join('\n\n')
}

export async function resolveKbInject(
  deps: KbResolveDeps,
  picks: KbRefPick[],
  query?: string
): Promise<KbInjectBlock[]> {
  const out: KbInjectBlock[] = []
  for (const p of picks) {
    try {
      if (p.kind === 'doc') {
        if (p.channel === 'full-text') {
          const text = deps.indexer.getDocText(p.id)
          if (text) out.push({ kind: 'doc', name: p.name, channel: 'full-text', text: clip(text) })
        } else {
          const doc = deps.indexer.getDoc(p.id)
          let scoped = doc ? deps.indexer.queryChunks(query || p.name, RAG_TOP_K, doc.filePath) : []
          // 查询无命中时退化为该文档前几块，避免「挂了却空白」
          if (!scoped.length && doc) {
            scoped = deps.indexer.queryChunks(p.name, RAG_TOP_K, doc.filePath)
          }
          const text = scoped
            .map((c) => c.text)
            .join('\n---\n')
            .trim()
          if (text) out.push({ kind: 'doc', name: p.name, channel: 'rag', text: clip(text) })
          else {
            const full = deps.indexer.getDocText(p.id)
            if (full) out.push({ kind: 'doc', name: p.name, channel: 'full-text', text: clip(full) })
          }
        }
      } else if (p.kind === 'data') {
        const a = await deps.getDataAsset(p.id)
        if (a) out.push({ kind: 'data', name: a.tableName || p.name, channel: 'schema', text: clip(dataAssetToSchemaText(a)) })
      } else if (p.kind === 'worldbook') {
        const w = await getWorld(p.id)
        if (w) out.push({ kind: 'worldbook', name: w.name || p.name, channel: 'full-text', text: clip(worldbookToText(w)) })
      }
    } catch {
      /* 单资产失败不阻断整体注入 */
    }
  }
  return out
}

export function renderInjectBlocks(blocks: KbInjectBlock[]): string {
  if (!blocks.length) return ''
  const parts = blocks.map((b) => {
    const tag = b.channel === 'rag' ? 'RAG 检索' : b.channel === 'schema' ? '数据表结构' : '全文注入'
    return `【知识库引用 · ${tag} · ${b.name}】\n${b.text}`
  })
  return `以下是用户从本地知识库挂载的参考资料，请在回答时优先参考并必要时注明来源名称：\n\n${parts.join('\n\n')}`
}
