# 告警值班续期提案契约

`lightmoni_alerts_plan` 新增 operation=incident.renew，输入 `{operation,target_id,reason,idempotency_key}`。要求 alerts.propose + alerts.detail.read + alerts.incidents.read、admin、allHosts=true。

仅当前 state=acknowledged 且 owner_id 等于操作者的事件可续期；管理员角色不绕过 owner 约束。预览 after 只标记将延长处理期限，实际 handling_until 以原生回执为准。

提案绑定响应 generation、规则/组 revision 和 owner。Apply 复验稳定 grant、Scope、owner 和目标版本；撤销、过期、降权、owner/状态变化时失败关闭。真实续期由原 Alerts 事务按 handling_seconds/3600 秒更新 handling_until 并写 renewed 审计，不增加 generation。

不开放直接 renew/Apply、通知重试/测试工具。预览/结果不包含事件证据、联系人、payload 或供应商响应。
