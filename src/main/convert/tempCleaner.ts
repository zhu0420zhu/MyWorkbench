/* ============================================
 * 临时文件清理（移植自 ck 06_格式转换引擎/temp_cleaner.py，REQ-06-07）
 * 转换过程中产生的临时文件自动清理：目录创建、单文件/整目录清理、过期清理、状态查询。
 * ============================================ */

import { mkdirSync, rmSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getLogger } from '../tools/logger.ts'

const logger = getLogger('convert.temp')

const DEFAULT_EXPIRE_HOURS = 24

export class TempCleaner {
  private tempBase: string

  constructor(tempBaseDir?: string) {
    this.tempBase = tempBaseDir || join(tmpdir(), 'lingmo_convert')
    try {
      mkdirSync(this.tempBase, { recursive: true })
    } catch {
      /* ignore */
    }
  }

  createTempDir(prefix = 'conv'): string {
    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    const dir = join(this.tempBase, `${prefix}_${ts}_${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  cleanupFile(filePath: string): boolean {
    try {
      if (statSync(filePath).isFile()) {
        rmSync(filePath, { force: true })
        logger.debug(`已清理临时文件: ${filePath}`)
        return true
      }
    } catch (err) {
      logger.warning(`清理文件失败: ${filePath}, 错误: ${(err as Error).message}`)
    }
    return false
  }

  cleanupDir(dirPath: string): boolean {
    try {
      rmSync(dirPath, { recursive: true, force: true })
      logger.info(`已清理临时目录: ${dirPath}`)
      return true
    } catch (err) {
      logger.warning(`清理目录失败: ${dirPath}, 错误: ${(err as Error).message}`)
      return false
    }
  }

  cleanupExpired(expireHours = DEFAULT_EXPIRE_HOURS): { cleanedFiles: number; cleanedDirs: number; freedSpace: number } {
    const cutoff = Date.now() - expireHours * 3600 * 1000
    let cleanedFiles = 0
    let cleanedDirs = 0
    let freedSpace = 0
    try {
      for (const entry of readdirSync(this.tempBase, { withFileTypes: true })) {
        const full = join(this.tempBase, entry.name)
        let mtime = 0
        try {
          mtime = statSync(full).mtimeMs
        } catch {
          continue
        }
        if (mtime >= cutoff) continue
        if (entry.isFile()) {
          const size = statSync(full).size
          if (this.cleanupFile(full)) {
            cleanedFiles++
            freedSpace += size
          }
        } else if (entry.isDirectory()) {
          let dirSize = 0
          try {
            for (const f of readdirSync(full, { withFileTypes: true })) {
              try {
                if (f.isFile()) dirSize += statSync(join(full, f.name)).size
              } catch {
                /* ignore */
              }
            }
          } catch {
            /* ignore */
          }
          if (this.cleanupDir(full)) {
            cleanedDirs++
            freedSpace += dirSize
          }
        }
      }
    } catch (err) {
      logger.error(`扫描临时目录失败: ${(err as Error).message}`)
    }
    logger.info(`清理完成: 文件=${cleanedFiles}, 目录=${cleanedDirs}, 释放空间=${freedSpace}字节`)
    return { cleanedFiles, cleanedDirs, freedSpace }
  }

  getTempStatus(): { tempDir: string; exists: boolean; totalFiles: number; totalSize: number } {
    let totalFiles = 0
    let totalSize = 0
    try {
      for (const f of readdirSync(this.tempBase, { withFileTypes: true })) {
        if (f.isFile()) {
          totalFiles++
          try {
            totalSize += statSync(join(this.tempBase, f.name)).size
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      return { tempDir: this.tempBase, exists: false, totalFiles: 0, totalSize: 0 }
    }
    return { tempDir: this.tempBase, exists: true, totalFiles, totalSize }
  }
}

let _cleaner: TempCleaner | null = null

export function getTempCleaner(): TempCleaner {
  if (!_cleaner) _cleaner = new TempCleaner()
  return _cleaner
}
