/* ============================================
 * 通用 JSON 配置管理（复用 lingmo 既有的 userData 文件化存储范式）
 * 各移植模块（organize / convert / searchIndex）的配置均落 JSON 于 userData，
 * 与 prefs.ts / data.ts 保持一致的「数据自主、文件化」约定。
 * ============================================ */

import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'

export class ConfigStore<T extends Record<string, unknown>> {
  private name: string
  private defaults: T
  private cache: T | null = null

  constructor(name: string, defaults: T) {
    this.name = name
    this.defaults = defaults
  }

  private file(): string {
    return join(app.getPath('userData'), `${this.name}.json`)
  }

  async load(): Promise<T> {
    try {
      const raw = await fs.readFile(this.file(), 'utf-8')
      this.cache = { ...this.defaults, ...(JSON.parse(raw) as Partial<T>) }
    } catch {
      this.cache = { ...this.defaults }
    }
    return this.cache
  }

  async get(): Promise<T> {
    if (!this.cache) return this.load()
    return this.cache
  }

  async set(patch: Partial<T>): Promise<T> {
    const cur = await this.get()
    this.cache = { ...cur, ...patch }
    await fs.mkdir(app.getPath('userData'), { recursive: true })
    // 原子写：先写临时文件再同目录 rename 替换，避免进程崩溃/断电留下半截 JSON 损坏配置
    const target = this.file()
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
    try {
      await fs.writeFile(tmp, JSON.stringify(this.cache, null, 2), 'utf-8')
      await fs.rename(tmp, target)
    } finally {
      // rename 失败或写盘异常时清掉残留临时文件；目标文件保持原样
      await fs.rm(tmp, { force: true }).catch(() => undefined)
    }
    return this.cache
  }
}
