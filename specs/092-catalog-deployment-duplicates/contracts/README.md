# Contracts

`POST /api/v1/ops/catalog/:id/install` 保持原契约：每个 `deployments[].cluster_id` 唯一，同一集群的机器放入同一个 `machine_ids`；重复配置返回 HTTP 400 / `duplicate_application_deployment`，不创建资源或执行记录。

安装表单：自选位置时提交前执行相同唯一性校验，提示“每个集群只能配置一次部署；多台机器请在同一部署中选择。” / “Configure each cluster once; select multiple machines in the same deployment.”；自动选址不提交手工草稿位置。

后端错误显示：“部署集群重复。请移除重复的安装位置；同一集群的多台机器请在一处选择。” / “A cluster is selected more than once. Remove the duplicate target and select its machines in one deployment.”
