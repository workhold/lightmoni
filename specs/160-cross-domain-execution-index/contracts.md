# 跨领域执行索引契约

索引只保存 domain/native_id/host_id/state 的投影，原生 Task Run、Deployment、Operation Run、Agent 首装和维护记录始终为事实来源，索引不接受执行或审批。

`lightmoni_domain_executions_list` 输入 `{domain?,state?,offset?,limit?}`；`lightmoni_domain_executions_get` 输入 `{id}`，id 为 domain:native_id。返回 execution_id/domain/native_id/native_state/host_id/review_url。

每次调用要求 executions.read 与对应领域 Scope；Task/Agent 生命周期复验 Host，服务部署和运维要求安装级授权。native_state 保留 queued/running/unknown/rolled_back 等事实，不统一映射为成功。OpenAPI/Bearer、服务主体和持续授权不属于本切片。
