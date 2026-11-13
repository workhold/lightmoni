# 148 · 告警规则与静默提案闭环

状态：已实现，待 PR 审核。继承 SDD 046/047/134～147 和全平台能力开放 Goal，本切片是 Slice 3 的告警提案。当前 stacked 基线包含 SDD 138～147；PR #192～#201 未获本轮合并授权，本切片独立创建面向 main 的 PR 并明确依赖，不自动合并。

## 需求与范围

1. 新增 `alerts.propose` 与 `lightmoni_alerts_plan`，支持原 rule.update/rule.silence/silence.create/update/end，复用 AlertCapabilities 与 AlertProposalService。
2. 因提案 before/after/result 包含 SQL 和配置，调用同时要求 `alerts.detail.read`；Scope 发现与直接调用均检查两者。
3. AlertProposalService 增加真实 ProposalSource，外部提案不伪造助手 session；owner、原 revision/版本、15 分钟期限和人工审批不变。
4. 外部提案使用稳定 grant 和业务幂等；审批前复验账户、grant、alerts.propose/detail 与安装级权限，撤销/降权后失败关闭。
5. 内部 propose_alert_change 改走同一 Dispatcher；原 HTTP 审批与真实回执保持。
6. 不新增 apply/approve 工具，不开放通知、事件接手、直接执行或服务主体。

## 非目标

- 不改变 AlertCapabilities 的校验、状态、通知或静默状态机。
- 不把告警提案转换为任务或直接执行，不放宽主机级数据隔离。
- 不宣称其他 Slice 3 领域提案已开放。

## 验收

1. 外部告警提案只保存 awaiting_approval，审批前无配置变化；审批后使用原 AlertCapabilities commit。
2. 缺少 propose/detail、有限 Host、撤销或 owner 不符均失败；同 key 幂等、异输入冲突。
3. 内部助手使用相同 Dispatcher，原告警提案/真实 Mastra/HTTP 回归通过。
4. 官方 MCP 客户端完成 rule/silence 提案、审批和回读，无 apply/approve。
5. 相关回归、类型检查、构建和 runtime 全量与 main 基线对比有真实记录。
