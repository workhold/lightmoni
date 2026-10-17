# 研究记录

## Pi SDK

2026-10-18 使用 npm registry 检查到：

- `@earendil-works/pi-agent-core@1.3.0` 提供 `Agent`、工具循环、事件订阅和 `abort()`。
- `@earendil-works/pi-coding-agent@1.3.0` 提供 `createAgentSession`、`createCodingTools`、`SessionManager.inMemory` 和 `ModelRuntime.registerProvider`。
- provider 支持 `openai-completions`、`openai-responses`、`anthropic-messages` 和 `google-generative-ai`。
- Pi 的 `AgentSession` 在 tool call 后自动发起下一次模型请求，因此适合在一个 code task 内进行多轮执行。

## 选型

使用 Pi Agent 与 coding-agent 工具 SDK：

1. Agent 在内存管理多轮状态，工具使用受控 cwd。
2. 可以替换 read、write、edit、bash、find、ls operations；内置 grep 即使传 operations 仍会启动 rg，因此改成受控字面文本搜索。
3. 可以订阅 `tool_execution_start/end`、`turn_start/end`、`agent_end` 事件。
4. 可以直接调用 `agent.abort()`，无需管理外部 CLI 的进程协议。

Pi 只负责代码任务内部循环；Mastra 仍负责 LightMoni 用户对话、监控工具和最终回答。

最低 Node 版本随 Pi 依赖提高到 22.19。createCodingTools 仅提供 read/bash/edit/write，find/ls/grep 另从 createReadOnlyTools 注册。tool_execution_end 不含 args，用 toolCallId 关联 start 事件才能正确记录实际检查命令。SDK 的错误以 stopReason=error 返回而非总是 reject，因此执行器必须核对终止原因。
