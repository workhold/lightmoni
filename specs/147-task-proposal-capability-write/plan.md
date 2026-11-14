# 实施计划

## 1. 扩展任务能力

- tasks.plan 的 operation 增加 create/update，task 使用 TaskProposalService 的同一 taskDraftSchema。
- create 使用 task 定义；update 使用 task_id+task；不接受歧义的 run_id/host_ids 外层字段。
- 保持现有 dispatch/cancel/retry 和 proposalView/幂等响应。

## 2. Host 授权与审批复验

- 对有限 Host Principal，create/update 要求显式非空 task.host_ids，拒绝 target_all 和 label_ids。
- update 同时检查当前定义与合并后定义；create 检查拟创建定义。
- beforeApply 对存储的规范化定义再次执行同一检查，并沿用 grant/Scope 校验。
- afterApply 不伪造 Task Run；create/update 不创建 capability_run_authorizations。

## 3. 内部助手统一

- propose_task_action 不再对 create/update 使用旧 execute fallback，五种操作统一 invoke tasks.plan。
- 保持原工具名、会话 owner、提案链接和审批 HTTP。

## 4. 验证与交付

- 添加 create/update、Host 边界、撤销、幂等、内部助手和官方 MCP 闭环测试。
- 复跑任务/助手/MCP/授权/核心及全领域回归。
- 执行全仓类型检查、构建和 runtime 全量；main 既有失败单独对照。
- 更新系统设计、平台 MCP 和接入指南，推送 stacked 分支并创建面向 main 的 PR，注明依赖 #192～#200，不合并。
