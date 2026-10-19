# Contracts: 主机管理与 Agent 引导部署

## 主机

`GET /api/v1/machines` 返回主机元数据：`id`、`name`、`address`、`port`、`username`、`connection_method`、`host_key_fingerprint`、`host_key_status`、`agent_id`、`agent_status`、`created_at`、`updated_at` 和凭据摘要。永远不返回 `encrypted_secret`。

`POST /api/v1/machines` 接收 `name`、`address`、`port`、`username`、`connection_method`、`host_key_fingerprint`、可选 `platform`、`arch`。仅管理员可写。

## 凭据

`POST /api/v1/machines/:id/credentials` 接收 `method` (`ssh_key`、`password`、`manual_script`)、一次性 `secret` 和可选 `expires_in_seconds`。响应只返回 `credential_id`、方法、指纹、过期时间、`retention` 和提示。`password` 默认 15 分钟 TTL，并返回中文长期保存警告。

`DELETE /api/v1/machines/:id/credentials/:credentialId` 撤销凭据；撤销后部署 worker 拒绝租约。凭据秘密只由后端 worker 在执行阶段短暂解密。

## 部署

`POST /api/v1/machines/:id/deployments/plan` 接收 `version`、`arch`、`initial_label_id` 和 `credential_id`，返回 `awaiting_approval` 计划、固定步骤、目标和风险提示。

`POST /api/v1/machines/:id/deployments/:deploymentId/apply` 只接受 `{confirm:true}`，管理员确认后执行已固定模板；响应包含阶段、脱敏输出和 `agent_id`，不包含 token、私钥、密码或完整 stdout。密码凭据返回明确的手动脚本提示，不自动 SSH。

## Assistant tools

- `list_managed_machines`: 只读主机列表，不含凭据。
- `get_managed_machine`: 读取单台主机和部署状态，不含秘密。
- `propose_agent_install`: 读取真实主机后生成待确认计划，不执行。
- `get_agent_installation`: 读取脱敏部署回执。
