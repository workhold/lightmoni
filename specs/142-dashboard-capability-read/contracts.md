# 大盘只读契约

## 能力

- `lightmoni_dashboards_list`：dashboards.read；`scope=custom|system|all`、search、limit/offset，返回 id/title/revision/updated_at/kind/panel_count/variable_count。
- `lightmoni_dashboards_get`：dashboards.detail.read；按 ID 返回完整原生 `{dashboard}`。
- `lightmoni_dashboards_versions`：dashboards.read；返回 `{dashboard_id,versions}`，包含 revision/updated_at/base_revision/overwritten。

全部 allHosts=true。列表和版本为 R0，完整详情为 R1；详情超过 60 KiB 或完整响应超过 64 KiB 时返回 result_too_large，不返回不完整配置。

## 权限与兼容

成员会话增加 dashboards.read/dashboards.detail.read，仅保留现有内部/Web 读取；外部 PAT/OAuth 仍管理员专用。Scope 不授予保存、复制、删除、告警草稿或 AI draft_dashboard。

内部新工具返回对应 data。原 `/dashboards`、`/system-monitoring`、详情和版本 API 的响应与 seed/revision 行为不变。
