/* ============================================================
 * 知识库流水线 — IPC 桥接（P1：convert → index → QA 协同；P0：数据型资产 + 引用记录）
 * 暴露 domain:action：
 *   - knowledgeBase:build                  构建知识库（文档/图片经转换引擎 + 索引器汇入检索）
 *   - knowledgeBase:listDataAssets         列出已登记的数据型资产
 *   - knowledgeBase:getDataAsset           取单个数据型资产
 *   - knowledgeBase:assetColumns           取数据型资产列定义
 *   - knowledgeBase:addReference           新增一条引用记录
 *   - knowledgeBase:listReferences         按作用域/落点过滤引用记录
 * 编排逻辑见 builder.ts / dataAssets.ts / referenceStore.ts，本文件仅做 IPC 转发与依赖装配。
 * ============================================================ */

import { ipcMain } from 'electron'
import { getKnowledgeBuilder, getDataAssetRegistry } from './index.ts'
import { addReference, listReferences } from './referenceStore.ts'
import { getIndexer } from '../searchIndex/index.ts'
import { listWorlds } from '../sillytavern/worlds.ts'
import { resolveKbInject, renderInjectBlocks } from './kbTrigger.ts'
import type {
  KnowledgeBuildInput,
  KnowledgeBuildOptions,
  KnowledgeBuildResult,
  DataAssetRecord,
  ReferenceRecord,
  ReferenceScope,
  KbCandidate,
  KbInjectBlock,
  KbRefPick
} from '../../shared/types.ts'

export function registerKnowledgeBaseIpc(): void {
  const builder = getKnowledgeBuilder()
  const registry = getDataAssetRegistry()
  const indexer = getIndexer()

  /** 构建知识库：将文档/图片经「转换引擎 + 索引器」汇入本地检索引擎 */
  ipcMain.handle(
    'knowledgeBase:build',
    (_e, inputs: KnowledgeBuildInput[], opts?: KnowledgeBuildOptions): Promise<KnowledgeBuildResult> =>
      builder.build(inputs, opts ?? {})
  )

  /** 列出已登记的数据型资产（可按 kbId 过滤） */
  ipcMain.handle(
    'knowledgeBase:listDataAssets',
    (_e, kbId?: string): Promise<DataAssetRecord[]> => registry.list(kbId)
  )

  /** 取单个数据型资产 */
  ipcMain.handle(
    'knowledgeBase:getDataAsset',
    (_e, assetId: string): Promise<DataAssetRecord | null> => registry.get(assetId)
  )

  /** 取数据型资产列定义 */
  ipcMain.handle(
    'knowledgeBase:assetColumns',
    (_e, assetId: string): Promise<DataAssetRecord['columns']> => registry.columns(assetId)
  )

  /** 新增引用记录 */
  ipcMain.handle(
    'knowledgeBase:addReference',
    (_e, rec: ReferenceRecord): Promise<void> => addReference(rec)
  )

  /** 按作用域/落点过滤引用记录 */
  ipcMain.handle(
    'knowledgeBase:listReferences',
    (_e, scope?: ReferenceScope, refPos?: string): Promise<ReferenceRecord[]> =>
      listReferences({ scope, referencePosition: refPos })
  )

  /** # 引用选择器：列出可挂载候选（索引文档 + 数据资产 + 世界书） */
  ipcMain.handle(
    'knowledgeBase:listCandidates',
    async (_e, q?: string): Promise<KbCandidate[]> => {
      const key = (q ?? '').trim()
      const out: KbCandidate[] = []
      for (const d of indexer.listDocs(80, key || undefined)) {
        out.push({
          kind: 'doc',
          id: d.docId,
          name: d.fileName,
          meta: d.filePath,
          defaultChannel: d.chunkCount > 8 ? 'rag' : 'full-text'
        })
      }
      for (const a of await registry.list()) {
        if (key && !a.fileName.toLowerCase().includes(key.toLowerCase()) && !a.tableName.toLowerCase().includes(key.toLowerCase())) continue
        out.push({
          kind: 'data',
          id: a.assetId,
          name: a.tableName || a.fileName,
          meta: `${a.rowCount} 行 · ${a.columns.length} 列`,
          defaultChannel: 'schema'
        })
      }
      for (const w of await listWorlds()) {
        if (key && !w.name.toLowerCase().includes(key.toLowerCase())) continue
        out.push({
          kind: 'worldbook',
          id: w.id,
          name: w.name,
          meta: `${w.entryCount} 条目`,
          defaultChannel: 'full-text'
        })
      }
      return out
    }
  )

  /** # 引用解析：把选中资产编译为可注入文本块 */
  ipcMain.handle(
    'knowledgeBase:resolveInject',
    (_e, picks: KbRefPick[], query?: string): Promise<KbInjectBlock[]> =>
      resolveKbInject({ indexer, getDataAsset: (id) => registry.get(id) }, picks, query)
  )

  /** 编译为 system 段落（渲染层也可自行拼；主进程提供保证语义一致） */
  ipcMain.handle('knowledgeBase:renderInject', (_e, blocks: KbInjectBlock[]): string => renderInjectBlocks(blocks))
}
