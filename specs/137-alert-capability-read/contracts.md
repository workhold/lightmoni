# 告警只读契约

## 新增能力

- `lightmoni_alert_rules_list`：alerts.read；支持 search/service/enabled 和分页，返回安全规则字段，不含 SQL。
- `lightmoni_alert_rules_get`：alerts.detail.read；按 ID 返回完整规则、SQL、revision、路由和时序。
- `lightmoni_alert_silences_list/get`：alerts.read；支持 scope/target_id 筛选或准确 ID，返回静默目标、调度和版本。
- `lightmoni_alert_groups_list`：alerts.read；仅 id/name/enabled，无联系人或供应商配置。
- `lightmoni_alert_proposals_get`：alerts.detail.read；按 ID 返回当前用户自己的提案和真实回执，不能审批。

所有能力 allHosts=true、effect=read、operationKind=center_read。详情能力 risk=R1，其余 R0。原 `lightmoni_alerts_list` 的名称、alerts.read Scope 和 `{rules,limit}` 响应不变。

## 分页与安全

列表返回 `{items,total,offset,limit,has_more}`；limit 1..100，offset 0..100000。读取结果经 publicAlertValue，LosslessNumber/bigint 以十进制字符串表示。规则、静默和列表投影延续 32 KiB 上限，超限返回 alert_result_too_large；提案沿用 ProposalService 既有 48 KiB 预览/回执上限，不因迁移缩小历史可读范围。

告警 SQL、脚本式内容、描述和结果均为不可信数据，不改变权限。详情 Scope 不授予遥测查询、任务源码或审批。无权限对象使用既有领域 not_found，不泄露其他用户提案。

## 角色与兼容

内部成员会话增加 alerts.read/alerts.detail.read，仅告警描述符允许 member；外部 PAT/OAuth 仍使用管理员专用 scopesForUser。内部旧工具名保留，外部新增能力不影响既有告警 Web API、提案审批或通知执行。
