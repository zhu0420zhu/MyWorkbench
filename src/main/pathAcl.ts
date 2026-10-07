/* ============================================================
 * 会话级路径授权（共享模块）
 * 主进程各 IO 型 IPC（pdf/media 等）共用同一份白名单：
 * 仅「用户在对话框里明确选中/保存的路径」及其同目录产物、
 * 授权目录内部文件可被 IPC 读写。
 * 其他模块（如 docs）打开文件时须调用 allowPath 登记，
 * 否则跨模块链路（如文档处理打开 PDF → pdf:read 预览）会被拒绝。
 *
 * ⚠ 存储必须挂在 globalThis 上，不能用模块级 const：
 * 打包器（electron-vite/rollup）在 main 产物中会把本模块**复制成多份**
 * （实测 out/main/index.js 同时存在 allowPath 与 allowPath$1 两个实例），
 * 模块级 Set 会让「docs 登记 → pdf:read 校验」落在两个不同集合里，
 * 表现为跨模块读文件永远被拒（PDF 预览报「读取 PDF 失败」）。
 * 挂 globalThis 后所有副本共享同一份存储。
 * ============================================================ */

import { dirname } from 'node:path'

interface PathAclStore {
  paths: Set<string>
  dirs: Set<string>
}

const GLOBAL_KEY = '__lingmoPathAcl__'

function getStore(): PathAclStore {
  const g = globalThis as unknown as Record<string, PathAclStore | undefined>
  let store = g[GLOBAL_KEY]
  if (!store) {
    store = { paths: new Set<string>(), dirs: new Set<string>() }
    g[GLOBAL_KEY] = store
  }
  return store
}

export function allowPath(p: string): void {
  if (p) getStore().paths.add(p)
}

export function allowDir(dir: string): void {
  if (dir) getStore().dirs.add(dir)
}

function isInsideDir(p: string, dir: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '')
  const f = norm(p)
  const d = norm(dir)
  return f.length > d.length && f.startsWith(d + '/')
}

export function isPathAllowed(p: string): boolean {
  if (!p) return false
  const { paths, dirs } = getStore()
  if (paths.has(p)) return true
  const dir = dirname(p)
  // 也允许同目录下的默认输出名（转换产物）
  for (const a of paths) {
    if (dirname(a) === dir) return true
  }
  for (const d of dirs) {
    if (isInsideDir(p, d)) return true
  }
  return false
}
