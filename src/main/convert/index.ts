/* 格式转换引擎 — 统一出口（移植自 ck 06_格式转换引擎） */

import { app } from 'electron'
import { join } from 'node:path'
import { ConversionQueue } from './queue.ts'

export * from './types.ts'
export { BaseConverter, normFormat, safeSize } from './baseConverter.ts'
export { ConverterRegistry, getConverterRegistry } from './registry.ts'
export {
  FFmpegConverter,
  ImageMagickConverter,
  LibreOfficeConverter,
  PandocConverter
} from './converters.ts'
export { ConversionQueue } from './queue.ts'
export { TempCleaner, getTempCleaner } from './tempCleaner.ts'

let _queue: ConversionQueue | null = null

/** 获取转换任务队列单例（持久化于 userData/convert-queue.json） */
export function getConversionQueue(): ConversionQueue {
  if (!_queue) {
    _queue = new ConversionQueue(join(app.getPath('userData'), 'convert-queue.json'))
  }
  return _queue
}
