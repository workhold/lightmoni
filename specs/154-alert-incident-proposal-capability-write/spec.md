# 154 · 告警事件接手提案与原生执行

状态：实现与验证完成，等待评审与合并授权。继承 SDD 046/047/134～153 和全平台能力开放 Goal，本切片开放 Slice 3 的首个值班动作：告警事件接手。PR #208 尚未获本轮合并授权，本切片基于 main 独立创建 PR，不自动合并。

## 需求与范围

1. 既有 `lightmoni_alerts_plan` 增加 `incident.ack`，复用 AlertProposalService 的 owner、15 分钟期限、来源、稳定 grant、业务幂等和人工 Apply，不新增工具。
2. 除 alerts.propose + alerts.detail.read 外，incident.ack 额外要求 alerts.incidents.read；仅管理员、allHosts=true。
3. 原生 Alerts.acknowledge 拆分为异步只读预检与同步提交，保持既有 Web/通知接手路径兼容；AlertCapabilities 只做预览/版本适配，不复制接手状态机。
4. 提案绑定事件 generation、规则/责任组 revision、owner 和安全 before/after 摘要；审批及提交前复验，真实接手由原 Alerts 同步事务完成。
5. 提案增加真实受保护 review_url；预览/结果不包含事件证据、联系人、payload 或供应商响应。
6. 内部 propose_alert_change 支持同一操作，保持原生人工审批；不开放直接 ack、Apply、转交、升级、续期、通知重试/测试工具。

## 非目标

- 不改变通知派发、响应升级、取消、恢复或 unknown 语义。
- 不开放成员外部凭据；现有内部成员读取权限不改变。
- 不宣称其他值班动作、Agent 后续生命周期、服务回滚或真实客户端矩阵已完成。

## 验收

1. incident.ack 只创建 awaiting_approval，事件仍 firing；审批后原响应变为 acknowledged 且 owner 正确。
2. 同 key 幂等、异输入冲突；缺 incidents.read、有限 Host、成员和撤销授权均失败关闭。
3. 预览/结果无敏感证据，review_url 可用；规则或责任组变化使旧提案失效。
4. 内部旧工具兼容；官方 MCP 完成计划、原人工 Apply 和真实事件回读。
5. 相关回归、类型检查、构建和 runtime 全量与既有基线对比有真实记录。
