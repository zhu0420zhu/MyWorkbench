/**
 * 批量导出（拆分「逐页导出」用）。
 *
 * 背景（审计 P2#6）：旧实现在循环里逐页调 `savePdf`，而 `savePdf` 内部会弹
 * `dialog.showSaveDialog` —— 100 页 PDF 就要连续点 100 次保存框。
 *
 * 现改为「选一次目标目录 → 批量写入」：
 *   1. 目录只选一次（`api.pickDir`），随后全部走 `api.write`；
 *   2. 写入前先探测重名，重名不静默覆盖 —— 必须由调用方二次确认；
 *   3. 逐个写入并逐条记录结果，返回「成功数 + 失败清单（含原因）」，不做笼统失败上报。
 *
 * 本模块不依赖 React / pdf-lib：页面字节由调用方通过 `buildPage` 注入，
 * 因此可以在无头环境下驱动同一条真实代码路径做验收。
 */

export interface BatchTarget {
  name: string
  path: string
  bytes: Uint8Array
}

export interface BatchWriteOutcome {
  ok: number
  failed: Array<{ name: string; error: string }>
}

export interface BatchWriteApi {
  pickDir: (title?: string) => Promise<string | null>
  exists: (paths: string[]) => Promise<boolean[]>
  write: (path: string, data: Uint8Array) => Promise<boolean>
}

export interface ExportEachResult {
  /** 用户取消（未选目录 / 重名确认被拒）时为 true，此时不写入任何文件 */
  canceled: boolean
  dir: string
  ok: number
  failed: Array<{ name: string; error: string }>
  /** 本次探测到的重名文件（可能为空） */
  conflicts: string[]
}

/** 目录 + 文件名 → 完整路径（Node 的 fs 接受正斜杠路径，跨平台一致） */
export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, '')}/${name}`
}

/** 逐页文件名：可预期、可复现（原名-pN.pdf） */
export function eachPageName(baseName: string, pageIndex: number): string {
  return `${baseName}-p${pageIndex + 1}.pdf`
}

/** 顺序写入全部目标，逐条记录成败；单个失败不中断其余文件。 */
export async function writeTargets(
  api: BatchWriteApi,
  targets: BatchTarget[],
  formatError: (e: unknown) => string = (e) => (e instanceof Error ? e.message : String(e))
): Promise<BatchWriteOutcome> {
  const failed: Array<{ name: string; error: string }> = []
  let ok = 0
  for (const t of targets) {
    try {
      if (await api.write(t.path, t.bytes)) ok++
      else failed.push({ name: t.name, error: '写入被拒绝（路径未授权或超出大小上限）' })
    } catch (err) {
      failed.push({ name: t.name, error: formatError(err) })
    }
  }
  return { ok, failed }
}

/**
 * 「逐页导出」完整流程：选一次目录 → 生成每页字节 → 重名确认 → 批量写入。
 * `confirmOverwrite` 返回 false 时**不写入任何文件**（取消语义）。
 */
export async function exportEachPage(
  api: BatchWriteApi,
  opts: {
    baseName: string
    pages: number[]
    buildPage: (pageIndex: number) => Promise<Uint8Array>
    confirmOverwrite: (names: string[]) => Promise<boolean>
    pickTitle?: string
    formatError?: (e: unknown) => string
  }
): Promise<ExportEachResult> {
  const dir = await api.pickDir(opts.pickTitle ?? '选择导出目录')
  if (!dir) return { canceled: true, dir: '', ok: 0, failed: [], conflicts: [] }

  const targets: BatchTarget[] = []
  for (const i of opts.pages) {
    const name = eachPageName(opts.baseName, i)
    targets.push({ name, path: joinPath(dir, name), bytes: await opts.buildPage(i) })
  }

  const exists = await api.exists(targets.map((t) => t.path))
  const conflicts = targets.filter((_, k) => exists[k]).map((t) => t.name)
  if (conflicts.length && !(await opts.confirmOverwrite(conflicts))) {
    return { canceled: true, dir, ok: 0, failed: [], conflicts }
  }

  const outcome = await writeTargets(api, targets, opts.formatError)
  return { canceled: false, dir, ...outcome, conflicts }
}
