# 服务与部署只读契约

## 能力

- `lightmoni_services_list`：`{}` → `{services}`。
- `lightmoni_services_get`：`{service_id}` → `{service,targets,releases}`。
- `lightmoni_deployments_list`：`{service_id,limit?,offset?}` → `{items,total,offset,limit,has_more}`；limit 1..100，最多读取 Store 的 100 条历史。
- `lightmoni_deployments_get`：`{deployment_id}` → `{deployment}`。
- `lightmoni_deployments_events`：`{deployment_id}` → `{deployment_id,events}`。

全部要求 deployments.read、admin 和安装级授权。读取不授予服务/目标/Release 修改、部署审批、回滚、制品或遥测核验写权限。

## 状态与投影

部署保留原生 id/service/target/release、status/state/phase、operation_id/kind、plan、target_snapshot、receipt、error/error_code、时间和 telemetry/stale。事件保持 append-only 顺序和原生 phase/state/code/summary/actor/created_at。

draft、awaiting_approval、agent_ready、running、unknown 或回滚状态不得映射为 succeeded；真实状态由 Store 决定。大结果由能力层 64 KiB 限制拒绝，不生成不完整“成功”摘要。

## 内部兼容

list_services 返回 data.services；get_service_deployment 解包 data.deployment；get_service_deployment_events 返回 data 原形态。新 list_service_details/list_service_deployments 返回对应 data。旧 propose_service_deployment 保持内部专用。
