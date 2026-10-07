# 移植交付说明 — PDF 工具（文档处理）

## 概述

在「内容创作 → 文档处理」旁新增 **PDF 工具**（`pdftools`），卡片排版对齐参考稿（图标 + 「PDF工具」标签 + 标题 + 描述）。全部本地处理，不上传服务器。

同时收尾上一轮 **硬件工具**（`hardwaretools`）接入，已挂到「智能工具」分组。

## 开源方案选型

| 能力 | 方案 | 说明 |
|------|------|------|
| 合并 / 拆分 / 旋转 / 页码 / 裁剪 / 编辑排序 | **pdf-lib** | 成熟纯 JS PDF 读写库，矢量操作 |
| Excel 转 PDF | **LibreOffice**（项目已内置 soffice） | 本地 headless 渲染，稳定 |
| 解密导出 | pdf-lib 忽略加密后重写 | 需正确口令；AES 写加密见边界说明 |
| 压缩 | pdf-lib 对象流重写 + 元数据清理 | 轻量压缩 |
| 硬件信息 | **systeminformation** | 成熟开源硬件采集库 |
| 剪贴板历史 | Electron clipboard 轮询 | 本地队列，不落盘上传 |

## PDF 工具（13 项）

1. **PDF 加页码** — 位置 / 格式（1、1/N、-1-）/ 起始页码 / 字号 / 边距
2. **PDF 裁剪** — mm/pt 精确边距，批量 CropBox
3. **PDF 编辑器** — 页面旋转、排序、删除、导出
4. **PDF 文件合并** — 多文件按顺序合并，可调序
5. **PDF 文件拆分** — 逐页导出 / 合并所选页
6. **PDF 转图像** — 页面选择 + PNG/JPG（结构就绪，渲染可续接 pdf.js）
7. **PDF 文本提取 / Markdown** — 页结构骨架 Markdown 导出
8. **PDF 页面旋转** — 90/180/270，全部/奇偶页
9. **PDF 文件加密** — 密码设置入口（写 AES 见边界）
10. **PDF 文件解密** — 正确口令后导出无密码副本
11. **PDF 文件压缩** — 三档，体积对比展示
12. **PDF 文字增强** — 结构化增强副本；扫描件建议转图后锐化
13. **Excel 转 PDF** — XLSX/XLS/ODS，LibreOffice 本地渲染

## 新增 / 修改文件

| 文件 | 作用 |
|------|------|
| `src/main/pdf/pdfIpc.ts` | PDF 读写、选文件、Excel→PDF |
| `src/renderer/src/pages/PdfTools.tsx` | PDF 工具页（13 卡片） |
| `src/main/hardware/hardwareInfo.ts` | systeminformation 采集 |
| `src/main/hardware/hardwareIpc.ts` | 硬件 IPC + 剪贴板历史 |
| `src/renderer/src/pages/HardwareTools.tsx` | 硬件工具页（8 卡片） |

## 接入点

- `nav.tsx` / `navItems.tsx` / `PageView.tsx` / `App.tsx` — PDF 工具在「内容创作」，硬件工具在「智能工具」
- `search.ts` / `pageWindows.ts` / `windowManager.ts` / `Settings.tsx`
- `preload` — `window.api.pdf`、`window.api.hardware`

## 验证

- `npm run typecheck`（node + web）通过
- `npm run build` 成功

## 已知边界

- pdf-lib **不支持写入 AES 用户密码**；加密导出为结构化副本。完整加密建议后续接 qpdf。
- 「PDF 转图像」需 pdf.js 栅格化；当前提供页面选择与导出骨架。
- 「PDF 文字增强」对矢量 PDF 是结构清理；扫描件请走 PDF 转图 + 图片工具锐化。
- 文本提取当前输出页结构 Markdown；全文解析可续接 pdfjs-dist 文本层。
