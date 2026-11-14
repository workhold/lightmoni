# 158 · 通知重试提案与原生排队

状态：实现与验证完成，等待评审与合并授权。继承 SDD 046/047/134～157 和全平台能力开放 Goal，本切片开放 Slice 3 的通知重试提案与 outbox 排队。PR #208～#211 和依赖 PR #212 均未获本轮合并授权，本切片 stacked 在 #212 上并独立创建 PR，不自动合并。

## 需求与范围

1. 既有 `lightmoni_alerts_plan` 增加 `delivery.retry`，输入 delivery ID、原因、业务幂等键和可选 confirm_possible_duplicate，不新增工具。
2. 额外要求 alerts.notifications.read；仅管理员、allHosts=true，创建和审批均复验 notifications.read、稳定 grant 与目标版本。
3. 仅 failed/unknown/expired 可重试；unknown 必须明确确认可能重复发送，禁止自动重试。提取原生 Alerts.prepareDeliveryRetry/commitDeliveryRetry，保持原 Alert API 语义。
4. 提案绑定原始 outbox 内容摘要、owner 和安全 before/after；审批后原 updateDelivery 将记录恢复为 queued、attempts=0、next_attempt=now。
5. queued 只表示等待原通知 worker 领取，不表示已发送/送达；预览/结果不包含联系人、payload、供应商响应或原始错误。
6. 内部 propose_alert_change 支持同一操作；不开放直接 retry/Apply、通知测试或任意供应商调用工具。

## 非目标

- 不改变通知 worker、供应商协议、限流、重试次数、回执或 unknown 语义。
- 不宣称真实供应商已送达、其他值班动作、Agent 后续生命周期、服务回滚或真实客户端矩阵已完成。

## 验收

1. failed/unknown/expired 才能创建；unknown 未确认时失败关闭，确认后审批前原状态不变。
2. 同 key 幂等、异输入冲突；有限 Host、成员、撤销或 Scope 缩小均失败关闭。
3. 审批后 outbox=queued，预览/结果无敏感材料；官方 MCP 完成提案、原人工 Apply 和真实 queued 回读。
4. 相关回归、类型检查、构建和 runtime 全量与既有基线对比有真实记录。
