# 灵墨工作台 · 本地知识库竞品调研报告

**调研人**：许清楚（软件产品经理，研究模式）
**调研方式**：GitHub REST API 实测拉取仓库元数据（Star/语言/许可证/归档状态/最后推送）＋ 各项目官方文档站实测抓取核验特性
**数据快照时间**：2026-09-02（Star 量为 API 实测值，非估算）
**核验原则**：所有「支持程度」判定均附证据来源；无法核验的一律标注「未确认」，未做任何推测性填充

---

## 0. 结论速览（TL;DR）

三条最重要的发现：

1. **「本地知识库文档 + 一键安装」是成熟赛道，已有明确最佳实践可直接抄。** AnythingLLM 是唯一同时做到「桌面一键安装包 + Docker 一行命令 + 完整独立文档站 + Desktop/Docker 功能差异对照表」的标杆（MIT 许可，可放心借鉴）。
2. **「知识库在多场景被一键导入」已有两种成熟范式，但没人做全。** 范式 A：**编排节点式**（Dify 的 Knowledge Retrieval 节点、FastGPT/MaxKB 的知识库检索模块）；范式 B：**输入框引用式**（Open WebUI 的 `#` 引用知识库 + Notes 附件注入）。灵墨的「一键导入」应走范式 B 为主、范式 A 为辅。
3. **「知识库 → 数据分析 / 数据整理」是全生态的明确空白，也是灵墨最大机会点。** 实测核验 Open WebUI 官方文档：其 `kb_exec` 工具**明确只能做文件系统式读取与文本检索（ls/cat/grep/find），不能对知识库里的 CSV 执行代码做聚合统计分析**。所有主流项目的知识库都只服务「问答/写作」，没有一个把知识库真正接入「表格数据分析」场景。
4. **⚠️ 高危信号**：形态上与灵墨**最接近**的项目 `reorproject/reor`（Electron + 本地 RAG + 笔记/写作一体，8,565 ⭐）已于 **2025-05 归档停更**；`FlowiseAI/Flowise`（55,398 ⭐）也已 **archived**。说明「本地优先桌面 AI 知识工作台」这条路**尚无活跃的成熟开源产品占位** —— 既是机会，也需警惕其失败原因。

---

## 1. 主要参考项目清单（12 个）

### A 组：本地知识库 / RAG 平台（9 个）

| # | 项目 | GitHub URL | Star（实测） | 主要语言 / 技术栈 | 许可证 | 状态 |
|---|---|---|---|---|---|---|
| A1 | **AnythingLLM** | https://github.com/Mintplex-Labs/anything-llm | **65,496** | JavaScript（Electron 桌面端 + Node/Express + React，SQLite + LanceDB） | **MIT** ✅ | 活跃（2026-09 有推送） |
| A2 | **Open WebUI** | https://github.com/open-webui/open-webui | **150,669** | Python（FastAPI）+ Svelte | NOASSERTION → 实为「Open WebUI License」（BSD-3 衍生 + 品牌保留条款）**需法务核验** | 活跃 |
| A3 | **Dify** | https://github.com/langgenius/dify | **154,180** | TypeScript + Python | NOASSERTION → 实为「Dify Open Source License」（Apache-2.0 + 商用/多租户附加限制）**需法务核验** | 活跃 |
| A4 | **RAGFlow** | https://github.com/infiniflow/ragflow | **89,871** | GitHub 主语言标记为 **Go**（历史以 Python 为主，语言构成变化未逐一核验） | **Apache-2.0** ✅ | 活跃 |
| A5 | **FastGPT** | https://github.com/labring/FastGPT | **29,540** | TypeScript（Next.js + MongoDB + PgVector/Milvus） | NOASSERTION → 实为「FastGPT Open Source License」（Apache-2.0 + 附加条款）**需法务核验** | 活跃 |
| A6 | **MaxKB** | https://github.com/1Panel-dev/MaxKB | **22,697** | Python（Django + Vue） | **GPL-3.0** ⚠️（传染性，商用需评估） | 活跃 |
| A7 | **kotaemon** | https://github.com/Cinnamon/kotaemon | **25,727** | Python（Gradio + LanceDB/Chroma/Milvus） | **Apache-2.0** ✅ | 较活跃（2026-07 推送） |
| A8 | **Khoj** | https://github.com/khoj-ai/khoj | **36,911** | Python（Django）+ 多端客户端 | **AGPL-3.0** ⚠️ | 较活跃（2026-08 推送） |
| A9 | **GPT4All** | https://github.com/nomic-ai/gpt4all | **77,388** | C++（Qt 原生桌面 + llama.cpp） | **MIT** ✅ | ⚠️ **低活跃**（最后推送 2025-05-27，近一年无更新） |

### B 组：本地优先笔记 / 知识工作台（3 个，形态与架构参考）

| # | 项目 | GitHub URL | Star（实测） | 主要语言 / 技术栈 | 许可证 | 状态 |
|---|---|---|---|---|---|---|
| B1 | **SiYuan 思源笔记** | https://github.com/siyuan-note/siyuan | **46,116** | TypeScript（Electron）+ Go 内核 | **AGPL-3.0** ⚠️ | 活跃 |
| B2 | **Logseq** | https://github.com/logseq/logseq | **44,731** | Clojure/ClojureScript（Electron） | **AGPL-3.0** ⚠️ | 活跃 |
| B3 | **Trilium（TriliumNext）** | https://github.com/TriliumNext/Trilium | **37,665** | TypeScript（Electron + Node，**SQLite** 单文件） | **AGPL-3.0** ⚠️ | 活跃（2026-09 推送） |

> **B3 Trilium 是技术栈上与灵墨最同构的项目**（Electron + Node + SQLite 单文件本地存储），其安装分发与文档站做法最值得直接对标。

---

## 2. 两条主线的支持程度矩阵

### 主线①：本地知识库说明文档 + 一键安装

| 项目 | 支持程度 | 实现方式 | 证据（实测） |
|---|---|---|---|
| **A1 AnythingLLM** | **明确支持（标杆）** | ① macOS/Windows/Linux **一键安装包**；② Docker 一行 `docker run -d -p 3001:3001 ... mintplexlabs/anythingllm`；③ Docker Compose；④ 云平台一键部署模板（AWS/GCP/DigitalOcean/Railway/Render）；⑤ **独立文档站 docs.anythingllm.com**，按平台分页（macOS/Windows/Linux/Local Docker/Cloud Docker）+ System Requirements 独立页 | 官方文档实测：`docs.anythingllm.com/installation-desktop/overview` 明确写「You want a **one-click installable app**」，并给出 **Desktop vs Docker 逐项功能差异对照表**（含 `One-click install ✅/❌`） |
| **A2 Open WebUI** | **明确支持** | Docker 一行命令 / `pip install open-webui`；**独立文档站 docs.openwebui.com**，Knowledge 有专属章节（Setting Up a Knowledge Base 分步指引）。无官方桌面安装包 | 官方文档实测：`docs.openwebui.com/features/workspace/knowledge/` 有完整「Setting Up a Knowledge Base」三步流程 |
| **A3 Dify** | **明确支持** | Docker Compose 一键启动；**独立文档站 docs.dify.ai**（多语言），Knowledge 建库有独立章节。无桌面安装包 | 官方文档实测 `docs.dify.ai/en/cloud/use-dify/knowledge/readme#create-knowledge` |
| **A4 RAGFlow** | **明确支持** | `git clone` → `cd docker` → `docker compose -f docker-compose.yml up -d`；**独立文档站 ragflow.io/docs**，Quickstart 覆盖「启服务 → 建 dataset → 干预解析 → 建 AI chat」全链路。⚠️ 门槛高：要求 CPU≥4核 / RAM≥16GB / Disk≥50GB，且需手调 `vm.max_map_count≥262144`；官方仅支持 x86，ARM 需自行构建镜像 | 官方 Quickstart 实测，前置条件与命令逐条核对 |
| **A5 FastGPT** | **明确支持（本土化最佳）** | ① **交互式一键安装脚本** `bash <(curl -fsSL https://doc.fastgpt.io/deploy/install.sh)`，自动下载 compose、随机生成 root 密码与各类密钥、自动探测 Docker socket；② 提供**阿里云镜像源**（解决国内 pull 失败）；③ 手动 compose；④ **甚至提供「让 Coding Agent 代部署」的 SKILL.md 入口**；⑤ 独立文档站 doc.fastgpt.io | 官方文档实测 `doc.tryfastgpt.ai/docs/introduction/development/docker/`，三种获取配置文件方法逐条核对 |
| **A6 MaxKB** | **明确支持** | 单行 `docker run -d --name=maxkb -p 8080:8080 -v ~/.maxkb:/opt/maxkb 1panel/maxkb`，附默认账号密码；**提供离线安装文档**（面向国内 pull 失败）；文档站 maxkb.cn/docs | README 实测 + 离线安装文档链接实测 |
| **A7 kotaemon** | **部分支持** | Docker 多镜像分档（`main-lite` / `main-full` / `main-ollama` 捆绑 Ollama）；源码 uv/conda；**Release 页提供 .zip 供非开发者下载**；文档站 cinnamon.github.io/kotaemon（User Guide + Developer Guide）。**但 README 未提供 .exe/.dmg 图形化一键安装器** | README 实测：安装章节仅命令行方式，无 GUI installer |
| **A8 Khoj** | **明确支持** | 桌面 App + Obsidian 插件 + Emacs 插件 + Web 多端；self-host 文档 `docs.khoj.dev/get-started/setup`；**独立文档站 docs.khoj.dev** | 官方文档站首页实测，客户端矩阵逐条列出 |
| **A9 GPT4All** | **明确支持** | **四个平台原生一键安装器直链**：`gpt4all-installer-win64.exe`、`win64-arm.exe`、`darwin.dmg`、`linux.run` + Flathub（社区维护）；有 System Requirements 说明 | README 实测，安装器直链逐条核对。⚠️ 但项目近一年无推送 |
| **B1 SiYuan** | **明确支持（分发渠道最全）** | **应用商店分发**（App Store / Google Play / F-Droid / **Microsoft Store**）+ 官网安装包 + GitHub Releases + 包管理器（Repology）+ Docker/Compose/**Unraid/TrueNAS**；文档站 siyuan-en.b3log.org；**并有 Beta/Alpha 更新通道设置项**。⚠️ Docker 版有明确功能裁剪（不支持导出 PDF/HTML/Word、不支持导入 Markdown） | README 实测，安装矩阵与 Docker 限制逐条核对 |
| **B2 Logseq** | **明确支持** | 桌面安装包（Win/macOS/Linux）+ 移动端；官方站有下载与文档 | GitHub 描述实测；文档站结构未逐页核验 |
| **B3 Trilium** | **明确支持** | Win/macOS 二进制发行包（Releases）+ Linux 包管理器 + Flatpak（**尚未上架 FlatHub**）+ Docker（`triliumnext/trilium`）+ 仓库内含 `docker-compose.yml` 与 **`docker-compose.rootless.yml`**；**独立文档站 docs.triliumnotes.org，且应用内 F1 直达同源帮助**；文档可本地编辑（`pnpm edit-docs`） | README 实测。⚠️ 数据库引擎 README 未披露（历史上为 SQLite，此处标**未确认**） |

### 主线②：多场景「一键导入本地知识库」

| 项目 | 支持程度 | 实现方式 | 覆盖的灵墨对标场景 | 证据（实测） |
|---|---|---|---|---|
| **A2 Open WebUI** | **明确支持（范式 B 标杆，最贴合灵墨）** | ① 对话框内 **`#` 直接引用知识库**（无需预先绑定模型）；② 或在 `Workspace > Models > Edit` 把知识库**绑定到模型**；③ 知识库作用域可来自三处：模型上的知识、**对话所在文件夹的知识**、对话本身附加的 KB/Notes；④ **Notes 场景**：笔记可上传附件，附件「以检索上下文形式注入该笔记下每一条消息」，笔记本身可被 `+ (More) > Attach Notes` 或**从侧边栏直接拖拽进对话**做全文注入；⑤ Agentic 工具集（`query_knowledge_files` / `grep_knowledge_files` / `view_file` / `view_note` 等） | 写作 ✅、文案 ✅、笔记 ✅、**数据分析 ❌** | 文档原文实测：「Attach the knowledge base to a model in **Workspace > Models > Edit**, or **reference it in chat with `#`**」；Notes 文档实测「Non-image files attached to the note are **injected as retrieval context on every message**」 |
| **A3 Dify** | **明确支持（范式 A 标杆）** | 工作流中放置 **Knowledge Retrieval 节点** → 「Select Knowledge to Search」**可添加一个或多个已有知识库**（选择式 UI，即一键）→ 输出 `result` 变量 → 在 LLM 节点的 `Context` 里选中该变量即完成上下文注入；支持节点级 Rerank/Top K/Score Threshold 二次过滤 + **元数据过滤**（手动/自动）；Chatflow 默认开启 **Citation and Attributions 引用展示** | 写作/文案（通过自建 App）✅；数据分析 **部分**（需自行搭工作流，无原生表格分析场景） | 官方文档实测 `docs.dify.ai/.../knowledge-retrieval`，「Add one or more existing knowledge bases」「In **Context**, select the Knowledge Retrieval node's `result` variable」 |
| **A4 RAGFlow** | **明确支持** | 建 Chat 助手时「**specify your datasets**」直接勾选一个或多个 dataset；支持 Agent；**内置 code executor 沙箱（需 gVisor）**；表格类文件（CSV/XLSX/XLS）在支持的解析格式内 | 写作/文案 ✅；**数据分析 部分支持**（有代码沙箱 + 支持 CSV/XLSX 入库，但「知识库→表格分析」是否为一等公民场景**未确认**） | Quickstart 实测「Name your assistant and **specify your datasets**」；前置条件中 gVisor/sandbox 说明实测 |
| **A5 FastGPT** | **明确支持** | 工作流中的知识库检索模块，应用可绑定多个知识库（选择式）；4.14+ 起有插件市场 + MCP Server（3003 端口）+ **Agent Sandbox（3006 端口，含文件预览代理）** | 写作/文案 ✅；数据分析 **未确认** | Docker 部署文档实测（端口用途、沙箱/MCP 组件）；知识库绑定 UI 细节未逐页核验，标**部分未确认** |
| **A6 MaxKB** | **明确支持** | RAG Pipeline + Agentic Workflow 编排 + MCP 工具调用；应用关联知识库；原生支持文本/图片/音频/视频多模态输入输出 | 写作/文案 ✅；数据分析 **未确认** | README 特性列表实测；「一键关联」具体 UI 交互**未确认** |
| **A1 AnythingLLM** | **明确支持** | **Workspace 为知识边界单位**（每个 workspace 隔离文档/会话/Agent 配置），拖拽上传即自动分块向量化；`@agent` 指令启动 Agent 会话；支持 **自定义工具 / MCP / Agent Flows**；**完整 Developer API（Desktop 与 Docker 均 ✅）**，可把 AnythingLLM 当作后端被外部场景调用；答案带来源引用 | 写作/文案 ✅（通过 workspace 对话）；笔记 ❌（无笔记场景）；数据分析 **未确认**（`docs.anythingllm.com/agent/usage` 与 `/agent/defaults` 均 404，**内置技能清单未能核验，不做推测**） | `docs.anythingllm.com/agent/overview` 实测确认 `@agent` 指令、自定义工具/MCP/Agent Flows；Desktop/Docker 对照表确认 `Full developer API ✅✅`、`Third-party data connectors ✅✅` |
| **A7 kotaemon** | **部分支持** | 混合 RAG（全文＋向量＋Rerank）；**GraphRAG 索引管道**（NanoGraphRAG / LightRAG / MS GraphRAG）；**引用能力极强：浏览器内 PDF 查看器直接高亮引用并显示相关性分数，低相关时主动告警**；多模态解析器可选（Doclinq / PaddleOCR 本地开源方案） | 仅问答场景；写作/数据分析/笔记 ❌ | README 实测，Key Features 逐条核对 |
| **A8 Khoj** | **明确支持（跨场景分发范式）** | **通过官方 Obsidian 插件 / Emacs 插件把同一个知识库带进用户既有的笔记与写作环境**；理解 pdf / plaintext / markdown / org-mode / Notion 页面；支持自然语言 find 与 chat 两种消费方式 | 笔记 ✅、写作 ✅；数据分析 ❌ | 文档站首页实测，客户端与文件格式矩阵逐条核对 |
| **A9 GPT4All** | **部分支持** | **LocalDocs** 功能：把本地文件夹作为私有知识库与之对话（2023-07 起稳定，V3.0.0 改进了 LocalDocs 工作流）；LangChain / Weaviate 集成 | 仅问答场景 | README Release History 实测。⚠️ 项目近一年无推送，不建议作为主要参考 |
| **B1 SiYuan** | **部分支持** | 通过 **OpenAI API 实现 AI 写作与问答**；CLI `search` 命令**支持 `semantic` 语义查询类型**（还有 full-text / asset-content / SQL 四种）；内置 Tesseract OCR；仓库定位已改为「人与智能体协作的知识工作空间」。 **但「基于本地笔记的 RAG 流水线」与 MCP 支持在 README 中均未提及 → 未确认** | 笔记 ✅（本体即笔记）；写作 部分；数据分析 ❌ | README Features 与 CLI 命令表实测；RAG/MCP 未提及故标**未确认** |
| **B2 Logseq** | **不支持（本体）/ 依赖插件** | 本体无内置 RAG；靠插件生态；本地优先 Markdown/org 文件存储 | — | GitHub 描述实测；插件生态内 RAG 方案**未逐一核验** |
| **B3 Trilium** | **不支持** | README 未提及任何内置 AI 聊天 / LLM 对话 / 笔记 RAG 功能。仅在 Shoutouts 中致谢了 **LLM provider 图标（Lobe Icons）**，可能为扩展预留，但主页未列为功能。有 Scripting + REST API 可自建 | — | README 实测，Features/Scripting 章节逐条核对，确认无 AI 功能条目 |

---

## 3. 关键空白与差异化机会（实测确认）

| 场景 | 生态现状 | 灵墨机会 |
|---|---|---|
| 知识库 → 写作 / 文案 | **已被充分覆盖**（Open WebUI、Dify、AnythingLLM、Khoj 均可） | 无差异化，做到「不比别人差」即可，重点在交互摩擦更低 |
| 知识库 → 笔记 | **部分覆盖**（Open WebUI Notes 最完整；Khoj 靠 Obsidian 插件寄生在别人的笔记里） | **中等机会**：灵墨自带笔记 + 世界书 + 标签，可做到比 Open WebUI Notes 更强的双向流转 |
| 知识库 → **数据分析** | **明确空白**。已核实：Open WebUI 官方文档明确 `kb_exec` 只做 ls/cat/grep/find 文本读取，**「无法在 KB 文件上执行聚合、统计等代码分析」**，且该工具默认关闭（`ENABLE_KB_EXEC=True` 才启用）且标注为实验性。RAGFlow 虽有 gVisor 代码沙箱且支持 CSV/XLSX 入库，但「知识库→表格分析」是否一等公民**未确认** | **最大差异化机会**。灵墨已有 CSV/数据表 + 图表 + 规则化结论能力，若能做到「知识库里的数据表一键导入数据分析场景」，是全生态第一个 |
| 知识库 → **数据整理/清洗** | **明确空白**，未发现任何项目把知识库接入数据清洗场景 | **最大差异化机会（同上）** |

---

## 4. ⚠️ 风险警示：同赛道的失败样本（务必研读）

| 项目 | GitHub URL | Star | 语言 / 许可 | 状态 | 为何重要 |
|---|---|---|---|---|---|
| **reor** | https://github.com/reorproject/reor | 8,565 | JavaScript（**Electron**）/ AGPL-3.0 | **🔴 已归档**（最后推送 2025-05-13） | **形态与灵墨几乎完全同构**：「Private & local AI personal knowledge management app」= Electron + 本地 RAG + 笔记/写作一体。它在 8.5k Star 的关注度下仍然停更，是灵墨必须复盘的样本 |
| **Flowise** | https://github.com/FlowiseAI/Flowise | 55,398 | TypeScript / NOASSERTION | **🔴 已归档**（archived=true，最后推送 2026-08-13） | 5.5 万 Star 的可视化 AI 编排工具已归档，说明「纯编排」定位在被平台方（Dify）挤压 |
| **Verba** | https://github.com/weaviate/Verba | 7,711 | Python / BSD-3-Clause | **🔴 已归档** | 厂商附属 RAG UI（Weaviate 官方）也已停更 |
| **Quivr** | https://github.com/QuivrHQ/quivr | 39,453 | Python / NOASSERTION | 转型（现定位 "Opiniated RAG **for integrating GenAI in your apps**"，即从产品转为 SDK/库） | 3.9 万 Star 的 RAG 产品放弃产品形态转做库，说明纯 RAG 产品层难以为继 |
| **PrivateGPT** | https://github.com/zylon-ai/private-gpt | 57,490 | Python / Apache-2.0 | 转型（现定位 "Complete **API layer** for private AI applications"） | 与 Quivr 同样从产品转 API 层 |

**结论**：单靠「本地 RAG + 问答」这一价值主张无法长期存活（reor / Verba / Quivr / PrivateGPT 四个样本一致）。灵墨的护城河必须建立在**「知识库 × 多个生产力场景（尤其数据分析/整理）的深度耦合」**上，而不是知识库本身。

### 其他补充参考（不计入主要项目）

| 项目 | URL | Star | 语言 / 许可 | 参考点 |
|---|---|---|---|---|
| Onyx（原 Danswer） | https://github.com/onyx-dot-app/onyx | 31,887 | Python / NOASSERTION | 企业级连接器（Connector）体系 |
| Open Notebook | https://github.com/lfnovo/open-notebook | 38,079 | TypeScript / **MIT** | NotebookLM 开源实现：「同一组 sources 派生出笔记/播客/写作」的多产物范式，与灵墨「一个知识库喂多场景」思路高度一致，**建议重点研读** |
| AppFlowy | https://github.com/AppFlowy-IO/AppFlowy | 76,187 | Dart（Flutter）+ Rust / AGPL-3.0 | 本地优先多形态工作区（doc/wiki/表格） |
| AFFiNE | https://github.com/toeverything/AFFiNE | 72,107 | TypeScript + Rust / NOASSERTION（**许可证构成未确认**） | 本地优先 + doc/whiteboard/table 多场景同构 |
| LobeChat | https://github.com/lobehub/lobe-chat | 82,158 | TypeScript / NOASSERTION（**未确认**） | 知识库 + Electron 桌面端 + Agent 编排（细节**未确认**） |
| Obsidian Smart Connections | https://github.com/brianpetro/obsidian-smart-connections | 5,422 | JavaScript / NOASSERTION | **本地 embedding + 写作时侧栏推荐相关笔记/片段**，是「写作场景无感知注入知识库」的轻量范式 |
| Quartz | https://github.com/jackyzha0/quartz | 13,152 | TypeScript / **MIT** | Markdown → 站点，可作为知识库文档站自建方案 |

**对照用商业闭源产品**（不计入参考）：Obsidian 本体、Notion、NotebookLM、Cursor。

---

## 5. 对灵墨工作台的借鉴点（5 条）

### 借鉴点 1 —— 安装分发直接抄 AnythingLLM，并加上 FastGPT 的本土化补丁
- **抄 AnythingLLM**：文档站首页放**「Desktop vs Docker/Server 逐项功能差异对照表」**（含"是否支持一键安装"这一行）。这是降低用户决策成本最高效的一张表，灵墨可改造为「桌面版 vs 便携版」对照。
- **抄 AnythingLLM**：安装文档**按平台拆成独立页面**（macOS / Windows / Linux），外加独立的 System Requirements 页——而非一页塞满所有平台。
- **抄 Trilium**：**应用内 F1 直达与在线文档同源的帮助页**，并把文档源码放进仓库、支持本地编辑。这对「知识库要有完善说明文档」这一诉求是最优解——文档与产品同版本发布，不会漂移。
- **抄 FastGPT**：如果灵墨知识库需要拉取模型/嵌入模型等外部依赖，必须提供**国内镜像源**与**离线安装包**两条路（FastGPT、MaxKB、SiYuan 三家都专门为国内 pull 失败做了文档）。
- **抄 SiYuan**：分发渠道尽量覆盖 **Microsoft Store**（Windows 用户一键装 + 自动升级），并提供 Beta/Alpha 更新通道设置项。

### 借鉴点 2 —— 多场景导入用「Open WebUI 范式 B」而非「Dify 范式 A」
灵墨是本地优先的**个人**生产力应用，不是编排平台。Dify 的节点式（范式 A）对个人用户过重。建议：
- **核心交互抄 Open WebUI 的 `#` 引用**：在写作/文案/笔记/数据分析各场景的输入区，键入 `#` 即弹出本地知识库列表，选中即完成注入。这是「一键导入」的最低摩擦形态。
- **抄 Open WebUI 的三层知识作用域**：`场景默认知识库` + `所属文件夹/项目的知识库` + `本次会话临时附加`。这套分层能同时满足"每次都要用"和"这次临时用"两种需求，避免用户反复手动挂载。
- **抄 Open WebUI 的 Notes/Knowledge 双通道**：**全文注入（Notes，精确可控）** 与 **RAG 检索（Knowledge，可扩展）** 是两种不同机制，应在 UI 上明确区分并让用户自选。灵墨的「世界书」天然对应前者、知识库对应后者，这条区分可以直接落地。
- **抄 Dify 的一处**：注入后**默认展示引用与来源归属**（Citation and Attributions），并允许关闭。RAGFlow 与 kotaemon 也都把引用作为一等公民（kotaemon 更进一步：在内嵌 PDF 查看器里高亮引用并显示相关性分数，低相关时主动告警）——这是本地知识库建立信任的关键。

### 借鉴点 3 —— 把「知识库 → 数据分析 / 数据整理」做成灵墨的独占能力
这是本次调研最确定的空白（已用 Open WebUI 官方文档实证：其知识工具**明确不能对 KB 内文件执行代码做统计分析**）。建议：
- 知识库索引流水线应**区分「文档型」与「数据型」资产**：Markdown/PDF/DOCX 走向量检索；CSV/XLSX 走结构化登记（表名、列名、类型、行数、样例行）。
- 在数据分析场景，`#` 引用一个**数据型**知识库资产时，注入的不应是文本 chunk，而是**表结构 Schema + 样例行 + 本地文件句柄**，让分析引擎直接对原表计算——这样才能得出正确的聚合结论而非幻觉。
- 参考 **RAGFlow 的 code executor 沙箱（gVisor）** 与 **FastGPT 的 Agent Sandbox（含文件预览代理）** 的隔离思路，但灵墨是本地单机应用，可用更轻的进程级隔离。
- 参考 **Open Notebook**（MIT，38k ⭐）的「同一组 sources 派生多种产物」范式，把「一个知识库 → 写作稿 / 分析报告 / 笔记 / 文案」做成显式的产物矩阵。

### 借鉴点 4 —— 许可证红线（工程选型前必须过一遍）
- **可安全参考/借用代码**：AnythingLLM（**MIT**）、GPT4All（**MIT**）、RAGFlow（**Apache-2.0**）、kotaemon（**Apache-2.0**）、Open Notebook（**MIT**）、Quartz（**MIT**）。
- **⚠️ 仅可参考设计、不可借用代码**：SiYuan / Logseq / Trilium / AppFlowy / Khoj 均为 **AGPL-3.0**；MaxKB 为 **GPL-3.0**。传染性强，闭源或商业化场景下风险高。
- **⚠️ 需法务单独核验**：Dify、Open WebUI、FastGPT、Onyx、AFFiNE、LobeChat、Quivr 的 GitHub API 许可证字段均为 **NOASSERTION**（即自定义许可证，通常是 Apache-2.0/BSD-3 加商用或品牌限制条款）。**不要凭"它是开源的"就假设可自由使用**。
- **建议**：灵墨的知识库检索层与文档站直接对标 MIT 的 AnythingLLM，规避 AGPL 阵营。

### 借鉴点 5 —— 避免走上 reor 的老路：知识库不是产品，场景耦合才是
本次调研最强的负面信号：形态与灵墨几乎同构的 **reor（Electron + 本地 RAG + 笔记，8.5k ⭐）已于 2025-05 归档**；同时 Verba 归档、Quivr 与 PrivateGPT 双双从"产品"退回"库/API 层"。四个独立样本指向同一结论：
- **不要把「本地知识库 + 能问答」当作卖点**——这个价值主张已被 AnythingLLM（65k ⭐、MIT、桌面一键装、还免费）彻底商品化，任何新项目都无法在此维度竞争。
- 灵墨的真实护城河是**已有的六个场景（写作/数据分析/数据整理/文案/笔记/知识库）之间的数据流转**。知识库应被定位为**贯穿这六个场景的底层供给层**，而非第七个并列的功能模块。
- 落地建议：优先级上，**「知识库→数据分析/数据整理」的一键导入应排在「知识库→写作/文案」之前**（P0 vs P1）。因为后者是生态已解决的红海，前者是灵墨可以独占的空白。

---

## 6. 明确标注为「未确认」的信息（不做推测）

| 项 | 说明 |
|---|---|
| AnythingLLM 内置 Agent 技能完整清单（是否含图表生成 / SQL 连接器） | `docs.anythingllm.com/agent/usage` 与 `/agent/defaults` 两个路径实测均返回 **404**，未能核验，故不列举 |
| RAGFlow 主要语言构成 | GitHub API 主语言字段返回 **Go**（历史上以 Python 为主），语言占比变化未逐一核验 |
| Trilium 数据库引擎 | README 未披露（仅提"沿用现有数据库"），历史上为 SQLite，此处标未确认 |
| SiYuan 是否有基于本地笔记的 RAG 流水线 / MCP 支持 | README 未提及，仅确认有 OpenAI API 写作问答 + CLI semantic 搜索 |
| FastGPT / MaxKB「知识库一键关联到应用」的具体 UI 交互 | 特性存在已确认，交互细节未逐页核验 |
| RAGFlow「知识库 → 数据分析」是否为一等公民场景 | 已确认有代码沙箱且支持 CSV/XLSX 入库，但是否有面向表格分析的产品化场景未确认 |
| AFFiNE / LobeChat / Quivr / Onyx 的确切许可证条款 | API 返回 NOASSERTION，具体条款未逐条阅读 |
| Logseq 插件生态内的 RAG 方案 | 未逐一核验 |
| Dify / Open WebUI 等项目文档站的全量结构 | 仅核验了与本次两条主线直接相关的页面 |

---

**下一步选项**：
- （a）深入拆解 Open WebUI 的 `#` 引用与三层知识作用域的具体交互流程，产出灵墨的「一键导入」交互规格；或
- （b）针对「知识库→数据分析」空白，产出该场景的 PRD。
请指示优先级。
