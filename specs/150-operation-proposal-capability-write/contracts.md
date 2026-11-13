# 运维操作提案契约

`lightmoni_operations_plan` 输入 `{resource_id,operation,input,reason,idempotency_key}`，要求 operations.propose + operations.read、admin、allHosts=true。

返回 `{proposal,run}`；run 为原安全元数据，proposal 含 id/operation/status/native_status/review_url。status 仅表示 awaiting_approval 或审批接受后的 completed；queued/running/unknown 不是成功。

创建时 ExecutionGrantRegistry 绑定 operation=run.id；审批和中心 privileged 派发前复验。撤销、过期、降权、无校验器或授权冲突不开始执行。

内部 propose_operations_action 返回原 `{run}` 元数据。无资源写入、审批、取消、触发、Schedule 或直接执行工具。同 key 同输入返回原 Run，异输入 idempotency_conflict。
