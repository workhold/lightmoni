# 通知重试提案契约

`lightmoni_alerts_plan` 新增 operation=delivery.retry，输入 `{operation,target_id,confirm_possible_duplicate?,reason,idempotency_key}`。要求 alerts.propose + alerts.detail.read + alerts.notifications.read、admin、allHosts=true。

仅原 outbox 状态为 failed/unknown/expired 时可重试；unknown 必须 confirm_possible_duplicate=true。Apply 只把原记录恢复为 queued、attempts=0、next_attempt=now，等待原通知 worker 领取，不表示已发送或送达。

提案绑定原 outbox 内容摘要。Apply 复验稳定 grant、Scope 和目标版本；撤销、过期、降权、目标变化或未明确确认 unknown 时失败关闭。预览/结果不包含联系人、payload、供应商响应或原始错误。

不开放直接 retry/Apply、通知测试或任意供应商调用工具。真实投递结果继续通过 alerts.notifications.read 查询，unknown 不自动重试。
