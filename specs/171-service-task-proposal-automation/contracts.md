# 服务主体任务提案持续授权契约

## 能力与输入

服务管理 API 形状不变。`capabilities` 可包含 `lightmoni_tasks_plan@1`，服务端保存 `tasks.plan` 稳定 ID。规则必须显式固定一种 `input.operation`，服务调用只接受 `task.dispatch`、`run.cancel`、`run.retry`；空操作规则、其他 tasks.plan 操作和其他 propose 能力返回 `automation_capability_forbidden`。

固定输入仍在提交及每个后续阶段按递归子集匹配完整原始调用，包括 operation、目标、host_ids、reason 与 idempotency_key（若规则固定了这些字段）。未固定字段由原 JSON Schema、原生 revision/指纹、Host 和人工审批约束。

## 原生提案与人工审批

任务 ProposalSource 可加密保存 `subject_type=service`、`subject_id`、`owner_user_id` 和 `{capability_id,name,version,input}` 证据。服务 ID 仍是 Stored.owner_id；Owner 管理员可读取/审批，服务 ID 可读取自己的提案，其他主体保持 404。

服务提案 Apply 要求 actor 为有效管理员且 actor.id 等于 owner_user_id；actor.id 等于服务 owner_id 时明确拒绝，防止服务自批。审批写回使用 Stored.owner_id，审计 actor_id、任务 requested_by 和原生执行 actor 使用人类 Owner。

能力输入证据只用于授权复验，不进入 proposalView、MCP structuredContent、索引或日志。既有加密存储中的脚本/目标保护不变。

## 提交、审批、领取与启动

`ExternalAuthority.authorizeContinuation` 复验稳定 grant、Owner、capability_id/name/version、固定输入和服务资格，但不扣预算。`authorizeInvocation` 在同一校验后原子扣减一次提交预算。

任务 beforeApply 使用原提案能力证据调用 authorizeContinuation，并保留 Scope、Host、目标和指纹检查。capability_run_authorizations 增加 `proposal_id`；初始 run 绑定服务 ID 与 proposal ID，自动重试复制该关联。

beforeStart 通过 proposal ID 取回加密能力证据并再次调用 authorizeContinuation。失败时沿用原任务中心 authorization_revoked/auto_retry_closed 围栏，不发放新 lease、不创建替代执行。预算计数不参与 continuation 判断，已审批执行不会因新提交预算耗尽而被撤销。

## 兼容与结果

旧 ProposalSource 没有服务字段时按个人/内部提案处理，旧 run authorization 的 proposal_id 默认空；只有服务主体必须提供完整证据并失败关闭。现有工具数量、名称、Scope、请求/响应、幂等键主体隔离和原生审阅地址不变。

服务提案没有直接执行语义。completed proposal 表示原生审批接受；run queued/running/unknown 不是成功，取消与重试以真实 Task Run 回执为准，unknown 永不自动重试。
