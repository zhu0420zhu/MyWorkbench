/* ============================================
 * 知识库流水线（P1：convert → index → QA 协同，移植自 awesome-llm-apps RAG/知识库）
 * 编排逻辑：
 *   对每个输入文件：
 *     0) P0：数据型扩展名（.csv/.tsv/.xlsx/.xls）在一切文本索引之前被拦截，
 *        作为结构化数据资产登记进知识库（DataAssetRegistry），彻底消除
 *        「CSV 被当文本块索引」缺陷；
 *     1) 先尝试直接建索引（文本/HTML/图片）→ 命中即完成；
 *     2) 若原格式不支持，经「格式转换引擎」产出可抽取文本，再以原路径建索引；
 *   目录则递归遍历。
 * 本模块为纯编排层，依赖以接口注入（registry/indexer/tempCleaner/describer/dataRegistry），
 * 不引入 electron，可在 Node 下无头测试。
 * ============================================================ */

import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { extractText, isImageFile } from '../searchIndex/parser.ts'
import { getLogger } from '../tools/logger.ts'
import { DATA_EXTS } from './dataAssets.ts'
import type {
  ConversionResult,
  ConvertInput,
  DataAssetRecord,
  DataAssetRegInput,
  IngestResult,
  KnowledgeBuildInput,
  KnowledgeBuildItem,
  KnowledgeBuildOptions,
  KnowledgeBuildResult,
  KnowledgeBuildStatus,
  AssetType
} from '../../shared/types.ts'

/** 可注入依赖（均为结构化最小接口，便于无头测试与解耦具体实现） */
export interface BuilderRegistry {
  findConverter(sourceFormat: string, targetFormat: string): string | undefined
  convert(input: ConvertInput): Promise<ConversionResult>
}

export interface BuilderIndexer {
  ingest(filePath: string, describer?: (p: string) => Promise<string | null>): Promise<IngestResult>
  ingestText(
    filePath: string,
    text: string,
    origin?: 'text' | 'converted',
    meta?: { assetType?: AssetType; kbId?: string }
  ): Promise<IngestResult>
}

export interface BuilderTempCleaner {
  createTempDir(prefix?: string): string
  cleanupFile(path: string): void
  cleanupDir(path: string): void
}

/** 数据型资产登记接口（由 DataAssetRegistry 实现，注入给构建器在文本索引前拦截） */
export interface BuilderDataRegistry {
  register(input: DataAssetRegInput): Promise<DataAssetRecord>
}

export interface KnowledgeBuilderDeps {
  registry: BuilderRegistry
  indexer: BuilderIndexer
  tempCleaner: BuilderTempCleaner
  /** 图片视觉描述函数（Vision RAG）；未提供则图片按普通文件走跳过分支 */
  describer?: (p: string) => Promise<string | null>
  /** P0：数据型资产登记器（CSV/TSV/XLSX 在文本索引前拦截登记） */
  dataRegistry?: BuilderDataRegistry
  /** P0：本次构建归属的知识库 id（缺省 'default'，由 build() 的 opts.kbId 覆盖） */
  kbId?: string
  logger?: { info: (m: string) => void; warning: (m: string) => void }
}

/** 文本友好目标优先级：先无损纯文本，再 markdown/html（CSV/TSV/XLSX 交由数据型资产登记，不再当文本块索引） */
const TEXT_TARGETS = ['.txt', '.md', '.html']

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.cache', 'Cache'])

export class KnowledgeBuilder {
  private readonly deps: KnowledgeBuilderDeps
  private readonly logger: { info: (m: string) => void; warning: (m: string) => void }

  constructor(deps: KnowledgeBuilderDeps) {
    this.deps = deps
    this.logger = deps.logger ?? getLogger('knowledgeBase')
  }

  /** 为给定源格式挑选一个能产出可抽取文本的目标格式（供测试与外部复用） */
  pickTextTarget(srcExt: string): string | undefined {
    const src = srcExt.toLowerCase().startsWith('.') ? srcExt.toLowerCase() : `.${srcExt.toLowerCase()}`
    for (const t of TEXT_TARGETS) {
      if (this.deps.registry.findConverter(src, t)) return t
    }
    return undefined
  }

  async build(inputs: KnowledgeBuildInput[], opts: KnowledgeBuildOptions = {}): Promise<KnowledgeBuildResult> {
    const recursive = opts.recursive ?? true
    const includeImages = opts.includeImages ?? true
    const tempDir = this.deps.tempCleaner.createTempDir('kb')
    const items: KnowledgeBuildItem[] = []
    const counters = { ingested: 0, ingestedConverted: 0, skipped: 0, failed: 0 }

    const addItem = (
      sourcePath: string,
      status: KnowledgeBuildStatus,
      chunkCount: number,
      extra?: Partial<KnowledgeBuildItem>
    ): void => {
      items.push({ sourcePath, status, chunkCount, ...extra })
      if (status === 'ingested') counters.ingested++
      else if (status === 'ingested-converted') counters.ingestedConverted++
      else if (status === 'skipped') counters.skipped++
      else counters.failed++
    }

    const processFile = async (filePath: string): Promise<void> => {
      // 0) P0：数据型资产拦截（在一切文本索引之前）。
      //    CSV/TSV/XLSX/XLS 作为结构化数据资产登记进知识库，并回填 dataAssetId；
      //    彻底消除「CSV 被当文本块索引」缺陷。
      const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
      if (
        (opts.includeDataAssets ?? true) &&
        (DATA_EXTS as readonly string[]).includes(ext) &&
        this.deps.dataRegistry
      ) {
        try {
          const rec = await this.deps.dataRegistry.register({
            path: filePath,
            kbId: this.deps.kbId ?? opts.kbId ?? 'default'
          })
          addItem(filePath, 'ingested', 0, { dataAssetId: rec.assetId })
        } catch (err) {
          addItem(filePath, 'error', 0, { error: `数据资产登记失败: ${(err as Error).message}` })
        }
        return
      }

      // 1) 直接建索引（文本/HTML/图片）。图片仅在 includeImages 时传入 describer。
      const direct = await this.deps.indexer.ingest(filePath, includeImages ? this.deps.describer : undefined)
      if (direct.success) {
        addItem(filePath, 'ingested', direct.chunkCount)
        return
      }
      // 2) 不支持 → 经格式转换引擎产出文本，再以原路径建索引
      const tgt = this.pickTextTarget(ext)
      if (!tgt) {
        addItem(filePath, 'skipped', 0, { error: '无可用文本目标格式（如 pptx 暂不支持文本抽取）' })
        return
      }
      const res = await this.deps.registry.convert({ sourcePath: filePath, targetFormat: tgt, outputDir: tempDir })
      if (!res.success || !res.targetPath) {
        addItem(filePath, 'skipped', 0, { error: `转换失败: ${res.error || '未知错误'}` })
        return
      }
      try {
        const text = await extractText(res.targetPath)
        if (text === null || !text.trim()) {
          addItem(filePath, 'skipped', 0, { error: '转换后未抽到文本', viaPath: res.targetPath })
        } else {
          const r = await this.deps.indexer.ingestText(filePath, text, 'converted')
          addItem(filePath, r.success ? 'ingested-converted' : 'error', r.chunkCount, {
            viaPath: res.targetPath,
            error: r.success ? undefined : r.error
          })
        }
      } catch (err) {
        addItem(filePath, 'error', 0, {
          error: `读取转换结果失败: ${(err as Error).message}`,
          viaPath: res.targetPath
        })
      } finally {
        this.deps.tempCleaner.cleanupFile(res.targetPath)
      }
    }

    const walkDir = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (err) {
        this.logger.warning(`扫描目录失败: ${dir}, ${(err as Error).message}`)
        return
      }
      for (const e of entries) {
        const full = join(dir, e.name)
        if (e.isDirectory()) {
          if (recursive && !SKIP_DIRS.has(e.name)) await walkDir(full)
          continue
        }
        await processFile(full)
      }
    }

    for (const input of inputs) {
      if (input.kind === 'dir') await walkDir(input.path)
      else await processFile(input.path)
    }

    this.deps.tempCleaner.cleanupDir(tempDir)

    const total = items.length
    const ok = counters.failed === 0
    const message = `共 ${total} 项 | 直接索引 ${counters.ingested} | 转换后索引 ${counters.ingestedConverted} | 跳过 ${counters.skipped} | 失败 ${counters.failed}`
    this.logger.info(`知识库构建完成: ${message}`)
    return {
      ok,
      total,
      ingested: counters.ingested,
      ingestedConverted: counters.ingestedConverted,
      skipped: counters.skipped,
      failed: counters.failed,
      items,
      message
    }
  }
}
