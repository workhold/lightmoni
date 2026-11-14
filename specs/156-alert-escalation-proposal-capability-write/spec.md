# 156 · 告警事件主动升级提案与原生执行

状态：实现与验证完成，等待评审与合并授权。继承 SDD 046/047/134～155 和全平台能力开放 Goal，本切片开放 Slice 3 的告警事件主动升级。PR #208、#209 和依赖 PR #210 均未获本轮合并授权，本切片 stacked 在 #210 上并独立创建 PR，不自动合并。

## 需求与范围

1. 既有 `lightmoni_alerts_plan` 增加 `incident.escalate`，输入事件 ID、原因和业务幂等键，不新增工具。
2. 额外要求 alerts.incidents.read；仅管理员、allHosts=true，创建和审批均复验 incidents.read、稳定 grant 与目标版本。
3. 提取原生 Alerts.prepareEscalate/commitEscalate，复用 resetPaging 和 primary→backup、其他→fallback 规则，保持 Alert API 错误语义。
4. 提案绑定事件 generation、规则/责任组 revision、owner 和安全 before/after；审批后原事务重置分页、保存事件并记录 manual_escalation 审计。
5. 升级结果 state=unclaimed、owner 清空、stage 为 backup 或 fallback；预览/结果不包含敏感证据，不把升级当成对方接手或通知已成功送达。
6. 内部 propose_alert_change 支持同一操作；不开放直接 escalate/Apply、续期、通知重试/测试工具。

## 非目标

- 不改变自动升级、通知派发、取消、恢复或 unknown 语义。
- 不开放成员外部凭据，不宣称其他值班动作、Agent 后续生命周期、服务回滚或真实客户端矩阵已完成。

## 验收

1. incident.escalate 只创建 awaiting_approval，审批前事件不变；审批后 stage 按原规则变化且 state=unclaimed。
2. 同 key 幂等、异输入冲突；已结束事件、有限 Host、成员、撤销或 Scope 缩小均失败关闭。
3. 预览/结果无敏感证据，内部工具兼容；官方 MCP 完成 ack→escalate→真实 backup 回读。
4. 相关回归、类型检查、构建和 runtime 全量与既有基线对比有真实记录。
