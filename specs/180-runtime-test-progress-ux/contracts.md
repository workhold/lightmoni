# SDD 180 契约

## 测试语义

- 403 的 `human_admin_session_required` 是会话边界，不得降级为 409 或移除。
- 409 的 orphan/revoked 拒绝必须在合法管理员会话下验证，确保测试真正到达领域准入。
- queued 只有同时满足未开始、无 lease、无 lease hash、无 lease 到期且 attempts 为 0/缺省时才是可延后的未领取工作；其他执行中和 unknown 状态继续构成围栏。

## 待审批进度

- `awaiting_approval` 的百分比、阶段和时间分别为 0、`awaiting_approval`、空字符串，不接受 stale 事件提升。
- 待审批文案不表示已接受、排队或开始执行；过期计划必须提示重新准备。
- 其他状态沿用 SDD 178 的真实事件映射和中心终态核验。
