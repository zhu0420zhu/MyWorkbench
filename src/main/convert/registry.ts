/* ============================================
 * 转换器注册表（移植自 ck convert_engine.py ConverterRegistry）
 * 汇总所有转换器格式映射，按「源格式→目标格式」自动路由到对应转换器。
 * ============================================ */

import { extname } from 'node:path'
import { getLogger } from '../tools/logger.ts'
import { BaseConverter } from './baseConverter.ts'
import type { ConversionResult, ConvertInput, FormatMap } from './types.ts'
import { FFmpegConverter, ImageMagickConverter, LibreOfficeConverter, PandocConverter } from './converters.ts'

const logger = getLogger('convert.registry')

export class ConverterRegistry {
  private converters = new Map<string, BaseConverter>()
  private formatIndex = new Map<string, Map<string, string>>()

  register(converter: BaseConverter): void {
    const name = converter.name
    this.converters.set(name, converter)
    for (const [src, targets] of Object.entries(converter.formatMap)) {
      if (!this.formatIndex.has(src)) this.formatIndex.set(src, new Map())
      const idx = this.formatIndex.get(src)!
      for (const tgt of targets) if (!idx.has(tgt)) idx.set(tgt, name)
    }
    logger.info(`注册转换器: ${name}, 可用=${converter.isAvailable()}, 映射数=${Object.keys(converter.formatMap).length}`)
  }

  unregister(name: string): boolean {
    const converter = this.converters.get(name)
    if (!converter) return false
    for (const [src, targets] of Object.entries(converter.formatMap)) {
      const idx = this.formatIndex.get(src)
      if (!idx) continue
      for (const tgt of targets) if (idx.get(tgt) === name) idx.delete(tgt)
    }
    this.converters.delete(name)
    return true
  }

  /** 自动路由转换（REQ-06-01） */
  async convert(input: ConvertInput): Promise<ConversionResult> {
    const sourceFormat = extname(input.sourcePath).toLowerCase()
    const targetFormat = input.targetFormat.toLowerCase()
    const tgt = targetFormat.startsWith('.') ? targetFormat : `.${targetFormat}`

    const converterName = this.findConverter(sourceFormat, tgt)
    if (!converterName) {
      logger.warning(`不支持的格式转换: ${sourceFormat} → ${tgt}`)
      return {
        success: false,
        sourcePath: input.sourcePath,
        targetPath: null,
        targetFormat: tgt,
        converterName: '',
        duration: 0,
        error: `不支持的格式转换: ${sourceFormat} → ${tgt}`,
        fileSizeBefore: 0,
        fileSizeAfter: 0
      }
    }
    const converter = this.converters.get(converterName)!
    if (!converter.isAvailable()) {
      return {
        success: false,
        sourcePath: input.sourcePath,
        targetPath: null,
        targetFormat: tgt,
        converterName,
        duration: 0,
        error: `转换器 ${converterName} 不可用（底层工具未安装）`,
        fileSizeBefore: 0,
        fileSizeAfter: 0
      }
    }
    logger.info(`转换路由: ${sourceFormat} → ${tgt}, 转换器=${converterName}`)
    return await converter.convert(input.sourcePath, tgt, input.outputDir, input.quality, input.kwargs)
  }

  findConverter(sourceFormat: string, targetFormat: string): string | undefined {
    const idx = this.formatIndex.get(sourceFormat.toLowerCase())
    if (!idx) return undefined
    return idx.get(targetFormat.toLowerCase())
  }

  getSupportedConversions(sourceFormat = ''): Record<string, string[]> {
    if (sourceFormat) {
      const s = sourceFormat.toLowerCase().startsWith('.') ? sourceFormat.toLowerCase() : `.${sourceFormat.toLowerCase()}`
      const idx = this.formatIndex.get(s)
      return idx ? { [s]: [...idx.keys()] } : {}
    }
    const out: Record<string, string[]> = {}
    for (const [src, idx] of this.formatIndex) out[src] = [...idx.keys()]
    return out
  }

  getAvailableConverters(): Array<{ name: string; available: boolean; sourceFormats: string[]; formatCount: number }> {
    const result: Array<{ name: string; available: boolean; sourceFormats: string[]; formatCount: number }> = []
    for (const [name, converter] of this.converters) {
      result.push({
        name,
        available: converter.isAvailable(),
        sourceFormats: converter.getSupportedSources(),
        formatCount: Object.values(converter.formatMap).reduce((a, b) => a + b.length, 0)
      })
    }
    return result
  }

  get totalFormatsSupported(): number {
    let total = 0
    for (const idx of this.formatIndex.values()) total += idx.size
    return total
  }

  get count(): number {
    return this.converters.size
  }
}

let _registry: ConverterRegistry | null = null

/** 获取转换器注册表单例（首次调用注册默认转换器） */
export function getConverterRegistry(): ConverterRegistry {
  if (!_registry) {
    _registry = new ConverterRegistry()
    _registry.register(new FFmpegConverter())
    _registry.register(new ImageMagickConverter())
    _registry.register(new LibreOfficeConverter())
    _registry.register(new PandocConverter())
    logger.info(
      `默认转换器注册完成 | 转换器数=${_registry.count} | 格式映射数=${_registry.totalFormatsSupported}`
    )
  }
  return _registry
}
