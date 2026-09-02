/* 多平台发布 · 装配：注册适配器 + 初始化队列（userData 持久化） */
import { app } from 'electron'
import { join } from 'node:path'
import { registerAdapter } from './adapter.ts'
import { PublishQueue } from './queue.ts'
import { weiboAdapter } from './adapters/weibo.ts'
import { zhihuAdapter } from './adapters/zhihu.ts'
import { juejinAdapter } from './adapters/juejin.ts'
import { bilibiliAdapter } from './adapters/bilibili.ts'
import { gongzhonghaoAdapter } from './adapters/gongzhonghao.ts'
import { csdnAdapter } from './adapters/csdn.ts'

let queue: PublishQueue | null = null

export function registerAdapters(): void {
  registerAdapter(weiboAdapter)
  registerAdapter(zhihuAdapter)
  registerAdapter(juejinAdapter)
  registerAdapter(bilibiliAdapter)
  registerAdapter(gongzhonghaoAdapter)
  registerAdapter(csdnAdapter)
}

export async function initPublish(): Promise<PublishQueue> {
  if (!queue) {
    registerAdapters()
    const file = join(app.getPath('userData'), 'publish-queue.json')
    queue = new PublishQueue({ filePath: file })
    await queue.load()
  }
  return queue
}
