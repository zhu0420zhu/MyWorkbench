# 移植交付说明 — MCP → LLM 函数调度（Tool-Augmented Generation）

> 对应 awesome-llm-apps 的 **MCP** 类别落地第二阶段：将已连接的 MCP server 工具接入 LLM 的函数调度，
> 让「与本地文件对话」与（后续）智能体能真正**调用外部工具**后再生成答案。
> 延续既有范式：主进程 + IPC + 无头测试、纯逻辑零外部依赖、非破坏性改动、不含渲染层 GUI。

---

## 一、本次新增/改动

| 文件 | 改动 |
| --- | --- |
| `src/main/mcp/toolBridge.ts` | **新增**。MCP → LLM 工具桥 `createMcpToolBridge(manager)`，实现 `ToolBridge` |
| `src/main/mcp/index.ts` | 导出 `createMcpToolBridge`；新增 `getMcpManager()` 全局单例 |
| `src/main/mcp/mcpIpc.ts` | 改用 `getMcpManager()` 单例（与 searchIndexIpc 共享连接） |
| `src/main/searchIndex/searchIndexIpc.ts` | 用 `createMcpToolBridge(getMcpManager())` 构造 `QaService` |
| `src/main/searchIndex/qa.ts` | `CompleteFn` 对齐 `ToolAwareLlm`；构造增可选 `ToolBridge`；`ask()` 走工具增强 |
| `src/main/ai.ts` | `complete()` 支持可选 `tools` 参数与 `tool_calls` 解析（向后兼容） |
| `src/shared/types.ts` | 扩展 `AiChatMessage` 联合类型；新增 `AiTool`/`AiToolCall`/`ToolAwareLlm`/`ToolInvocation`/`ToolLoopResult`/`ToolBridge`；`AskResult.mcpToolCalls?` |
| `tests/smoke-mcp-tools.ts` | **新增**。22 项无头测试（内存 transport 模拟 server） |

---

## 二、工具桥设计（纯逻辑、可注入、零依赖）

### 2.1 命名空间映射
- `getAiTools()` 聚合所有 `connected` server 的工具，生成 LLM 工具定义时以 `serverId__name` 命名（如 `svr-0001__get_weather`）。
- `executeToolCall()` 收到 LLM 的 `tool_call` 后，按首个 `__` 拆回 `serverId` 与 `name`，路由到对应 `manager.callTool({serverId, name, arguments})`。

### 2.2 ReAct 工具循环 `runToolLoop(llm, messages, opts?)`
1. 取工具列表（默认 `getAiTools()`，或用 `opts.tools` 覆盖）。
2. **无工具时**直接单轮生成（避免 `listToolsFull` 网络开销与循环）。
3. 每轮：调用 `llm(messages, {tools})`。
   - 返回 `tool_calls` → 追加 `assistant`（含 `tool_calls`）消息，逐条执行并追加 `tool` 结果消息（`tool_call_id` 对应）。
   - 无 `tool_calls` → 返回最终 `answer`。
4. 超过 `maxIterations`（默认 4）→ 最后一次**不带工具约束**强制生成文本，避免死循环。

### 2.3 接入点
- **QaService**：`ask()` 在检索上下文就绪后，若注入了 `ToolBridge`，先让 LLM 按需调用外部工具再生成答案；桥不可用时退化为原有单轮生成（行为不变）。
- **智能体（后续）**：同一 `ToolBridge` 可被 agents 复用，无需重复实现调度逻辑。
- **AI 后端**：`ai.ts complete()` 现已携带 `tools` 并解析 `tool_calls`，任意 OpenAI 兼容端点（含支持 function calling 的模型）均可驱动。

---

## 三、契约变更（全部 optional / 向后兼容）

- `AiChatMessage` 由单一结构改为联合类型：`system` / `user` / `assistant{content?, tool_calls?}` / `tool{content, tool_call_id}`。
- `complete(messages, opts?: { tools?: AiTool[] })`：返回新增 `toolCalls?: AiToolCall[]`。
- `AskResult.mcpToolCalls?: ToolInvocation[]`：透出本次问答调用的外部工具（serverId / name / arguments / result / isError），供 GUI 透明度展示。
- `QaService` 构造函数：`(indexer, llm, opts?, bridge?)` —— 第四参数为可选，旧调用不受影响。

---

## 四、验证结果（全绿）

| 项目 | 结果 |
| --- | --- |
| `npm run typecheck:node` | 通过 |
| `npm run typecheck:web` | 通过 |
| `npm run build` | 成功（main 205.58 kB / preload 13.77 kB）|
| `tests/smoke-mcp-tools.ts` | 22 / 0 |
| `tests/smoke-mcp.ts`（回归） | 16 / 0 |
| `tests/smoke-qa.ts`（回归） | 18 / 0 |
| `tests/smoke-context.ts`（回归） | 25 / 0 |

---

## 五、使用示例（概念）

```ts
// 注册并连接一个 MCP server（如暴露 get_weather 的工具）
await ipcRenderer.invoke('mcp:add-server', {
  name: 'weather', command: 'npx', args: ['-y', 'my-weather-mcp'], enabled: true
})
// 与本地文件对话时，若 LLM 判定需要天气数据，会自动调用该工具后再作答
const res = await ipcRenderer.invoke('searchIndex:ask', { question: '北京明天要带伞吗？结合本地笔记里的行程。' })
console.log(res.answer, res.mcpToolCalls) // 答案 + 调用过的工具清单
```

---

## 六、awesome-llm-apps 移植收尾状态

- **已交付**：三大模块（智能分类/格式转换/全文检索）、与本地文件对话(CRAG)、记忆与个性化 / 常驻智能体(HN+Release Radar) / Vision RAG、知识库流水线、上下文窗口优化、MCP 集成客户端、MCP → LLM 函数调度。
- **剩余可行项（需真实环境/渲染层）**：
  1. 真实 MCP server 端到端验证（stdio 路径与协议层已就绪，需在已配置具体 server 的环境实跑一次）。
  2. P2 Agent Skills / GenUI（依赖渲染层，延后）。
  3. 各模块接入渲染层 GUI（此前明确延后）。
- 主进程 + IPC + 统一任务调度/配置/日志 的移植与协同已全部落地并通过验证。
