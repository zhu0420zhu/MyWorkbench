/* 知识库流水线 — 统一出口与单例（P1：convert → index → QA 协同；P0：数据型资产登记） */

import { app } from 'electron'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { KnowledgeBuilder, type BuilderDataRegistry } from './builder.ts'
import { DataAssetRegistry } from './dataAssets.ts'
import { getConverterRegistry } from '../convert/index.ts'
import { getTempCleaner } from '../convert/tempCleaner.ts'
import { getIndexer } from '../searchIndex/index.ts'
import { describeImageForIndex } from '../searchIndex/vision.ts'
import { kbRoot } from '../kbData.ts'
import { importTable, getTable, listTables } from '../tablesCore.ts'
import type { DataAssetRecord } from '../../shared/types.ts'

let _builder: KnowledgeBuilder | null = null
let _dataRegistry: DataAssetRegistry | null = null

/**
 * 数据型资产登记单例（注入 kbRoot / 导入表 / 转换引擎 / 原子写 / 读状态）。
 * CSV/TSV 直接解析；XLSX/XLS 经转换引擎 .xlsx→.csv 再解析；落库独立于用户表库
 * （userData/kb/tables/lingmo.db），复用 aggregateTable 聚合引擎。
 */
export function getDataAssetRegistry(): DataAssetRegistry {
  if (!_dataRegistry) {
    const converterRegistry = getConverterRegistry()
    const stateFile = (): string => join(kbRoot(), 'dataAssets.json')
    const atomicWrite = async (file: string, obj: unknown): Promise<void> => {
      await fs.mkdir(kbRoot(), { recursive: true })
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
      try {
        await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8')
        await fs.rename(tmp, file)
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => undefined)
      }
    }
    const readState = async (): Promise<{ assets: DataAssetRecord[] }> => {
      try {
        const raw = await fs.readFile(stateFile(), 'utf-8')
        const parsed = JSON.parse(raw) as { assets?: DataAssetRecord[] }
        return { assets: Array.isArray(parsed.assets) ? parsed.assets : [] }
      } catch {
        return { assets: [] }
      }
    }
    _dataRegistry = new DataAssetRegistry({
      kbRoot,
      importTable,
      getTable,
      listTables,
      getConverter: (src: string, tgt: string) => converterRegistry.findConverter(src, tgt),
      convert: (input) => converterRegistry.convert(input),
      atomicWrite,
      readState
    })
  }
  return _dataRegistry
}

/** 获取知识库构建器单例（注入真实依赖：转换注册表 / 索引器 / 临时清理 / 视觉描述 / 数据型资产登记） */
export function getKnowledgeBuilder(): KnowledgeBuilder {
  if (!_builder) {
    _builder = new KnowledgeBuilder({
      registry: getConverterRegistry(),
      indexer: getIndexer(),
      tempCleaner: getTempCleaner(),
      describer: describeImageForIndex,
      dataRegistry: getDataAssetRegistry()
      // kbId 在 build() 调用时由 opts.kbId 注入
    })
  }
  return _builder
}

export { KnowledgeBuilder } from './builder.ts'
export type {
  BuilderRegistry,
  BuilderIndexer,
  BuilderTempCleaner,
  KnowledgeBuilderDeps,
  BuilderDataRegistry
} from './builder.ts'
