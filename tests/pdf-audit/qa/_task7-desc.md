【状态】yan-qa 因 429 频率限制失败（配额 2026-09-29 16:34 UTC+8 重置），重置后重起 QA 席位。以下为完整接力信息。

## 待验范围（全部已完工冻结）
#2 压缩档位+加密闸门 / #3 Excel 方向 / #4 拆分批量 / #5 裁剪框选 / #6 页码预览 / #13 PDF 提取接通 OCR / #14 OCR 渲染进程探针（可复跑 `npm run probe:pdf-ocr` 作对照，探针结果主理人已复核：12/12、jsep wasm、命中 100%）

## 高价值断言（须独立复算，不得只复跑工程师脚本）
1. **结构压缩+加密源=损坏文件**：无保护 且 文本 0 字、页面全白（pdf-lib 无口令解不开，copyPages 搬密文又丢 /Encrypt）。主理人已用自造素材独立证实（lead-check-compress-guard.mjs 37/0）。
2. **图像化+加密源=可见但无保护**：内容非白像素与源同量级，但副本无任何口令。
3. **OCR 回路**：已知文本 PDF → 渲染成图 → OCR → markdown。node 无头 E2E 命中 **100%（20/20）**、置信度 95.9%、23/0；渲染进程真实路径（jsep wasm + 生产模型文件）探针实测**同样 100%（20/20）、置信度 96.0%**（`npm run probe:pdf-ocr`，12/12，主理人已复跑核对）。QA 须自造素材独立复算命中率。
4. **裁剪仍矢量**：MediaBox 不变 + 页面内容流逐字节不变（证明未栅格化）。
5. 两模式加密后果文案必须不同，structure 必须含「0 字」。

## 前任工程师关键接力
- `qa-fixtures/owner-only-r4.pdf` 被 ObjStm 加密，pdf-lib 读不出页树、会先抛错，**盖住「静默脱保护」这条风险路径** → 造素材须自己来（生产 encryptPdf + 图像主导页）。
- `test:pdf-ocr-extract` 的命中判定是「规范化后子串包含」，OCR 行内无空格。

## 必做的一项 UI 实测（headless 覆盖不到）
OCR 双后端疑虑已由 #14 探针消除（node 无头 = jsep 渲染进程，命中率一致）。**剩下的唯一缺口：新按钮的面板流未在真实 app 里点过。** 纯图像素材已现成：`tests/pdf-audit/work/image-only-sample.pdf`（3 页，无文字层，由 `npm run make:image-only-pdf` 生成，自检 4/4）。请在 app 里实测：
- 提取文字 → 选 `tests/pdf-audit/work/image-only-sample.pdf` → 应出现红色 Alert +「用 OCR 识别此扫描件」按钮 → 点击 → 逐页进度 → 产出 markdown（含 `## 第 N 页`）
- **有文本层的 PDF 不应出现该按钮**（走原路径，不强行 OCR）

## 已知事实（别去追）
- **matteWhite 结论更正（#14）**：pdfjs-dist 6.3.289 在 Chromium 与 node canvas 下**默认填充不透明白底**（透明像素 0）——早先「pdf.js 默认透明 → 黑图」的说法是错的；当时 OCR 0 行的真因是 node 侧 Image shim 未等原生异步 decode() 完成。matteWhite 的定位是**白底不变式防线**（不依赖上游默认值，旧版本/background 参数仍可能透明），不是缺陷修复。源码注释已按实测口径改写。别把这里当缺陷追。
- `test:pdf-security` = **95/0**（此前记的 135 是与 test-enhance-algo 的 135 记混；文件未被改动，素材齐全）
- 新脚本走 npm 入口：`test:pdf-guard` 78/0、`test:pdf-raster-levels` 23/0、`test:pdf-compress-levels` 33/0、`test:pdf-split-batch` 17/0、`test:pdf-crop-select` 22/0、`test:pdf-page-number` 24/0、`test:pdf-excel-orient` 8/0、`test:pdf-ocr-extract` 23/0、`probe:pdf-ocr` 12/12（直接裸跑需 `--experimental-loader=./tests/loader.mjs`，probe-ocr 除外——自带 run.mjs）
- IPC `pdf:pick-dir`/`pdf:exists` 三段式已核（index.d.ts 按**方法名**查：765、937-938 行；别 grep channel 字符串）
- 主理人已做 `tests/pdf-audit/lead-check-compress-guard.mjs` 37/0（自造加密素材）

## 回归基线（重派后必须逐项核对）
typecheck 双绿 / test-enhance-algo **167/0** / test-crypto-primitives 37/0 / test:pdf-security 95/0 / audit-functions 19/0 / test:pdf-guard 78/0 / test:pdf-raster-levels 23/0 / test:pdf-ocr-extract 23/0 / probe:pdf-ocr 12/12

## 边界
只写 tests/pdf-audit/qa/ 下自己的脚本；不改 src/、diag-*.mjs、verify-*.mjs、lead-check-*.mjs、probe-ocr/。发现源码缺陷不要自行修，回报主理人路由。