# 告警提案契约

`lightmoni_alerts_plan` 输入沿用 propose_alert_change 的 operation/target/patch/silence/until/reason，并增加外部必需 idempotency_key。要求 alerts.propose + alerts.detail.read、admin、allHosts=true。

返回 `{proposal}`，初始 awaiting_approval；不含 apply/approve 能力。审批仍由现有管理员 HTTP 完成，外部稳定 grant 在审批前复验。MCP session 为空且不作为 owner/授权依据。

同 installation/user/capability/key 同输入返回原提案，异输入 idempotency_conflict。撤销、过期、降权、Scope/Host 不符或原 revision 变化按原语义失败，不修改配置。

AlertProposalService 的 owner、加密 before/after、15 分钟期限和真实 commit/audit 不变；内部旧工具和历史提案行为不变。
