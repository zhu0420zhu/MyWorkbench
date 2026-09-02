# 灵墨工作台 · 增量架构设计 + 任务分解（2026-09-01）

> 架构师：高见远。输入：`lingmo-enhance-prd-2026-09-01.md` + 主理人六项裁决。
> 已核实代码现状：tablesCore.ts / tables.ts / Analytics.tsx / DataLab.tsx / stickies.ts / stickyPanel.ts / StickyPanelWindow.tsx / Stickies.tsx / parseClient·parseWorker / main/index.ts / preload 双文件。
> 本文只描述**增量**，不重复存量设计。工程师按「任务列表」顺序执行即可。

---

## 〇、核实结论（设计依据）

| # | 事实 | 来源 | 对设计的影响 |
|---|------|------|--------------|
| F1 | `command:run` 参数是**纯字符串**：`ipcMain.handle('command:run', (_e, command: string) => spawn(command, {shell:true, detached:true}))`，返回 `pid \| null`；preload 已暴露 `window.api.runCommand(command)` | main/index.ts:559、preload/index.ts:779 | 裁决 4 落地：**不自造 `{kind,payload}` 第二套格式**，StickyNote 直接加可选 `command?: string`，执行复用 `runCommand` |
| F2 | rows 表结构 `(table_id, row_id, ord, data)`，data 为每行 JSON 文本；已有 200 行/批多值 INSERT + 事务 + ROLLBACK（writeTableRows） | tablesCore.ts:64-166 | 聚合可走 SQL `json_extract`；导入单事务直接复用 writeTableRows，失败回滚已天然满足 AC2.3 |
| F3 | Analytics 表模式现状：`tables.get(id)` 整表过 IPC → 渲染层内存聚合（useMemo）→ ECharts；无结论区、无导出 | Analytics.tsx:74-91,185-224 | 需求 3 改为聚合 IPC 通道；需求 1 在同一数据流上加结论/摘要/导出 |
| F4 | DataLab 导入现状：Worker 解析 → `tables.create(name)`（创建空表，第 1 次写盘）→ `tables.update(full)`（整表再传再写，第 2 次） | DataLab.tsx:161-191 | 双次往返确认存在，合并为单次 `tables:import` |
| F5 | `tables:list` 只返回 TableMeta（含 updatedAt）；`updateCell` 毫秒级且 touchTable 刷新 updatedAt | tablesCore.ts:95-99,337-358 | 渲染层缓存按 updatedAt 失效可行 |
| F6 | 导出通道 `exportText(defaultName, content)` / `exportBuffer(defaultName, data)` 已有（内部即 dialog 另存为） | preload/index.ts:592-594 | 报告导出零新 IPC |
| F7 | StickyNote 模型：{id,title,content,color,pinned,date?,createdAt,updatedAt}；编辑入口在 Stickies.tsx 的 Modal 表单（title/content/date/color） | shared/types.ts:306-318、Stickies.tsx:249-262 | `command?` 加进模型 + 表单加一个 Input 即可，stickies.ts 存储层透传零改动 |
| F8 | 悬浮面板双态机制健在：先广播形态→渲染层换 UI（30ms 错峰）→窗口尺寸动画（280ms 后设 minSize）；双态 bounds 各自记忆 | stickyPanel.ts:18-37 | P0-4.1 只做保真回归打磨，不动机制 |

---

## 一、增量设计（按四项需求）

### 需求 1：分析深度增强 + 结果导出（P0：结论区 + 导出；P1：直方图）

**分析结论纯规则化（裁决 1）**：新增纯逻辑模块 `src/renderer/src/utils/analysisCore.ts`（不依赖 electron/react/echarts，可无头直测）：

```ts
/** 列统计摘要（数值列） */
interface ColumnStats {
  column: string; count: number; missing: number; missingRate: number
  min: number; max: number; mean: number; median: number; std: number
}
function computeStats(rows: Array<Record<string, string|number>>, col: string): ColumnStats | null

/** 规则化结论条目：kind 用于渲染着色与导出分组 */
interface ConclusionItem { kind: 'overview'|'top'|'extreme'|'trend'|'missing'; text: string }
function buildConclusions(input: {
  totalRows: number; matchedRows: number
  chartData: Array<{ name: string; value: number }>
  aggregate: 'raw'|'sum'|'avg'|'count'
  xCol: string; yCol: string | null
  catLimit: number          // 供报告注明截断
}): ConclusionItem[]
// 规则集（P0 固定）：
//  overview：总行数 / 参与聚合行数（含因 Y 非数值被剔除的行数）
//  top：Top-3 类目及占比（基于 chartData，注明「已按 Top-N 截断」当截断发生）
//  extreme：最大/最小值所在类目
//  trend：折线数据首尾比较 + 简单线性斜率符号 → 「整体上升/下降/基本持平」
//  missing：任一数值列缺失率 > 5% 时提示
```

性能：单遍数值统计 + Map 聚合，20 万行实测量级为几十 ms（≪500ms），P0 在主线程 useMemo 即可，不冻结；若 bench 超标再下沉 Worker（见风险 R4）。

**导出（裁决 6）**：新增 `src/renderer/src/utils/analysisReport.ts`：`buildMarkdownReport({...}): string`（标题 + 统计摘要表 + 结论区 + 聚合明细表，截断时注明）。Analytics 加「导出」下拉：① PNG = `echarts.getDataURL()` → `exportBuffer`；② 聚合 CSV = chartData 拼文本 → `exportText`；③ Markdown 报告 → `exportText`。三者各自另存为对话框，P0 不打包 zip（需引依赖，留 P2）。

**直方图（P1-1.3）**：analysisCore 增 `histogram(values: number[], bins: number): Array<{lo,hi,count}>`，Analytics 图表类型加「分布」，分箱 5~20 可调。

**涉及文件**：新增 `src/renderer/src/utils/analysisCore.ts`、`src/renderer/src/utils/analysisReport.ts`、`tests/analysisCore.test.ts`；修改 `Analytics.tsx`。

### 需求 2：导入单次 IPC + 单事务落库（P0）

**新 IPC `tables:import`**（裁决 3：载荷不分批，>50 万行分批留 P2）：

```
渲染层                          主进程
──────                          ──────
Worker 解析（不变）
  │ TextImportOk.table
  ▼
本地进度：解析中 → 「写入中…」   tables:import(input: TableImportInput)
  await tables.import(...)  ──▶  tablesCore.importTable(root, input)
                                  ① 随机生成 id/createdAt，updatedAt = now
                                  ② writeTableRows（现有）：BEGIN → upsertTable →
                                     deleteRows → 200 行/批 INSERT → COMMIT
                                     （任何一步抛错 → ROLLBACK，无半张脏表）
                                  ③ 返回 { id, metas: TableMeta[] }
setActive(本地已持有的 full 表) ◀── 一次 IPC 一次事务完成
setTables(metas)；不回读整表
```

- 渲染层「写入中→完成」两阶段进度用**本地状态**即可满足 AC2.3 的确定性提示（解析在 Worker、写入是一次 await，粒度天然两级）；`webContents.send` 事件通道留给 P1-2.3 后台化导入使用。
- DataLab 现有 `create→update` 调用点（DataLab.tsx:174-177）删除，替换为单次 `tables.import`；`tables:create/update` IPC 保留（新建空表、结构变更仍用）。
- AC2.2 的 ≥30% 提速来源：省一次整表结构化克隆 + 一次 IPC 往返 + 一次 create 写盘；基准用现有 `tests/bench-*.ts` 范式新增导入基准前后对比。

**涉及文件**：`tablesCore.ts`（+importTable）、`tables.ts`（+importTable 薄包装）、`main/index.ts`（+`tables:import` 注册）、preload 双文件、`DataLab.tsx`、`shared/types.ts`（+TableImportInput）、新增 `tests/bench-import.ts`。

### 需求 3：跨模块聚合 IPC（P0，裁决 2：SQL 优先）

**新 IPC `tables:aggregate`**：

```ts
// shared/types.ts 增量
type AggregateKind = 'raw' | 'sum' | 'avg' | 'count'   // 与现有内联字面量对齐
interface AggregateRequest {
  tableId: string
  xFieldId: string            // 传 fieldId（非列名），字段可重名
  yFieldId?: string | null
  agg: AggregateKind
  topN?: number               // 默认 200，SQL LIMIT 用
  sampleRows?: number         // raw 模式采样行数，默认 1000（PREVIEW_MAX 同级）
}
interface AggregateGroup { name: string; value: number }
interface AggregateResult {
  tableId: string; updatedAt: number      // 供缓存失效
  totalRows: number; matchedRows: number  // matched = 参与聚合行数（结论区用）
  groups: AggregateGroup[]                // 聚合结果（raw 模式 = 按行序前 N 行）
}
```

**主进程实现路线（tablesCore.ts 新增 `aggregateTable`，纯逻辑可无头测）**：
- **sum/avg/count（默认路线）**：单条 SQL 完成，只回传聚合结果：
  ```sql
  SELECT json_extract(data, '$."xId"')            AS k,
         COUNT(*)                                 AS cnt,
         SUM(CASE WHEN json_extract(data,'$."yId"') GLOB '-?[0-9]*(.[0-9]*)?'
                  THEN CAST(json_extract(data,'$."yId"') AS REAL) END) AS s
  FROM rows WHERE table_id = ?
  GROUP BY k
  ORDER BY s/cnt DESC   -- 按聚合语义排序
  LIMIT ?               -- topN
  ```
  数值判定用 `GLOB` 过滤（非数值不进 SUM/CASE），avg = s/cnt 在 Node 侧算，避免 SQL 重复扫描。count 不依赖 yFieldId。
- **raw**：`SELECT data FROM rows WHERE table_id=? ORDER BY ord LIMIT ?` → Node 侧取 x/y 组装。
- **内存归并兜底**：`aggregateInMemory(root, req)`——group_concat 整表取回主进程内存归并（复用 getRowsPacked）。**切换策略**：P0 以行数为开关（> 30 万行走内存归并，因 json_extract 逐行解析成本在大表上线性劣化；30 万行内 SQL 路线更省传输）；`tests/bench-aggregate.ts` 以 10 万行/30 万行两档实测，若 SQL 路线在 10 万行 > 800ms 则下调阈值。两路线结果对拍一致性进测试。

**渲染层（Analytics.tsx 表模式改造）**：
- 表模式不再 `tables.get(id)` 整表加载；选中表 → `tables.aggregate(req)` → chartData 直接用 `result.groups`，`matchedRows/totalRows` 喂结论区。CSV 模式数据流不变（已有 Worker 预解析）。
- 预览表：raw 模式 `groups` 即采样行（≤1000），沿用 PREVIEW_MAX 渲染上限。
- **缓存（P0-3.2）**：Analytics 内 `Map<tableId, { updatedAt: number; result: AggregateResult }>`；换聚合列/方式时若命中且 `tables.list()` 返回的该表 updatedAt 未变则复用，否则重查。DataLab 编辑（updateCell/update 均 touchTable）后 updatedAt 必变，缓存自然失效，满足 AC3.3。字段列表（fields）单独小缓存：表模式需 fields 渲染下拉，`tables.get` 仍会拉整表——新增轻量做法：AggregateResult 附带不可行，改为在 `tables:aggregate` 之外复用现有 `tables:list`（无字段）+ **首次选中表时仍 `tables:get` 一次取 fields（只取 fields，行数据用后即弃，不做状态保留）**，之后换聚合列不再回读。此项开销一次性、可接受（备选：主进程加 `tables:fields` 轻量 IPC，若 bench 显示 fields 解析占大头再加，标注 P1 可选任务）。

**涉及文件**：`tablesCore.ts`（+aggregateTable/aggregateInMemory）、`tables.ts`、`main/index.ts`（+`tables:aggregate`）、preload 双文件、`shared/types.ts`、`Analytics.tsx`、新增 `tests/bench-aggregate.ts`、`tests/tablesAggregate.test.ts`。

### 需求 4：便利贴打开程序闭环（P0，裁决 4/5）

- **数据模型（裁决 4 → 复用 F1 约定）**：`StickyNote` 增 `command?: string`（纯字符串命令，与 `command:run` 现有格式一致）。stickies.ts 存储透传，零改动；旧数据无字段 → 按钮不显示，向后兼容。
- **编辑入口**：Stickies.tsx 编辑 Modal 增「打开程序（可选）」Input（placeholder 给示例如 `code %USERPROFILE%` 或 `https://...`）；卡片展开态右下角显示「打开程序」按钮（仅 command 非空时渲染）。
- **执行**：`window.api.runCommand(note.command)`；返回 null / 抛错 → `message.error('启动失败：请检查命令是否有效')`；成功可 toast pid。安全边界维持 PRD：仅执行用户本人在便签中填写的命令。
- **悬浮面板（裁决 5）**：范围锁定 stickyPanel.ts + StickyPanelWindow.tsx；P0-4.1 为保真回归打磨（动画时序常量、双态 bounds 记忆、最小尺寸顶回回归），不重构多贴架构、不动 stickyWindows.ts。Stickies.tsx 是面板展开态与主窗口共用组件，command 功能天然两处同时生效。

**涉及文件**：`shared/types.ts`（StickyNote+command）、`Stickies.tsx`（表单+按钮）、`stickyPanel.ts` / `StickyPanelWindow.tsx`（回归打磨）、新增 `tests/stickyCommand.test.ts`（可选，纯校验函数）。

---

## 二、IPC 契约增量汇总（preload 双文件硬约束）

| IPC | preload（index.ts 实现 + index.d.ts 声明，双侧同步） | main/index.ts 注册 |
|-----|------|------|
| `tables:import` | `import: (input: TableImportInput) => Promise<{ id: string; metas: TableMeta[] }>` | `ipcMain.handle('tables:import', (_e, input) => importTable(input))` |
| `tables:aggregate` | `aggregate: (req: AggregateRequest) => Promise<AggregateResult>` | `ipcMain.handle('tables:aggregate', (_e, req) => aggregateTable(req))` |

零新增的复用：`runCommand`（便利贴）、`exportText/exportBuffer`（报告导出）、`stickies:*` 全套。类型全部入 `src/shared/types.ts`。

---

## 三、有序任务列表（P0 → P1，粒度到文件/模块）

| # | 任务 | 涉及文件 | 依赖 | 优先级 |
|---|------|----------|------|--------|
| T1 | 共享类型增量：AggregateKind/AggregateRequest/AggregateResult/TableImportInput/ConclusionItem/ColumnStats；StickyNote +command? | shared/types.ts | 无 | P0 |
| T2 | 基准先行：tables:aggregate 与 tables:import 基准脚本（10 万行 CSV 生成 + 计时） | 新增 tests/bench-aggregate.ts、tests/bench-import.ts | T1 | P0 |
| T3 | tablesCore.ts：importTable（单事务，复用 writeTableRows） | src/main/tablesCore.ts | T1 | P0 |
| T4 | tablesCore.ts：aggregateTable（SQL json_extract 路线 + aggregateInMemory 兜底 + 行数开关） | src/main/tablesCore.ts | T1 | P0 |
| T5 | tables.ts 薄包装 + main/index.ts 注册 `tables:import`、`tables:aggregate` | src/main/tables.ts、src/main/index.ts | T3,T4 | P0 |
| T6 | preload 双文件同步：tables.import / tables.aggregate | src/preload/index.ts、src/preload/index.d.ts | T5 | P0 |
| T7 | tablesCore 无头测试（importTable 原子性/失败回滚、聚合两路线对拍） | 新增 tests/tablesImport.test.ts、tests/tablesAggregate.test.ts | T3,T4 | P0 |
| T8 | DataLab 导入链路改造：删除 create→update，单次 tables.import；「解析中→写入中→完成/失败」两阶段提示；失败提示 + 不回读整表 | src/renderer/src/pages/DataLab.tsx | T6 | P0 |
| T9 | analysisCore.ts：computeStats + buildConclusions（规则集固定）+ 无头测试 | 新增 src/renderer/src/utils/analysisCore.ts、tests/analysisCore.test.ts | T1 | P0 |
| T10 | Analytics.tsx 表模式改造：走 tables:aggregate，本地缓存按 updatedAt 失效；fields 一次性获取 | src/renderer/src/pages/Analytics.tsx | T6 | P0 |
| T11 | Analytics.tsx 结论区 + 统计摘要展示（接 T9，CSV/表两模式通用） | src/renderer/src/pages/Analytics.tsx | T9,T10 | P0 |
| T12 | 导出：analysisReport.ts（Markdown 组装）+ Analytics 导出菜单（PNG/CSV/MD 三选） | 新增 src/renderer/src/utils/analysisReport.ts、Analytics.tsx | T11 | P0 |
| T13 | StickyNote command：Stickies.tsx 表单字段 + 卡片「打开程序」按钮 + runCommand 失败提示 | src/renderer/src/pages/Stickies.tsx | T1 | P0 |
| T14 | 悬浮面板保真回归打磨：展开/收起动画时序、双态 bounds 记忆、最小尺寸回归（手工验证清单） | src/main/stickyPanel.ts、src/renderer/src/components/StickyPanelWindow.tsx | 无 | P0 |
| T15 | 收口：typecheck 双绿（node+web）→ 既有测试回归 → build → bench 前后对比记录 | — | T7~T13 | P0 |
| T16 | P1-1.3 直方图：analysisCore.histogram（分箱 5~20 可调）+ Analytics「分布」视图 | analysisCore.ts、Analytics.tsx | T9 | P1 |
| T17 | P1-2.3 后台化导入：主进程 webContents.send 进度事件通道，导入中可继续其他操作 | tablesCore.ts、tables.ts、preload 双文件、DataLab.tsx | T8 | P1 |
| T18 | P1-3.3 大表分页/采样通用 IPC（tables:page），供更多消费方复用 | tablesCore.ts 等全套契约 | T4 | P1 |

依赖主链：T1 → T2/T3/T4 → T5 → T6 → {T8, T10}；T1 → T9 → T11 → T12。T13、T14 独立可并行。

---

## 四、共享知识（跨文件约定，工程师必须遵守）

1. **command 字段 schema**：`StickyNote.command?: string` —— 与 `command:run` 现有纯字符串约定一致，**禁止**再引入 `{kind,payload}` 结构。展示名 = 从 command 截取首个 token 的文件名。
2. **聚合结果类型**：一律 `AggregateGroup { name, value }`（与现有 chartData 元素同形），渲染层零转换；结论区输入直接吃 chartData。
3. **结论条目格式**：`ConclusionItem { kind, text }`，kind 枚举固定 5 种；渲染按 kind 着色，Markdown 导出按 kind 分组标题。
4. **聚合 IPC 传 fieldId 不传列名**（字段可重名）；渲染层负责 fields.name ↔ fieldId 映射。
5. **preload 双文件手写同步**为硬约束：改 index.ts 必须同 commit 改 index.d.ts，类型入 shared/types.ts，否则 typecheck 不过。
6. **导入失败原子性**：任何落库错误由 writeTableRows 的 ROLLBACK 保证，渲染层只负责提示，不做补偿性清理。
7. **基准先行**：T2 的 bench 在实现前先跑出「现状基线」数字，T15 收口时对比，AC2.2 的 ≥30% 以此为证。

---

## 五、风险与待明确事项

- **R1（中）** json_extract 数值判定依赖 GLOB 模式，对脏文本（全角数字、千分位逗号）会误判为非数值被剔除 → 与现有渲染层 `isFinite(Number(v))` 判定存在理论差异；用 T7 对拍测试兜底，差异行数应在千分之一内，超出则改内存归并为默认。
- **R2（低）** 20 万×20 导入载荷不分批，结构化克隆内存峰值约几十 MB —— 主理人已裁决接受；>50 万行场景留 P2 分批。
- **R3（低）** Analytics 缓存一致性：缓存校验依赖 tables:list 的 updatedAt 快照，若未来出现绕过 touchTable 的写路径会脏读；约定所有写路径必须 touch（现状已满足）。
- **R4（低）** 结论/统计若实测逼近 500ms（20 万行极端宽表），下沉 analysisCore 到 Worker（parseWorker 范式已有，改造点收敛在 analysisCore 纯函数）。
- **R5（低）** 悬浮面板动画为手工调优常量（30ms/280ms），自动化测试覆盖不了观感；T14 需附手工验证清单交测试阶段执行。

**待明确**：无阻塞项。六项裁决已覆盖全部 PRD 待确认问题；唯一留白是报告打包 zip（P2，需引打包依赖时再向主理人确认）。
