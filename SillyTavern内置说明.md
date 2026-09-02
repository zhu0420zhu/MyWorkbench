# SillyTavern 内置「写作」页 — 交付说明

**日期**：2026-08-28 ｜ **范围**：灵墨工作台 v0.1.0（Electron 43 + React 19）

## 做了什么

将真实的 SillyTavern（release 1.18.0，MIT 开源 AI 聊天前端）**内置到「写作」页**，并把它的 UI 融合进现有界面：

- 写作页顶部新增第三个模式「**SillyTavern**」，进入后自动启动本地服务并以 **iframe 嵌入**，页面结构沿用灵墨外框（标题栏/状态标签/停止按钮），内部是 SillyTavern 的完整界面（角色卡、世界书、预设等）。
- SillyTavern 通过本应用自带的 **OpenAI 兼容代理桥**（`127.0.0.1:18788`）出对话，**直接复用「设置 → AI」里已配置的 endpoint/apiKey/model**，无需在 SillyTavern 内二次填写。
- 独立窗口、进程隔离：SillyTavern 以子进程运行（Electron 二进制充当 Node，`ELECTRON_RUN_AS_NODE=1`），崩溃不影响主应用；应用退出自动清理。

## 关键实现

| 模块 | 说明 |
|---|---|
| `src/main/sillytavern/sillytavernHost.ts` | 生命周期：按需启动/停止 SillyTavern 子进程、预置设置、健康检查 |
| `src/main/sillytavern/openaiProxy.ts` | OpenAI 兼容代理：`/chat/completions` → 本应用 AI 配置，SSE 流式透传 |
| `src/main/sillytavern/sillytavernIpc.ts` | IPC：start / stop / status / available / open-external |
| `src/renderer/src/components/SillyTavernPanel.tsx` | 融合面板：自动启动 + iframe + 状态提示 + 浏览器打开 |
| `vendor/SillyTavern` | 内置的 SillyTavern 本体（含依赖与预编译前端 lib） |

## 验证结果

- 全链路冒烟测试通过：SillyTavern 启动 ~5s → 对话请求 → 代理 → LLM → SSE 流式回传 200。
- `ELECTRON_RUN_AS_NODE` 生产级启动路径单独验证通过（端口正常监听）。
- 类型检查（node/web）与 electron-vite 构建全部通过。

## 对 vendor 的三个必要补丁

1. **`webpack.config.js`**：`getWebpackCacheVersion` 的 `shake256` → `sha256`（Electron 内置 Node 不支持 shake256，否则启动即崩）。
2. **`src/server-main.js`**：helmet 加 `frameguard: false`（受 `ST_ALLOW_EMBED=1` 控制，允许 iframe 嵌入）；`preSetupTasks` 在 `ST_SKIP_WEBPACK=1` 时用预编译 `prebuilt/lib.js` 跳过 41s 的 webpack 编译。
3. 渲染页 CSP 增加 `frame-src http://127.0.0.1:* http://localhost:*`。

## 打包产物（dist/）

- **`灵墨工作台 Setup 0.1.0.exe`** — NSIS 安装版（约 376MB，含 SillyTavern 全部依赖）
- **`灵墨工作台 0.1.0.exe`** — 便携版（约 376MB）
- `灵墨工作台 Setup 0.1.0.exe.blockmap` — 增量更新块映射

> 体积说明：安装包变大是因为内置了完整的 SillyTavern（约 436MB vendor，其中 node_modules 374MB）。这是「真实内置」方案的固有成本。

## 使用方式

1. 安装/运行新包后，进入「写作」页 → 顶部切换到「**SillyTavern**」。
2. 若「设置 → AI」已配置模型，SillyTavern 会自动通过代理出对话；未配置时面板会提示先去设置。
3. 停止按钮可随时关闭本地服务；「在浏览器打开」可弹出独立窗口使用。

## 备注

- SillyTavern 数据（角色卡、聊天记录、设置）保存在 `userData/sillytavern-data/`，与应用数据同目录。
- 首次启动会写入默认设置并 seed 内容（几秒），随后启动走预编译产物，均无 40s+ 编译等待。
