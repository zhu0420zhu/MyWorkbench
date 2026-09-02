/* ============================================
 * 热点聚合模块（P0 重构）
 * 数据源：dailyhot-api（MIT）
 * 由于 dailyhot-api 的 registry.js 在运行时用 fs.readdirSync 扫描 routes/ 目录，
 * 打包进 asar 后该目录不存在，导致所有平台 404。因此这里直接用 Hono 起本地服务，
 * 并将需要的路由文件做静态 import，由 electron-vite 一并打进主进程 bundle。
 * ============================================ */

import { net } from 'electron'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { dedupeAndRank, normalizeTitle, type HotEvent, type HotSourceItem } from './hotDedup.ts'
import { getLogger } from './tools/logger.ts'

// 静态导入 dailyhot-api 路由（必须静态才能被 electron-vite 打包进主进程）
import * as routeWeibo from 'dailyhot-api/dist/routes/weibo.js'
import * as routeZhihu from 'dailyhot-api/dist/routes/zhihu.js'
import * as routeBilibili from 'dailyhot-api/dist/routes/bilibili.js'
import * as routeDouyin from 'dailyhot-api/dist/routes/douyin.js'
import * as routeToutiao from 'dailyhot-api/dist/routes/toutiao.js'
import * as routeBaidu from 'dailyhot-api/dist/routes/baidu.js'
import * as routeTieba from 'dailyhot-api/dist/routes/tieba.js'
import * as routeDouban from 'dailyhot-api/dist/routes/douban-group.js'
import * as routeIthome from 'dailyhot-api/dist/routes/ithome.js'
import * as routeSspai from 'dailyhot-api/dist/routes/sspai.js'
import * as route36kr from 'dailyhot-api/dist/routes/36kr.js'
import * as routeHuxiu from 'dailyhot-api/dist/routes/huxiu.js'
import * as routeIfanr from 'dailyhot-api/dist/routes/ifanr.js'
import * as routeGeekpark from 'dailyhot-api/dist/routes/geekpark.js'
import * as routeJuejin from 'dailyhot-api/dist/routes/juejin.js'
import * as routeGithub from 'dailyhot-api/dist/routes/github.js'

const logger = getLogger('hot')

/* ---------- 平台配置 ---------- */
export interface PlatformConfig {
  id: string
  name: string
  route: string
  weight: number
}

export const PLATFORMS: PlatformConfig[] = [
  { id: 'weibo', name: '微博', route: 'weibo', weight: 1.0 },
  { id: 'zhihu', name: '知乎', route: 'zhihu', weight: 0.95 },
  { id: 'bilibili', name: 'B站', route: 'bilibili', weight: 0.9 },
  { id: 'douyin', name: '抖音', route: 'douyin', weight: 0.85 },
  { id: 'toutiao', name: '头条', route: 'toutiao', weight: 0.85 },
  { id: 'baidu', name: '百度', route: 'baidu', weight: 0.8 },
  { id: 'tieba', name: '贴吧', route: 'tieba', weight: 0.7 },
  { id: 'douban', name: '豆瓣', route: 'douban-group', weight: 0.6 },
  // 科技 / AI 行业
  { id: 'ithome', name: 'IT之家', route: 'ithome', weight: 0.8 },
  { id: 'sspai', name: '少数派', route: 'sspai', weight: 0.7 },
  { id: '36kr', name: '36氪', route: '36kr', weight: 0.7 },
  { id: 'huxiu', name: '虎嗅', route: 'huxiu', weight: 0.65 },
  { id: 'ifanr', name: '爱范儿', route: 'ifanr', weight: 0.6 },
  { id: 'geekpark', name: '极客公园', route: 'geekpark', weight: 0.6 },
  { id: 'juejin', name: '掘金', route: 'juejin', weight: 0.6 },
  { id: 'github', name: 'GitHub', route: 'github', weight: 0.55 }
]

type RouteModule = { handleRoute: (c: unknown, noCache: boolean) => Promise<Record<string, unknown>> }

const ROUTES: Record<string, RouteModule> = {
  weibo: routeWeibo as unknown as RouteModule,
  zhihu: routeZhihu as unknown as RouteModule,
  bilibili: routeBilibili as unknown as RouteModule,
  douyin: routeDouyin as unknown as RouteModule,
  toutiao: routeToutiao as unknown as RouteModule,
  baidu: routeBaidu as unknown as RouteModule,
  tieba: routeTieba as unknown as RouteModule,
  'douban-group': routeDouban as unknown as RouteModule,
  ithome: routeIthome as unknown as RouteModule,
  sspai: routeSspai as unknown as RouteModule,
  '36kr': route36kr as unknown as RouteModule,
  huxiu: routeHuxiu as unknown as RouteModule,
  ifanr: routeIfanr as unknown as RouteModule,
  geekpark: routeGeekpark as unknown as RouteModule,
  juejin: routeJuejin as unknown as RouteModule,
  github: routeGithub as unknown as RouteModule
}

const LOCAL_PORT = 3001
const SERVER_TIMEOUT_MS = 15000

/* ---------- DailyHotApi 本地服务管理（懒启动，失败降级） ---------- */
let serverReady: Promise<number | null> | null = null

function buildApp(): Hono {
  const app = new Hono()

  // 健康检查：列出可用路由
  app.get('/all', (c) =>
    c.json({
      code: 200,
      count: Object.keys(ROUTES).length,
      routes: Object.keys(ROUTES).map((r) => ({ name: r, path: `/${r}` }))
    })
  )

  // 注册各平台路由（行为与 dailyhot-api 保持一致：返回 { code: 200, ...listData }）
  for (const [id, route] of Object.entries(ROUTES)) {
    app.get(`/${id}`, async (c) => {
      try {
        const noCache = c.req.query('cache') === 'false'
        const data = await route.handleRoute(c, noCache)
        return c.json({ code: 200, ...data })
      } catch (err) {
        logger.warning(`本地热榜路由 /${id} 处理失败: ${(err as Error).message}`)
        return c.json({ code: 500, message: (err as Error).message }, 500)
      }
    })
  }

  return app
}

async function startLocalServer(): Promise<number | null> {
  try {
    const app = buildApp()

    // 端口探测：3001 起，被占用则 +1
    let port = LOCAL_PORT
    let server: ReturnType<typeof serve> | undefined
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        server = serve({ fetch: app.fetch, port })
        break
      } catch {
        port++
      }
    }
    if (!server) throw new Error('本地热榜服务启动失败')

    // 健康检查
    const deadline = Date.now() + SERVER_TIMEOUT_MS
    while (Date.now() < deadline) {
      try {
        const res = await net.fetch(`http://127.0.0.1:${port}/all`)
        if (res.ok) {
          logger.info(`DailyHot API 已就绪: http://127.0.0.1:${port}`)
          return port
        }
      } catch {
        /* 服务尚未就绪，重试 */
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    logger.warning('DailyHot API 健康检查超时')
    return port
  } catch (err) {
    logger.error(`本地热榜服务启动失败: ${(err as Error).message}`)
    return null
  }
}

function getServerPort(): Promise<number | null> {
  if (!serverReady) serverReady = startLocalServer()
  return serverReady
}

/* ---------- 条目规范化 ---------- */
function normalizeItem(raw: unknown, platform: string): HotSourceItem | null {
  const r = raw as Record<string, unknown> | null
  if (!r) return null
  const title = String(r.title ?? r.word ?? r.name ?? r.item_title ?? '').trim()
  if (!title) return null
  const url = String(r.url ?? r.mobileUrl ?? r.link ?? r.item_url ?? '')
  const hot = Number(r.hot ?? r.hotValue ?? r.heat ?? r.score ?? r.num ?? r.hot_score ?? 0) || 0
  return { platform, title, url, hot }
}

function extractList(json: unknown): unknown[] {
  if (Array.isArray(json)) return json
  const obj = json as Record<string, unknown> | null
  if (!obj) return []
  if (Array.isArray(obj.data)) return obj.data as unknown[]
  if (Array.isArray(obj.list)) return obj.list as unknown[]
  if (Array.isArray(obj.result)) return obj.result as unknown[]
  // 部分平台返回 { data: { list: [...] } }
  const data = obj.data as Record<string, unknown> | null
  if (data && Array.isArray(data.list)) return data.list as unknown[]
  return []
}

/* ---------- 单平台抓取 ---------- */
async function fetchPlatform(cfg: PlatformConfig): Promise<HotSourceItem[]> {
  const port = await getServerPort()
  if (!port) return []
  const res = await net.fetch(`http://127.0.0.1:${port}/${cfg.route}`, {
    headers: { Accept: 'application/json' }
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as unknown
  const rawList = extractList(json)
  const items: HotSourceItem[] = []
  for (const raw of rawList) {
    const item = normalizeItem(raw, cfg.id)
    if (item) items.push(item)
  }
  return items
}

/* ---------- 聚合抓取 ---------- */
export interface HotPlatformStatus {
  id: string
  name: string
  status: 'ok' | 'error'
  count: number
  error?: string
}

export interface HotFetchResult {
  events: HotEvent[]
  platforms: HotPlatformStatus[]
  updatedAt: number
}

export async function fetchAllHot(): Promise<HotFetchResult> {
  const results = await Promise.all(
    PLATFORMS.map(async (cfg) => {
      try {
        const items = await fetchPlatform(cfg)
        return { cfg, items, error: null as string | null }
      } catch (err) {
        logger.warning(`平台 ${cfg.name} 抓取失败: ${(err as Error).message}`)
        return { cfg, items: [] as HotSourceItem[], error: (err as Error).message }
      }
    })
  )

  const allItems = results.flatMap((r) => r.items)
  const platformWeights: Record<string, number> = {}
  for (const cfg of PLATFORMS) platformWeights[cfg.id] = cfg.weight

  const events = dedupeAndRank(allItems, { platformWeights })
  const platforms: HotPlatformStatus[] = results.map((r) => ({
    id: r.cfg.id,
    name: r.cfg.name,
    status: r.error ? 'error' : 'ok',
    count: r.items.length,
    error: r.error ?? undefined
  }))

  logger.info(`热点聚合完成: ${events.length} 个事件 / ${allItems.length} 条原始`)
  return { events, platforms, updatedAt: Date.now() }
}

/** 单平台原始榜单（UI 排查用） */
export async function fetchPlatformRaw(platformId: string, limit = 30): Promise<HotSourceItem[]> {
  const cfg = PLATFORMS.find((p) => p.id === platformId)
  if (!cfg) return []
  try {
    const items = await fetchPlatform(cfg)
    return items.slice(0, limit)
  } catch {
    return []
  }
}

export { normalizeTitle }
