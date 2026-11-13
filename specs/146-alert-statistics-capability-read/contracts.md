# 告警响应统计契约

`lightmoni_alert_response_statistics_get` 输入可选 from/to/group_id/priority，要求 alerts.statistics.read、allHosts=true、R1。返回原 from/to/users/records/truncated/definition，算法、零成员和 20000 上限不变。

内部 get_alert_response_statistics 返回同一 data。Scope 不授予事件修改、接手、通知或配置权限；成员只保留内部/Web 读取，外部 PAT/OAuth 仍管理员专用。

原 `/api/v1/alerts/response-statistics` 响应不变。非法 from/to 返回原 400 边界，统计读取不产生任何写入。
