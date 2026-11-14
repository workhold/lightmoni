# 告警事件接手提案契约

`lightmoni_alerts_plan` 新增 operation=incident.ack，输入 `{operation,target_id,reason,idempotency_key}`。要求 alerts.propose + alerts.detail.read + alerts.incidents.read、admin、allHosts=true。

返回原 AlertProposal 和受保护 review_url。before/after/result 仅含事件 ID、规则/组、generation、状态、owner 和接手段位等安全字段，不包含 evidence、联系人、payload 或供应商响应。awaiting_approval 不是已接手；completed 只表示原 Alerts 接手事务已提交。

提案绑定响应 generation 与规则/组 revision。Apply 复验稳定 grant、Scope、组成员、规则状态和目标版本；撤销、过期、降权、规则/组变化或他人已接手时失败关闭。业务幂等和原通知取消/响应审计保持原语义。

不开放直接 ack、Apply、transfer/escalate/renew、通知重试/测试工具。内部 propose_alert_change 使用同一原提案服务。
