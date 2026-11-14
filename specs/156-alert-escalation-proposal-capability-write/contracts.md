# 告警事件主动升级提案契约

`lightmoni_alerts_plan` 新增 operation=incident.escalate，输入 `{operation,target_id,reason,idempotency_key}`。要求 alerts.propose + alerts.detail.read + alerts.incidents.read、admin、allHosts=true。

预览 after 仅表示审批后的预期状态：state=unclaimed、owner 清空、stage 按原 primary→backup、其他→fallback 规则变化，分页计数重置。升级完成不等于目标成员已接手，也不证明通知已送达。

提案绑定响应 generation、规则/组 revision 和 owner。Apply 复验稳定 grant、Scope、响应权限和目标版本；撤销、过期、降权、事件结束或目标变化时失败关闭。真实升级由原 Alerts 事务保存并写 manual_escalation 审计。

不开放直接 escalate/Apply、续期、通知重试/测试工具。预览/结果不包含事件证据、联系人、payload 或供应商响应。
