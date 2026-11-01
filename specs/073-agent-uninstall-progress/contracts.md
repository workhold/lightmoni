# 既有 API 与界面状态契约

不新增或更改服务端端点、字段和状态转移。

- GET /api/v1/machines/:id：读取当前主机、连接凭据和卸载历史；仅选择 machine_id 与目标一致的记录。
- GET /api/v1/machines/:id/uninstallations/:operationId：重读固定记录；返回的 machine_id、id 与 plan.machine.id 必须匹配原目标。
- POST .../:operationId/apply：仍需管理员确认 confirm:true；网页同一次打开至多派发一次，不因轮询或网络失败重放。
- POST .../:operationId/cancel：仅取消 awaiting_approval；取消完成刷新能力。发送过 apply 但仍未执行的旧计划允许按原端点取消，服务端 busy/CAS 为最终依据。
- POST .../:operationId/reconcile：仅 unknown，只读检查，不能通过查看进展自动触发。

| 持久状态 | 可见含义 | 可用后续操作 |
| --- | --- | --- |
| awaiting_approval | 尚待审阅；发出 apply 后说明请求已发送 | 审阅确认（未派发过）、取消、刷新 |
| running | 正在卸载，等待远端结果 | 自动/手动读取状态 |
| unknown | 远端结果未知 | 选择有效 SSH 凭据后只读核对、刷新 |
| succeeded | 卸载完成，展示真实回执 | 查看记录、刷新 |
| failed / cancelled | 已结束，展示失败原因或取消结果 | 查看记录、刷新 |
