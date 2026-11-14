# Agent 安装提案契约

`lightmoni_agent_installations_plan` 输入 `{machine_id,check_id,version,arch,initial_label_id?,runtime_mode?,reason,idempotency_key}`，要求 agents.maintain.propose + agents.read、admin 和 machine_id 主机授权。

返回 `{proposal,plan}`。proposal 含 id/operation/status/native_status/review_url；plan 为原安全安装计划。status=awaiting_approval 仅表示等待人工审批；审批接受后的 completed 不表示安装成功。真实状态以 machine_deployments 和安装回执为准，running/unknown 不是成功。

外部来源在同一 SQLite 事务中保存原计划、幂等记录和 domain=agent_installation 的稳定 grant。原管理员 Apply 复验 grant、双 Scope 与主机范围；无绑定的内部/历史计划沿用原流程。MCP 不提供审批或直接执行。

同 key 同规范化输入返回原计划，异输入 idempotency_conflict。check_id、target_revision、版本/架构、runtime_mode 和凭据 revision 继续由原领域校验。
