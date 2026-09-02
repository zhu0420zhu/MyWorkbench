/* 灵墨工作台 · 字段类型推断（纯函数，主进程 / 渲染层共享，无第三方依赖）
 *
 * 从 renderer/src/utils/ioFormats.ts 的 inferType 下沉并补全 date 检测，
 * 保证主进程数据资产登记与渲染层导入共用同一套列类型判定。
 */

import type { FieldType } from './types'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?)?$/

function isDateLike(v: string): boolean {
  if (!ISO_DATE.test(v)) return false
  const t = v.replace('T', ' ').replace(/[Zz]$/, '')
  const d = new Date(t)
  return !Number.isNaN(d.getTime())
}

/**
 * 推断单列类型：与渲染层 buildTableFromRows 行为对齐（数值 / 布尔 / 文本），
 * 并补全 date 检测（ISO 日期）。计数 + 一旦达标即返回，避免全列扫描。
 * 仅当 >=70% 的取值为某类型时才判定为该类型，其余回退为 text。
 */
export function inferFieldType(values: string[]): FieldType {
  const total = values.length
  if (total === 0) return 'text'
  const threshold = Math.max(1, Math.floor(total * 0.7))
  let numeric = 0
  let dateish = 0
  let boolish = false
  for (let i = 0; i < total; i++) {
    const v = values[i]
    if (v === '' || v == null) continue
    if (isFinite(Number(v))) {
      numeric++
      if (numeric >= threshold) return 'number'
    } else if (v === 'true' || v === 'false') {
      boolish = true
    } else if (isDateLike(v)) {
      dateish++
      if (dateish >= threshold) return 'date'
    }
  }
  if (boolish) return 'checkbox'
  return 'text'
}
