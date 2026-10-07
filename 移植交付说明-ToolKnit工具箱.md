# 移植交付说明 · ToolKnit 功能对标（工具箱）

**日期**：2026-09-28  
**来源**：[ZihangDong/toolknit-desktop](https://github.com/ZihangDong/toolknit-desktop)（Apache-2.0）· [ZihangDong/toolknit](https://github.com/ZihangDong/toolknit)（MIT，网页版 92 工具索引）  
**目标**：把 ToolKnit 桌面端 68 项工具中，适合灵墨工作台「本地优先」定位、可在 Electron 渲染进程纯本地完成的能力移植进来。

---

## 1. 对照结论

| ToolKnit 分类 | 项数 | 灵墨原状 | 本次动作 |
|---|---|---|---|
| PDF 文档 | 13 | 文档处理有阅读/Word | **二期**（pdf-lib / 预览） |
| PPT 演示 | 7 | 无 | **二期** |
| 图像 | 7 | 格式转换弱 | **本期补齐** 裁剪/压缩/WebP-PNG/图标/拼接 |
| 音频 / 视频 | 7 | 无 | **二期**（FFmpeg 运行时） |
| 文本与转写 | 5 | 文本工具已很强 | 保留，不重复移植 |
| 计算器 | 5 | 无 | **本期补齐** |
| 创意 | 3 | 无 | **本期补齐** |
| 清理 | 2 | 文件工具已有磁盘清理/重复/整理 | 保留 |
| AI 工作台 | 5 | 写作/智能体/翻译已有 | 保留 |
| 硬件与系统 | 8 | 有磁盘信息 | **二期**（systeminfo / 剪贴板历史） |
| 开发者 | 6 | Base64/URL/JSON 在文本工具 | **本期补齐** UUID/JWT/Hash |

---

## 2. 本期交付（工具箱页）

新页面 **智能工具 → 工具箱**（`src/renderer/src/pages/Toolbox.tsx` + `utils/toolbox.ts`）：

### 开发者
- UUID v4 批量生成（1–200）
- JWT 查看器（header / payload / alg / iat / exp 本地解析）
- Hash：MD5（兼容）/ SHA-1 / SHA-256 / SHA-384 / SHA-512（Web Crypto）
- HMAC（SHA 系列）
- 密码生成器（长度 / 字符集 / 排除易混字符）

### 计算器
- Unix 时间戳 ⇄ 本地时间（自动识别秒/毫秒）
- 房贷（等额本息 / 等额本金）
- 利息（单利 / 年复利 / 月复利）
- BMI / 体脂率（BMI 估算 + 美军公式占位）

### 创意
- 颜色空间联动：HEX / RGB / HSL / HSV / CMYK + 相对亮度 + 文字对比建议
- 图片主色提取（Canvas 量化）
- 打字测试（WPM / 正确率 / 进度）

### 图像（Canvas 本地）
- 裁剪导出 PNG
- JPEG 压缩（质量 + 最长边缩放）
- 转 WebP / PNG
- 多尺寸图标（32 / 128 / 256）
- 长图拼接（横/纵 + 间距）

全部 **本地计算，不上传文件**；密码与 JWT 不写持久历史。

---

## 3. 菜单与检索对齐

- `nav.tsx` / `navItems.tsx` / `PageView.tsx` / `App.tsx` 菜单分组「智能工具」
- 设置 → 启动默认页面可选「工具箱」
- 命令面板（Ctrl+K）可搜：toolbox / uuid / jwt / hash / 房贷 / 配色 / 裁剪 等
- 独立窗口标题「工具箱」（pageWindows）

---

## 4. 验证

- `npm run typecheck:node` / `typecheck:web` 双绿
- `npm run build`（electron-vite）绿
- 功能自检：UUID/JWT/Hash/密码/时间戳/房贷/颜色/裁剪 为纯函数或 Canvas，无主进程改动

---

## 5. 二期建议（未做）

1. **PDF 套件**：合并/拆分/页码/旋转/加密/解密/压缩（建议 `pdf-lib` + `pdfjs-dist`）
2. **PPT**：转 PDF/图片、大纲（接现有 AI 路由）
3. **音视频**：检测本机 FFmpeg，做格式转换/截帧/GIF（与 ToolKnit 依赖复用思路一致）
4. **系统硬件**：主进程 `systeminfo` / WMI 只读摘要；剪贴板历史（Electron clipboard + 本地加密）
5. **Markdown 编辑器**（GFM/Mermaid）：可挂在文档处理旁

---

## 6. 许可说明

ToolKnit Desktop 为 Apache-2.0，网页索引为 MIT。本期为 **功能对标与原创实现**（未直接拷贝其源码文件），算法与交互按灵墨技术栈（React 19 + antd 5 + Canvas/Web Crypto）重写，避免许可与风格耦合。
