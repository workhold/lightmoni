# 163 · 服务主体任务提案持续授权

状态：实现与验证完成，等待评审与合并授权。继承 SDD 046/047/134～162 与全平台能力开放 Goal，继续 Slice 5。基线为 `main@5076f64` + SDD 162 PR #218（`8ce9bca`）；#218 尚未合入，本切片为显式依赖它的 stacked PR，目标仍为 main，不自动合并。

## 需求与范围

1. 服务主体除 SDD 162 固定只读能力外，可经管理员明确授权使用 `lightmoni_tasks_plan@1`，仅限现有任务的 `task.dispatch`、`run.cancel`、`run.retry`。不得创建/修改任务、脚本或周期计划，不开放其他领域提案或直接 execute。
2. 服务规则继续绑定 capability_id/name/version、固定输入子集、Host、提交预算和期限。运行时可改变 idempotency_key、run_id 等未固定字段，但每次都必须通过原 Schema、目标、Host、revision、原生指纹和人工审批。
3. 提案仍以独立服务 ID 为业务 owner，来源加密保存服务 subject、Owner 管理员和原始能力调用约束证据；该证据不得进入工具结果、日志或审阅安全投影。
4. Owner 管理员可通过原任务提案页面/API 读取并审批服务提案，其他管理员不能越权读取；服务主体自身即使直接调用内部 Apply 也必须被拒绝。审批人和真实执行 actor 均为人类 Owner，不伪造成服务或模型。
5. 持续授权复验：
   - 提交：现有 Dispatcher 校验服务/token/grant/Owner、能力规则、输入、Host 并原子扣减一次提交预算；
   - 审批：原 Apply 前复验稳定 grant、服务策略、原始输入、Scope、Host 和原生指纹；
   - 领取：Agent/helper 领取前复验同一服务策略、原始输入和 Host；
   - 启动：自动重试入队及后续领取继续通过原 beforeStart 围栏复验，不因已审批或预算耗尽而跳过。
6. `capability_run_authorizations` 增加 proposal_id 关联，自动重试复制完整关联。审批和后续启动不重复消耗提交预算；预算耗尽可能阻止新提案，但不能据此撤销已授权执行。
7. 保持个人 PAT/OAuth、内部助手和 Web 原生审批兼容。提案接受、审批接受、queued/running/unknown 与最终成功分别表达，unknown 不自动重试，取消不冒充远端停止。

## 非目标

- 不开放 task.create/task.update、告警/部署/运维/Agent/SDK 服务提案、通用 apply/approve/execute、任意脚本或 Shell。
- 不提供服务策略编辑、轮换或自动批准，不新增第二套提案/执行状态机。
- 不操作生产主机、不发布镜像，不宣称真实 Codex/Claude、真实 Agent 或生产 E2E 已验证。

## 验收

1. 服务只能创建固定范围内的原生任务提案，不能自批；Owner 能审阅并由原任务中心执行，其他管理员和服务自身不能审批。
2. 提交后策略漂移、撤销、过期或 Owner 降权会阻止审批；审批后这些变化会阻止未领取任务及自动重试启动。
3. 正常任务可由 helper fixture 领取并回读真实原生状态，自动重试保留 proposal/grant/service 关联；预算不重复扣减。
4. 个人外部提案与内部提案回归通过，相关测试、类型检查、构建和文档检查有真实记录。
