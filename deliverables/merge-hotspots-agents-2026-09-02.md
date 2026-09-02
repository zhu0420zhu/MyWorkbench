# 全网热点 × 智能体 合并实现方案（v1.0）

> 目标：将「全网热点」与「智能体」两个功能合并为同一个模块 / 入口，**统一数据来源与交互逻辑**，同时**完整保留两者原有的核心能力**，并输出合并后的实现方案与代码结构。
>
> 日期：2026-09-02 ｜ 范围：主进程 `src/main/*` + 渲染层 `src/renderer/*` + 契约 `src/shared/types.ts` + preload 双写
> 调研依据：`src/main/hot.ts` / `hotDedup.ts` / `hotNotifier.ts` / `src/main/agents/*` / `src/renderer/src/pages/Hotspots.tsx` / `src/renderer/src/components/AgentsPanel.tsx`（均已逐行确认）

---

## 0. TL;DR（给决策者的结论）

- **UI 已经合并了 80%**：当前「多媒体」页（`Hotspots.tsx`）就是用 `Segmented` 在 `全网热点` / `智能体` 两个 tab 间切换，且两者都挂在同一个 `hotspots` 路由下（`PageView.tsx:54`）。所以「合并成同一个入口」这件事基本已经做完了。
- **真正的缺口只有两块**，也是本方案的重点：
  1. **数据源不统一**：全网热点走 `fetchAllHot()`（16 个中文平台 / dailyhot-api / 本地 Hono 服务），智能体走 `fetchHnBriefing()`（Hacker News Algolia）+ `fetchReleaseRadar()`（GitHub）—— 两套完全独立的抓取与结构。
  2. **交互逻辑不统一**：全网热点 tab = 聚合列表 + 内置浏览器 + 多平台发布 + 推送通知；智能体 tab = 任务表格 + 立即运行 + 历史记录。两者 UI 形态割裂。
- **方案核心**：引入一层 **`feed`（信息流）抽象**，把「16 个热点平台」和「HN / GitHub 两个智能体任务」都包装成同一种 `FeedSource`；由统一的 `FeedAggregator` 做合并去重排序，由统一的 `FeedNotifier` 做推送。渲染层收敛为 **一个「情报流」页 + 一个「数据源管理」面板**，把两个 tab 的不同交互沉淀为**同一 feed 上的不同能力标签**，而非两个割裂页面。
- **不重写现有引擎**：`hot.ts` / `hotDedup.ts` / `hotNotifier.ts` / `agents/*` 全部保留并复用，只在其上做**薄封装层** `src/main/feed/`，风险最小、行为可追溯。

---

## 1. 现状盘点（已合并 / 未合并）

| 维度 | 现状 | 是否合并 |
|------|------|----------|
| 入口页 | `Hotspots.tsx` 单一页，标题「多媒体·全网热点 / 多媒体·智能体」 | ✅ 已合并（Segmented 切换） |
| 路由 | `hotspots` 一个 key，`agents` 仅作为 `initialTab` 参数（`PageView.tsx:54`） | ✅ 已合并 |
| 数据源 | 热点 = dailyhot-api（16 平台）；智能体 = HN + GitHub | ❌ 完全独立 |
| 聚合/去重 | 热点走 `dedupeAndRank`；智能体结果**未参与去重** | ❌ 不统一 |
| 通知 | 热点走 `hotNotifier`（周期 topN 推送）；智能体走 `AgentScheduler.notify`（每次运行弹通知） | ❌ 两条通知链路 |
| 列表交互 | 热点：可点开内置浏览器 / 编辑发布；智能体：可启用 / 立即运行 / 看历史 | ❌ 形态割裂 |
| IPC 契约 | `hot:*` + `agents:*` 两套独立 domain | ❌ 不统一 |
| preload | `index.ts:624-629`（`hot`）+ `index.ts:780-786`（`agents`） | ❌ 两套 |

**结论**：入口已合，内核未合。本方案聚焦内核（数据源 + 交互）的统一，入口层只做微调（把两个 tab 收敛为一个 feed + 一个管理抽屉）。

---

## 2. 统一领域模型（`src/shared/types.ts` 新增）

两者最终都产出「可点击的条目（标题 / 链接 / 备注 / 来源）」。先归一化为统一 `FeedItem`，再让两个旧结构都向它映射。

```ts
/* ============================================================
 * 信息流（feed）—— 全网热点 × 智能体 统一抽象
 * 同时被主进程（src/main/feed）、preload 双写、渲染层引用，故置于 shared。
 * ============================================================ */

/** 统一条目：全网热点事件 与 智能体结果 都映射到此结构 */
export interface FeedItem {
  /** 稳定 id（热点走 simhash hex；智能体走 title hash） */
  id: string
  title: string
  url?: string
  /** 展示热度 / 权重（热点=热度值；智能体=点数/权重，可为 0） */
  hot: number
  /** 条目级来源：可能是多平台共识（热点）或单来源（智能体） */
  sources: FeedItemSource[]
  /** 来源类别：'hot' = 热点平台；'agent' = 智能体任务 */
  sourceKind: 'hot' | 'agent'
  /** 数据归属的 FeedSource id（如 weibo / hn-briefing） */
  sourceId: string
  /** 分类（复用 categorize，智能体条目默认 '科技'） */
  category: string
  /** 额外元信息（如 HN 的「120 分 · torvalds」） */
  meta?: string
  firstSeen: number
}

export interface FeedItemSource {
  platform: string      // 平台/任务 id（weibo / hn-briefing / release-radar）
  name: string          // 展示名（微博 / Hacker News 简报 / Release Radar）
  title: string
  url: string
  hot: number
}

/** 数据源元信息（管理面板用） */
export interface FeedSourceMeta {
  id: string
  name: string
  kind: 'hot' | 'agent'
  description?: string
  /** 该源产出的条目分类倾向（用于默认归类） */
  defaultCategory?: string
  /** 是否已启用（参与合并 feed / 通知） */
  enabled: boolean
  /** 周期毫秒（智能体任务用；热点平台为 0=实时聚合） */
  intervalMs: number
  lastRunAt: number | null
  lastStatus: 'idle' | 'ok' | 'error'
  lastSummary?: string
  /** 单源最近一次产出的条目数 */
  lastItemCount: number
}

export interface FeedSourceStatus {
  id: string
  status: 'ok' | 'error'
  count: number
  error?: string
}

/** 合并后的信息流结果（替代 HotFetchResult 给渲染层用） */
export interface FeedResult {
  items: FeedItem[]
  sources: FeedSourceStatus[]
  updatedAt: number
}

/** 数据源配置（启用 / 周期） */
export interface FeedSourceConfig {
  enabled: boolean
  intervalMs: number
}

/** 统一通知设置（合并 hotNotifier + 智能体通知） */
export interface FeedNotifySettings {
  enabled: boolean
  intervalMinutes: number
  topCount: number
  /** 是否对智能体运行结果也弹通知（默认 true） */
  notifyAgents: boolean
}
```

> **映射规则**
> - `HotEvent`（`hotDedup.ts:22`）→ `FeedItem`：`sourceKind:'hot'`，`sources` = 原 `sources` 改名后的 `FeedItemSource[]`，`hot` = `event.hot`，`category` = `categorize(title)`。
> - `AgentResultItem`（`types.ts:727`）→ `FeedItem`：`sourceKind:'agent'`，`sourceId` = jobId（hn-briefing / release-radar），`hot` = 0（或解析 meta 里的点数），`meta` = 原 `meta`，`url` = 原 `url`。

---

## 3. 主进程结构：新增 `src/main/feed/`（薄封装层）

保留 `hot.ts` / `hotDedup.ts` / `hotNotifier.ts` / `agents/*` **不动**，只在上面加一层。

```
src/main/feed/
├── feedTypes.ts        # 仅本地类型辅助（若需要；主契约仍走 shared/types.ts）
├── source.ts           # interface FeedSource { collect(); getMeta(); runNow(); setConfig() }
├── sources/
│   ├── hotSource.ts     # 包装 fetchAllHot() → 16 个 FeedSource(kind:'hot')
│   └── agentSource.ts   # 包装每个 AgentJob → FeedSource(kind:'agent')
├── aggregator.ts       # 合并所有 source.collect() → dedupeAndRank → FeedResult
├── feedService.ts      # 注册表 + 启用/周期/立即运行/历史（复用 ConfigStore）
└── feedIpc.ts          # registerFeedIpc()
```

### 3.1 `source.ts` —— 统一数据源接口

```ts
export interface FeedSource {
  id: string
  kind: 'hot' | 'agent'
  /** 拉取本源条目（合并进统一 feed 用） */
  collect(): Promise<FeedItem[]>
  /** 管理面板元信息 */
  getMeta(): FeedSourceMeta
  /** 立即运行一次（智能体任务 / 热点也可手动刷新单源） */
  runNow(): Promise<FeedItem[]>
  /** 设置启用 / 周期 */
  setConfig(c: FeedSourceConfig): void
}
```

### 3.2 `sources/hotSource.ts` —— 复用 `fetchAllHot`

```ts
import { fetchAllHot, PLATFORMS } from '../hot.ts'
import { categorize } from '../../renderer/...' // 注意：categorize 在渲染层，主进程需抽一份纯函数（见 §3.6）
// 把 16 个 PlatformConfig 各包装为一个 FeedSource：
export function createHotSources(): FeedSource[] {
  return PLATFORMS.map((cfg) => ({
    id: cfg.id,
    kind: 'hot',
    async collect() {
      const r = await fetchAllHot()           // 仍走本地 Hono 服务 + 去重
      // 过滤出本平台贡献的 source，映射为 FeedItem
      return r.events
        .filter((e) => e.sources.some((s) => s.platform === cfg.id))
        .map((e) => toFeedItem(e, cfg.id))
    },
    getMeta() { /* 读 hotNotifier 状态 + PLATFORMS 权重 */ },
    async runNow() { return this.collect() },
    setConfig() { /* 热点平台目前全量参与，enabled 可留作未来开关 */ }
  }))
}
```

> **优化点**：`fetchAllHot()` 一次返回全量，16 个 source 各自 `collect()` 会重复调用 16 次。实现时让 `aggregator.ts` 只调用**一次** `fetchAllHot()`，再按平台分发到各 `FeedSource` 的「已缓存结果」，而不是每个 source 各自拉取。接口上保留 `collect()` 语义，内部用缓存。

### 3.3 `sources/agentSource.ts` —— 复用 `AgentScheduler` 的 job

```ts
import { getAgentScheduler } from '../agents/index.ts'
import { fetchHnBriefing } from '../agents/jobs/hn.ts'
import { fetchReleaseRadar } from '../agents/jobs/releaseRadar.ts'

// 把每个 AgentJob 包成 FeedSource(kind:'agent')
export function createAgentSources(): FeedSource[] {
  const sched = getAgentScheduler()
  return [...sched.jobs.values()].map((job) => ({
    id: job.id,                       // hn-briefing / release-radar
    kind: 'agent',
    async collect() {
      const res = job.id === 'release-radar'
        ? await fetchReleaseRadar((await sched.getConfig()).releaseRepos)
        : await fetchHnBriefing()
      return res.items.map((it) => toFeedItemFromAgent(job.id, res, it))
    },
    getMeta() { /* 复用 scheduler.list() 的 AgentJobInfo */ },
    async runNow() { return (await sched.runNow(job.id)).items.map(...) },
    setConfig(c) { void sched.setJobConfig(job.id, c) }
  }))
}
```

### 3.4 `aggregator.ts` —— 统一合并 + 去重 + 排序

```ts
import { dedupeAndRank, type HotSourceItem } from '../hotDedup.ts'

export async function aggregateFeed(sources: FeedSource[]): Promise<FeedResult> {
  const enabled = sources.filter((s) => s.getMeta().enabled)
  // 一次拉全量（热点走 fetchAllHot；智能体各自 run）
  const perSource = await Promise.all(enabled.map(async (s) => ({
    id: s.id, items: await s.collect(), error: null as string | null
  })))
  const all: FeedItem[] = perSource.flatMap((p) => p.items)
  // 统一去重：把所有 FeedItem 规整成 HotSourceItem[] 喂给既有 dedupeAndRank
  const norm: HotSourceItem[] = all.map((i) => ({
    platform: i.sourceId, title: i.title, url: i.url ?? '', hot: i.hot
  }))
  const platformWeights = Object.fromEntries(enabled.map((s) => [s.id, 1]))
  const ranked = dedupeAndRank(norm, { platformWeights })
  // 把去重后的 HotEvent 再映射回 FeedItem（保留 sourceKind / agent meta）
  const items = ranked.map((e) => toFeedItem(e))
  const sourcesStatus = perSource.map((p) => ({
    id: p.id, status: p.error ? 'error' : 'ok', count: p.items.length, error: p.error ?? undefined
  }))
  return { items, sources: sourcesStatus, updatedAt: Date.now() }
}
```

> **关键收益**：HN 与 GitHub 的结果现在**会进入同一套去重排序链路**，跨源共识（如某 HN 话题恰好也被微博讨论）会被合并，这是两个功能各自为政时做不到的。

### 3.5 `feedService.ts` —— 注册表 + 周期 + 历史 + 通知

- 持有 `Map<string, FeedSource>` 合并 hot+agent 两套源。
- 复用 `ConfigStore<{ sources: Record<string, FeedSourceConfig> }>`（对齐现有 `AgentsConfig` 风格）。
- 周期检查：复用 `isJobDue`（已有 `agents/due.ts`）扫描各 source 的 `intervalMs`，到点则 `runNow()` 并写入历史 `ConfigStore<{ records: FeedRunRecord[] }>`。
- 通知：新建 `FeedNotifier`，**合并** `hotNotifier`（周期 topN 推送）与 `AgentScheduler.notify`（运行结果弹窗）两条链路为一条：
  - `notifyAgents=true` 时，智能体运行成功也弹系统通知；
  - 周期到点对合并 feed 取 topN 推送。
- 启动：在 `app.whenReady()` 里紧邻 `registerHotIpc` / `registerAgentsIpc` 之后调用 `registerFeedIpc()`；周期由 `feedService.start()` 接管（原 `hotNotifier.startHotNotifier()` 与 `AgentScheduler.start()` 可保留或收敛到此处，见 §6 风险）。

### 3.6 主进程需要一份纯函数 `categorize`

`src/renderer/src/utils/category.ts` 的 `categorize` 现在只在渲染层。主进程映射 `FeedItem.category` 时需要它。按项目约定（纯逻辑下沉 `*Core.ts`），把分类规则抽到 `src/main/feed/categorizeCore.ts`（无 electron 依赖），渲染层 `category.ts` 改为 re-export，避免重复实现。

---

## 4. IPC 契约（`feed:*` 统一 domain）

`src/main/feed/feedIpc.ts` 注册以下 handle；preload `index.ts` + `index.d.ts` **双写** `feed` 对象。

| handle | 作用 | 替代的旧 IPC |
|--------|------|--------------|
| `feed:result` | 拉取合并后的 `FeedResult` | `hot:fetch` |
| `feed:list-sources` | 列出全部 `FeedSourceMeta`（16 热点 + 2 智能体） | `agents:list` + 热点 platforms |
| `feed:run-source` | 立即运行某 source，返回新 `FeedItem[]` | `agents:run-now` |
| `feed:set-source-config` | 启用/禁用 + 周期 | `agents:job-config` |
| `feed:history` | 某 source 的运行历史 `FeedRunRecord[]` | `agents:history` |
| `feed:notify-get` / `feed:notify-set` / `feed:notify-check` / `feed:notify-status` | 统一通知设置/检查 | `hot:notifier-*` |

> **迁移策略**：旧 `hot:*` / `agents:*` handle **不立即删除**——先实现 `feed:*` 并迁移两个渲染消费者，确认 `grep` 零引用后再删旧 handle 与 preload 旧字段（见 §7 验证清单）。这样中途可回滚。

---

## 5. 渲染层结构（收敛为「情报流」单页）

### 5.1 入口不变，内容重构

- 路由 key 保持 `hotspots`（navItems.tsx:42），标签可保留「多媒体」或升级为「情报中心」。
- `Hotspots.tsx` 重构为 **`FeedCenter.tsx`**（或就地重命名），删除 `Segmented(hotspots|agents)` 双 tab，改为：
  - **主区 = 统一信息流列表**（`FeedList`），所有 source 的条目混排，每条带 `sourceKind` 徽标（🔥热点 / 🤖智能体）+ 平台 Tag + 分类 Tag。
  - **右侧/顶部筛选** = `Segmented`（全部分类，复用 `HOT_CATEGORIES`）+ `Segmented`（按 sourceKind：`全部 / 热点 / 智能体`）+ 数据源状态条。
  - **「数据源」抽屉/面板**（`SourceManager`）= 把原热点 `platforms` 标签 + 原 `AgentsPanel` 任务表 **合并为一个列表**：每行 = 一个 `FeedSourceMeta`，含 启用 Switch / 周期输入 / 立即运行 / 上次状态 / 历史入口。

### 5.2 共享组件（沉淀两个 tab 的交互）

```
src/renderer/src/components/feed/
├── FeedList.tsx         # 统一列表（复用 Hotspots 现有 List 渲染 + 分类/热度/平台 Tag）
├── FeedItemCard.tsx     # 单条：标题/热度/来源徽标/分类/「打开浏览器」「编辑发布」
├── SourceBrowser.tsx    # 复用 Hotspots 内置 webview 浏览器（抽成独立组件）
├── SourceManager.tsx    # 数据源管理（合并原 AgentsPanel + 热点 platforms 状态条）
└── PublishDrawer.tsx    # 复用 Hotspots 的「编辑发布」Modal（多平台分发 + AI 摘要/改写）
```

### 5.3 能力保留（关键：两个功能的原有核心能力一个不丢）

| 原「全网热点」能力 | 合并后落点 |
|-------------------|-----------|
| 16 平台聚合热点列表 | `FeedList` 中 `sourceKind==='hot'` 的条目（默认视图） |
| 内置浏览器阅读 | `SourceBrowser`（点条目打开，保留前进/后退/刷新/外部打开） |
| 多平台一键发布（公众号等） | `PublishDrawer`（点条目「编辑发布」） |
| AI 摘要 / 按平台改写 | `PublishDrawer` 内 `aiSummarize` / `aiRewrite`（逻辑原样迁移） |
| 周期推送 topN 通知 | `FeedNotifier`（统一通知，`notifyAgents=false` 时只推热点） |
| 平台状态可视化 | `SourceManager` 里 `FeedSourceMeta.lastStatus` |

| 原「智能体」能力 | 合并后落点 |
|------------------|-----------|
| HN 首页简报（定时） | `FeedSource(kind:'agent', id:'hn-briefing')` → 进入统一 feed |
| GitHub Release Radar（定时） | `FeedSource(kind:'agent', id:'release-radar')` → 进入统一 feed |
| 启用 / 禁用 / 改周期 | `SourceManager` 的 Switch + 周期输入（调 `feed:set-source-config`） |
| 立即运行 | `SourceManager` 每行「立即运行」按钮（调 `feed:run-source`） |
| 运行历史 | `SourceManager` 每行展开「历史」（调 `feed:history`） |
| 运行成功弹系统通知 | `FeedNotifier`（统一通知，`notifyAgents=true` 时生效） |

> 用户视角：以前要在两个 tab 间切；合并后，HN/GitHub 的条目**直接出现在同一个信息流里**，想单独管理（改周期、看历史）点开「数据源」抽屉即可。

---

## 6. 命名澄清与风险

1. **「智能体」≠ LLM 对话机器人**：本项目里 `agents/*` 是「常驻定时任务」（HN 简报 / Release Radar），与聊天 AI 无关。合并方案保留其「定时 + 历史 + 通知」语义，不引入 LLM 调用。
2. **`agents/jobs/hn.ts` 命名误导**：它抓的是 Hacker News 首页，不是中文热点。合并后其在 `SourceManager` 中显示为「Hacker News 简报（智能体）」，避免与「全网热点」混淆。
3. **通知链路收敛风险**：现有 `hotNotifier.startHotNotifier()`（`hotNotifier.ts`）与 `AgentScheduler.start()`（`scheduler.ts:141`）是两条独立 `setInterval`。合并到 `feedService.start()` 时，需确认不会双启导致重复通知。建议：`feedService` 启动后，**停用**两条旧定时（保留函数但不再 `start()`），等旧 IPC 删除时一并清理。
4. **`fetchAllHot` 重复调用**：见 §3.2 优化点——aggregator 内部只调一次，各 hot source 读缓存，避免 16× 网络请求。
5. **分类函数位置**：`categorize` 抽到 `src/main/feed/categorizeCore.ts`，渲染层 re-export（§3.6）。
6. **仓库状态（顺带提醒）**：当前 `/e/MyWorkbench` 仅有 `b1f5631` 一个提交，热点/智能体相关文件（`src/main/hot.ts`、`src/main/agents/*` 等）均为**未提交**状态（见 `git status` 大量 `??`）。本方案实施前建议先把现有可用代码提交一个基线，避免重构中丢失。KB 的 Analytics 接线修复（P0 遗留）也尚未提交——需先 `git add` 对应文件并 commit 后再动 feed 重构。

---

## 7. 分阶段实施计划（含文件清单与验证）

### 阶段 A：契约与类型（无行为变更）
- [ ] `src/shared/types.ts` 新增 `FeedItem` / `FeedItemSource` / `FeedSourceMeta` / `FeedSourceStatus` / `FeedResult` / `FeedSourceConfig` / `FeedNotifySettings` / `FeedRunRecord`。
- [ ] 新建 `src/main/feed/categorizeCore.ts`（从渲染层 `category.ts` 抽纯函数）。
- 验证：`tsc` typecheck 双绿（web + node target）。

### 阶段 B：主进程 feed 封装层
- [ ] `src/main/feed/source.ts`（接口）。
- [ ] `src/main/feed/sources/hotSource.ts`（包装 `fetchAllHot`）。
- [ ] `src/main/feed/sources/agentSource.ts`（包装 `AgentScheduler` job）。
- [ ] `src/main/feed/aggregator.ts`（合并 + 去重 + 排序，复用 `dedupeAndRank`）。
- [ ] `src/main/feed/feedService.ts`（注册表 + 周期 + 历史 + 统一通知）。
- [ ] `src/main/feed/feedIpc.ts`（`registerFeedIpc()`）。
- [ ] `src/main/index.ts`：`app.whenReady()` 内紧邻 `registerHotIpc`/`registerAgentsIpc` 之后调用 `registerFeedIpc()` 与 `feedService.start()`。
- 验证：`node --experimental-strip-types` 跑一个无头脚本，调用 `aggregateFeed` 确认 16 热点 + 2 智能体条目都进 `FeedResult`（注意：导入了 electron 的模块不可在纯 node 跑，需把纯逻辑下沉——见 §3.6 / 项目约定）。

### 阶段 C：preload 双写
- [ ] `src/preload/index.ts` + `index.d.ts` 新增 `feed: { result, listSources, runSource, setSourceConfig, history, notifyGet, notifySet, notifyCheck, notifyStatus }`，与现有 `hot` / `agents` 并存。
- 验证：grep 确认新字段与旧字段都在，typecheck 通过。

### 阶段 D：渲染层重构
- [ ] 抽 `SourceBrowser.tsx`、`PublishDrawer.tsx`（从 `Hotspots.tsx` 现有逻辑迁移，逻辑原样）。
- [ ] 新建 `FeedList.tsx` / `FeedItemCard.tsx` / `SourceManager.tsx`（合并原 `AgentsPanel` + 热点 platforms 状态条）。
- [ ] `Hotspots.tsx` → 重构为 `FeedCenter.tsx`：单一 feed 视图 + 筛选 + 数据源抽屉；删除 `Segmented(hotspots|agents)`。
- [ ] `PageView.tsx:54` 改为渲染 `FeedCenter`（不再传 `initialTab`）。
- [ ] `navItems.tsx:42` 标签可保留「多媒体」或改「情报中心」。
- [ ] 删除 `AgentsPanel.tsx`（能力已并入 `SourceManager`）。
- 验证：typecheck 双绿 + `npm run build` 通过。

### 阶段 E：清理与接线验证（沿用项目「接线了才算完成」）
- [ ] `grep -rn "api.hot\|api.agents" src/renderer` 应为 0（全部改为 `api.feed`）。
- [ ] `grep -rn "AgentsPanel" src/` 应为 0。
- [ ] 删除旧 `hot:*` / `agents:*` IPC handle 与 preload 旧字段（确认无引用后）。
- [ ] `grep -rn "ipcMain.handle('hot:\|ipcMain.handle('agents:" src/main` 应为 0。
- [ ] 产物确认：build 后 `grep` 打包产物确认 `feed:` 进了 `out/`。
- [ ] 手动：启动应用 → 情报流同时出现热点与 HN/GitHub 条目 → 数据源抽屉可改周期/立即运行/看历史 → 周期通知正常。

---

## 8. 文件改动总表

**新增**
- `src/shared/types.ts`（追加 feed 契约段）
- `src/main/feed/categorizeCore.ts`
- `src/main/feed/source.ts`
- `src/main/feed/sources/hotSource.ts`
- `src/main/feed/sources/agentSource.ts`
- `src/main/feed/aggregator.ts`
- `src/main/feed/feedService.ts`
- `src/main/feed/feedIpc.ts`
- `src/renderer/src/components/feed/FeedList.tsx`
- `src/renderer/src/components/feed/FeedItemCard.tsx`
- `src/renderer/src/components/feed/SourceManager.tsx`
- `src/renderer/src/components/feed/SourceBrowser.tsx`
- `src/renderer/src/components/feed/PublishDrawer.tsx`
- `src/renderer/src/pages/FeedCenter.tsx`（重构自 `Hotspots.tsx`）

**修改**
- `src/main/index.ts`（注册 `feedIpc` + `feedService.start()`）
- `src/preload/index.ts` + `index.d.ts`（新增 `feed` 段）
- `src/renderer/src/components/PageView.tsx`（渲染 `FeedCenter`）
- `src/renderer/src/utils/category.ts`（re-export 主进程抽出的纯函数）
- `src/renderer/src/navItems.tsx`（标签可选升级）

**删除（阶段 E，确认无引用后）**
- `src/renderer/src/components/AgentsPanel.tsx`
- `src/renderer/src/pages/Hotspots.tsx`（被 `FeedCenter` 取代）
- 旧 `hot:*` / `agents:*` IPC handle 及 preload 对应字段

---

## 9. 范围之外（本次不做）

- 不引入 LLM 对话式「智能体」，保持现有定时任务语义。
- 不改动 `publish.*`（多平台分发）与 `knowledge.*`（知识库）模块本身，只复用其 IPC。
- 数据库表 / 看板 / 写作 等其它模块不受影响。
