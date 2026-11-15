# SDD 170 实施计划

1. 在 `ai-runtime/src/runner.ts` 分离摘要供应商错误与不合格摘要输出；摘要输出不合格时优先保留已有摘要并追加降级说明，通过 compaction 事件传播 `degraded`。
2. 在 Runtime 类型、Web 时间线和 AssistantPage 中传递并展示降级状态，保持原 checkpoint、凭据检查和 summary_through 规则。
3. 在 `AgentUpdateProgress` 增加受控终态轮询与成功/失败/未知展示，避免卸载或终态后的读取；主机列表对运行中的 Agent 更新启用已有的快速刷新。
4. 增加四协议摘要截断、事件时间线、更新卡片终态与停止轮询测试，以及 `vchive` 类型未知记录的现状说明。
5. 更新 `docs/system-design.md`，运行相关测试、类型检查、构建和文档检查，创建 PR 后按授权合入。

## 架构与兼容

`degraded` 是可选的展示元数据，旧消费者可忽略。审批、执行、恢复、重试和凭据边界不变；详见 [spec.md](spec.md) 与 [contracts.md](contracts.md)。
