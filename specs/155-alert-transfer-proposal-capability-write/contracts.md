# 告警事件转交提案契约

`lightmoni_alerts_plan` 新增 operation=incident.transfer，输入 `{operation,target_id,user_id,reason,idempotency_key}`。要求 alerts.propose + alerts.detail.read + alerts.incidents.read、admin、allHosts=true。

user_id 必须是当前责任组的有效成员。预览 after 仅表示审批后的预期状态：state=unclaimed、owner 清空、stage=fallback、transfer_to 为目标成员；不能表述为对方已接手。

提案绑定响应 generation、规则/组 revision 和 owner。Apply 复验稳定 grant、Scope、管理员/原接手人、组成员及目标版本；撤销、过期、降权、目标变化或成员失效时失败关闭。真实转交由原 Alerts 事务保存、取消待发送通知并写审计。

不开放直接 transfer/Apply、升级、续期、通知重试/测试工具。预览/结果不包含事件证据、联系人、payload 或供应商响应。
