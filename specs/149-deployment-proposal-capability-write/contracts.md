# 服务部署提案契约

`lightmoni_deployments_plan` 输入 `{service_id,target_id,release_id,reason,idempotency_key}`，要求 deployments.propose + deployments.read、admin、allHosts=true。

返回 `{proposal,plan}`；proposal 含 id/operation/status/native_status/review_url。status 仅区分 awaiting_approval 与审批接受后的 completed；真实部署状态继续由 deployments.get/events 提供，agent_ready/queued 不是成功。

创建计划时写入 ExecutionGrantRegistry；审批与中心 SSH 派发前复验稳定 grant。撤销、过期、降权、缺少校验器或同 ID 授权冲突均 fail closed，不开始未执行 Job。

内部 propose_service_deployment 返回原 plan 形态。无 rollback/cancel/upload/approve/execute 外部工具。同 key 同输入返回原计划，异输入 idempotency_conflict。
