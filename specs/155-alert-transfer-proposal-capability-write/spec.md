# 155 · 告警事件转交提案与原生执行

状态：实现与验证完成，等待评审与合并授权。继承 SDD 046/047/134～154 和全平台能力开放 Goal，本切片开放 Slice 3 的告警事件转交。PR #208 和依赖 PR #209 均未获本轮合并授权，本切片 stacked 在 #209 上并独立创建 PR，不自动合并。

## 需求与范围

1. 既有 `lightmoni_alerts_plan` 增加 `incident.transfer`，输入事件 ID、目标 user_id、原因和业务幂等键，不新增工具。
2. 除 alerts.propose + alerts.detail.read 外，额外要求 alerts.incidents.read；仅管理员、allHosts=true，创建和审批均复验。
3. 提取原生 Alerts.prepareTransfer/commitTransfer 和 resetPaging，保持既有 Alert API 的错误与转交语义；AlertCapabilities 只做预览和版本适配。
4. 提案绑定事件 generation、规则/责任组 revision、owner、目标成员和安全摘要；目标必须是当前有效组成员，管理员审批后才执行原转交事务。
5. 转交结果 state=unclaimed、owner 清空、stage=fallback、group.fallback 为目标成员；转交不等于对方已接手，预览和结果不包含敏感证据。
6. 内部 propose_alert_change 支持同一操作；不开放直接 transfer/Apply、升级、续期、通知重试/测试工具。

## 非目标

- 不改变通知派发、响应升级、取消、恢复或 unknown 语义。
- 不开放成员外部凭据，不宣称其他值班动作、Agent 后续生命周期、服务回滚或真实客户端矩阵已完成。

## 验收

1. incident.transfer 只创建 awaiting_approval，审批前事件不变；审批后事件 unclaimed 且目标成员正确。
2. 非组成员、同 key 异输入、有限 Host、成员、撤销或 Scope 缩小均失败关闭。
3. 预览/结果无敏感证据，内部工具兼容；官方 MCP 完成 ack→transfer→真实 unclaimed 回读。
4. 相关回归、类型检查、构建和 runtime 全量与既有基线对比有真实记录。
