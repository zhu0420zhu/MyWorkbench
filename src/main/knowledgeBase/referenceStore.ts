/* ============================================================
 * 知识库引用记录存储（P0：L1 scene-default / project / session 引用）
 *
 * 基于通用 ConfigStore 落 JSON 于 userData/kb/：
 *   - kb/references.json      引用记录（ReferenceRecord[]）
 *   - kb/sceneDefaultKB.json 场景默认知识库映射
 * 仅依赖 electron 的 app.getPath（经 ConfigStore），无第三方依赖。
 * ============================================================ */

import { app } from 'electron'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigStore } from '../configStore'
import type { ReferenceRecord, ReferenceScope, SceneDefaultKb } from '../../shared/types'

type ReferenceState = { records: ReferenceRecord[] }
type SceneDefaultKbState = { sceneDefaultKB: Record<string, string[]> }

const referencesStore = new ConfigStore<ReferenceState>('kb/references', { records: [] })
const sceneDefaultKbStore = new ConfigStore<SceneDefaultKbState>('kb/sceneDefaultKB', { sceneDefaultKB: {} })

/** 确保 kb 目录存在（ConfigStore 仅 mkdir userData，不会创建中间的 kb 目录） */
async function ensureKbDir(): Promise<void> {
  await mkdir(join(app.getPath('userData'), 'kb'), { recursive: true })
}

/** 新增一条引用记录 */
export async function addReference(rec: ReferenceRecord): Promise<void> {
  await ensureKbDir()
  const s = await referencesStore.get()
  await referencesStore.set({ records: [...s.records, rec] })
}

/** 按作用域 / 落点过滤引用记录 */
export async function listReferences(opts?: {
  scope?: ReferenceScope
  referencePosition?: string
}): Promise<ReferenceRecord[]> {
  const s = await referencesStore.get()
  let recs = s.records
  if (opts?.scope) recs = recs.filter((r) => r.scope === opts.scope)
  if (opts?.referencePosition) recs = recs.filter((r) => r.referencePosition === opts.referencePosition)
  return recs
}

/** 读取场景默认知识库映射 */
export async function getSceneDefaultKb(): Promise<SceneDefaultKb> {
  return sceneDefaultKbStore.get()
}

/** 写入场景默认知识库映射（全量覆盖） */
export async function setSceneDefaultKb(payload: SceneDefaultKb): Promise<SceneDefaultKb> {
  await ensureKbDir()
  return sceneDefaultKbStore.set(payload)
}
