/* ============================================================
 * 手术式文档编辑 · IPC 薄包装
 *   docs:surgical-extract  读文件 → 登记 ACL → 抽取单元
 *   docs:surgical-apply    备份(.bak) → 手术 → 原子写回(临时文件+rename)
 * 仅本文件 import electron；核心逻辑在 ./index.ts。
 * ============================================================ */

import { ipcMain } from 'electron'
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { SurgicalApplyResult, SurgicalEdit, SurgicalExtractResult } from '../../../shared/types'
import { allowPath } from '../../pathAcl'
import { surgicalApply, surgicalExtract } from './index'
import { containerToLegacySupport, legacyApply, legacyExtract } from './legacyContainer'

export function registerSurgicalIpc(): void {
  ipcMain.handle(
    'docs:surgical-extract',
    async (_e, path: string): Promise<SurgicalExtractResult> => {
      try {
        if (!path) return { ok: false, error: '路径为空' }
        allowPath(path) // 登记共享路径白名单，便于后续跨模块链路访问
        // legacy 格式（DOC/XLS/RTF）：转容器后手术，结果带高保真转换说明
        if (containerToLegacySupport(extname(path))) return await legacyExtract(path)
        const buf = await readFile(path)
        return await surgicalExtract(buf, extname(path))
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'docs:surgical-apply',
    async (_e, path: string, edits: SurgicalEdit[]): Promise<SurgicalApplyResult> => {
      try {
        if (!path) return { ok: false, error: '路径为空' }
        allowPath(path)
        // legacy 格式：容器缓存内手术 → .bak → 转回原格式覆写（legacyApply 内部处理）
        if (containerToLegacySupport(extname(path))) return await legacyApply(path, edits ?? [])
        const buf = await readFile(path)
        const r = await surgicalApply(buf, extname(path), edits ?? [])
        if (!r.ok) return { ok: false, error: r.error }
        // 无变更：不写回、不产生备份
        if (!r.bytes) {
          return { ok: true, changedCount: r.changedCount ?? 0, skipped: r.skipped }
        }
        // 覆写前备份：原路径 + .bak
        const backupPath = path + '.bak'
        await copyFile(path, backupPath)
        // 原子写回：临时文件 + rename（同目录保证同盘原子）
        const tmp = path + '.surgical-tmp'
        await writeFile(tmp, r.bytes)
        await rename(tmp, path)
        return { ok: true, backupPath, changedCount: r.changedCount, skipped: r.skipped }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )
}
