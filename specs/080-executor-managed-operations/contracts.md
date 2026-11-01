# 契约

- operations.managed.v1 独立于 container.managed.v1 / script.elevated.v1，默认关闭；启用明确说明批准的运维程序可能取得整机权限。
- privileged managed payload 固定 kind、原 job ID、不可变 actions/capabilities/target、私有 OperationPayload/制品摘要、超时及输出上限。plan/permit 的 request_sha256 覆盖完整载荷，主体为独立 root executor；开始许可仅使用一次，不可用普通 control 代领。
- 生产 AgentJob 标记 execution_principal，管理型 job 的 lease 与 root job 同一 lease。普通 HTTP 不得操作该行，即使获知 ID/lease。回执必须经独立签名鉴权、当前策略和原领域验证。
- 原领域批准版本在领取和开始时必须仍有效。私有制品分块请求绑定 root job、release ID、offset、不可变大小/sha256；禁止任意 URL、路径或跨任务读取。
- 运维 adapter 只使用 root 自有程序和 root 私有状态。首次迁移不得把旧 Agent 可写元数据当作 root 授权或执行代码；已有持久业务数据不自动创建空副本，需精确核验或明确迁移计划。
