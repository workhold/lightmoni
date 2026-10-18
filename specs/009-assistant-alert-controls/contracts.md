# 业务与助手契约

## 公共业务能力

`AlertCapabilities` 接收已注册的 Alerts 实例。身份来自 Router 的 User（业务层只需 id/role）。提供规则列表/单项、静默列表/单项及不含联系方式的告警组目录。

`prepare(actor, operation, input, signal?) -> AlertChange` 只校验并产生 before/after，不写业务对象。`commit(actor, change)` 同步复核并提交，不自行开启事务；HTTP 与助手由各自事务包裹。`AlertChange` 字段：`operation,target_id,expected_version,before,after,summary,impact[]`。操作为：

| operation | input |
| --- | --- |
| rule.update | `{id, revision, patch}`，仅更新明确列出的业务字段 |
| rule.silence | `{id, revision, until}`，空 until 解除，时间为 RFC3339 |
| silence.create | `{silence}`，主服务写 id/created_by |
| silence.update | `{id, version, patch}`，复核旧范围及新范围权限 |
| silence.end | `{id, version}`，提前结束一次性或周期窗口 |

`revalidate(actor, storedChange, signal?)` 对持久化提案重新校验，保留创建/修改窗口时已展示的 ID 和时间；只有重新准备得到且未被修改的对象才能 commit。`silence.end` 预览表示确认时立即结束，实际 `until/ended_at` 使用确认事务的服务器时间，避免把确认前的静默期追溯算成无人响应时间；实际时间由 result 回读展示。修改静默必须仍有目标范围权限，原创建者即使已离组仍可提前结束自己创建的窗口。

现有 POST/PUT rules（含创建）、POST rules/:id/silence、GET/POST/DELETE silences 委托共享服务；新增 GET rules/:id、GET silences/:id、PUT silences/:id。版本冲突为 409，未授权 403，不存在 404，输入错误 400；错误不泄露配置凭据。列表保持原 HTTP 返回数组，AI 适配层裁剪并明确 has_more。

## AI 工具

- `list_alert_rules`：可选名称/服务/启停过滤，有界返回摘要及 ID。
- `get_alert_rule`：指定 ID 回读详情。
- `list_alert_silences`、`get_alert_silence`：有界返回静默信息。
- `list_alert_groups`：仅返回选择范围需要的 ID/名称/启停。
- `get_alert_proposal`：按 ID 核验当前用户提案和完成回执；只读，不能确认或应用。
- `propose_alert_change`：`{operation,target_id?,patch?,silence?,until?,reason}`。服务补上当前版本；需要用户意图说明，不能伪造身份。只返回 `{proposal:...}` 摘要和待确认状态。

具体字段及工具 schema 以实现测试固定。确认接口不注册为模型工具。

## 提案接口

`GET /api/v1/assistant/alert-proposals/:id` 仅当前所有者可读。

`POST /api/v1/assistant/alert-proposals/:id/apply` body `{}`，仅当前所有者明确确认。不存在/他人 404，权限变化 403，版本变化/过期 409。成功返回完整最新提案：`{id,session_id,operation,target_id,status,before,after,summary,impact,reason,created_at,expires_at,applied_at?,result?}`；status 为 `awaiting_approval|completed`。result 是执行后的业务对象。存储和页面可显示过期，不以客户端时间授权。重复确认返回原 completed 记录，不能重复业务写入。

SQL、规则和静默描述均为不可信数据。每次工具、提案及对象输出检查大小，不静默裁剪可审批内容；超限要求缩小目标。GET 失败时 UI 禁止应用。

业务层及持久化变更保留精确整数；助手工具、前后配置与完成回执中的超出 JavaScript 安全整数范围的值使用十进制字符串，避免原生 JSON/浏览器显示舍入或将无损数值对象当成配置。

每轮提供主服务当前 UTC 时间，供模型计算“静默 30 分钟”等相对时长；不明确的本地时间仍需澄清时区。

提案最大 48 KiB，创建时预留完整执行结果与版本字段空间；规则/静默单项工具最大 32 KiB，列表默认 30、最多 100 项，支持 offset 分页并提供 total/has_more。每轮向模型补入当前会话最近 20 条主服务核验状态，避免已压缩历史中的“待确认”覆盖实际已完成回执；更早的 ID 可调用 get_alert_proposal 核验。完成回执只证明 applied_at 时执行成功，当前对象仍应通过对应 get 工具重新查询。
