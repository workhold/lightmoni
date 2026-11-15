# 服务主体与固定自动化契约

## 管理 API

以下端点只接受现有管理员 Web 会话，不属于 MCP 工具：

- `POST /api/v1/mcp-access/service-accounts`：创建服务主体与一把独立 Bearer。
- `GET /api/v1/mcp-access`：在原有摘要中增加当前管理员的 `service_accounts` 安全元数据。
- `DELETE /api/v1/mcp-access/service-accounts/:id`：撤销服务、对应 grant 和全部 token。

创建输入仅含 `name`、`capabilities`、`host_ids`、`expires_in_hours`、`max_invocations`。每项规则仅含 `name`、`version` 和可选 `input` 固定子集；服务端同时保存描述符的稳定 capability_id，并在发现与调用时核对。`host_ids=null` 表示明确授权全部已登记主机，数组表示封闭集合，缺省不提供隐式全主机权限。`max_invocations` 为 1～100000 的整数，期限沿用 1～8760 小时限制。

创建响应包含服务 ID、规则、Scope、Host、预算、期限和一次明文 `token`；后续摘要只包含 token ID、使用次数和状态，不包含明文或 hash。服务策略不可原地编辑。

## 主体与调用

服务 Principal 使用独立 `service_id` 作为 `user.id` 的兼容存储字段，并显式标记 `subject_type=service`、`owner_user_id`；它不代表个人用户，也不插入 `users`。原生只读适配器继续接收同一 Principal 形状。调用审计增加 `subject_type`，旧记录默认 `user`。

服务 Bearer 使用独立前缀并只存单向 hash。MCP 和 `GET /api/v1/capabilities`、`POST /api/v1/capabilities/:name/invoke`、`GET /api/v1/openapi.json` 复用现有认证入口。

`ExternalAuthority` 可增加能力可见性和执行前授权钩子。服务主体缺少钩子时失败关闭；用户 PAT/OAuth 不受额外服务策略影响。

固定子集匹配只比较 JSON 数据：对象规则中的每个字段必须递归匹配，数组/原始值整体相等。未约束字段不是任意权限，仍受能力 Schema、大小、Scope、Host、目标和描述符安全投影限制。

Dispatcher 在真实领域执行前调用授权钩子。预算使用 `invocation_count < max_invocations` 的单条条件更新扣减；并发只能有一个事务推进计数。扣减代表一次已接纳调用尝试，不代表业务成功，失败不退款。`queued/running/unknown` 语义不因本切片改变。

## 失败与兼容

- 未授权 capability/version/输入：`403 automation_capability_forbidden` 或 `403 automation_input_forbidden`。
- 预算耗尽：`429 automation_budget_exhausted`。
- 撤销、到期、Owner 非有效管理员或凭据异常：沿用安全认证失败，不泄露策略或目标内容。
- 服务不得调用 propose/execute、审批或管理工具；本切片不创建提案或执行授权。
- 现有 Principal 未标记 `subject_type` 时按 `user` 处理，现有工具、Scope、请求/响应、分页游标和稳定 grant 兼容。
