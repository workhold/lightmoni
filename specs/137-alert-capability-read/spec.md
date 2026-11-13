# 137 · 告警只读能力垂直迁移

状态：已实现，待 PR 审核。继承 SDD 046/047/134/135/136 和全平台能力开放 Goal，本切片是 Slice 2 的告警领域：规则、静默、责任组和既有提案读取。当前 stacked 基线包含 SDD 134～136；PR #186/#187/#188 未获合并授权，本切片独立创建面向 main 的 PR 并明确依赖，不自动合并。

## 需求与范围

1. 新建 AlertReadService，内部 AI 与 MCP/HTTP 复用 AlertCapabilities、AlertProposalService、筛选、分页、安全投影和大小限制。
2. 保留 `lightmoni_alerts_list` 的原目录响应；新增分页规则 list、完整规则 get、静默 list/get、责任组 list 和 owner-bound 提案 get。
3. 普通目录/静默/责任组使用 `alerts.read`；完整规则 SQL 与提案 before/after/result 使用独立 `alerts.detail.read`。
4. 所有告警读取为安装级权限，有限主机授权不能发现或直接调用；读取不授予修改、审批、通知供应商秘密或联系人详情。
5. 内部助手保留 list_alert_rules/get_alert_rule/list_alert_silences/get_alert_silence/list_alert_groups/get_alert_proposal 名称，过滤旧实现以避免重复；propose_alert_change 仍走原领域提案服务，本切片不对外开放。
6. 保留成员内部助手的既有告警读取；外部 PAT/OAuth 仍只向管理员发 Scope。成员不能因此获得任务、主机或外部凭据。
7. 告警提案继续 owner 隔离、原状态/revision 和人工审批；读取提案不产生审批或执行。

## 非目标

- 不开放告警创建/修改/静默写入、通知测试、事件接手或任意 SQL 执行。
- 不把告警 SQL 当作遥测查询权限，不开放主机级告警隔离。
- 不改变告警评估、通知 outbox、值班状态机或 Web 领域 API。
- 不宣称部署、运维、日志/Trace 或后续 Slice 3 提案已开放。

## 验收

1. 六个内部旧读取工具与外部对应能力共用 AlertReadService，无同名重复注册，原输出形态保持。
2. alerts.read 不能读取完整规则 SQL 或提案详情；alerts.detail.read 不能代替其他领域 Scope。
3. 有限主机授权不能发现/调用告警能力；成员仅保留内部读取，外部成员授权仍不可用。
4. 规则筛选/分页、静默筛选、责任组安全字段和提案 owner 隔离有测试；大结果有界且不泄露秘密。
5. 官方 MCP 客户端按 Scope 发现和调用；无 apply/写入工具新增。
6. 相关回归、类型检查、构建和 runtime 全量与 main 基线对比有真实记录。
