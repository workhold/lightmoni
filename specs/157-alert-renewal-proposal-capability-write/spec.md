# 157 · 告警值班续期提案与原生执行

状态：实现与验证完成，等待评审与合并授权。继承 SDD 046/047/134～156 和全平台能力开放 Goal，本切片开放 Slice 3 的告警值班续期。PR #208～#210 和依赖 PR #211 均未获本轮合并授权，本切片 stacked 在 #211 上并独立创建 PR，不自动合并。

## 需求与范围

1. 既有 `lightmoni_alerts_plan` 增加 `incident.renew`，输入事件 ID、原因和业务幂等键，不新增工具。
2. 额外要求 alerts.incidents.read；仅管理员、allHosts=true，创建和审批均复验 incidents.read、稳定 grant 与目标版本。
3. 提取原生 Alerts.prepareRenew/commitRenew，只有当前 acknowledged 事件的 owner 才能续期；管理员身份不能绕过 owner 约束。
4. 提案绑定事件 generation、规则/责任组 revision、owner 和安全 before/after；审批后按原 handling_seconds/3600 秒规则更新 handling_until 并写 renewed 审计，不增加 generation。
5. 预览仅表达将延长处理期限，实际 handling_until 以原事务回执为准；不包含敏感证据，不把续期当成事件已恢复或通知已送达。
6. 内部 propose_alert_change 支持同一操作；不开放直接 renew/Apply、通知重试/测试工具。

## 非目标

- 不改变自动升级、通知派发、取消、恢复或 unknown 语义。
- 不开放成员外部凭据，不宣称其他值班动作、Agent 后续生命周期、服务回滚或真实客户端矩阵已完成。

## 验收

1. 只有当前 owner 的 incident.renew 才能创建并完成；非 owner 和未接手事件失败关闭。
2. 同 key 幂等、异输入冲突；有限 Host、成员、撤销或 Scope 缩小均失败关闭。
3. 审批后 handling_until 延长且 generation 不变，预览/结果无敏感证据；官方 MCP 完成 ack→renew→真实回读。
4. 相关回归、类型检查、构建和 runtime 全量与既有基线对比有真实记录。
