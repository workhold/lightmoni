# SDD 166 实施任务

- [x] T001 读取生产取消时间线并完成一台主机真实只读 SSH preflight，确认 connected/ready/checks，未创建提案或修改主机。
- [x] T002 [US1] 在 `runtime/test/assistant.test.ts` 增加 pending tool 取消回执及真实失败区分测试。
- [x] T003 [US1] 在 `web/src/features/assistant/assistant.test.mjs` 增加取消、历史兼容和真实失败时间线测试。
- [x] T004 [US1] 修改 `runtime/src/assistant/index.ts`、`web/src/features/assistant/types.ts`、`timeline.ts` 与 `AssistantPage.tsx`，实现取消状态与标签。
- [x] T005 运行相关 Runtime/Web/AI runtime 测试、类型检查、构建和文档检查。
- [x] T006 [US3] 创建短期最小权限 PAT，通过真实 MCP 完成发现、只读调用、越权及撤销验证，记录脱敏证据。
- [ ] T007 更新 `specs/166-assistant-cancellation-state/validation.md`，同步 main 并创建 PR；本次不合入，合入需另行授权，不直接 push main。
