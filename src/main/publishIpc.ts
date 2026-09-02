/* 多平台发布 · IPC 桥接（P1 框架 + P2 排程/AI/统计） */
import { ipcMain } from 'electron'
import {
  initPublish,
  listAdapters,
  getAdapter,
  openLoginWindow,
  closeLoginWindow,
  checkLogin,
  checkAllLogin,
  makePublishContext,
  summarizeContent,
  rewriteForPlatform,
  getGzhCredential,
  saveGzhCredential,
  clearGzhCredential
} from './publish/index.ts'

let schedulerStarted = false

/** 排程定时器：每分钟执行到期任务（应用生命周期内常驻） */
function startScheduler(): void {
  if (schedulerStarted) return
  schedulerStarted = true
  setInterval(() => {
    void (async () => {
      try {
        const queue = await initPublish()
        await queue.runPending(makePublishContext())
      } catch {
        /* 忽略调度异常 */
      }
    })()
  }, 60_000)
}

export function registerPublishIpc(): void {
  startScheduler()

  ipcMain.handle('publish:list-platforms', () =>
    listAdapters().map((a) => ({ id: a.id, name: a.name, status: a.status, modeLabel: a.modeLabel }))
  )

  ipcMain.handle('publish:login', (_e, platformId: string) => {
    openLoginWindow(platformId)
    return true
  })
  ipcMain.handle('publish:close-login', () => {
    closeLoginWindow()
    return true
  })
  ipcMain.handle('publish:check-login', (_e, platformId: string) => checkLogin(platformId))
  ipcMain.handle('publish:check-all-login', () => checkAllLogin())

  ipcMain.handle(
    'publish:create',
    async (_e, input: { title: string; content: string; targets: string[]; contentId?: string; scheduledAt?: number }) => {
      const queue = await initPublish()
      const ctx = makePublishContext()
      for (const platformId of input.targets) {
        await queue.add({ title: input.title, content: input.content }, platformId, input.contentId ?? '', input.scheduledAt)
      }
      // 仅执行到期任务（排程任务未到时间不执行）
      await queue.runPending(ctx)
      return queue.list().slice(0, 50)
    }
  )

  ipcMain.handle('publish:list-jobs', async () => (await initPublish()).list().slice(0, 50))

  ipcMain.handle('publish:retry', async (_e, id: string) => {
    const queue = await initPublish()
    await queue.retry(id, true)
    await queue.runJob(id, makePublishContext())
    return queue.list().slice(0, 50)
  })

  /* ---- P2 ---- */
  ipcMain.handle('publish:stats', async () => {
    const jobs = (await initPublish()).list()
    const byPlatform: Record<string, { total: number; success: number; failed: number; pending: number }> = {}
    for (const j of jobs) {
      const s = byPlatform[j.platformId] ?? { total: 0, success: 0, failed: 0, pending: 0 }
      s.total++
      if (j.status === 'success') s.success++
      else if (j.status === 'failed') s.failed++
      else s.pending++
      byPlatform[j.platformId] = s
    }
    const now = Date.now()
    return {
      total: jobs.length,
      success: jobs.filter((j) => j.status === 'success').length,
      failed: jobs.filter((j) => j.status === 'failed').length,
      pending: jobs.filter((j) => j.status === 'pending' || j.status === 'running').length,
      scheduled: jobs.filter((j) => j.scheduledAt !== undefined && j.scheduledAt > now).length,
      byPlatform
    }
  })

  ipcMain.handle('publish:ai-summarize', (_e, input: { title: string; content: string }) =>
    summarizeContent(input.title, input.content)
  )

  ipcMain.handle('publish:ai-rewrite', (_e, input: { title: string; content: string; platformId: string }) => {
    const adapter = getAdapter(input.platformId)
    return rewriteForPlatform(input.title, input.content, adapter?.name ?? input.platformId)
  })

  /* ---- 公众号凭证 ---- */
  ipcMain.handle('publish:gzh-config', async () => {
    const cred = await getGzhCredential()
    return cred ? { appId: cred.appId, hasSecret: true } : { appId: '', hasSecret: false }
  })
  ipcMain.handle('publish:gzh-save', async (_e, input: { appId: string; secret: string }) => {
    await saveGzhCredential(input.appId, input.secret)
    return true
  })
  ipcMain.handle('publish:gzh-clear', async () => {
    await clearGzhCredential()
    return true
  })
}