# ck 项目 × 灵墨工作台｜差异分析与改造清单

> 审计日期：2026-08-12｜审计范围：只读静态代码与文档分析，未执行任何构建或运行
> 对比基线：`E:\MyWorkbench\ck`（灵墨AI文件管理系统）→ `E:\MyWorkbench`（灵墨工作台 lingmo-workbench）
> 证据标注规则：`文件路径:行号`。所有结论均附证据；无证据处明确标注「未验证」。

---

## 0. 审计结论摘要

| 项 | 结论 |
|---|---|
| 两者关系 | **非平行项目，而是既定的「源 → 目标」迁移关系**，已有 3 处移植落地 |
| 功能重叠度 | 5 个功能域重叠（文件工具 / OCR / AI 对话 / 资产统计 / 设置主题） |
| ck 独有能力 | 9 大类，约 2.1 万行 Python 无对应实现 |
| 灵墨独有能力 | 10 个页面级功能，ck 完全没有 |
| 需改造项总数 | **17 项**（P0×5、P1×7、P2×5） |
| 不可对齐项 | **3 项**（触碰 ck 架构红线 ARCH-01/03/04 与 REQ-08-03） |
| 反向改造项 | **2 项**（灵墨标准弱于 ck，应由灵墨侧修正，不可让 ck 向下对齐） |

### 迁移关系的直接证据

| 证据 | 位置 | 原文 |
|---|---|---|
| 类型层移植 | `src/preload/index.d.ts:33` | `/* ---- 工具集类型（由 ck 08_工具集 移植） ---- */` |
| 实现层移植 | `src/main/tools/fileUtils.ts:2` | `文件工具模块（由 ck 08_工具集/file_utils.py 移植为 TypeScript）` |
| UI 层移植 | `src/renderer/src/pages/FileTools.tsx:481` | `磁盘分析 · 目录占用 · 重复文件 · 目录监控 · 磁盘清理（由 ck 工具集移植）` |

**判定**：迁移方向为 ck → 灵墨工作台，且已完成 08_工具集 的 6/9 文件。本清单以「继续推进模块迁移」为默认路径。

---

## 1. 项目画像对照

| 维度 | ck（灵墨AI文件管理系统） | 灵墨工作台（lingmo-workbench） |
|---|---|---|
| 技术栈 | Python 3.12 + PySide6 6.6 + FastAPI 0.110 | Electron 43 + React 19 + TypeScript 7 + Vite 7 |
| 进程模型 | **双进程**：launcher 拉起 FastAPI 网关子进程 + GUI 主进程（`01_启动器/launcher.py:7-20`） | **单进程**：Electron main + renderer（`src/main/index.ts`） |
| 通信方式 | HTTP / SSE over 127.0.0.1，动态端口（`api_reference.md:26-37`） | Electron IPC + contextBridge（`src/preload/index.ts`） |
| 存储方案 | SQLite/PostgreSQL + Redis + ChromaDB + Celery（`02_依赖清单/requirements.txt`） | **纯 JSON 文件化**，17 个文件（`README.md:40-56`） |
| 代码体量 | 网关 12623 行 / 客户端 11642 行 / 技能 2633 行 / 智能体 2347 行 / 转换 2027 行 / 工具集 2655 行 | 全量 12811 行 TS |
| 治理体系 | **REQ 锚点全覆盖**：REQ-01~12 + ARCH-01~05 架构红线 | 仅 5 处残留锚点（全在 `fileUtils.ts`） |
| 主题能力 | 9 套 QSS 主题（`architecture.md:205-214`） | 深浅双主题 + 自定义主题色（`README.md:20`） |
| 打包产物 | PyInstaller onefile → `LingMoAI.exe` | electron-builder → nsis + portable |

---

## 2. 功能点逐项比对

### 2.1 重叠功能域（5 项）——差异集中在实现逻辑

| 功能 | ck 实现 | 灵墨实现 | 差异性质 |
|---|---|---|---|
| **磁盘/目录分析** | `08_工具集/disk_analyzer.py`（395 行） | `src/main/tools/diskAnalyzer.ts`（314 行） | 已移植，逻辑对齐，**行数缩减 20%** 需确认是否有能力裁剪 |
| **重复文件检测** | `duplicate_detector.py`（381 行） | `duplicateDetector.ts`（308 行） | 已移植。ck 支持「内容相似度比对」（`REQ-03-02`），灵墨仅哈希（`README.md:17` 标注"哈希查重"）→ **能力缺口** |
| **目录监控** | `file_watcher.py`（348 行） | `fileWatcher.ts`（244 行） | 已移植，事件模型保留 snake_case |
| **OCR 识别** | RapidOCR + PyMuPDF **Python 后端**，双引擎回退（`architecture.md:174-183`） | PP-OCRv4 + SLANet **onnxruntime-web WASM 前端**（`README.md:24-34`） | **实现路径完全不同**。灵墨多出「表格结构识别 → Markdown」，ck 无；ck 多出「PDF 5 引擎文本提取回退链」，灵墨无 |
| **AI 对话** | 三模型智能路由 + 容错兜底（`models/router.py`，331 行） | 单 endpoint OpenAI 兼容（`src/main/ai.ts:71`） | **架构级差异**，详见 §4 冲突项 |

### 2.2 ck 独有功能（9 大类，灵墨零实现）

| # | 功能域 | ck 位置 | 体量 | 对应锚点 |
|---|---|---|---|---|
| 1 | **格式转换引擎**（插件化 4 转换器 + 队列 + 临时清理） | `06_格式转换引擎/` | 2027 行 | REQ-06-01~13 |
| 2 | **技能系统**（基类/管理器/执行器 + 5 内置技能） | `07_技能系统/` | 2633 行 | 无锚点（借鉴 OpenClaw） |
| 3 | **AI 智能体平台**（AIP 国标 GB/Z 185 身份码/描述/发现/交互） | `04_AI智能体平台/` | 2347 行 | 无锚点 |
| 4 | **RAG 私有知识库**（切分/向量化/检索问答） | `services/rag_service.py` + `chunking_service.py` + `data/vector_store.py` | 864 行 | REQ-09-02 |
| 5 | **文档智能服务群**（解析/去重/关联/时间线/自动归档/格式推荐） | `services/document_parser.py` `dedup_service.py` `document_link_service.py` `timeline_service.py` `auto_archive_service.py` `format_advisor_service.py` | 3174 行 | REQ-09-06/09/10/11 |
| 6 | **API Key 管控中台**（加密保险库/配额限流/调用统计/Key 管理台） | `services/api_key_store.py` `quota_limiter_service.py` `call_stats_service.py` + `api/api_key_admin.py` | 2605 行 | REQ-12-06~11 |
| 7 | **智能分类与整理执行** | `08_工具集/file_organizer.py` | **591 行，未移植** | REQ-02-01/02/03 |
| 8 | **全文检索索引** | `05_桌面客户端/ui/pages/search_preview_page.py` | 278 行 | REQ-04-01 |
| 9 | **重试/路径基础设施** | `08_工具集/tenacity_retry.py`（228 行）+ `paths.py`（66 行） | **294 行，未移植** | REQ-12-10 |

### 2.3 灵墨独有功能（10 项，ck 零实现）

知识库笔记（Markdown）、便利贴（置顶悬浮 + 日历）、数据库表格/看板、白板（tldraw）、文本工具（22 种处理 + 翻译）、热点聚合（16 平台 + SimHash 去重）、多平台一键分发（7 适配器 + 队列/排程/退避）、快捷卡片、自动化命令（流式输出）、Ctrl+K 跨模块搜索。

> **说明**：这些属于灵墨工作台的定位扩张（从「文件管理」扩为「一体化工作台」），不构成 ck 的改造项，但决定了 ck 能力迁入时的信息架构落位。

---

## 3. 接口规范差异（改造重点）

### 3.1 契约形态

| 项 | ck | 灵墨工作台 |
|---|---|---|
| 协议 | HTTP REST + SSE | Electron IPC（invoke/handle + send/on） |
| 命名 | 路径式：`/api/v1/classify`、`/v1/chat/completions`、`/api/convert/status/{task_id}` | **channel 式 `domain:action` kebab-case**：`tools:scan-directory`、`hot:notifier-get`、`publish:check-all-login` |
| 前端调用面 | `http_client.py` 发起请求 | `window.api.<domain>.<method>()` camelCase（`src/preload/index.d.ts:135-285`） |
| 鉴权 | Bearer Token 强制（`api_reference.md:41-53`） | **无鉴权**（同进程 IPC，contextBridge 隔离） |
| 错误规范 | 统一错误体 + 8 个业务错误码（`api_reference.md:320-343`） | **无统一规范**：`ai.ts` 返回 `{ok,error}`、`gzhCredential.ts:29` 直接 `throw`、多数 handler 直接返回值 |
| 类型来源 | Pydantic model | `src/shared/types.ts`（251 行）集中定义 |

### 3.2 已暴露的规范破损（实证）

灵墨工作台现有 IPC 共 **107 个 handler**（`index.ts` 82 个 + `toolsIpc.ts` 17 个 + `publishIpc.ts` 15 个），命名规范统一为 `domain:action`。但从 ck 移植的部分**字段命名未归一**：

| 破损点 | 证据 | 冲突对象 |
|---|---|---|
| `FileInfo.relative_path` | `preload/index.d.ts:36` | 灵墨自身 `Shortcut.createdAt`（`shared/types.ts:8`）camelCase |
| `DiskInfoDict.percent_used` / `total_formatted` | `preload/index.d.ts:71-74` | 同上 |
| `CategoryStat.size_formatted` | `preload/index.d.ts:81` | 同上 |
| `FileEvent.event_type` / `old_path` | `preload/index.d.ts:130-132` | 同上 |
| 受污染文件 | `tools/diskAnalyzer.ts`、`tools/fileUtils.ts`、`tools/fileWatcher.ts`、`preload/index.d.ts`、`pages/FileTools.tsx` | 5 个文件 |

**影响**：Python snake_case 直接穿透到 TS 类型层与 React 渲染层。后续每迁一个 ck 模块，这个污染面就扩大一次。

---

## 4. 业务流程差异

| 流程 | ck | 灵墨工作台 | 判定 |
|---|---|---|---|
| **危险操作流程** | 预览 → 用户确认 → 执行 → 异常自动回滚 + 操作日志（`features.md:87-92`） | 即时执行，无预览态、无回滚 | ck 更严谨，**不可向下对齐** |
| **长任务流程** | `task_id` + 5 态状态机（pending/processing/completed/failed/cancelled）+ 进度查询 + 取消（`api_reference.md:265-299`） | 仅发布队列有状态机（`PublishJobStatus`，`shared/types.ts:185`），其余全同步阻塞 | 需补齐 |
| **启动流程** | 查空闲端口 → 拉网关子进程 → 等就绪 → 起 GUI → GUI 退出杀网关（`launcher.py:36-45` 注释块） | Electron 单进程直起 + 旧版数据自动迁移（`README.md:58`） | 形态不同，迁移后 ck 流程整体消失 |
| **崩溃诊断** | 全局 excepthook 写 `%APPDATA%/LingMo/logs/crash.log`（`launcher.py:40-87`） | 未发现等价机制（`logs/` 目录仅 2 个 .log） | ck 更完备，**建议反向移植** |
| **日志留存** | loguru + 调用统计中间件 + 保留天数策略（`services/call_stats_service.py`，730 行） | `tools/logger.ts`（43 行） | 差距 17 倍，需补齐 |
| **测试流程** | M1~M8 里程碑测试（8 个 `test_mN_features.py`）+ 9 个诊断脚本 | 7 个 `verify-*.mjs` 根级校验脚本 | 组织方式不同，覆盖映射未验证 |

---

## 5. 冲突项：不可对齐 / 需反向对齐

> 这部分是本次审计最关键的发现。**若机械地让 ck「对齐灵墨标准」，会触发架构红线违规与安全能力倒退。**

### 5.1 不可对齐（3 项，触碰 ARCH 红线）

| # | 冲突 | ck 侧约束 | 灵墨侧现状 | 后果 |
|---|---|---|---|---|
| C1 | **本地模型禁令** | `ARCH-01`：「不部署任何本地量化模型、不依赖本机GPU」；`REQ-09-12`：「无本地模型、无Ollama离线推理」 | `README.md:64` 首推 `Ollama（本地）` 作为配置示例第一行 | ck 若采纳 Ollama 路线 = 直接违反 ARCH-01/ARCH-04 |
| C2 | **三模型分工调度** | `ARCH-03` 明确 Qwen/DeepSeek/GLM 三方分工；`REQ-09-16` 要求单模型故障自动切换另两款兜底 | `ai.ts:71` 单 endpoint 单 model，无路由无兜底 | ck 若降级为单通道 = 丢失容错路由，违反 ARCH-03 |
| C3 | **本地中间件栈** | `REQ-08-03` 要求 PostgreSQL + Redis + Celery + Chroma；`REQ-08-04` Docker Compose 一键启动（`04_Docker配置/docker-compose.yml` 已存在） | 纯 JSON 文件化存储（`README.md:36-56`） | RAG 向量检索（REQ-09-02）无法在纯 JSON 上实现，属硬冲突 |

**处置建议**：C1/C2 保留 ck 原设计，将灵墨的「单 endpoint」视为**降级模式**而非标准，在灵墨侧扩展为「多 Provider 配置 + 路由策略」。C3 需一次显式选型决策（见改造项 R14）。

### 5.2 需反向对齐（2 项，灵墨标准弱于 ck）

| # | 问题 | ck 做法 | 灵墨现状 | 优先级 |
|---|---|---|---|---|
| R-A | **API Key 明文落地** | `02_核心配置与安全/security.py:29-60` `KeyVault` Fernet 对称加密 + 机器指纹绑定，`REQ-12-11` 明令「禁止明文落地」 | `src/main/ai.ts:35` 将含 `apiKey` 的对象 `JSON.stringify` 明文写入 `ai-config.json` | **P0** |
| R-B | **灵墨内部规范不自洽** | — | `publish/gzhCredential.ts:2,31` 已用 `safeStorage.encryptString` 加密公众号 Secret，但同一应用的 `ai-config.json` 明文。同项目两套凭据标准 | **P0** |

---

## 6. 改造清单（17 项）

### P0｜阻断级：不先做则后续迁移持续放大成本（5 项）

| ID | 改造项 | 必要原因 | 影响范围 | 证据 |
|---|---|---|---|---|
| **R01** | 建立 **IPC 契约映射规范**：将 ck 的 HTTP 路由逐条映射为 `domain:action` channel，产出映射表并纳入评审 | ck 有 7 个 API 文件（约 3254 行）待迁；不先定契约，每个模块各写各的，107 个现有 handler 的命名一致性会被破坏 | `03_AI网关服务/api/*.py` 全 7 文件；灵墨 `preload/index.d.ts`、`shared/types.ts` | `toolsIpc.ts:20-62`、`publishIpc.ts:40-119` 现有命名范式 |
| **R02** | **字段命名归一**：snake_case → camelCase，建立边界转换层（Python 侧保留 snake，进 TS 即转） | 污染已穿透类型层到渲染层，5 个文件受影响；每迁一模块扩大一次 | `tools/diskAnalyzer.ts`、`tools/fileUtils.ts`、`tools/fileWatcher.ts`、`preload/index.d.ts:36,71-74,81,130-132`、`pages/FileTools.tsx` | §3.2 |
| **R03** | **【反向】API Key 加密存储**：灵墨 `ai-config.json` 改用 `safeStorage`，与 `gzhCredential.ts` 统一 | 违反 ck `REQ-12-11` 且灵墨自身双标；明文密钥落盘是可直接利用的风险 | `src/main/ai.ts:27-37`（写）、`:17-25`（读）、`Settings.tsx` 展示层需配合脱敏 | `ai.ts:35` vs `gzhCredential.ts:31` |
| **R04** | **统一错误契约**：定义 `{ ok, code, message }` 返回体 + 复用 ck 的 8 个业务错误码 | 灵墨现有三种错误风格混用，跨模块无法统一处理；ck 迁入后错误语义会丢失 | 107 个 IPC handler 需分批改造；`shared/types.ts` 新增错误类型 | `api_reference.md:320-343`；`ai.ts` 返回 `{ok,error}` vs `gzhCredential.ts:29` throw |
| **R05** | **明确 AI 多 Provider 架构决策**：在灵墨侧扩展 `AiConfig` 为多 Provider + 路由策略，而非让 ck 降级 | 直接关系 C1/C2 两条红线；此决策不定，ck 的 `router.py`(331) + 3 个 adapter(743) 无法迁移 | `shared/types.ts:55-60` `AiConfig`；`src/main/ai.ts` 全量；ck `models/` 全 5 文件 | `ARCH-01/03/04`、`REQ-09-12/16`、`README.md:64` |

### P1｜能力对齐：功能缺口与流程缺失（7 项）

| ID | 改造项 | 必要原因 | 影响范围 | 证据 |
|---|---|---|---|---|
| **R06** | 移植 `file_organizer.py`（591 行）→ 智能分类与整理执行 | 08_工具集迁移只完成 6/9，最核心的「整理执行」算法未迁，导致 REQ-02 整个模块在灵墨侧空缺 | 新增 `src/main/tools/fileOrganizer.ts` + IPC + FileTools 新增标签页 | `08_工具集/` 9 文件 vs `src/main/tools/` 6 文件 |
| **R07** | 补齐**预览 → 确认 → 执行 → 回滚**流程 | ck 对危险操作有强制预览与回滚（`features.md:87-92`），灵墨即时执行；迁入整理/清理能力若无此流程 = 用户数据风险 | R06 的前置依赖；`pages/FileTools.tsx` 清理区；`tools/fileUtils.ts` 删除/移动路径 | `features.md:87-92`、`REQ-02-03` |
| **R08** | 建立**通用长任务状态机**（task_id + 5 态 + 进度 + 取消） | ck 转换/OCR/分类均为长任务；灵墨仅 publish 有状态机，其余同步阻塞，迁入即卡 UI | 新增 `src/main/taskQueue.ts`；`shared/types.ts` 新增 Task 类型；复用 `PublishJobStatus` 模式 | `api_reference.md:265-299`；`shared/types.ts:185` |
| **R09** | 补齐**重试与降级基础设施**（移植 `tenacity_retry.py` 228 行） | `REQ-12-10` 要求超时/限流自动重试 + 优雅降级；灵墨 `ai.ts` 无重试，`hot.ts` 有降级但各自实现 | 新增 `src/main/utils/retry.ts`；`ai.ts`、`hot.ts`、`translate.ts`、`publish/queue.ts` 复用 | `REQ-12-10`、`08_工具集/tenacity_retry.py` |
| **R10** | 补齐**调用统计与日志留存** | `REQ-12-04/08` 要求全流程日志可追溯 + 调用次数/配额监控；灵墨 `logger.ts` 仅 43 行 | 扩展 `src/main/tools/logger.ts`；新增统计存储 + Settings 展示 | ck `call_stats_service.py`(730) vs `logger.ts`(43) |
| **R11** | 重复检测补齐**内容相似度比对** | `REQ-03-02` 要求「MD5/SHA 哈希 + 内容相似度」双路，灵墨仅哈希，高度相似文件识别不出 | `src/main/tools/duplicateDetector.ts`（308 行）；`DuplicateResultGroup.similarity` 字段已预留但未验证是否真实计算 | `REQ-03-02`；`README.md:17`「哈希查重」；`preload/index.d.ts:109` |
| **R12** | 【反向】移植**崩溃日志钩子** | ck 有全局 excepthook 写 crash.log 供用户自诊断；灵墨未发现等价机制，打包后用户「打不开」无法定位 | 新增 Electron `process.on('uncaughtException')` + 渲染进程错误上报 | `launcher.py:40-87` |

### P2｜长期演进：需先做选型决策（5 项）

| ID | 改造项 | 必要原因 | 影响范围 | 前置条件 |
|---|---|---|---|---|
| **R13** | 格式转换引擎迁移（2027 行，REQ-06-01~13 共 13 条锚点） | 灵墨完全无格式转换页面，是 ck 最大的独立功能块；Electron 下可通过子进程调用 FFmpeg/LibreOffice/Pandoc | 新增 `src/main/convert/`（4 转换器 + 队列 + 清理）+ 新页面 + 导航项 | 依赖 R08 任务状态机 |
| **R14** | **存储架构选型决策**：RAG/向量检索是否引入 ChromaDB，或改用可嵌入方案 | C3 硬冲突项。`REQ-08-03` 要求 Chroma，灵墨「数据自主·文件化」是核心卖点（`README.md:36`），二者不可兼得 | 决定 R15 可行性；影响 `data.ts` 数据目录契约、备份/导入导出 | 需产品决策，非技术决策 |
| **R15** | RAG 私有知识库迁移（864 行） | `REQ-09-02` 核心 AI 能力；灵墨知识库仅 Markdown 笔记 + 元数据搜索（`SearchResult` 只有 shortcut/note/automation 三种 kind），无向量检索 | 依赖 R14 结论；`src/main/notes.ts`、`search.ts` 需重构 | R14 |
| **R16** | 全文检索索引（REQ-04-01 毫秒级多条件检索） | 灵墨 `search.ts` 是元数据级搜索，非全文索引；ck 支持 PDF/Office 全文 + OCR 扫描件索引 | `src/main/search.ts`；`shared/types.ts:45-53` `SearchResult` 需扩展 | R14（索引存储形态） |
| **R17** | 技能系统 + 智能体平台（4980 行）形态评估 | 两模块在灵墨侧无任何对应概念，且无 REQ 锚点绑定（技能系统借鉴 OpenClaw、智能体基于 GB/Z 185 国标）。**建议先评估是否属于本产品定位内，而非直接迁移** | 若保留，需新增 2 个页面 + 完整 IPC 域；若裁撤，需在 ck 侧归档说明 | 产品定位澄清 |

### 附加治理项

| ID | 项 | 说明 |
|---|---|---|
| **G01** | **恢复 REQ 锚点治理** | ck 全项目锚点绑定开发/任务/BUG/测试/验收；灵墨仅 `fileUtils.ts` 残留 5 处（REQ-01-01/03/04、REQ-02-01、REQ-03-02）。建议每迁一模块补齐锚点注释，否则验收无法追溯 |
| **G02** | 主题体系收敛 | ck 9 套 QSS 主题 vs 灵墨深浅双主题 + 主题色。迁移时不建议照搬 9 套（`Dream Purple`/`Purple Night` 等紫系与灵墨现有设计语言不一致），建议以「双主题 + 主题色」为准，ck 侧 9 主题作为预设色板收敛 |

---

## 7. 建议执行顺序

```
第一阶段（契约与安全，P0）
  R03 ─┐
  R04 ─┼─► 可并行，无相互依赖
  R02 ─┘
  R01 ──► 依赖 R02/R04 的结论落地为规范文档
  R05 ──► 需先出架构决策（涉 ARCH 红线）

第二阶段（能力补齐，P1）
  R08 ──► R06 ──► R07     （状态机 → 分类算法 → 安全流程）
  R09 ─┐
  R10 ─┼─► 基础设施，可并行
  R12 ─┘
  R11 ──► 独立

第三阶段（选型后演进，P2）
  R14（产品决策）──► R15 ──► R16
  R13 ──► 依赖 R08
  R17 ──► 定位澄清后再定
```

---

## 8. 数据缺失与未验证项声明

以下内容本次审计**未能取得证据**，不做结论：

1. `diskAnalyzer.ts`（314 行）相对 `disk_analyzer.py`（395 行）缩减的 81 行是否为能力裁剪 —— 未做逐函数比对。
2. `DuplicateResultGroup.similarity` 字段（`preload/index.d.ts:110`）是否真实参与相似度计算，或仅为哈希命中时的占位常量 —— 未读实现体。
3. ck 的 M1~M8 测试用例与灵墨 7 个 `verify-*.mjs` 的覆盖映射关系 —— 未做用例级比对。
4. ck `README.md`（445 KB）未通读，可能含本报告未覆盖的变更历史或已知问题。
5. `06_子项目/01_灵墨英语`（Android）与 `02_灵墨知识库`（Obsidian）为独立子项目，与灵墨工作台无功能交集，本次未纳入比对范围。
6. `architecture.md:245-247` 的「格式转换技术栈」表格在源文档中即为空表（表格结构破损），ck 侧该处信息缺失。
