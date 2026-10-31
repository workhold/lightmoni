# 复用契约

- 查询：`GET /api/v1/ops/resources/:zone/records?offset=N&limit=20&keyword=...`，返回 records、total。
- 操作：`POST /api/v1/ops/resources/:zone/actions`，请求 `{revision, confirmed:true, action, input}`；逐记录创建 `action=create_record,input={record}`，修改 `action=update_record,input={record:{...原记录,type?,value?}}`，删除 `action=delete_record,input={id}`，同步 `action=sync,input={}`。
- 记录 ID 保持字符串，优先 `id`，兼容 `provider_record_id`。更新只覆盖选中的 type/value，其他字段保持原值；创建不能携带已有 ID。
- HTTP 成功不等于业务成功：`run.state=failed/unknown`、`run.result.state=verifying`、`run.result.verified=false` 单独展示。缺少可确认成功的回执按未知处理。网络或 5xx 结果未知，4xx 明确失败；401/403/409 停止后续目标。
- 批次浏览器内串行，每个请求保留原有 revision/confirmed 和管理员校验。不是事务，不引入新批量路由或持久化任务，不自动重试。
