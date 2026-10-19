# 契约

所有 HTTP 接口和 AI 主机工具仅管理员可用。

- `POST /api/v1/machines/:id/ssh-check`：`{credential_id?:string}`；只允许这些参数。返回 `{id,machine_id,credential_id,connected,ready,platform,arch,checks,error_code,checked_at,expires_at}`。checks 仅固定布尔值，错误码无原始输出。连接失败仍保存并返回结构化回执；无凭据/无指纹/不支持的连接方式在连接前返回 4xx。
- `POST /api/v1/machines/:id/deployments/plan`：新增必填 `check_id`，其余 version/arch/credential_id/initial_label_id 保持；返回持久化计划与 `review_url`。
- AI `check_managed_machine_ssh({machine_id,credential_id?})`：真实 SSH 固定检查；仅后端解密。
- AI `get_managed_machine({machine_id})`：新增有效私钥元数据 `ssh_credentials[{id,method,expires_at}]`。
- AI `propose_agent_install({machine_id,check_id,version,arch,initial_label_id?})`：保存与 HTTP 相同的待审核计划；返回 id/status/plan/review_url，不执行安装。
- `GET /machines?machine=<id>&deployment=<id>`：打开指定现存计划；只有 awaiting_approval 可确认，后端继续校验状态和时效。

检查错误码包括 `ssh_failed/host_key_mismatch/timed_out/cancelled/invalid_response/prerequisites_missing`。SSH 检查通过不代表指定发行包已可下载、完整安装必定成功或 Agent 已激活。
