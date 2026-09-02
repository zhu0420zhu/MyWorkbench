# 移植交付说明 · 记忆与个性化 / 常驻智能体 / 多模态 Vision RAG

> 源项目：`awesome-llm-apps`（Shubhamsaboo）
> 目标：灵墨工作台（`E:\MyWorkbench`，Electron + React + TS）
> 对应类别：七（记忆与个性化）、五（多模态）、二-3（常驻智能体）
> 专家：Senior Developer · 任务规划 → 增量实现与验证 → 交付确认

---

## 一、本轮交付概览

在已交付的「智能分类整理 / 格式转换引擎 / 本地全文检索 + 问答(CRAG)」基础上，新增三类能力，全部复用既有 `ai.ts` / `searchIndex` / `ConfigStore` / `TaskScheduler` / `getLogger` / `fileUtils`，零新增第三方依赖，离线优先。

### 1. 记忆与个性化（七）
- **分类纠正记忆**（`organize/memoryCore.ts` 纯逻辑 + `organize/memory.ts` 主进程包装）
  - 记录用户对分类的纠正（文件扩展名 → 类别），达到阈值（默认 2 次）后在 `aiClassify` 中**优先采用记忆、跳过 LLM**，形成「越用越懂你」的个性化。
  - 新增 IPC：`organize:record-correction` / `organize:memory-list` / `organize:memory-clear`。
- **问答个性化偏好**（`searchIndex` Q&A）
  - `AskRequest.prefs` 支持 `answerStyle`(简洁/详细) 与 `maxCitations`，`QaService` 据之调整提示词与引用条数。
  - 新增 IPC：`searchIndex:qa-prefs-get` / `searchIndex:qa-prefs-set`（持久化于 `searchIndex-qa-prefs.json`），`ask` 时自动合并存储偏好。

### 2. 常驻智能体（二-3：Always-on Agents）
- 新增 `agents/` 模块：`scheduler.ts`（周期调度 + 历史 + 桌面通知，每 60s 扫描到期任务，复用 `ConfigStore`）、`jobs/hn.ts`（HN 首页简报，公开 Algolia API 免 Key）、`jobs/releaseRadar.ts`（GitHub Release Radar，公开 Releases API、对比上次版本报告新发布）。
- 周期配置持久化于 `agents-config.json`，历史 `agents-history.json`；运行期无需 Key（公开 API，与 `ai.ts` 联网一致）。
- 新增 IPC：`agents:list` / `agents:history` / `agents:run-now` / `agents:config` / `agents:job-config`；主进程 `app.whenReady` 注册并 `start()`。

### 3. 多模态 Vision RAG（五）
- `ai.ts` 新增 `completeVision`（多模态消息：文本 + 图片 base64 URL）。
- `searchIndex` 图片入库：非文本图片经视觉模型生成描述后建索引（`origin: 'image'`）；**视觉不可用则降级为文件名索引**，保证所有图片均可被检索。
- 复用既有 `Indexer` + `ask` 链路，图片问答与文本问答一致。

---

## 二、新增 / 修改文件清单

| 文件 | 变更 | 说明 |
|---|---|---|
| `src/shared/types.ts` | 改 | 新增 `ClassificationMemoryEntry` / `QaPrefs`(挂 `AskRequest`) / `AiContentPart`+`AiVisionMessage` / `AgentsConfig`+`Agent*` 契约 |
| `src/main/ai.ts` | 改 | 新增 `completeVision`（视觉多模态调用） |
| `src/main/organize/memoryCore.ts` | 新增 | 纯逻辑记忆核心（无 electron，可无头测试） |
| `src/main/organize/memory.ts` | 新增 | `ClassificationMemory` 包装 `MemoryCore` + `ConfigStore` |
| `src/main/organize/organizer.ts` | 改 | `aiClassify` 记忆优先；新增 `recordCorrection/listMemory/clearMemory/loadMemory` |
| `src/main/organize/organizeIpc.ts` | 改 | 注册记忆相关 IPC |
| `src/main/searchIndex/qa.ts` | 改 | `prefs` 驱动提示词风格与引用截断 |
| `src/main/searchIndex/parser.ts` | 改 | 新增 `IMAGE_EXTS` / `isImageFile` |
| `src/main/searchIndex/types.ts` | 改 | `IndexChunk`/`IndexDoc` 增加 `origin?` |
| `src/main/searchIndex/indexer.ts` | 改 | `ingest`/`ingestDir` 支持图片描述入库（降级文件名） |
| `src/main/searchIndex/searchIndexIpc.ts` | 改 | `ingest` 接入 `describeImageForIndex`；新增 `qa-prefs-*` |
| `src/main/agents/due.ts` | 新增 | 纯函数 `isJobDue`（无 electron） |
| `src/main/agents/scheduler.ts` | 新增 | `AgentScheduler`（周期/历史/通知） |
| `src/main/agents/jobs/hn.ts` | 新增 | HN 首页简报（fetch 可注入） |
| `src/main/agents/jobs/releaseRadar.ts` | 新增 | GitHub 版本雷达（fetch 可注入） |
| `src/main/agents/index.ts` | 新增 | 单例 + 默认作业注册 |
| `src/main/agents/agentsIpc.ts` | 新增 | 注册 agents IPC 并 `start()` |
| `src/main/index.ts` | 改 | 注册 `registerAgentsIpc()` |
| `src/preload/index.ts` + `index.d.ts` | 改 | 暴露 `organize` 记忆接口、`searchIndex` 偏好接口、`agents` 命名空间 |

---

## 三、验证结果

| 项 | 结果 |
|---|---|
| `npm run typecheck:node` | ✅ 通过 |
| `npm run typecheck:web` | ✅ 通过 |
| `npm run build`（electron-vite） | ✅ 通过（main 183 kB / preload 13.26 kB / renderer 全量） |
| `tests/smoke-agents-memory.ts`（无头） | ✅ 22 项全过 |

无头冒烟覆盖：记忆阈值/纠正更新、HN 作业（含失败路径）、Release Radar 新版本对比、调度到期纯函数、QA 偏好（风格/引用截断）、Vision 图片入库（视觉描述 + 文件名降级检索）。

---

## 四、关键说明与约束

- **无破坏性改动**：既有 `searchIndex` 索引 JSON 格式兼容（`origin` 为可选字段）；分类/转换/检索既有行为不变。
- **离线优先 + 联网一致**：检索/记忆/分类规则全部本地；仅「生成、视觉描述、常驻智能体抓取」需联网，与既有 `ai.ts` 联网策略一致。
- **Vision 依赖模型能力**：`completeVision` 在模型不支持视觉时返回错误，`describeImageForIndex` 自动降级为文件名索引，不崩溃。
- **常驻智能体公开 API 限频**：GitHub 未授权 60 次/小时，周期运行（默认 6h/24h）足够；可在 GUI 通过 `agents:config`/`agents:job-config` 调整周期与关注仓库。
- **构建提示**：沙箱内 Vite 对 `out/` 走回收站会失败，构建前用 `rm -rf out` 清空（单独调用）即可。

---

## 五、未移植项（依分诊已排除，附原因）

- 入门/高级单任务智能体（Blog→Podcast、医疗影像、表情包/音乐生成、旅行规划、深度研究、VC尽调、电影制作、欺诈调查等）：强依赖外部付费 API、浏览器、媒体生成模型或第三方服务，与本地文件管理工作台定位无关，破坏「无破坏性改动 / 离线优先」约束，故不移植。
- RAG（四）：上一阶段已完成（本地倒排 + 问答 + CRAG），本轮未重复。
