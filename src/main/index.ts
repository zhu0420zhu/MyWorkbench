import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type WebContents
} from 'electron'
import { join } from 'path'
import { spawn, type ChildProcess } from 'child_process'
import { pathToFileURL } from 'url'
import { existsSync } from 'fs'
import { promises as fs } from 'fs'
import type { AiChatMessage, AiTool } from '../shared/types'
import { listShortcuts, addShortcut, updateShortcut, removeShortcut } from './shortcuts'
import { listNotes, getNote, createNote, updateNote, removeNote } from './notes'
import {
  listAutomations,
  addAutomation,
  updateAutomation,
  removeAutomation
} from './automations'
import { searchAll } from './search'
import { readModel, readWasm, getDict, getTableDict, pickImage, pickImages } from './ocr'
import { listStickies, getSticky, createSticky, updateSticky, removeSticky } from './stickies'
import {
  showStickyWindow,
  closeStickyWindow,
  broadcastStickyUpdate,
  closeAllStickyWindows,
  setStickyWindowSize
} from './stickyWindows'
import {
  showStickyPanel,
  closeStickyPanel,
  setStickyPanelMode,
  getStickyPanelMode,
  type StickyPanelMode
} from './stickyPanel'
import { translateText, TRANSLATE_LANGS } from './translate'
import { readAiConfig, saveAiConfig, chat, stopChat, complete, testAiConnection, listAiProfiles, addAiProfile, addOllamaProfile, updateAiProfile, removeAiProfile, setActiveAiProfile, testAiProfile, getRouting, setRouting, listEndpointModels } from './ai'
import { dataInfo, backupData, importData, getDataDirSetting, setDataDirSetting, applyCustomDataDir, pickDir } from './data'
import {
  aggregateTable,
  createTable,
  getTable,
  importTable,
  listTables,
  removeTable,
  updateCell,
  updateTable
} from './tables'
import {
  listBoards,
  createBoard,
  removeBoard,
  getBoardSnapshot,
  saveBoard,
  renameBoard
} from './boards'
import { registerToolsIpc } from './toolsIpc'
import { registerPublishIpc } from './publishIpc'
import { registerOrganizeIpc } from './organize/organizeIpc'
import { registerConvertIpc } from './convert/convertIpc'
import { getTempCleaner } from './convert/tempCleaner'
import { registerMediaIpc } from './media/mediaIpc'
import { registerHardwareIpc } from './hardware/hardwareIpc'
import { registerPdfIpc } from './pdf/pdfIpc'
import { registerSearchIndexIpc } from './searchIndex/searchIndexIpc'
import { registerKnowledgeBaseIpc } from './knowledgeBase/knowledgeBaseIpc'
import { registerKbDataIpc } from './kbDataIpc'
import { registerMcpIpc } from './mcp/mcpIpc'
import { registerNotesFeatureIpc } from './notesFeature/notesFeatureIpc'
import { registerNovelIpc } from './novel/novelIpc'
import { listProjects, getProject } from './novel/store'
import { registerDocsIpc } from './docsIpc'
import { registerSurgicalIpc } from './docs/surgical/surgicalIpc'
import { registerPptIpc } from './ppt/pptConvert'
import { registerAgentsHubIpc } from './agentsHub/ipc'
import { registerSillyTavernIpc } from './sillytavern/sillytavernIpc'
import { registerFeedIpc } from './feed/feedIpc'
import { getFeedService } from './feed/feedService'
import { getPrefs, setPrefs } from './prefs'
import { getLogger, installGlobalErrorHandlers } from './tools/logger'
import { loadUsageStats, recordPageVisit, resetUsageStats } from './usageStats'
import {
  listSnapshots,
  createSnapshot,
  getSnapshot,
  restoreSnapshot,
  removeSnapshot,
  clearSnapshots,
  type SnapshotKind
} from './snapshots'
import {
  listBookSources,
  exportBook,
  pandocAvailable,
  pickCoverImage,
  generateCover,
  type BookExportInput,
  type BookCoverOptions
} from './bookExport'
import { loadMemory, saveMemory, clearMemory, exportMemory, importMemory } from './aiMemory'
import { addPromptLog, listPromptLog, deletePromptLog, clearPromptLog } from './promptLog'
import {
  initWindowManager,
  attachWindowManager,
  attachCloseGuard,
  registerWindowIpc,
  MAIN_PROFILE,
  isCloseGuardMinimize
} from './windowManager'
import {
  openPageWindow,
  closePageWindow,
  closeAllPageWindows,
  listPageWindows,
  hasPageWindow
} from './pageWindows'

// 全局兜底：uncaughtException / unhandledRejection 统一写入 userData/logs
installGlobalErrorHandlers()

const CACHE_DIRS = [
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

/** 旧版应用名 myworkbench 的数据目录 → 新名 lingmo-workbench，仅在新目录无数据时迁移一次 */
async function migrateLegacyData(): Promise<void> {
  const newDir = app.getPath('userData')
  const legacy = join(app.getPath('appData'), 'myworkbench')
  try {
    if (legacy === newDir || !existsSync(legacy)) return
    const markers = ['shortcuts.json', 'automations.json', 'notes', 'ai-config.json']
    const hasData = markers.some((f) => existsSync(join(newDir, f)))
    if (hasData) return
    await fs.cp(legacy, newDir, {
      recursive: true,
      filter: (src) => !CACHE_DIRS.some((k) => src.includes(k))
    })
    console.log('[migrate] 已从 myworkbench 迁移数据到', newDir)
  } catch (err) {
    console.warn('[migrate] 迁移失败:', err)
  }
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: MAIN_PROFILE.defaultWidth,
    height: MAIN_PROFILE.defaultHeight,
    minWidth: MAIN_PROFILE.minWidth,
    minHeight: MAIN_PROFILE.minHeight,
    show: false,
    autoHideMenuBar: true,
    frame: false,
    backgroundColor: '#141414',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webviewTag: true
    }
  })

  // 尺寸记忆 + 最小/最大限制（记忆的 bounds 若已不在任何显示器上会自动回到居中默认）
  attachWindowManager(mainWindow, 'main', MAIN_PROFILE)

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    // 同步初始最大化状态：以最大化尺寸启动时，自定义标题栏按钮图标才不会画错
    mainWindow.webContents.send('window:maximized', mainWindow.isMaximized())
  })

  // 最大化状态推送（自定义标题栏按钮切换）
  mainWindow.on('maximize', () => {
    if (!mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('window:maximized', true)
    }
  })
  mainWindow.on('unmaximize', () => {
    if (!mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('window:maximized', false)
    }
  })

  // 最小化时把便利贴抽离为无边框悬浮窗独立显示在桌面；还原时自动收起
  // 关闭守卫选择「最小化到后台」时也会触发 minimize，此时应抑制便利贴面板弹出
  mainWindow.on('minimize', () => {
    if (!isCloseGuardMinimize()) {
      void showStickyPanel()
    }
  })
  mainWindow.on('restore', () => {
    closeStickyPanel()
  })

  // 关闭按钮：询问「最小化到后台 / 直接退出」，可勾选不再提示
  attachCloseGuard(mainWindow, {
    onBackground: () => closeStickyPanel(),
    onRestore: () => closeStickyPanel()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const runningProcesses = new Map<string, ChildProcess>()

async function runAutomation(sender: WebContents, id: string): Promise<boolean> {
  const list = await listAutomations()
  const auto = list.find((a) => a.id === id)
  if (!auto || runningProcesses.has(id)) return false

  let child: ChildProcess
  try {
    child = spawn(auto.command, {
      cwd: auto.cwd?.trim() || undefined,
      shell: true,
      windowsHide: true
    })
  } catch {
    return false
  }
  runningProcesses.set(id, child)

  const push = (payload: unknown): void => {
    try {
      if (!sender.isDestroyed()) sender.send('automations:output', payload)
    } catch {
      /* ignore */
    }
  }
  const finish = (payload: unknown): void => {
    try {
      if (!sender.isDestroyed()) sender.send('automations:done', payload)
    } catch {
      /* ignore */
    }
  }

  child.stdout?.on('data', (d: Buffer) => push({ id, chunk: d.toString(), isError: false }))
  child.stderr?.on('data', (d: Buffer) => push({ id, chunk: d.toString(), isError: true }))
  child.on('error', (err) => {
    push({ id, chunk: `[启动失败] ${err.message}\n`, isError: true })
    runningProcesses.delete(id)
    finish({ id, exitCode: null })
  })
  child.on('close', (code) => {
    runningProcesses.delete(id)
    finish({ id, exitCode: code })
  })
  return true
}

function stopAutomation(id: string): boolean {
  const child = runningProcesses.get(id)
  if (!child) return false
  child.kill()
  return true
}

function registerIpc(): void {
  // 无边框窗口控制
  ipcMain.handle('window:minimize', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize()
  })
  ipcMain.handle('window:toggle-maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('window:close', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
  })
  // 页面独立窗口：写作 / 笔记 / 白板等可从主窗口分离为独立无边框窗口
  ipcMain.handle('window:open-page', (_e, page: string, id?: string) =>
    typeof page === 'string' && page.length > 0 ? openPageWindow(page, id) : false
  )
  ipcMain.handle('window:close-page', (_e, page: string, id?: string) =>
    closePageWindow(page, id)
  )
  ipcMain.handle('window:page-windows', () => listPageWindows())
  ipcMain.handle('window:has-page', (_e, page: string, id?: string) => hasPageWindow(page, id))
  ipcMain.handle('app:relaunch', () => {
    app.relaunch()
    app.exit(0)
    return true
  })

  ipcMain.handle('shortcuts:list', () => listShortcuts())
  ipcMain.handle('shortcuts:add', (_e, input) => addShortcut(input))
  ipcMain.handle('shortcuts:update', (_e, payload) => updateShortcut(payload))
  ipcMain.handle('shortcuts:remove', (_e, id: string) => removeShortcut(id))

  ipcMain.handle('notes:list', () => listNotes())
  ipcMain.handle('notes:get', (_e, id: string) => getNote(id))
  ipcMain.handle('notes:create', (_e, title: string) => createNote(title))
  ipcMain.handle('notes:update', async (_e, id: string, content: string) => {
    const list = await updateNote(id, content)
    // 每次保存留一个快照点（内容未变化或 30s 内重复保存会自动跳过）
    await createSnapshot('note', id, content, { reason: 'auto', minIntervalMs: 30_000 }).catch(
      () => undefined
    )
    return list
  })
  ipcMain.handle('notes:remove', (_e, id: string) => {
    void clearSnapshots('note', id).catch(() => undefined)
    return removeNote(id)
  })

  /* ---- 版本快照：笔记 / 写作草稿通用 ---- */
  ipcMain.handle('snapshots:list', (_e, kind: SnapshotKind, id: string) => listSnapshots(kind, id))
  ipcMain.handle(
    'snapshots:create',
    (_e, kind: SnapshotKind, id: string, content: string, label?: string) =>
      createSnapshot(kind, id, content, { reason: 'manual', label })
  )
  ipcMain.handle('snapshots:get', (_e, kind: SnapshotKind, id: string, snapId: string) =>
    getSnapshot(kind, id, snapId)
  )
  ipcMain.handle(
    'snapshots:restore',
    (_e, kind: SnapshotKind, id: string, snapId: string, currentContent: string) =>
      restoreSnapshot(kind, id, snapId, currentContent)
  )
  ipcMain.handle('snapshots:remove', (_e, kind: SnapshotKind, id: string, snapId: string) =>
    removeSnapshot(kind, id, snapId)
  )

  /* ---- 导出成书：笔记 / 草稿按序拼装 → EPUB / DOCX / PDF / HTML / MD / TXT ---- */
  ipcMain.handle('book:sources', () => listBookSources())
  ipcMain.handle('book:pandoc-available', () => pandocAvailable())
  ipcMain.handle('book:export', (e, input: BookExportInput) =>
    exportBook(BrowserWindow.fromWebContents(e.sender), input)
  )
  ipcMain.handle('book:pick-cover', (e) => pickCoverImage(BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle('book:generate-cover', (_e, opts: BookCoverOptions) => generateCover(opts))

  ipcMain.handle('automations:list', () => listAutomations())
  ipcMain.handle('automations:add', (_e, input) => addAutomation(input))
  ipcMain.handle('automations:update', (_e, payload) => updateAutomation(payload))
  ipcMain.handle('automations:remove', (_e, id: string) => removeAutomation(id))
  ipcMain.handle('automations:running', () => [...runningProcesses.keys()])
  ipcMain.handle('automations:run', (event, id: string) => runAutomation(event.sender, id))
  ipcMain.handle('automations:stop', (_e, id: string) => stopAutomation(id))

  ipcMain.handle('tables:list', () => listTables())
  ipcMain.handle('tables:get', (_e, id: string) => getTable(id))
  ipcMain.handle('tables:create', (_e, name: string) => createTable(name))
  ipcMain.handle('tables:update', (_e, table) => updateTable(table))
  ipcMain.handle('tables:updateCell', (_e, tableId: string, rowId: string, fieldId: string, value) => updateCell(tableId, rowId, fieldId, value))
  ipcMain.handle('tables:remove', (_e, id: string) => removeTable(id))
  // 单次导入：解析结果整表一次过 IPC，主进程单事务落库（省掉旧 create→update 的二次整表传输）
  ipcMain.handle('tables:import', (_e, input) => importTable(input))
  // 跨模块聚合：Analytics 引用 DataLab 表时主进程算好只回聚合结果，不整表过 IPC
  ipcMain.handle('tables:aggregate', (_e, req) => aggregateTable(req))

  ipcMain.handle('boards:list', () => listBoards())
  ipcMain.handle('boards:create', (_e, title: string) => createBoard(title))
  ipcMain.handle('boards:remove', (_e, id: string) => removeBoard(id))
  ipcMain.handle('boards:get', (_e, id: string) => getBoardSnapshot(id))
  ipcMain.handle('boards:save', (_e, id: string, snapshot) => saveBoard(id, snapshot))
  ipcMain.handle('boards:rename', (_e, id: string, title: string) => renameBoard(id, title))

  ipcMain.handle('search:all', (_e, query: string) => searchAll(query))

  ipcMain.handle('ocr:model', (_e, name: string) => readModel(name))
  ipcMain.handle('ocr:wasm', (_e, name: string) => readWasm(name))
  ipcMain.handle('ocr:dict', () => getDict())
  ipcMain.handle('ocr:table-dict', () => getTableDict())
  ipcMain.handle('ocr:pick-images', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    return win ? pickImages(win) : []
  })
  ipcMain.handle('ocr:pick-image', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    return win ? pickImage(win) : null
  })

  ipcMain.handle('ai:get-config', () => readAiConfig())
  ipcMain.handle('ai:save-config', (_e, cfg) => saveAiConfig(cfg))
  ipcMain.handle('ai:test-connection', () => testAiConnection())
  ipcMain.handle('ai:list-profiles', () => listAiProfiles())
  ipcMain.handle('ai:add-profile', (_e, input) => addAiProfile(input))
  ipcMain.handle('ai:update-profile', (_e, id: string, patch) => updateAiProfile(id, patch))
  ipcMain.handle('ai:remove-profile', (_e, id: string) => removeAiProfile(id))
  ipcMain.handle('ai:set-active-profile', (_e, id: string) => setActiveAiProfile(id))
  ipcMain.handle('ai:test-profile', (_e, cfg) => testAiProfile(cfg))
  ipcMain.handle('ai:list-models', (_e, endpoint: string, apiKey?: string) => listEndpointModels(endpoint, apiKey))
  ipcMain.handle('ai:add-ollama', (_e, opts?: { endpoint?: string; model?: string; name?: string }) => addOllamaProfile(opts))
  ipcMain.handle('ai:get-routing', () => getRouting())
  ipcMain.handle('ai:set-routing', (_e, r) => setRouting(r))

  ipcMain.handle('usage:page-visit', (_e, page: string) => recordPageVisit(page))
  ipcMain.handle('usage:reset', () => resetUsageStats())
  ipcMain.handle('usage:dashboard', async () => {
    const usage = await loadUsageStats()
    const [shortcuts, notes, automations, cfg, boardsMeta, novelList, stickies, profiles] = await Promise.all([
      listShortcuts(),
      listNotes(),
      listAutomations(),
      readAiConfig(),
      listBoards().catch(() => []),
      listProjects().catch(() => []),
      listStickies().catch(() => []),
      listAiProfiles().catch(() => ({ activeId: '', profiles: [] }))
    ])
    let tables = 0
    try {
      tables = (await listTables()).length
    } catch {
      tables = 0
    }
    let chapters = 0
    try {
      for (const p of novelList) {
        const full = await getProject(p.id)
        chapters += full?.chapters.length ?? 0
      }
    } catch {
      /* ignore */
    }
    return {
      usage,
      content: {
        shortcuts: shortcuts.length,
        notes: notes.length,
        automations: automations.length,
        boards: boardsMeta.length,
        novelProjects: novelList.length,
        novelChapters: chapters,
        dataTables: tables,
        aiProfiles: profiles.profiles.length,
        stickies: stickies.length,
        dataDir: app.getPath('userData'),
        aiConfigured: Boolean(cfg.endpoint)
      }
    }
  })
  ipcMain.handle('ai:chat', (event, sessionId: string, messages, modelOverride?: string, tools?: AiTool[], sampling?: Record<string, number | string | boolean>) =>
    chat(event.sender, sessionId, messages, modelOverride, tools, sampling)
  )
  ipcMain.handle('ai:complete', (_e, messages: AiChatMessage[], modelOverride?: string) =>
    complete(messages, modelOverride ? { modelOverride } : undefined)
  )
  // (removed duplicate ai:complete)
  ipcMain.handle('ai:stop', (_e, sessionId: string) => stopChat(sessionId))

  ipcMain.handle('data:info', () => dataInfo())
  ipcMain.handle('data:import', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    return importData(win)
  })
  ipcMain.handle('data:get-datadir', () => getDataDirSetting())
  ipcMain.handle('data:set-datadir', (_e, dir: string | null) => setDataDirSetting(dir))
  ipcMain.handle('data:pick-dir', (event, title: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    return pickDir(win, title ?? '选择目录')
  })

  ipcMain.handle('file:pick-text', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择数据文件',
      filters: [
        { name: '数据文件', extensions: ['csv', 'txt', 'json', 'tsv'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const file = result.filePaths[0]
    const content = await fs.readFile(file, 'utf-8')
    return { name: file.split(/[\\/]/).pop() ?? file, content }
  })

  ipcMain.handle('stickies:list', () => listStickies())
  ipcMain.handle('stickies:get', (_e, id: string) => getSticky(id))
  ipcMain.handle('stickies:create', (_e, input) => createSticky(input))
  ipcMain.handle('stickies:update', (_e, payload) => {
    const result = updateSticky(payload)
    broadcastStickyUpdate(payload)
    return result
  })
  ipcMain.handle('stickies:remove', (_e, id: string) => {
    closeStickyWindow(id)
    return removeSticky(id)
  })
  ipcMain.handle('stickies:stick', (_e, id: string) => showStickyWindow(id))
  ipcMain.handle('stickies:unstick', (_e, id: string) => closeStickyWindow(id))
  // 便利贴悬浮窗尺寸切换（折叠 ⇄ 展开大尺寸）
  ipcMain.handle('stickies:set-size', (_e, id: string, width: number, height: number) =>
    setStickyWindowSize(id, width, height)
  )
  // 便利贴悬浮面板窗：折叠图标态 / 展开内容态
  ipcMain.handle('stickies:panel-mode', () => getStickyPanelMode())
  ipcMain.handle('stickies:panel-set-mode', (_e, m: StickyPanelMode) => setStickyPanelMode(m))

  ipcMain.handle('translate:run', async (_e, text: string, source: string, target: string) => {
    try {
      return { ok: true, value: await translateText(text, source, target) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  ipcMain.handle('translate:langs', () => TRANSLATE_LANGS)

  ipcMain.handle('prefs:get', () => getPrefs())
  ipcMain.handle('prefs:set', (_e, prefs) => setPrefs(prefs))

  /** 选择自定义壁纸图：复制到 userData/wallpapers，返回持久化绝对路径 */
  ipcMain.handle('prefs:pick-wallpaper', async (event): Promise<{ ok: boolean; path?: string; error?: string }> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts = {
      title: '选择壁纸图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
      properties: ['openFile' as const]
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || !result.filePaths[0]) return { ok: false, error: 'cancelled' }
    try {
      const src = result.filePaths[0]
      const dir = join(app.getPath('userData'), 'wallpapers')
      await fs.mkdir(dir, { recursive: true })
      const ext = src.slice(src.lastIndexOf('.'))
      const dest = join(dir, `wp-${Date.now()}${ext}`)
      await fs.copyFile(src, dest)
      return { ok: true, path: dest }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  /** 壁纸路径 → data URL（CSP img-src 限制 file://，改走 base64 更稳） */
  ipcMain.handle('prefs:wallpaper-url', async (_e, path: string): Promise<string> => {
    if (!path) return ''
    try {
      const buf = await fs.readFile(path)
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
      const mime =
        ext === 'png'
          ? 'image/png'
          : ext === 'webp'
            ? 'image/webp'
            : ext === 'gif'
              ? 'image/gif'
              : ext === 'bmp'
                ? 'image/bmp'
                : 'image/jpeg'
      return `data:${mime};base64,${buf.toString('base64')}`
    } catch {
      try {
        return pathToFileURL(path).href
      } catch {
        return ''
      }
    }
  })

  ipcMain.handle('ai:memory-load', () => loadMemory())
  ipcMain.handle('ai:memory-save', (_e, memory) => saveMemory(memory))
  ipcMain.handle('ai:memory-clear', () => clearMemory())
  ipcMain.handle('ai:memory-export', () => exportMemory())
  ipcMain.handle('ai:memory-import', (_e, json: string) => importMemory(json))

  ipcMain.handle('prompt-log:add', (_e, input) => addPromptLog(input))
  ipcMain.handle('prompt-log:list', () => listPromptLog())
  ipcMain.handle('prompt-log:delete', (_e, id: string) => deletePromptLog(id))
  ipcMain.handle('prompt-log:clear', () => clearPromptLog())

  ipcMain.handle('file:pick-buffer', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择数据文件',
      filters: [
        { name: '数据文件', extensions: ['csv', 'json', 'tsv', 'xlsx', 'xls', 'txt'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const file = result.filePaths[0]
    const buf = await fs.readFile(file)
    return { name: file.split(/[\\/]/).pop() ?? file, data: new Uint8Array(buf) }
  })

  // 多选文件（批量导入笔记用）
  ipcMain.handle('file:pick-buffers', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return []
    const result = await dialog.showOpenDialog(win, {
      title: '选择要导入的文件（可多选）',
      filters: [
        { name: '可导入文件', extensions: ['txt', 'md', 'csv', 'tsv', 'json', 'xlsx', 'xls'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return []
    const out: Array<{ name: string; data: Uint8Array; size: number }> = []
    for (const file of result.filePaths) {
      try {
        const buf = await fs.readFile(file)
        out.push({ name: file.split(/[\\/]/).pop() ?? file, data: new Uint8Array(buf), size: buf.length })
      } catch {
        /* 单个文件读取失败跳过 */
      }
    }
    return out
  })

  ipcMain.handle('export:save-buffer', async (event, payload: { defaultName: string; data: Uint8Array }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const result = await dialog.showSaveDialog(win, {
      title: '导出文件',
      defaultPath: payload.defaultName || '导出.xlsx',
      filters: [{ name: '文件', extensions: ['xlsx', 'xls', 'csv', 'json'] }]
    })
    if (result.canceled || !result.filePath) return null
    try {
      await fs.writeFile(result.filePath, Buffer.from(payload.data))
      return result.filePath
    } catch (err) {
      console.error('[export:save-buffer] 写入失败:', err)
      return null
    }
  })

  ipcMain.handle('export:save-text', async (event, payload: { defaultName: string; content: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const result = await dialog.showSaveDialog(win, {
      title: '导出文件',
      defaultPath: payload.defaultName || '导出.txt',
      filters: [
        { name: '文本文件', extensions: ['txt', 'md', 'csv', 'json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePath) return null
    try {
      await fs.writeFile(result.filePath, payload.content, 'utf-8')
      return result.filePath
    } catch (err) {
      console.error('[export:save-text] 写入失败:', err)
      return null
    }
  })
  // 写作自动保存：静默写入 userData/writing-drafts/<标题>.md（不弹对话框）
  ipcMain.handle('writing:save-draft', async (_e, payload: { title: string; content: string }) => {
    try {
      const draftDir = join(app.getPath('userData'), 'writing-drafts')
      await fs.mkdir(draftDir, { recursive: true })
      const safe = (payload.title || '未命名写作').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
      const filePath = join(draftDir, `${safe || '写作'}.md`)
      await fs.writeFile(filePath, payload.content, 'utf-8')
      // 自动保存每 30s 一次，快照节流到 5 分钟一个点，避免历史被刷屏
      await createSnapshot('draft', safe || '写作', payload.content, {
        reason: 'auto',
        minIntervalMs: 300_000
      }).catch(() => undefined)
      return filePath
    } catch {
      return null
    }
  })
  ipcMain.handle('data:backup', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    return backupData(win)
  })

  ipcMain.handle('open:external', (_e, url: string) => {
    if (typeof url === 'string' && /^(https?|file):\/\//i.test(url)) {
      return shell.openExternal(url).then(
        () => true,
        () => false
      )
    }
    return false
  })

  ipcMain.handle('command:run', (_e, command: string) => {
    if (typeof command !== 'string' || command.trim().length === 0) return null
    try {
      const child = spawn(command, { shell: true, detached: true, stdio: 'ignore' })
      child.unref()
      return child.pid ?? null
    } catch {
      return null
    }
  })
}

app.whenReady().then(async () => {
  await applyCustomDataDir()
  await migrateLegacyData()
  await initWindowManager()
  registerWindowIpc()
  registerIpc()
  registerToolsIpc()
  registerPublishIpc()
  registerOrganizeIpc()
  registerConvertIpc()
  // 启动时自动清理过期的转换临时目录（此前仅手动 IPC 可触发，长期会泄漏磁盘）。
  // 异步触发不阻塞启动；失败记日志，不静默吞。
  void Promise.resolve()
    .then(() => getTempCleaner().cleanupExpired())
    .catch((err) =>
      getLogger('convert').warning(`启动临时目录清理失败: ${err instanceof Error ? err.message : String(err)}`)
    )
  registerMediaIpc()
  registerHardwareIpc()
  registerPdfIpc()
  registerSearchIndexIpc()
  registerFeedIpc()
  getFeedService().start()
  registerKnowledgeBaseIpc()
  registerKbDataIpc()
  registerMcpIpc()
  registerNotesFeatureIpc()
  registerSillyTavernIpc()
  registerNovelIpc()
  registerDocsIpc()
  registerSurgicalIpc()
  registerPptIpc()
  registerAgentsHubIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  closeAllStickyWindows()
  closeStickyPanel()
  closeAllPageWindows()
})


