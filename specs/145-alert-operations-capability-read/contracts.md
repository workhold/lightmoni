# 告警事件与通知只读契约

## 能力

- `lightmoni_alert_incidents_list`：alerts.incidents.read；state/group_id/priority 和分页，返回安全事件摘要。
- `lightmoni_alert_incidents_get`：alerts.incidents.read；`{id}` → `{incident,timeline}`，按原 append 顺序。
- `lightmoni_alert_deliveries_list`：alerts.notifications.read；rule/group/table/service/status 等筛选和分页，返回安全投递摘要。

全部 allHosts=true、R1。事件详情最多 60 KiB，超限 result_too_large。投递安全字段包括 id/response/rule/group/table/service、status/delivery_status、attempts、provider/channel、时间和 error_present；不包含 target/联系人、payload、供应商响应或原始错误。

## 权限与状态

Scope 不授予接手、确认、分配、重试、测试或供应商配置。成员会话保留内部/Web 读取，外部 PAT/OAuth 仍管理员专用。queued/sending/retry/unknown 不等于送达成功，原生状态不改写。

原 HTTP 响应保持；内部新工具返回对应 data。无审批或执行工具。
