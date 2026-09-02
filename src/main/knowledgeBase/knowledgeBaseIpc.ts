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
import type {
  KnowledgeBuildInput,
  KnowledgeBuildOptions,
  KnowledgeBuildResult,
  DataAssetRecord,
  ReferenceRecord,
  ReferenceScope
} from '../../shared/types.ts'

export function registerKnowledgeBaseIpc(): void {
  const builder = getKnowledgeBuilder()
  const registry = getDataAssetRegistry()

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
}
