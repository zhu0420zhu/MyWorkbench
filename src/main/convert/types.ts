/* 格式转换引擎 — 类型定义（移植自 ck 06_格式转换引擎） */

export interface ConversionResult {
  success: boolean
  sourcePath: string
  targetPath: string | null
  targetFormat: string
  converterName: string
  duration: number
  error: string
  fileSizeBefore: number
  fileSizeAfter: number
}

export interface FormatMap {
  [source: string]: string[]
}

export interface ConvertInput {
  sourcePath: string
  targetFormat: string
  outputDir?: string
  quality?: string
  /** 转换器特定参数（如 ffmpeg 的 videoCodec/audioCodec、imagemagick 的 resize/density） */
  kwargs?: Record<string, unknown>
}

export type ConvertQuality = 'low' | 'medium' | 'high'
