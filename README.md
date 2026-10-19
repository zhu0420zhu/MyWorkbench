# 灵墨工作台

一体化本地工作台：**快捷工具 + 知识库 + 数据库 + 白板 + 自动化 + AI + OCR + 热点聚合**。

数据自主（文件化存储）、离线优先、深浅双主题、无边框窗口。

## 功能

| 页面 | 功能 |
|---|---|
| **自动工作台** | 快捷卡片（网址/命令，图标+颜色自定义）+ 自动化命令（一键运行/流式输出/停止/工作目录）+ **使用案例教程**（内置案例一键填入配置） |
| **知识库** | Markdown 笔记：搜索、编辑/预览切换、Ctrl+S 保存、标题自动提取、**导出 .md** |
| **便利贴** | 彩色便签（5 色）：新建/编辑/删除 · **置顶悬浮到桌面**（alwaysOnTop 小窗，编辑实时同步）· **任务日历**（按日展示/点击日期新建） |
| **数据整理** | 数据库（自定义字段：文本/数字/单选/日期/勾选 · 表格视图内联编辑 · 看板视图按单选分组）+ 可视化（ECharts 折线/柱状/饼图）· **多格式导入导出**（CSV / JSON / TSV / Excel，含表头/数值类型保留） |
| **白板** | 无限画布（tldraw：框选/画笔/便签/连线…），自动保存 |
| **文本工具** | 行处理（去重/重复统计/排序/反转/去空行/加行号）· 转换（大小写/反转字符）· 引号（**与符号添加联合使用**）· 编解码（Base64/URL/JSON 美化）· 正则替换 · 关键词高亮 · 差异对比 · 翻译（8 语言，MyMemory 免费 API）· **OCR 文本/表格识别 + 批量识别**；符号添加**多符号合并添加（输出与输入行数一致）**，支持 `%index%`/`%date%`/`%time%`/`%rand%` 效果标识 |
| **文件工具** | 磁盘信息（容量/使用率）· 目录占用分析 · 重复文件检测（哈希查重）· 目录监控（实时事件流）· 路径可**手动选择目录** |
| **多媒体（热点）** | **全网热点聚合**（微博/知乎/B站/抖音/头条/百度/贴吧/豆瓣 8 综合 + IT之家/少数派/36氪/虎嗅/爱范儿/极客公园/掘金/GitHub 8 科技平台，单源失效自动降级）· SimHash 同题去重 · 多源共识加权排序 · 自动分类 · **热点推送通知** · **多平台一键分发**（适配器框架 + 登录态持久化 + 发布队列/排程/退避重试 + AI 摘要改写；微博/知乎半自动/B站 wbi/掘金/公众号官方接口）· 事件点击**应用内浏览器**打开（webview 面板） |
| **AI 助手** | OpenAI 兼容 API（Ollama / OpenAI / 任意网关）：流式对话、对话时切换模型 · **对话记忆**（记忆开关自动记录、重启恢复、记忆导出/导入）· 新对话一键清空 |
| **设置** | 数据目录查看/自定义目录/一键导入导出、AI 模型配置（**服务预设**：Ollama/OpenAI/通义千问等自动填 endpoint）、**个性化**（主题色 + 默认页面）、存储格式说明、深浅主题 |

**全局**：`Ctrl+K` 跨模块搜索（↑↓ 选择、Enter 直达）；深浅双主题；无边框窗口 + 自定义标题栏。

## OCR 识别

文本工具页「OCR 识别」模式，支持**批量**识别（多图）：

- **文本识别**：选图（对话框）或拖拽图片（PNG / JPG / WebP）
  - 自研 PP-OCRv4 推理管线（onnxruntime-web WASM，纯本地、离线）：文本检测（DB）→ 方向分类 → 识别（CRNN+CTC）
  - 结果自动写入输出区，可继续用去重/引号等工具处理，或一键「存为笔记」
- **表格识别**：SLANet 表格结构识别（ch_ppstructure_mobile_v2_SLANet.onnx，WASM）
  - 结构识别（行列/单元格坐标）→ 单元格 PP-OCR 识别 → **Markdown 表格**输出（知识库预览完美渲染）

**资源与实现**：PP-OCR 模型（`paddle-ocr-onnx-models` npm 包）+ 表格模型（`resources/ch_ppstructure_mobile_v2_SLANet.onnx`）+ 字典（`resources/ppocr_keys_v1.txt`、`resources/table_structure_dict.txt`）+ wasm（`onnxruntime-web@1.16.3`，**wasm 二进制由主进程经 IPC 注入 `wasmBinary`**，vite 下需 `optimizeDeps.exclude: ['onnxruntime-web']`，见 `electron.vite.config.ts`）。

## 数据自主（文件化存储）

所有数据均为纯文本，默认位于 `%APPDATA%\lingmo-workbench\`（**可在设置页自定义目录**，如当前 `G:\新建文件夹 (2)`）：

```
shortcuts.json      工作台快捷方式
automations.json    自动化命令
tables.json         数据库表（字段 + 行）
notes/index.json    笔记元数据
notes/<id>.md       Markdown 正文
boards/boards.json  白板元数据
boards/<id>.json    白板画布快照
stickies.json       便利贴（含置顶状态）
ai-config.json      AI 模型配置
ai-memory.json      AI 对话记忆（开关 + 消息）
preferences.json    个性化（主题色/默认页面）
publish-queue.json  多平台发布任务队列
publish-gzh.json    公众号凭证（safeStorage 加密）
hot-notify.json     热点推送设置
hot-notify-state.json 热点推送快照（去重）
```

> 旧版（myworkbench）数据会在首次启动时自动迁移。

## AI 配置示例

| 服务 | endpoint | apiKey | model |
|---|---|---|---|
| Ollama（本地） | `http://127.0.0.1:11434/v1` | 留空 | 如 `llama3.1` |
| OpenAI | `https://api.openai.com/v1` | `sk-...` | 如 `gpt-4o` |

## 开发

```bash
npm install        # 首次安装依赖（Electron 二进制走 npmmirror 镜像）
npm run dev        # 启动开发模式（vite HMR + Electron 窗口）
npm run typecheck  # 类型检查（node + web）

# 打包 Windows 安装包（需设置镜像，否则 electron-builder 下载工具超时）：
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run build:win  # electron-vite build + electron-builder（nsis 安装包 + portable 便携版 → dist/）
```

> 说明：
> - 本机 PowerShell 执行策略禁止 .ps1 脚本，`npm` 命令请用 `npm.cmd`。
> - 白板（tldraw）的图标/翻译资源从 `cdn.tldraw.com` 加载，需要联网（CSP 已放行）。
> - 修改 JSON 文件后若 vite 报 "Unexpected token ﻿"，是写入了 BOM，用无 BOM UTF-8 重存。
> - OCR 的 onnxruntime-web 锁定 1.16.3（新版仅提供 threaded wasm，需跨域隔离，与本应用 CSP 冲突）；wasm 经 IPC 注入避免 vite 静态资源问题。

## 目录结构

```
src/
├─ main/            # Electron 主进程（窗口 + 全部 IPC + 存储层）
│  ├─ index.ts      #   窗口 + IPC 注册 + 旧数据迁移 + userData 固定
│  ├─ shortcuts.ts  ├─ notes.ts  ├─ automations.ts  ├─ tables.ts
│  ├─ boards.ts     ├─ stickies.ts  ├─ stickyWindows.ts  ├─ ocr.ts
│  ├─ aiMemory.ts   ├─ prefs.ts  ├─ translate.ts  ├─ exportIpc.ts
│  ├─ search.ts     ├─ ai.ts  └─ data.ts
│  ├─ hot.ts / hotDedup.ts / hotNotifier.ts   # 热点聚合 + 推送
│  ├─ tools/                        # 文件工具集（磁盘/去重/监控）
│  ├─ publish/                      # 多平台发布（适配器/队列/登录态/AI 整合）
│  └─ toolsIpc.ts / publishIpc.ts
├─ preload/         # contextBridge 安全桥接（window.api）
├─ shared/          # 共享类型 + uuid
└─ renderer/
   └─ src/
      ├─ theme/     #   深浅双主题
      ├─ nav.tsx    #   跨页导航 Context（10 项菜单 + 附加目标）
      ├─ pages/     #   自动工作台/知识库/便利贴/数据整理/白板/文本工具/文件工具/多媒体/热点/AI助手/设置
      ├─ utils/     #   textTools.ts（文本处理）+ ppocr.ts（OCR 管线）+ category.ts（热点分类）+ ioFormats.ts（导入导出）
      ├─ components/#   ShortcutCard / ShortcutModal / SearchModal / TitleBar
      └─ App.tsx    #   侧边导航 + Ctrl+K + 无边框标题栏
```

## 路线图

- [x] 骨架 + 深浅主题 + 无边框窗口 + Ctrl+K 搜索
- [x] 快捷卡片 · Markdown 笔记 · 自动化 · 数据库（表格/看板）· 白板
- [x] 文本工具（去重/高亮/引号/diff/符号添加）· OCR（PP-OCRv4 + SLANet 表格）
- [x] AI 流式对话 + 对话记忆 · 数据备份 · 个性化
- [x] 文件工具（磁盘/目录/重复/监控）· 目录手动选择
- [x] 热点聚合 + 推送通知 + 多平台一键分发
- [x] 便利贴（置顶悬浮 + 日历）· 模块合并（自动工作台 / 数据整理）· 多格式导入导出
- [x] 打包 Windows 安装包（nsis + portable）
- [ ] CSDN 适配器 · 更多发布平台 · 应用商店分发

## 许可证

本项目采用 **Apache License 2.0** 授权，全文见 [LICENSE](LICENSE)。

Copyright 2026 zhu0420zhu

Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at <http://www.apache.org/licenses/LICENSE-2.0>

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.

### 第三方组件

仓库中包含的第三方组件（如 `tests/pdf-audit/pylibs/` 下的 Pillow、lxml、pikepdf 等）遵循其各自许可证，详见对应目录下的 `LICENSE` 文件；Apache-2.0 不改变这些组件原有的授权条款。
