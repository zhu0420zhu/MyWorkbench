/* CSDN 适配器（骨架）：登录探测尽力实现，发布待适配（blog-console-api 含 x-ca 签名） */
import type { PlatformAdapter, PublishContext, PublishResult } from '../adapter.ts'
import { sessionFetch } from './fetch.ts'

export const csdnAdapter: PlatformAdapter = {
  id: 'csdn',
  name: 'CSDN',
  loginUrl: 'https://passport.csdn.net/login',
  status: 'skeleton',
  modeLabel: '待适配（CSDN 发布接口含签名校验）',

  async checkLogin(ctx) {
    try {
      // 登录态探测：创作中心接口返回未登录则跳登录
      const res = await sessionFetch(ctx, 'https://blog-console-api.csdn.net/v1/editor/getArticle?id=0')
      const json = (await res.json()) as { code?: number; msg?: string }
      return json?.code === 200
    } catch {
      return false
    }
  },

  async publish(_input, _ctx): Promise<PublishResult> {
    return { ok: false, platformId: 'csdn', error: 'CSDN 适配器开发中（x-ca 签名）' }
  }
}
