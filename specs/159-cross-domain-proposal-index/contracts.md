# 跨领域提案索引契约

索引只保存 domain/native_id、capability、owner_id、source、operation、native_state、review_url、host_id 和时间。原生提案始终为事实来源，索引不接受写入或审批。

`lightmoni_domain_proposals_list` 输入 `{domain?,state?,offset?,limit?}`；`lightmoni_domain_proposals_get` 输入 `{id}`，id 为 domain:native_id。统一返回 id/domain/native_id/capability/operation/status/native_status/review_url/source/created_at。

status 仅表示 awaiting_approval/completed；native_status 保留 queued/running/unknown 等领域事实，不得把 queued 映射为成功。每次调用要求 proposals.read 和对应领域 Scope，Host 范围只能读取匹配 host_id，跨 owner 不可见。

各领域提案创建、幂等和索引在同一 SQLite 事务接受；冲突不覆盖。读取刷新原生状态。OpenAPI/Bearer、执行索引、服务主体和持续授权不属于本切片。
