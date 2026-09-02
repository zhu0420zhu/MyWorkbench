import { app, BrowserWindow, dialog } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { listShortcuts } from './shortcuts'
import { listNotes } from './notes'
import { listAutomations } from './automations'
import { readAiConfig } from './ai'
import type { DataInfo } from '../shared/types'

const EXCLUDED = [
  'Cache',
  'GPUCache',
  'Code Cache',
  'DawnCache',
  'blob_storage',
  'Local Storage',
  'Session Storage',
  'Cookies',
  'Crashpad',
  'logs'
]

const DATA_FILES = [
  'shortcuts.json',
  'automations.json',
  'tables',
  'ai-config.json',
  'notes',
  'boards',
  'kb'
]

/** 自定义数据目录配置（放 appData 固定位置，不受 userData 影响） */
function settingsFile(): string {
  return join(app.getPath('appData'), 'lingmo-workbench-settings.json')
}

export async function dataInfo(): Promise<DataInfo> {
  const [shortcuts, notes, automations, cfg] = await Promise.all([
    listShortcuts(),
    listNotes(),
    listAutomations(),
    readAiConfig()
  ])
  return {
    dataDir: app.getPath('userData'),
    shortcuts: shortcuts.length,
    notes: notes.length,
    automations: automations.length,
    aiConfigured: Boolean(cfg.endpoint)
  }
}

export async function getDataDirSetting(): Promise<{ current: string; custom: string | null }> {
  let custom: string | null = null
  try {
    const raw = await fs.readFile(settingsFile(), 'utf-8')
    custom = JSON.parse(raw).dataDir ?? null
  } catch {
    /* 无配置 */
  }
  return { current: app.getPath('userData'), custom }
}

export async function setDataDirSetting(dir: string | null): Promise<{ custom: string | null }> {
  const data: Record<string, string> = {}
  if (dir) data.dataDir = dir
  await fs.mkdir(app.getPath('appData'), { recursive: true })
  await fs.writeFile(settingsFile(), JSON.stringify(data, null, 2), 'utf-8')
  return { custom: dir }
}

/** 启动时应用自定义数据目录（须在 app ready 前调用） */
export async function applyCustomDataDir(): Promise<void> {
  try {
    const raw = await fs.readFile(settingsFile(), 'utf-8')
    const cfg = JSON.parse(raw) as { dataDir?: string }
    if (cfg.dataDir && typeof cfg.dataDir === 'string' && cfg.dataDir.trim()) {
      await fs.mkdir(cfg.dataDir.trim(), { recursive: true })
      app.setPath('userData', cfg.dataDir.trim())
      console.log('[datadir] 自定义数据目录:', cfg.dataDir.trim())
    }
  } catch {
    /* 无配置则用默认 */
  }
}

/** 弹出目录选择框（不写入），返回路径 */
export async function pickDir(win: BrowserWindow, title: string): Promise<string | null> {
  const result = await dialog.showOpenDialog(win, {
    title,
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

/** 导出：复制数据目录到所选位置（排除运行时缓存） */
export async function backupData(win: BrowserWindow): Promise<string | null> {
  const target = await pickDir(win, '选择导出位置')
  if (!target) return null

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const dest = join(target, `myworkbench-backup-${stamp}`)

  await fs.cp(app.getPath('userData'), dest, {
    recursive: true,
    filter: (src) => !EXCLUDED.some((k) => src.includes(k))
  })
  return dest
}

/** 导入：从所选目录复制数据文件到当前数据目录 */
export async function importData(win: BrowserWindow): Promise<string | null> {
  const src = await pickDir(win, '选择要导入的数据目录')
  if (!src) return null
  const dest = app.getPath('userData')
  await fs.mkdir(dest, { recursive: true })
  let count = 0
  for (const f of DATA_FILES) {
    const s = join(src, f)
    try {
      await fs.access(s)
      await fs.cp(s, join(dest, f), { recursive: true, force: true })
      count++
    } catch {
      /* 源文件不存在则跳过 */
    }
  }
  if (count === 0) throw new Error('所选目录中没有可导入的数据文件')
  return src
}
