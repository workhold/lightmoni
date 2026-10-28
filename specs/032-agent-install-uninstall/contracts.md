# API 契约

- `POST /api/v1/machines/:id/uninstallations/plan`：管理员，绑定已通过且未过期的 SSH 检查与私钥；固定只读探测目标身份，返回 `id/status/plan/review_url`。拒绝未知或不一致节点及忙任务。
- `GET /api/v1/machines/:id/uninstallations`、`GET .../:uninstallationId`：返回脱敏计划、阶段、回执及错误，不返回 SSH 或 Agent 秘密。
- `POST .../:uninstallationId/apply`：仅 `{confirm:true}`；重复执行、过期、目标变化、无效凭据及任务忙返回冲突/验证错误。
- `POST .../:uninstallationId/cancel`：取消未执行计划，取消本身幂等。
- `POST .../:uninstallationId/reconcile`：固定只读核对结果未知的操作；只有远端确认程序与服务已移除且身份匹配后，才撤销中心凭据并完成记录。
- 状态：`awaiting_approval/running/succeeded/failed/unknown/cancelled`。`unknown` 明确表示可能已变更，不能当作未执行或成功。
- 主机详情增加卸载历史；主机摘要增加 `capabilities.uninstall_agent` 及最近卸载状态。已有契约字段保持兼容。
- SSH 检查兼容返回已有安装信息。安装计划/执行不得覆盖已有配置、身份或 Agent 程序。

实现应以具体请求和响应补充测试证据；确认成功包括远端删除核验和中心凭据撤销两部分。
