# 147 · 任务创建与修改提案闭环

状态：已实现，待 PR 审核。继承 SDD 046/047/134～146 和全平台能力开放 Goal，本切片开启 Slice 3：任务 create/update 提案。当前 stacked 基线包含 SDD 138～146；PR #192～#200 未获本轮合并授权，本切片独立创建面向 main 的 PR 并明确依赖，不自动合并。

## 需求与范围

1. 扩展现有 `lightmoni_tasks_plan`，支持 task.create/task.update，保留 dispatch/cancel/retry、工具名、Scope、响应和幂等兼容。
2. 内部 `propose_task_action` 五种操作全部通过 Dispatcher，不再让 create/update 回退到另一套工具执行路径。
3. 复用 TaskProposalService/NodeStore 的脚本类型、调度、revision、目标快照、owner 和人工审批；不新增直接执行或 Apply 工具。
4. Host 范围外部授权仅允许显式 host_ids 的静态任务目标；task.create/update 的修改前后目标均不得越权，禁止通过 target_all 或标签扩展。
5. 创建和审批前都复验稳定 grant、Scope 和 Host；重复请求沿用原幂等记录，变更目标/定义按原冲突语义处理。
6. 不开放脚本自动批准、unknown 自动重试、直接派发、服务主体或持续授权。

## 非目标

- 不改变任务中心、Agent 领取、脚本身份或调度状态机。
- 不允许通过 task.create/update 修改 origin/type 或绕过现有脚本约束。
- 不宣称告警、部署、运维、Agent 或插桩提案已经对外开放。

## 验收

1. 外部 create/update 只创建 awaiting_approval 提案，审批前无任务定义/执行变化；审批后复用原任务服务。
2. 有限 Host 可创建/修改授权内静态任务，越权、target_all、标签或修改前越权均失败。
3. 撤销/降权后审批失败；同 key 同输入幂等、异输入冲突，原五操作兼容。
4. 内部 create/update 也产生 Dispatcher 审计和共享提案，真实 Mastra/助手回归通过。
5. 官方 MCP 客户端完成 create/update、审批和结果读取闭环；无 apply/execute 工具。
6. 相关回归、类型检查、构建和 runtime 全量与 main 基线对比有真实记录。
