# 兼容契约

- `POST /ops/catalog/:id/install` 请求及 201 响应保持兼容：`resource` 已创建；`runs`/`deployments` 为执行提交结果；`deployment_error` 仅表示部署拒绝，不表示资源未创建。前端收到 resource 后关闭安装表单并打开该资源进度。
- 复用 `GET /ops/resources/:id`、`GET /ops/runs?resource_id=...`、`GET /ops/runs/:id/events?after=...`。事件 `sequence` 为本 run 单调游标，分页每次最多 200。读失败不得转为空成功。
- Agent job 仍使用 accepted → staging → activating → verifying 和最终 `/result`。可选 `snapshot.operations.progress={phase,code?}` 只接受预定义 phase 和 code；每条阶段由中心静态生成说明，拒绝自由文本。不变更 job phase 排序、lease、幂等或权限校验。旧 Agent 仅 job phase 时仍可展示。
- 内部 `OperationExecutionContext.progress?(phase,code?)` 发白名单阶段，不传任意命令或输出。`operationCommand` 将 Docker 错误归为有限诊断码；输出仍不对外提供。终态失败包含原阶段/原因，恢复失败继续 unknown。
- 无新数据库迁移；新步骤沿用最多 2000 条及既有日志 outbox。旧历史不补造步骤；最新安装与后续 inspect/stop 的记录各自展示，聚合不能用一次 inspect 成功覆盖原安装失败。

- 端口缺省/空值：手动模式采用模板容器端口；托管模式传递 host_port=0 由平台分配。显式数字端口（含旧客户端的0）保持原义。OpenResty 固定80/443不变。
