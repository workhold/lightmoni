# API 与数据契约

`POST /api/v1/machines/:id/credentials`：保留 method/secret/expires_in_seconds，新增 `retention?: temporary|managed|one_time|none`、`confirm_managed?: boolean`。

- ssh_key：省略 retention = temporary；temporary 默认/上限3600秒；managed 明确 confirm_managed=true，默认7776000秒、上限31536000秒。
- password：省略 retention = one_time，默认900秒、上限3600秒；其他策略拒绝。
- manual_script：不保存秘密，策略 none；不计入 SSH 能力。
- 新记录 `policy_source: explicit|default`；迁移记录 `legacy`。凭据响应新增 `secret_cleared_at`、`clear_reason`，不返回密文；事件只保留关联 ID、事件、操作者和时间。password 的 `secret_fingerprint` 固定为空，启动时清空历史密码摘要；只有私钥保留指纹标识。
- 机器响应新增 `active_ssh_credential_count`、`active_ssh_key_count`、`ssh_recovery_available`、`capabilities: {terminal,ssh_check,deploy_agent}`，各项 `{available:boolean,reason:string}`；reason 为 `host_busy|direct_ssh_required|host_fingerprint_required|ssh_credential_required|ssh_key_required|''`。
- `DELETE .../credentials/:credentialId`：幂等撤销并清空密文，终端立即失效。历史已撤销/过期记录也可清理，不要求重新解密。保留原密码/私钥用途校验和管理员权限。
- `clear_reason: expired|revoked|consumed|agent_activated|''`。清理已到期或撤销记录为无秘密元数据；重复清理不重复事件或覆盖原原因。凭据失效会取消引用它的 awaiting_approval 计划；运行中计划不由清理改写。
- Agent control/data 身份及 SDK Key API 不变。
