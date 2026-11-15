# SDD 165 实施任务

- [x] T001 核对最新 main、生产只读证据、内部/MCP 遥测契约和 Mastra `prepareStep` 能力，完成 spec、plan、contracts、tasks；确认无架构变更。
- [x] T002 [US1] 在 `runtime/test/assistant.test.ts` 与 `runtime/test/telemetry-capabilities.test.ts` 增加目录 12KB、助手 16KB、MCP 兼容和完整单表描述回归测试。
- [x] T003 [US2] 在 `ai-runtime/test/worker.test.ts` 增加持续工具请求与 `max_steps=1` 的四协议最后步骤测试。
- [x] T004 [US3] 在 `runtime/test/telemetry-capabilities.test.ts` 增加 assistant 时间宏前置校验及 MCP 不受影响测试。
- [x] T005 [US1] 修改 `runtime/src/assistant/tools.ts` 与 `runtime/src/capabilities/index.ts`，实现内部目录摘要和完整结构字节预算。
- [x] T006 [US1] 修改 `runtime/src/domains/telemetry.ts`，按 source 分离助手/MCP 查询样本字节预算。
- [x] T007 [US2] 修改 `ai-runtime/src/runner.ts`，在最后一步禁用工具并保持现有事件与终态闭环。
- [x] T008 [US3] 修改 `runtime/src/assistant/types.ts`、`runtime/src/assistant/tools.ts` 与 `runtime/src/domains/telemetry.ts`，增加选表指引、SQL 约束和 assistant 时间宏校验。
- [x] T009 运行相关测试、必要全量回归、typecheck、build 和文档检查，记录 `specs/165-assistant-context-resilience/validation.md`。
- [ ] T010 同步 main、审查完整 diff、创建 PR 并在检查后按 merge commit 合入；回读 main 与 PR 状态，不直接 push main。
